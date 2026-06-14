import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { createHmac, timingSafeEqual } from 'crypto';

// ---------------------------------------------------------------------------
// Signature verification — LivePay's scheme (per their docs):
//   Header:  X-Webhook-Signature: t=<timestamp>,v=<hex-digest>
//   String:  webhookUrl + timestamp + status + customer_reference + internal_reference
// ---------------------------------------------------------------------------
function verifySignature(
  webhookUrl: string,
  timestamp: string,
  status: string,
  customerReference: string,
  internalReference: string,
  receivedSignature: string,
  secret: string,
): boolean {
  try {
    const stringToSign =
      webhookUrl + timestamp + status + customerReference + internalReference;

    const expected = createHmac('sha256', secret)
      .update(stringToSign, 'utf8')
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(receivedSignature, 'hex');

    if (expectedBuf.length !== receivedBuf.length) return false;
    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  try {
    // ── 0. Security: Verify HMAC signature ──────────────────────────────────
    const signatureHeader = req.headers.get('x-webhook-signature');
    const webhookSecret = process.env.LIVEPAY_WEBHOOK_SECRET;

    if (!webhookSecret || !signatureHeader) {
      console.warn('[LivePay Webhook] Unauthorized: missing signature or secret');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Header format: "t=<timestamp>,v=<hex>"
    const [timestampPart, signaturePart] = signatureHeader.split(',');
    const timestamp = timestampPart?.split('=')[1];
    const receivedSignature = signaturePart?.split('=')[1];

    if (!timestamp || !receivedSignature) {
      console.warn('[LivePay Webhook] Unauthorized: malformed signature header');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Reject stale AND future-dated timestamps
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(timestamp);
    if (ageSeconds < -60 || ageSeconds > 300) {
      console.warn('[LivePay Webhook] Unauthorized: timestamp out of range, age:', ageSeconds, 's');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse body first — signature string requires payload fields
    const rawBody = await req.text();
    const payload = JSON.parse(rawBody);
    console.log('[LivePay Webhook] Received payload:', JSON.stringify(payload));

    const { status, customer_reference, internal_reference, metadata } = payload;

    if (!customer_reference || !internal_reference) {
      return NextResponse.json({ error: 'Missing references' }, { status: 400 });
    }

    // NOTE: log req.url in sandbox and verify it exactly matches the URL
    // configured in your LivePay dashboard (www, trailing slash, http vs https).
    const webhookUrl = req.url;

    if (
      !verifySignature(
        webhookUrl,
        timestamp,
        status,
        customer_reference,
        internal_reference,
        receivedSignature,
        webhookSecret,
      )
    ) {
      console.warn('[LivePay Webhook] Unauthorized: signature mismatch');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = await createAdminClient();

    // ── 1. Handle Success ────────────────────────────────────────────────────
    if (status === 'Success') {
      // Single RPC call — idempotency check, status update, and wallet credit
      // all happen inside one Postgres transaction (see migration.sql).
      // Either all three succeed together or none of them do.
      const { data, error: rpcError } = await supabase.rpc('process_livepay_success', {
        p_customer_reference: customer_reference,
        p_internal_reference: internal_reference,
        p_provider_payload:   payload,
      });

      if (rpcError) {
        console.error('[LivePay Webhook] RPC failed:', rpcError);
        // Return 500 so LivePay retries. The RPC's FOR UPDATE lock and
        // idempotency_key check make retries safe.
        return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
      }

      if (!data.ok) {
        console.error('[LivePay Webhook] Transaction not found:', customer_reference);
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }

      if (data.reason === 'already_processed') {
        console.log('[LivePay Webhook] Already processed, skipping:', customer_reference);
        return NextResponse.json({ success: true, message: 'Already processed' });
      }

      // ── 1a. Record donation if applicable ─────────────────────────────────
      // Intentionally outside the RPC transaction: non-fatal and reconcilable.
      // The wallet is already credited at this point regardless of what happens here.
      if (data.product === 'donation') {
        const category =
          metadata?.category ||  // preferred: from webhook metadata
          payload.category ||    // fallback: top-level payload field
          'General';             // final default

        const { error: donationError } = await supabase
          .schema('church')
          .from('donations')
          .insert({
            church_id:    data.tenant_id,
            category,
            amount_cents: data.amount,
          });

        if (donationError) {
          console.error('[LivePay Webhook] Failed to record donation (non-fatal):', donationError);
        }
      }

      revalidatePath('/', 'layout');
    }

    // ── 2. Handle Failure ────────────────────────────────────────────────────
    else if (status === 'Failed') {
      const { error: updateError } = await supabase
        .from('wallet_transactions')
        .update({
          status:           'failed',
          provider_payload: payload,
        })
        .eq('reference_code', customer_reference);

      if (updateError) {
        console.error('[LivePay Webhook] Failed to mark transaction as failed:', updateError);
        return NextResponse.json({ error: 'Database update failed' }, { status: 500 });
      }
    }

    // ── 3. Unknown status — log and acknowledge ──────────────────────────────
    else {
      console.warn(
        '[LivePay Webhook] Unknown status:', status,
        'for reference:', customer_reference,
      );
      // Return 200 to prevent LivePay retrying indefinitely for unknown statuses
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[LivePay Webhook] Unhandled error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
