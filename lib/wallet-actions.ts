'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function topUpWallet(formData: FormData) {
  try {
    const churchId = formData.get('churchId') as string;
    const amount = parseInt(formData.get('amount') as string, 10) || 10000;

    if (!churchId) {
      console.error('TopUp Error: Missing churchId in top up action.');
      return;
    }

    const supabase = await createClient();

    // Fetch current balance
    const { data: currentWallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('tenant_id', churchId)
      .maybeSingle();

    const currentBalance = currentWallet?.balance || 0;

    // Use standard upsert instead of update since the wallet might not exist yet
    const { error } = await supabase
      .from('wallets')
      .upsert({ 
        tenant_id: churchId,
        balance: currentBalance + amount,
        app_type: 'church',
        last_updated: new Date().toISOString()
      }, { onConflict: 'tenant_id' });

    if (error) {
      console.error('Failed to top up wallet:', error);
      return;
    } else {
      // Record a transaction as well to maintain history
      const { error: txError } = await supabase.from('wallet_transactions').insert({
        tenant_id: churchId,
        amount: amount,
        type: 'TOPUP',
        description: 'Test Top-up via Admin Dashboard',
        reference_code: 'TOPUP_TEST_' + Date.now(),
        status: 'success',
        product: 'sms',
        revenue_ugx: 0
      });
      if (txError) {
         console.error('Failed to record top up transaction:', txError);
      }
    }
  } catch (err: any) {
    console.error('Unhandled exception in topUpWallet:', err);
    throw err;
  }

  // Reload the current admin page to show updated balance
  revalidatePath('/', 'layout');
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
      last_updated: new Date().toISOString()
    })
    .eq('tenant_id', churchId);

  if (error) {
    console.error('Failed to empty wallet:', error);
    return;
  }

  revalidatePath('/', 'layout');
}
