import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function POST(req: Request) {
  try {
    // 0. Security: Verify the webhook secret from LivePay
    const signature = req.headers.get('x-livepay-signature');
    const webhookSecret = process.env.LIVEPAY_WEBHOOK_SECRET;

    if (!webhookSecret || !signature) {
      console.warn('[LivePay Webhook] Unauthorized attempt detected: Missing signature or secret');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // TODO: Implement actual signature verification logic if LivePay provides a library/spec
    // For now, we'll log it and proceed with the payload processing
    
    const payload = await req.json();
    console.log('[LivePay Webhook] Received payload:', JSON.stringify(payload));

    const { status, reference, transaction_id, amount, metadata } = payload;

    if (!reference || !transaction_id) {
      return NextResponse.json({ error: 'Missing references' }, { status: 400 });
    }

    const supabase = await createAdminClient();

    // 1. Find the pending transaction using reference_code
    const { data: transaction, error: findError } = await supabase
      .from('wallet_transactions')
      .select('*')
      .eq('reference_code', reference)
      .maybeSingle();

    if (findError || !transaction) {
      console.error('[LivePay Webhook] Transaction not found:', reference);
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    // 2. Handle Success
    if (status === 'success' || status === 'completed') {
      // Check if transaction is already processed to avoid double-crediting
      if (transaction.status === 'success') {
        return NextResponse.json({ success: true, message: 'Already processed' });
      }

      // Update transaction status and store LivePay transaction ID as idempotency key
      const { error: updateTxError } = await supabase
        .from('wallet_transactions')
        .update({ 
          status: 'success',
          idempotency_key: transaction_id, // LivePay ID as idempotency key
          provider_payload: payload
        })
        .eq('reference_code', reference);

      if (updateTxError) {
        console.error('[LivePay Webhook] Failed to update transaction status:', updateTxError);
        return NextResponse.json({ error: 'Database update failed' }, { status: 500 });
      }

      // Increment wallet balance using RPC
      const { error: rpcError } = await supabase.rpc('increment_wallet_balance', {
        p_tenant_id: transaction.tenant_id,
        p_amount: Math.floor(amount)
      });

      if (rpcError) {
        console.error('[LivePay Webhook] Failed to increment balance:', rpcError);
        // This is critical, might need manual reconciliation
      }

      // If this was a donation, record it in the church.donations table
      if (transaction.product === 'donation') {
        const category = transaction.provider_payload?.category || 'General';
        const { error: donationError } = await supabase
          .schema('church')
          .from('donations')
          .insert({
            church_id: transaction.tenant_id,
            category: category,
            amount_cents: transaction.amount, // Standardizing on amount in cents/units
          });

        if (donationError) {
          console.error('[LivePay Webhook] Failed to record donation:', donationError);
        }
      }

      revalidatePath('/', 'layout');
    } 
    // 3. Handle Failure
    else if (status === 'failed' || status === 'cancelled') {
      await supabase
        .from('wallet_transactions')
        .update({ 
          status: 'failed',
          provider_payload: payload 
        })
        .eq('reference_code', reference);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[LivePay Webhook] Error processing webhook:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
