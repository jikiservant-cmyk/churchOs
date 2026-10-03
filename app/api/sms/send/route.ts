import { NextResponse } from 'next/server';
import { getTenantAdminForChurchId } from '@/lib/auth/tenant';
import { sendSingleSMS, MAX_SMS_LENGTH, InsufficientBalanceError } from '@/lib/sms-actions';
import { normalizeUgPhone } from '@/lib/utils';
import { rateLimit } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { phoneNumber, message, churchId, idempotencyKey } = body;

  // Caller must be an admin of THIS church (profile checked through RLS).
  const admin = await getTenantAdminForChurchId(churchId);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  if (typeof phoneNumber !== 'string' || !normalizeUgPhone(phoneNumber)) {
    return NextResponse.json({ error: 'A valid phone number is required' }, { status: 400 });
  }
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_SMS_LENGTH) {
    return NextResponse.json({ error: `Message must be 1–${MAX_SMS_LENGTH} characters` }, { status: 400 });
  }
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 100)) {
    return NextResponse.json({ error: 'Invalid idempotency key' }, { status: 400 });
  }
  if (!(await rateLimit(`sms-send:${admin.churchId}`, 60, 60))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // Sender ID from the caller's own church row (RLS) — never from the client.
  const { data: church } = await admin.supabase.schema('church').from('churches').select('sender_id').eq('id', admin.churchId).maybeSingle();
  if (!church) return NextResponse.json({ error: 'Church configuration not found.' }, { status: 404 });
  const isSandbox = process.env.AT_USERNAME?.toLowerCase() === 'sandbox';
  const senderId = !isSandbox && church.sender_id ? String(church.sender_id).trim() : '';

  try {
    const result = await sendSingleSMS({
      phoneNumber,
      message,
      churchId: admin.churchId,
      // Namespaced per tenant so keys cannot collide across churches.
      idempotencyKey: idempotencyKey ? `${admin.churchId}:${idempotencyKey}` : undefined,
      senderId,
    });
    return NextResponse.json(result, { status: result.success ? 200 : 502 });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return NextResponse.json({ error: 'Insufficient SMS balance.' }, { status: 402 });
    }
    console.error('[sms/send] failed:', (err as Error).message);
    return NextResponse.json({ error: 'Failed to send SMS' }, { status: 502 });
  }
}
