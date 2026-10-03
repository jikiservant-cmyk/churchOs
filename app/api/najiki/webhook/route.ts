import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/server';
import { safeEqual } from '@/lib/security';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Najiki payment webhook.
 *
 *  - Fails CLOSED: with no signing secret configured every request is rejected.
 *  - HMAC-SHA256 over the raw body, constant-time compare.
 *  - Credits the amount recorded at initiation (inside `apply_topup`), never the
 *    payload's number; an amount mismatch parks the transaction for review.
 *  - Idempotent: replays return `already_processed` without touching the wallet.
 *  - Payloads (phone numbers, ids) are never logged.
 */
export async function POST(request: Request) {
  const secret = process.env.NAJIKI_WEBHOOK_SECRET || process.env.NAJIKI_API_KEY;
  if (!secret) {
    console.error('[najiki-webhook] no signing secret configured; rejecting');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const provided = (request.headers.get('x-najiki-signature') || '').replace(/^sha256=/i, '').trim().toLowerCase();
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!provided || !safeEqual(expected, provided)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : '';
  let reference = typeof payload.reference === 'string' ? payload.reference.slice(0, 128) : '';
  const paymentIntentId = typeof payload.paymentIntentId === 'string' ? payload.paymentIntentId.slice(0, 128) : '';

  try {
    const db = await createAdminClient();

    // Resolve our reference. Plain `.eq` filters only: no string-built `.or()`.
    if (!reference && paymentIntentId) {
      const { data } = await db.from('wallet_transactions').select('reference_code').eq('idempotency_key', paymentIntentId).maybeSingle();
      reference = data?.reference_code ?? '';
    }
    if (!reference) return NextResponse.json({ received: true }); // nothing we can match; ack so Najiki stops retrying

    if (status === 'success') {
      let amount: number | null = null;
      if (payload.amount !== undefined && payload.amount !== null) {
        amount = Number(payload.amount);
        if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
          return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
        }
      }

      const { data: outcome, error } = await db.rpc('apply_topup', {
        p_reference: reference,
        p_amount: amount,
        p_payload: payload,
      });
      if (error) {
        console.error('[najiki-webhook] apply_topup failed:', error.code, error.message);
        return NextResponse.json({ error: 'Processing error' }, { status: 500 }); // Najiki will retry
      }
      if (outcome === 'amount_mismatch') console.error('[najiki-webhook] amount mismatch; transaction parked for review');
      if (outcome === 'credited') revalidatePath('/', 'layout');
      return NextResponse.json({ received: true });
    }

    if (status === 'failed') {
      await db
        .from('wallet_transactions')
        .update({ status: 'failed', provider_payload: payload })
        .eq('reference_code', reference)
        .eq('type', 'TOPUP')
        .eq('status', 'pending'); // never downgrade a credited transaction
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('[najiki-webhook] unhandled error:', (err as Error).message);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
