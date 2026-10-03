/**
 * Single-SMS delivery with atomic billing.
 *
 * NOT a 'use server' module: callers (API routes, the queue worker) must have
 * authorised the tenant BEFORE calling. All DB writes use the service-role
 * client, so never pass an untrusted `churchId`.
 *
 * Billing flow (fixes "send first, charge a stale balance later"):
 *   1. log row (PENDING)           — reused if a previous attempt FAILED
 *   2. debit_wallet(...)           — atomic, balance check inside the UPDATE
 *   3. provider call               — Najiki, then Africa's Talking
 *   4. on any failure              — refund_wallet(...) and mark log FAILED
 */
import { randomUUID } from 'crypto';
import { normalizeUgPhone } from '@/lib/utils';
import { createAdminClient } from '@/lib/supabase/server';
import { maskPhone } from '@/lib/security';

export interface SendSMSParams {
  phoneNumber: string;
  message: string;
  churchId: string;
  idempotencyKey?: string;
  senderId?: string;
}

export interface SendSMSResult {
  success: boolean;
  messageId?: string | null;
  status?: string | null;
  error?: string;
}

const PROVIDER_TIMEOUT_MS = 15_000;
const SUCCESS_STATUSES = new Set(['success', 'sent', 'queued', 'buffered']);
export const MAX_SMS_LENGTH = 480;

export class InsufficientBalanceError extends Error {
  constructor() {
    super('Insufficient SMS balance');
    this.name = 'InsufficientBalanceError';
  }
}

async function sendNajikiSMS(to: string, message: string) {
  const url = process.env.NAJIKI_API_URL;
  const key = process.env.NAJIKI_API_KEY;
  const app = process.env.NAJIKI_APPLICATION_CODE;
  if (!url || !key || !app) throw new Error('Najiki is not configured');

  const res = await fetch(`${url.replace(/\/$/, '')}/api/messaging/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, message, applicationCode: app }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Najiki API error: ${res.status}`);
  const json = (await res.json()) as { smsId?: string; status?: string };
  return { messageId: json.smsId ?? null, status: json.status ?? 'queued' };
}

/** Africa's Talking REST API (the SDK was dropped: it pulled in vulnerable transitive deps). */
async function sendAfricasTalkingSMS(to: string, message: string, senderId?: string) {
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;
  if (!apiKey || !username) throw new Error('Africa\'s Talking is not configured');

  const endpoint =
    username.toLowerCase() === 'sandbox'
      ? 'https://api.sandbox.africastalking.com/version1/messaging'
      : 'https://api.africastalking.com/version1/messaging';

  const call = async (from?: string) => {
    const body = new URLSearchParams({ username, to, message });
    if (from) body.set('from', from);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Africa's Talking API error: ${res.status}`);
    return (await res.json()) as {
      SMSMessageData?: { Message?: string; Recipients?: { status: string; messageId?: string }[] };
    };
  };

  let data = await call(senderId);
  let recipients = data.SMSMessageData?.Recipients ?? [];
  if (recipients.length === 0 && senderId && /InvalidSenderId/i.test(data.SMSMessageData?.Message ?? '')) {
    data = await call(undefined);
    recipients = data.SMSMessageData?.Recipients ?? [];
  }
  if (recipients.length === 0) throw new Error(`Africa's Talking rejected the message: ${data.SMSMessageData?.Message ?? 'no recipients'}`);

  const r = recipients[0];
  return { messageId: r.messageId ?? null, status: r.status, ok: SUCCESS_STATUSES.has(String(r.status).toLowerCase()) };
}

export async function sendSingleSMS(params: SendSMSParams): Promise<SendSMSResult> {
  const { churchId, senderId } = params;
  const phone = normalizeUgPhone(params.phoneNumber);
  if (!phone) throw new Error('Invalid phone number format');
  const message = params.message?.trim();
  if (!message || message.length > MAX_SMS_LENGTH) throw new Error(`Message must be 1–${MAX_SMS_LENGTH} characters`);

  const admin = await createAdminClient();
  const logs = () => admin.schema('church').from('sms_logs');
  const idemKey = params.idempotencyKey || `sms_${randomUUID()}`;

  // ── 1. Log row (idempotent; reuse FAILED rows so retries work) ────────────
  let logId: string;
  const { data: inserted, error: insertErr } = await logs()
    .insert({ tenant_id: churchId, recipient_phone: phone, body: message, status: 'PENDING', idempotency_key: idemKey, sender_id: senderId || null })
    .select('id')
    .single();

  if (inserted) {
    logId = inserted.id;
  } else if (insertErr?.code === '23505') {
    const { data: existing } = await logs().select('id, status, tenant_id, provider_message_id, message_provider_status').eq('idempotency_key', idemKey).maybeSingle();
    if (!existing || existing.tenant_id !== churchId) throw new Error('Idempotency key conflict');
    if (SUCCESS_STATUSES.has(String(existing.status).toLowerCase())) {
      return { success: true, messageId: existing.provider_message_id, status: existing.message_provider_status }; // replay: never send twice
    }
    if (existing.status === 'PENDING') throw new Error('SMS is already being processed');
    // FAILED → retry on the same row. Compare-and-set so only one retry wins.
    const { data: claimed } = await logs().update({ status: 'PENDING', error_message: null, updated_at: new Date().toISOString() }).eq('id', existing.id).eq('status', existing.status).select('id');
    if (!claimed?.length) throw new Error('SMS is already being processed');
    logId = existing.id;
  } else {
    console.error('[sms] log insert failed:', insertErr?.code, insertErr?.message);
    throw new Error('Could not record SMS');
  }

  const fail = async (reason: string) => {
    await logs().update({ status: 'FAILED', error_message: reason.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', logId);
  };

  // ── 2. Atomic debit (fresh key per attempt so a retry after refund pays again)
  const { data: wallet } = await admin.from('wallets').select('sms_rate').eq('tenant_id', churchId).maybeSingle();
  if (!wallet || !(wallet.sms_rate > 0)) {
    await fail('No billing account');
    throw new Error('Billing account not found');
  }
  const debitKey = `sms:${logId}:${randomUUID().slice(0, 8)}`;
  const { data: debited, error: debitErr } = await admin.rpc('debit_wallet', {
    p_tenant_id: churchId,
    p_amount: wallet.sms_rate,
    p_idempotency_key: debitKey,
    p_description: `SMS to ${maskPhone(phone)}`,
    p_reference_id: logId,
  });
  if (debitErr) {
    console.error('[sms] debit error:', debitErr.code, debitErr.message);
    await fail('Billing error');
    throw new Error('Billing error');
  }
  if (!debited) {
    await fail('Insufficient balance');
    throw new InsufficientBalanceError();
  }

  // ── 3. Provider (Najiki → Africa's Talking) ───────────────────────────────
  let outcome: { messageId: string | null; status: string; ok: boolean } | null = null;
  let providerError = 'Provider unavailable';
  try {
    const r = await sendNajikiSMS(phone, message);
    outcome = { ...r, ok: true };
  } catch (najikiErr) {
    providerError = (najikiErr as Error).message;
    try {
      outcome = await sendAfricasTalkingSMS(phone, message, senderId);
      if (!outcome.ok) providerError = `Provider status: ${outcome.status}`;
    } catch (atErr) {
      providerError = (atErr as Error).message;
    }
  }

  // ── 4. Settle ─────────────────────────────────────────────────────────────
  if (!outcome || !outcome.ok) {
    await admin.rpc('refund_wallet', { p_tenant_id: churchId, p_original_key: debitKey });
    await fail(providerError);
    return { success: false, error: 'SMS delivery failed' };
  }

  const { error: finalizeErr } = await logs()
    .update({ status: 'Queued', message_provider_status: outcome.status, provider_message_id: outcome.messageId, error_message: null, updated_at: new Date().toISOString() })
    .eq('id', logId);
  // The message is already sent and paid for; do not throw (a retry would double-send).
  if (finalizeErr) console.error('[sms] could not finalise log:', finalizeErr.code, finalizeErr.message);

  return { success: true, messageId: outcome.messageId, status: outcome.status };
}
