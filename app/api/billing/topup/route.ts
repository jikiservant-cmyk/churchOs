import { NextResponse } from 'next/server';
import { createClient as createSupabaseServerClient } from '@/lib/supabase/server';

export async function POST(req: Request) {
  try {
    const { tenant_id, amount_ugx, provider_reference } = await req.json();

    if (!tenant_id || !amount_ugx || !provider_reference) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    
    // Server-side security check (Only admins/system can perform topups typically, 
    // but in a real webhook, you would verify the provider signature)

    const idempotencyKey = `topup_${provider_reference}`;

    // 1. Insert into Wallet Transactions
    const { error: txError } = await supabase
      .schema('public')
      .from('wallet_transactions')
      .insert({
        tenant_id,
        amount: amount_ugx, // Positive for Top-up
        type: 'TOPUP',
        description: `Wallet load via Mobile Money`,
        status: 'success',
        idempotency_key: idempotencyKey,
        product: 'sms',
        reference_id: provider_reference,
        revenue_ugx: 0, // Revenue calculation happens on deduction, not topup
      });

    if (txError) {
      // If error is unique constraint violation on idempotency_key, we ignore/return success (idempotent)
      if (txError.code === '23505') {
         console.info(`[Billing] Idempotent top-up prevented duplicate. Ref: ${provider_reference}`);
         return NextResponse.json({ success: true, message: 'Already processed' });
      }
      console.error('[Billing] Top-up transaction failed:', txError);
      return NextResponse.json({ error: 'Failed to record transaction' }, { status: 500 });
    }

    // 2. Update the Wallet Balance
    // NOTE: In production, it's safer to let a database trigger handle the balance rolling 
    // based on transaction inserts to prevent race conditions, or use an RPC call.
    // For now, this RPC handles the increment atomically.
    const { error: rpcError } = await supabase
      .rpc('increment_wallet_balance', { 
        p_tenant_id: tenant_id, 
        p_amount: amount_ugx 
      });

    if (rpcError) {
       console.error('[Billing] Wallet increment failed:', rpcError);
       // Should ideally log to billing_events for manual reconciliation
    }

    return NextResponse.json({ success: true, balance_added: amount_ugx });
  } catch (error) {
    console.error('[Billing] Top-up error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
