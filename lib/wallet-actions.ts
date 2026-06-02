'use server';

import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

/** Service-role client — bypasses RLS for DB writes (wallet_transactions has no INSERT policy) */
function getServiceDb() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * Called by TopUpModal's form submit.
 * FormData fields: churchId, phoneNumber, amount
 *
 * Flow:
 *  1. Auth check
 *  2. Validate inputs
 *  3. Insert PENDING wallet_transaction
 *  4. Call LivePay to initiate Mobile Money collection
 *  5. Return success → modal shows "check your phone"
 *  6. LivePay fires webhook → /api/billing/topup credits the wallet
 */
export async function initiateLivePayPayment(formData: FormData): Promise<{
  success?: boolean;
  message?: string;
  error?: string;
}> {
  // ── 1. Auth check ────────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized. Please log in again.' };

  // ── 2. Extract & validate inputs ─────────────────────────────────────────
  const churchId  = (formData.get('churchId')    as string)?.trim();
  const rawPhone  = (formData.get('phoneNumber') as string)?.trim();
  const amountStr = (formData.get('amount')      as string)?.trim();
  const amountUGX = parseInt(amountStr, 10);

  if (!churchId)  return { error: 'Missing church ID.' };
  if (!rawPhone || !/^(\+?256|0)\d{8,9}$/.test(rawPhone)) {
    return { error: 'Enter a valid Ugandan phone number (e.g. 0771234567).' };
  }
  if (isNaN(amountUGX) || amountUGX < 2000) {
    return { error: 'Minimum top-up is UGX 2,000.' };
  }

  // ── 3. Normalize phone → 256XXXXXXXXX ───────────────────────────────────
  let phone = rawPhone.replace(/\s+/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.startsWith('0')) phone = '256' + phone.slice(1);

  // ── 4. Create PENDING transaction (service role — no INSERT RLS policy) ──
  const db        = getServiceDb();
  const reference = crypto.randomUUID();

  const { error: txError } = await db.from('wallet_transactions').insert({
    tenant_id:       churchId,
    amount:          amountUGX,
    type:            'TOPUP',
    description:     `Wallet top-up via Mobile Money (${phone})`,
    reference_code:  reference,
    status:          'pending',
    idempotency_key: `topup-init-${churchId}-${Date.now()}`,
    product:         'sms',
    created_by:      user.id,
  });

  if (txError) {
    console.error('[initiateLivePayPayment] DB insert error:', txError);
    return { error: 'Could not start top-up. Please try again.' };
  }

  // ── 5. Call LivePay to initiate Mobile Money collection ──────────────────
  try {
    const res = await fetch('https://payments.livepayug.com/api/v1/collections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LIVEPAY_API_KEY}`,
      },
      body: JSON.stringify({
        account_no:   process.env.LIVEPAY_ACCOUNT_NO,
        amount:       amountUGX,
        phone_number: phone,
        reference:    reference,
        narrative:    'ChurchOS SMS Wallet Top-up',
        callback_url: `${process.env.APP_URL}/api/billing/topup`,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error('[initiateLivePayPayment] LivePay error:', res.status, errBody);

      await db
        .from('wallet_transactions')
        .update({ status: 'failed' })
        .eq('reference_code', reference);

      return {
        error:
          'Payment gateway error. Check LIVEPAY_API_KEY / LIVEPAY_ACCOUNT_NO in your .env, or try again.',
      };
    }
  } catch (err) {
    console.error('[initiateLivePayPayment] LivePay fetch failed:', err);

    await db
      .from('wallet_transactions')
      .update({ status: 'failed' })
      .eq('reference_code', reference);

    return { error: 'Could not reach payment gateway. Check your internet connection.' };
  }

  // ── 6. Return success — wallet credits after LivePay webhook fires ────────
  return {
    success: true,
    message: `Check your phone (${rawPhone}) — approve the Mobile Money prompt to complete the top-up.`,
  };
}
