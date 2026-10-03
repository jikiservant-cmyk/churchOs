import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { getTenantAdminForChurchId } from '@/lib/auth/tenant';
import { sendSingleSMS, MAX_SMS_LENGTH, InsufficientBalanceError } from '@/lib/sms-actions';
import { parseRecipientRefs, resolveRecipients, effectiveSenderId } from '@/lib/recipients';
import { isUuid, rateLimit } from '@/lib/security';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Largest broadcast delivered inline (streamed). Bigger ones must use /api/sms/enqueue. */
const MAX_STREAMED = 300;

/**
 * Streams per-recipient progress as NDJSON. Recipients are resolved from the
 * database by id; the client cannot supply phone numbers.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { message, churchId } = body;

  const admin = await getTenantAdminForChurchId(churchId);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  if (typeof message !== 'string' || !message.trim() || message.length > MAX_SMS_LENGTH) {
    return NextResponse.json({ error: `Message must be 1–${MAX_SMS_LENGTH} characters` }, { status: 400 });
  }
  const refs = parseRecipientRefs(body.recipients);
  if ('error' in refs) return NextResponse.json({ error: refs.error }, { status: 400 });
  if (refs.length > MAX_STREAMED) {
    return NextResponse.json({ error: `Use the queue endpoint for more than ${MAX_STREAMED} recipients.` }, { status: 413 });
  }
  if (!(await rateLimit(`broadcast:${admin.churchId}`, 10, 60 * 60))) {
    return NextResponse.json({ error: 'Too many broadcasts. Try again later.' }, { status: 429 });
  }

  let recipients;
  let senderId: string;
  try {
    recipients = await resolveRecipients(admin.supabase, admin.churchId, refs);
    const { data: church } = await admin.supabase.schema('church').from('churches').select('sender_id').eq('id', admin.churchId).maybeSingle();
    senderId = effectiveSenderId(church?.sender_id);
  } catch (err) {
    console.error('[sms/broadcast] setup failed:', (err as Error).message);
    return NextResponse.json({ error: 'Could not load recipients' }, { status: 500 });
  }
  if (recipients.length === 0) return NextResponse.json({ error: 'No valid recipients' }, { status: 400 });

  // Client-supplied batch id makes a double-submit idempotent (same keys → no resend/recharge).
  const batchId = isUuid(body.batchId) ? body.batchId : randomUUID();
  const tenantId = admin.churchId;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
      let sent = 0;
      try {
        send({ type: 'start', total: recipients.length });

        for (let i = 0; i < recipients.length; i++) {
          const r = recipients[i];
          const first = (r.full_name || 'Member').split(' ')[0];
          const personalised = message
            .replace(/{name}/gi, () => r.full_name || 'Member')
            .replace(/{first_name}/gi, () => first);
          try {
            const result = await sendSingleSMS({
              phoneNumber: r.phone_number,
              message: personalised,
              churchId: tenantId,
              idempotencyKey: `bc:${batchId}:${r.id}`,
              senderId,
            });
            if (result.success) {
              sent++;
              send({ type: 'success', recipient: r.full_name, index: i });
            } else {
              send({ type: 'error', recipient: r.full_name, error: 'Delivery failed' });
            }
          } catch (err) {
            if (err instanceof InsufficientBalanceError) {
              send({ type: 'halt', reason: 'Insufficient balance' });
              break;
            }
            send({ type: 'error', recipient: r.full_name, error: 'Delivery failed' });
          }
          await new Promise((res) => setTimeout(res, 100));
        }
        await audit('sms.broadcast_streamed', { tenantId, actor: admin.user.id, meta: { recipients: recipients.length, sent } });
        send({ type: 'complete' });
        controller.close();
      } catch (err) {
        console.error('[sms/broadcast] fatal:', (err as Error).message);
        send({ type: 'fatal', error: 'Broadcast failed' });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform' },
  });
}
