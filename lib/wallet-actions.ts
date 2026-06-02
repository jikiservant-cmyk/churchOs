'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

/**
 * Initiates a Mobile Money top-up via LivePay.
 * This does NOT credit the wallet directly — the webhook handler does that
 * once LivePay confirms payment.
 */
export async function topUpWallet(
  tenantId: string,
  amountUGX: number,
  phoneNumber: string,
  churchSlug: string
): Promise<{ success?: boolean; reference?: string; message?: string; error?: string }> {
  const supabase = await createClient();

  // 1. Auth guard
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized. Please log in again.' };

  // 2. Validate inputs
  if (!phoneNumber || !/^(256|\+256|07|0)\d{8,9}$/.test(phoneNumber.trim())) {
    return { error: 'Enter a valid Ugandan phone number (e.g. 0771234567).' };
  }
  if (!amountUGX || amountUGX < 1000) {
    return { error: 'Minimum top-up is UGX 1,000.' };
  }

  // 3. Normalize phone to 256XXXXXXXXX format
  let phone = phoneNumber.trim().replace(/\s+/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.startsWith('0')) phone = '256' + phone.slice(1);

  // 4. Create a PENDING transaction record first (idempotency guard)
  const reference = crypto.randomUUID();
  const idempotencyKey = `topup-init-${tenantId}-${Date.now()}`;

  const { error: txError } = await supabase.from('wallet_transactions').insert({
    tenant_id: tenantId,
    amount: amountUGX,
    type: 'TOPUP',
    description: `Wallet top-up via Mobile Money (${phone})`,
    reference_code: reference,
    status: 'pending',
    idempotency_key: idempotencyKey,
    product: 'sms',
    created_by: user.id,
  });

  if (txError) {
    console.error('[topUpWallet] DB insert error:', txError);
    return { error: 'Could not start top-up. Please try again.' };
  }

  // 5. Call LivePay to initiate Mobile Money collection
  const callbackUrl = `${process.env.APP_URL}/api/billing/topup`;

  let livePayOk = false;
  try {
    const res = await fetch('https://payments.livepayug.com/api/v1/collections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LIVEPAY_API_KEY}`,
      },
      body: JSON.stringify({
        account_no: process.env.LIVEPAY_ACCOUNT_NO,
        amount: amountUGX,
        phone_number: phone,
        reference: reference,
        narrative: 'ChurchOS SMS Wallet Top-up',
        callback_url: callbackUrl,
      }),
    });

    livePayOk = res.ok;

    if (!res.ok) {
      const errBody = await res.text();
      console.error('[topUpWallet] LivePay error:', res.status, errBody);
    }
  } catch (err) {
    console.error('[topUpWallet] LivePay fetch failed:', err);
  }

  // 6. If LivePay rejected, mark transaction failed and bail
  if (!livePayOk) {
    await supabase
      .from('wallet_transactions')
      .update({ status: 'failed' })
      .eq('reference_code', reference);

    return {
      error:
        'Payment gateway error. Check your LIVEPAY_API_KEY / LIVEPAY_ACCOUNT_NO in .env, or try again.',
    };
  }

  // 7. Revalidate so the wallet balance UI refreshes after webhook credits it
  revalidatePath(`/${churchSlug}/admin/messages`);

  return {
    success: true,
    reference,
    message: `✅ Check your phone (${phone}) — approve the Mobile Money prompt to complete the top-up.`,
  };
}

/**
 * Fetch the current wallet balance for a tenant.
 */
export async function getWalletBalance(tenantId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('wallets')
    .select('balance, sms_rate, last_updated')
    .eq('tenant_id', tenantId)
    .single();

  if (error) return null;
  return data;
}
