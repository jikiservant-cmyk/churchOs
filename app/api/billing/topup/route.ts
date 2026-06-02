import { NextResponse } from 'next/server';
import { createClient as createSupabaseServerClient } from '@/lib/supabase/server';
import crypto from 'crypto';

/**
 * POST /api/billing/topup
 *
 * LivePay webhook endpoint. Called by LivePay after a Mobile Money
 * collection request is approved (or fails) by the user.
 *
 * Security: verifies HMAC-SHA256 signature using LIVEPAY_WEBHOOK_SECRET.
 */
export async function POST(request: Request) {
  // 1. Read raw body BEFORE parsing — needed for signature check
  const rawBody = await request.text();

  // 2. Verify LivePay webhook signature
  const webhookSecret = process.env.LIVEPAY_WEBHOOK_SECRET ?? process.env.WEBHOOK_SECRET;
  const incomingSig =
    request.headers.get('x-livepay-signature') ??
    request.headers.get('x-webhook-signature') ??
    '';

  if (webhookSecret) {
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (
      incomingSig.length === 0 ||
      !crypto.timingSafeEqual(Buffer.from(incomingSig), Buffer.from(expected))
    ) {
      console.error('[topup webhook] Invalid signature');
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } else {
    console.warn('[topup webhook] LIVEPAY_WEBHOOK_SECRET not set — signature check skipped!');
  }

  // 3. Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const reference = (payload.reference ?? payload.ref ?? payload.transaction_ref) as string;
  const rawStatus = (payload.status ?? payload.payment_status ?? '') as string;
  const status = rawStatus.toLowerCase();

  if (!reference) {
    return NextResponse.json({ error: 'Missing reference' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // 4. Handle failed/cancelled payments — mark and return 200 so LivePay stops retrying
  const isSuccess =
    status === 'success' ||
    status === 'successful' ||
    status === 'completed' ||
    status === 'approved';

  if (!isSuccess) {
    await supabase
      .from('wallet_transactions')
      .update({ status: 'failed', provider_payload: payload })
      .eq('reference_code', reference)
      .eq('status', 'pending');

    console.log(`[topup webhook] Payment ${reference} marked failed. Status: "${rawStatus}"`);
    return NextResponse.json({ received: true });
  }

  // 5. Look up the pending transaction
  const { data: tx, error: txFetchError } = await supabase
    .from('wallet_transactions')
    .select('*')
    .eq('reference_code', reference)
    .eq('status', 'pending')
    .maybeSingle();

  if (txFetchError) {
    console.error('[topup webhook] DB lookup error:', txFetchError);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  if (!tx) {
    // Either already processed (idempotent) or unknown reference — return 200 either way
    console.log(`[topup webhook] Reference ${reference} not found or already processed.`);
    return NextResponse.json({ received: true });
  }

  // 6. Idempotency: Insert billing_event with unique idempotency_key
  //    If this webhook fires twice, the second INSERT will hit the unique constraint and we skip.
  const { error: eventError } = await supabase.from('billing_events').insert({
    event_type: 'topup',
    payload: payload,
    idempotency_key: reference, // unique constraint prevents double-processing
    reference_id: reference,
    tenant_id: tx.tenant_id,
  });

  if (eventError) {
    if (eventError.code === '23505') {
      // Duplicate key — already processed
      console.log(`[topup webhook] Duplicate for ${reference}, ignoring.`);
      return NextResponse.json({ received: true });
    }
    console.error('[topup webhook] billing_events insert error:', eventError);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  // 7. Credit the wallet atomically via the RPC (no race conditions)
  const { error: walletError } = await supabase.rpc('increment_wallet_balance', {
    p_tenant_id: tx.tenant_id,
    p_amount: tx.amount,
  });

  if (walletError) {
    console.error('[topup webhook] increment_wallet_balance failed:', walletError);
    // Don't return 500 here — we've already written billing_event, so retrying would double-credit
    // Log and investigate manually
    return NextResponse.json({ received: true });
  }

  // 8. Mark the transaction as success
  await supabase
    .from('wallet_transactions')
    .update({ status: 'success', provider_payload: payload })
    .eq('reference_code', reference);

  console.log(
    `[topup webhook] ✅ Wallet credited: tenant=${tx.tenant_id} amount=${tx.amount} ref=${reference}`
  );

  return NextResponse.json({ received: true });
}
