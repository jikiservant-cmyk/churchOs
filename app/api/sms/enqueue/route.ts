/**
 * POST /api/sms/enqueue
 *
 * Authenticated admins only. Recipients are resolved from the database by id
 * (the client cannot supply phone numbers), capped, persisted to sms_queue, and
 * delivery is kicked off after the response is sent.
 */
import { NextResponse, after } from 'next/server';
import { getTenantAdminForChurchId } from '@/lib/auth/tenant';
import { enqueueBroadcast, processQueueBatch } from '@/lib/queue-actions';
import { MAX_SMS_LENGTH } from '@/lib/sms-actions';
import { parseRecipientRefs, resolveRecipients, effectiveSenderId } from '@/lib/recipients';
import { rateLimit } from '@/lib/security';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const AUDIENCES = ['all', 'men', 'women', 'youth', 'new_converts', 'custom', 'missed_you'];

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
  const audience = typeof body.audience === 'string' && AUDIENCES.includes(body.audience) ? body.audience : 'custom';

  if (!(await rateLimit(`enqueue:${admin.churchId}`, 10, 60 * 60))) {
    return NextResponse.json({ error: 'Too many broadcasts. Try again later.' }, { status: 429 });
  }

  try {
    const { data: wallet } = await admin.supabase.from('wallets').select('balance, sms_rate').eq('tenant_id', admin.churchId).maybeSingle();
    if (!wallet) return NextResponse.json({ error: 'Billing account not found.' }, { status: 400 });
    if (wallet.balance < wallet.sms_rate) {
      return NextResponse.json({ error: 'Insufficient SMS balance.', remaining: 0 }, { status: 402 });
    }

    const recipients = await resolveRecipients(admin.supabase, admin.churchId, refs);
    if (recipients.length === 0) return NextResponse.json({ error: 'No valid recipients' }, { status: 400 });

    const { data: church } = await admin.supabase.schema('church').from('churches').select('sender_id').eq('id', admin.churchId).maybeSingle();

    const { broadcastId, enqueued, skipped } = await enqueueBroadcast({
      tenantId: admin.churchId,
      message,
      audience,
      senderId: effectiveSenderId(church?.sender_id),
      recipients,
      createdBy: admin.user.id,
    });

    await audit('sms.broadcast_enqueued', { tenantId: admin.churchId, actor: admin.user.id, meta: { broadcastId, enqueued, skipped } });

    // Deliver after the response (in-process; no secret-bearing HTTP self-call).
    after(async () => {
      try {
        await processQueueBatch({ tenantId: admin.churchId, batchSize: 15 });
      } catch (e) {
        console.error('[sms/enqueue] background processing failed:', (e as Error).message);
      }
    });

    return NextResponse.json({
      success: true,
      broadcastId,
      enqueued,
      skipped,
      message: `${enqueued} message${enqueued !== 1 ? 's' : ''} queued for delivery.`,
    });
  } catch (err) {
    console.error('[sms/enqueue] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to queue messages' }, { status: 500 });
  }
}
