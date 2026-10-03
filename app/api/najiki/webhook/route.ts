import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/server';
import { verifyNajikiSignature, classifyNajikiPayload } from '@/lib/najiki';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Najiki notification webhook (payments AND SMS delivery updates share this URL;
 * set the Najiki Application's webhookPath to `/api/najiki/webhook`).
 *
 *  - Fails CLOSED: with no signing secret configured every request is rejected.
 *  - Verifies Najiki's `X-Najiki-Signature: t=<ms>,v=<hmac>` (HMAC-SHA256 over
 *    "<ms>.<rawBody>"), constant-time. See lib/najiki.ts.
 *  - Payments: matched by the reference we sent in externalEntityId / metadata.
 *    Credits the amount recorded at initiation (inside `apply_topup`), never the
 *    payload's number; an amount mismatch parks the transaction for review.
 *  - SMS: 'failed' refunds the debit exactly once; 'delivered' updates the log.
 *  - Idempotent: replays never touch the wallet twice.
 *  - Payloads (phone numbers, ids) are never logged.
 */
export async function POST(request: Request) {
  const secrets = [process.env.NAJIKI_WEBHOOK_SECRET, process.env.NAJIKI_API_KEY].filter((x): x is string => !!x);
  if (secrets.length === 0) {
    console.error('[najiki-webhook] no signing secret configured; rejecting');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const verified = verifyNajikiSignature({
    secrets,
    rawBody,
    signatureHeader: request.headers.get('x-najiki-signature'),
    timestampHeader: request.headers.get('x-najiki-timestamp'),
  });
  if (!verified) {
    console.warn('[najiki-webhook] signature verification failed');
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

  const event = classifyNajikiPayload(payload);
  if (event.kind === 'ignored') return NextResponse.json({ received: true });

  try {
    const db = await createAdminClient();

    // ── SMS delivery updates ───────────────────────────────────────────────
    if (event.kind === 'sms') {
      const logs = () => db.schema('church').from('sms_logs');
      const { data: log } = await logs().select('id, tenant_id, status').eq('provider_message_id', event.smsId).maybeSingle();
      if (!log) return NextResponse.json({ received: true }); // not ours (or already purged)

      if (event.outcome === 'delivered') {
        await logs()
          .update({ status: 'Delivered', message_provider_status: 'delivered', updated_at: new Date().toISOString() })
          .eq('id', log.id)
          .eq('status', 'Queued');
        return NextResponse.json({ received: true });
      }

      // Failed after Najiki accepted it: give the money back, once.
      if (String(log.status).toUpperCase() !== 'FAILED') {
        const { data: debit } = await db
          .from('wallet_transactions')
          .select('idempotency_key')
          .eq('tenant_id', log.tenant_id)
          .eq('reference_id', log.id)
          .eq('type', 'SMS_SENT')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (debit?.idempotency_key) {
          const { error: refundErr } = await db.rpc('refund_wallet', { p_tenant_id: log.tenant_id, p_original_key: debit.idempotency_key });
          if (refundErr) {
            console.error('[najiki-webhook] refund failed:', refundErr.code, refundErr.message);
            return NextResponse.json({ error: 'Processing error' }, { status: 500 }); // Najiki retries
          }
        } else {
          console.error('[najiki-webhook] failed SMS has no debit to refund');
        }
        await logs()
          .update({ status: 'FAILED', message_provider_status: 'failed', error_message: (event.error ?? 'Delivery failed').slice(0, 300), updated_at: new Date().toISOString() })
          .eq('id', log.id);
        revalidatePath('/', 'layout');
      }
      return NextResponse.json({ received: true });
    }

    // ── Payment notifications ──────────────────────────────────────────────
    let reference = event.reference ?? '';
    if (!reference && event.paymentId) {
      const { data } = await db.from('wallet_transactions').select('reference_code').eq('idempotency_key', event.paymentId).maybeSingle();
      reference = data?.reference_code ?? '';
    }
    if (!reference || !reference.startsWith('CHURCH-')) {
      // Success we cannot match is money without a wallet: shout, but ack (retrying cannot help).
      console.error(`[najiki-webhook] unmatched ${event.outcome} notification; needs manual reconciliation`);
      return NextResponse.json({ received: true });
    }

    if (event.outcome === 'success') {
      if (event.currency && event.currency !== 'UGX') {
        console.error('[najiki-webhook] non-UGX success notification; not crediting');
        return NextResponse.json({ received: true });
      }
      if (event.amount !== null && (!Number.isInteger(event.amount) || event.amount <= 0)) {
        return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
      }

      const { data: outcome, error } = await db.rpc('apply_topup', {
        p_reference: reference,
        p_amount: event.amount,
        p_payload: payload,
      });
      if (error) {
        console.error('[najiki-webhook] apply_topup failed:', error.code, error.message);
        return NextResponse.json({ error: 'Processing error' }, { status: 500 }); // Najiki will retry
      }
      if (outcome === 'amount_mismatch') console.error('[najiki-webhook] amount mismatch; transaction parked for review');
      if (outcome === 'not_found' || outcome === 'invalid_state') console.error(`[najiki-webhook] apply_topup returned ${outcome}; needs manual reconciliation`);
      if (outcome === 'credited') revalidatePath('/', 'layout');
      return NextResponse.json({ received: true });
    }

    await db
      .from('wallet_transactions')
      .update({ status: 'failed', provider_payload: payload })
      .eq('reference_code', reference)
      .eq('type', 'TOPUP')
      .eq('status', 'pending'); // never downgrade a credited transaction
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('[najiki-webhook] unhandled error:', (err as Error).message);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
