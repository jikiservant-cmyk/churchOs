'use server';

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function initiateRelworxPayment(formData: FormData) {
  try {
    const churchId = formData.get('churchId') as string;
    const amount = parseInt(formData.get('amount') as string, 10) || 5000;
    const phoneNumber = formData.get('phoneNumber') as string;

    if (!churchId || !phoneNumber) {
      return { error: 'Missing required fields' };
    }

    const apiKey = process.env.RELWORX_API_KEY;
    const accountNo = process.env.RELWORX_ACCOUNT_NO;

    if (!apiKey || !accountNo) {
      console.error('[Relworx] API credentials missing');
      return { error: 'Payment service not configured' };
    }

    // 1. Create a pending transaction in our DB first
    const supabase = await createAdminClient();
    const referenceCode = `REL_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const { error: txError } = await supabase.from('wallet_transactions').insert({
      tenant_id: churchId,
      amount: amount,
      type: 'TOPUP',
      description: `Relworx Top-up for ${phoneNumber}`,
      reference_code: referenceCode,
      status: 'pending',
      product: 'sms',
      revenue_ugx: 0,
      created_by: 'system',
    });

    if (txError) {
      console.error('[Relworx] Failed to create pending transaction:', txError);
      return {
        error: `Database error: ${txError.message} (${txError.code})`,
        details: txError,
      };
    }

    // 2. Call Relworx API
    const response = await fetch('https://payments.relworx.com/api/mobile_money/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.relworx.v2',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        account_no: accountNo,
        msisdn: phoneNumber,
        amount: amount,
        currency: 'UGX',
        customer_reference: referenceCode,
        description: 'ChurchOS Wallet Top-up',
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[Relworx] API Error:', result);
      await supabase
        .from('wallet_transactions')
        .update({ status: 'failed' })
        .eq('reference_code', referenceCode);

      return { error: result.message || 'Payment request failed' };
    }

    // 3. Update transaction with Relworx internal reference
    await supabase
      .from('wallet_transactions')
      .update({ idempotency_key: result.internal_reference })
      .eq('reference_code', referenceCode);

    return { success: true, message: 'Payment prompt sent to your phone!' };
  } catch (err: any) {
    console.error('[Relworx] Unexpected error:', err);
    return { error: 'An unexpected error occurred' };
  }
}

export async function topUpWallet(formData: FormData): Promise<{ error?: string; success?: boolean; newBalance?: number }> {
  try {
    const churchId = formData.get('churchId') as string;
    const amount = parseInt(formData.get('amount') as string, 10) || 10000;

    if (!churchId) {
      console.error('TopUp Error: Missing churchId in top up action.');
      return { error: 'Missing churchId' };
    }

    const supabase = await createClient();
    const adminSupabase = await createAdminClient();

    // Atomic increment via RPC — avoids read-then-write race condition.
    // The RPC now returns the new balance as NUMERIC so we can log and confirm it.
    const { data: newBalance, error } = await adminSupabase.rpc('increment_wallet_balance', {
      p_tenant_id: churchId,
      p_amount: amount,
      p_app_type: 'church',
    });

    if (error) {
      console.error('Failed to top up wallet:', error);
      return { error: error.message };
    }

    console.log(`[Wallet] Top-up successful. New balance: ${newBalance}`);

    // Record a transaction to maintain history
    const { data: { user } } = await supabase.auth.getUser();

    const { error: txError } = await adminSupabase.from('wallet_transactions').insert({
      tenant_id: churchId,
      amount: amount,
      type: 'TOPUP',
      description: 'Test Top-up via Admin Dashboard',
      reference_code: 'TOPUP_TEST_' + Date.now(),
      status: 'success',
      product: 'sms',
      revenue_ugx: 0,
      created_by: user?.id || 'system',
    });

    if (txError) {
      console.error('Failed to record top up transaction:', JSON.stringify(txError, null, 2));
    }
  } catch (err: any) {
    console.error('Unhandled exception in topUpWallet:', err);
    return { error: err.message || 'An unexpected error occurred' };
  }

  revalidatePath('/', 'layout');
  return { success: true };
}

export async function emptyWallet(formData: FormData) {
  const churchId = formData.get('churchId') as string;

  if (!churchId) {
    return;
  }

  const supabase = await createClient();

  const { error } = await supabase
    .from('wallets')
    .update({
      balance: 0,
      last_updated: new Date().toISOString(),
    })
    .eq('tenant_id', churchId);

  if (error) {
    console.error('Failed to empty wallet:', error);
    return;
  }

  revalidatePath('/', 'layout');
}
