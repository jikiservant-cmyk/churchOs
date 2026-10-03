'use server';

import { randomUUID } from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { getCurrentTenantAdmin } from '@/lib/auth/tenant';
import { rateLimit } from '@/lib/security';
import { audit } from '@/lib/audit';
import { normalizeUgPhone } from './utils';

const MIN_TOPUP_UGX = 2_000;
const MAX_TOPUP_UGX = 5_000_000;

/** Najiki wants the local 0XXXXXXXXX form. Input is already validated E.164 (+256…). */
function toLocalFormat(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  return digits.startsWith('256') ? `0${digits.slice(3)}` : digits;
}

/**
 * Starts a mobile-money top-up for the CALLER'S church.
 *
 * The tenant is derived from the signed-in admin's profile; a `churchId` in the
 * form is ignored. (The old action trusted it, so anyone could create payments
 * attributed to any church.) Crediting happens only in the signed webhook.
 *
 * NOTE: the previous `topUpWallet` (free money, no auth) and `emptyWallet`
 * actions were removed. Nothing in the UI used them.
 */
export async function initiateNajikiPayment(formData: FormData) {
  try {
    const admin = await getCurrentTenantAdmin();
    if (!admin) return { error: 'Please sign in as a church admin to top up.' };
    const tenantId = admin.churchId;

    const amount = Number(formData.get('amount'));
    if (!Number.isInteger(amount) || amount < MIN_TOPUP_UGX || amount > MAX_TOPUP_UGX) {
      return { error: `Amount must be between ${MIN_TOPUP_UGX.toLocaleString()} and ${MAX_TOPUP_UGX.toLocaleString()} UGX.` };
    }
    const phone = normalizeUgPhone(String(formData.get('phoneNumber') ?? ''));
    if (!phone) return { error: 'Please enter a valid Ugandan mobile number.' };

    if (!(await rateLimit(`topup:${tenantId}`, 5, 10 * 60)) || !(await rateLimit(`topup-user:${admin.user.id}`, 10, 60 * 60))) {
      return { error: 'Too many top-up attempts. Please wait a few minutes.' };
    }

    const apiKey = process.env.NAJIKI_API_KEY;
    const applicationCode = process.env.NAJIKI_APPLICATION_CODE;
    if (!apiKey) {
      console.error('[najiki] NAJIKI_API_KEY is not configured');
      return { error: 'Payment service not configured.' };
    }
    const baseUrl = (process.env.NAJIKI_API_URL || 'https://najiki.netlify.app').replace(/\/$/, '');

    const db = await createAdminClient();
    const { data: tenant, error: tenantError } = await db.from('tenants').select('code').eq('id', tenantId).maybeSingle();
    if (tenantError) {
      console.error('[najiki] tenant lookup failed:', tenantError.code);
      return { error: 'Failed to load church data.' };
    }
    const tenantCode = tenant?.code || process.env.NAJIKI_TENANT_CODE;
    if (!tenantCode) return { error: 'Payment account is not configured for this church.' };

    // Pending transaction first; the webhook credits THIS recorded amount.
    const reference = `CHURCH-${randomUUID()}`;
    const { error: txError } = await db.from('wallet_transactions').insert({
      tenant_id: tenantId,
      amount,
      type: 'TOPUP',
      description: 'Mobile money top-up',
      reference_code: reference,
      status: 'pending',
      product: 'sms',
      revenue_ugx: 0,
      created_by: admin.user.id,
    });
    if (txError) {
      console.error('[najiki] pending tx insert failed:', txError.code, txError.message);
      return { error: 'Could not start the payment. Please try again.' };
    }

    const markFailed = (extra: Record<string, unknown>) =>
      db.from('wallet_transactions').update({ status: 'failed', provider_payload: extra }).eq('reference_code', reference).eq('status', 'pending');

    let response: Response;
    let result: Record<string, any> = {};
    try {
      response = await fetch(`${baseUrl}/api/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          amount,
          phoneNumber: toLocalFormat(phone),
          reference,
          currency: 'UGX',
          description: 'ChurchOS SMS Wallet Top-up',
          externalEntityId: tenantId,
          metadata: { churchId: tenantId, source: 'admin-dashboard' },
          ...(applicationCode ? { applicationCode } : {}),
          tenantCode,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      try { result = JSON.parse(text); } catch { result = { message: 'Invalid response from payment provider' }; }
    } catch (err) {
      console.error('[najiki] request failed:', (err as Error).message);
      await markFailed({ error: 'request_failed' });
      return { error: 'Payment provider unreachable. Please try again.' };
    }

    if (!response.ok) {
      console.error('[najiki] provider returned', response.status);
      await markFailed({ status: response.status, message: String(result.error || result.message || '').slice(0, 200) });
      return { error: 'Payment request failed. Please try again.' };
    }

    if (typeof result.paymentIntentId === 'string') {
      await db
        .from('wallet_transactions')
        .update({ idempotency_key: result.paymentIntentId, provider_payload: { paymentIntentId: result.paymentIntentId, status: result.status ?? null } })
        .eq('reference_code', reference);
    }

    await audit('wallet.topup_initiated', { tenantId, actor: admin.user.id, meta: { amount, reference } });
    return { success: true, message: 'Payment prompt sent to your phone!', paymentIntentId: result.paymentIntentId, reference };
  } catch (err) {
    console.error('[najiki] unexpected error:', (err as Error).message);
    return { error: 'An unexpected error occurred. Please try again.' };
  }
}
