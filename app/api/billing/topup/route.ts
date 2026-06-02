import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';

/** Service-role client — webhook has no user session/cookies, needs to bypass RLS */
function getServiceDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * POST /api/billing/topup
 *
 * LivePay webhook — fires after the admin approves or declines
 * the Mobile Money prompt on their phone.
 *
 * On success: credits wallet via increment_wallet_balance RPC,
 *             marks transaction 'success', revalidates cache.
 */
export async function POST(request: Request) {
  // ── 1. Read raw body before parsing (required for HMAC check) ────────────
  const rawBody = await request.text();

  // ── 2. Verify LivePay webhook signature ───────────────────────────────────
  const secret = process.env.LIVEPAY_WEBHOOK_SECRET ?? process.env.WEBHOOK_SECRET;
  const incomingSig =
    request.headers.get('x-livepay-signature') ??
    request.headers.get('x-webhook-signature') ??
    '';

  if (secret && incomingSig) {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    if (
      expected.length !== incomingSig.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(incomingSig))
    ) {
      console.error('[topup webhook] Invalid signature — rejected');
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // ── 3. Parse payload ──────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Support common LivePay field name variants
  const reference = (
    payload.reference ??
    payload.ref ??
    payload.internal_reference ??
    payload.transaction_ref
  ) as string;

  const rawStatus = (
    payload.status ??
    payload.payment_status ??
    payload.transaction_status ??
    ''
  ) as string;

  if (!reference) {
    return NextResponse.json({ error: 'Missing reference field' }, { status: 400 });
  }

  const db = getServiceDb();
  const isSuccess = ['success', 'successful', 'completed', 'approved'].includes(
    rawStatus.toLowerCase()
  );

  // ── 4. Handle failed / cancelled payments ────────────────────────────────
  if (!isSuccess) {
    await db
      .from('wallet_transactions')
      .update({ status: 'failed', provider_payload: payload })
      .eq('reference_code', reference)
      .eq('status', 'pending');

    console.log(`[topup webhook] Payment ${reference} failed. Status: "${rawStatus}"`);
    return NextResponse.json({ received: true });
  }

  // ── 5. Look up the pending transaction ───────────────────────────────────
  const { data: tx, error: txError } = await db
    .from('wallet_transactions')
    .select('*')
    .eq('reference_code', reference)
    .eq('status', 'pending')
    .maybeSingle();

  if (txError) {
    console.error('[topup webhook] DB lookup error:', txError);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  if (!tx) {
    // Already processed (idempotent) or unknown — always 200
    console.log(`[topup webhook] Reference ${reference} not found or already processed.`);
    return NextResponse.json({ received: true });
  }

  // ── 6. Idempotency guard via billing_events unique constraint ─────────────
  const { error: eventError } = await db.from('billing_events').insert({
    event_type: 'topup',
    payload: payload,
    idempotency_key: reference,
    reference_id: reference,
    tenant_id: tx.tenant_id,
  });

  if (eventError?.code === '23505') {
    // Duplicate webhook — already processed
    console.log(`[topup webhook] Duplicate for ${reference}, skipping.`);
    return NextResponse.json({ received: true });
  }
  if (eventError) {
    console.error('[topup webhook] billing_events error:', eventError);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  // ── 7. Credit wallet atomically via RPC ───────────────────────────────────
  const { error: walletError } = await db.rpc('increment_wallet_balance', {
    p_tenant_id: tx.tenant_id,
    p_amount: tx.amount,
  });

  if (walletError) {
    console.error('[topup webhook] increment_wallet_balance failed:', walletError);
    return NextResponse.json({ received: true });
  }

  // ── 8. Mark transaction success ───────────────────────────────────────────
  await db
    .from('wallet_transactions')
    .update({ status: 'success', provider_payload: payload })
    .eq('reference_code', reference);

  // ── 9. Revalidate cache so wallet balance refreshes on next page load ─────
  revalidatePath('/', 'layout');

  console.log(
    `[topup webhook] ✅ Wallet credited — tenant: ${tx.tenant_id}, amount: UGX ${tx.amount}, ref: ${reference}`
  );

  return NextResponse.json({ received: true });
}
