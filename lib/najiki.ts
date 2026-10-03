/**
 * Najiki gateway contract, in one place and free of framework imports so it can
 * be unit-tested (see tests/najiki.test.mjs). Verified against najiki-finance2:
 *
 *   - POST /api/payments        Authorization: Bearer <key>; body validated by
 *                               CreatePaymentRequestSchema (src/lib/schemas.ts)
 *   - POST /api/messaging/send  Bearer auth, `Idempotency-Key` header, 202 queued
 *   - notifications to us       X-Najiki-Signature: t=<ms>,v=HMAC_SHA256(secret, "<ms>.<rawBody>")
 */
import crypto from 'node:crypto';

/** Najiki treats payment types in its PLATFORM_FEE_TYPES list as platform money. */
export const NAJIKI_TOPUP_PAYMENT_TYPE = 'SMS_TOPUP';

/**
 * Najiki's own verifier allows 5 minutes, but when it delivers through QStash
 * the headers are signed once and retried later, so a tight window would reject
 * legitimate retries. Replays are harmless here (`apply_topup` is idempotent and
 * the HMAC covers the body), so we allow a day.
 */
export const NAJIKI_MAX_SKEW_MS = 24 * 60 * 60 * 1000;

export function najikiBaseUrl(raw: string | undefined): string {
  return (raw || 'https://najiki.netlify.app').replace(/\/+$/, '');
}

/** `Authorization: Bearer` is the only auth path /api/payments accepts. */
export function najikiAuthHeaders(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

export interface TopupRequestInput {
  applicationCode: string;
  /** Our wallet_transactions.reference_code. Doubles as Najiki's idempotency key. */
  reference: string;
  tenantId: string;
  amount: number;
  /** Local 0XXXXXXXXX form. */
  phoneNumber: string;
}

/** Body for POST /api/payments. Every required field of Najiki's schema is present. */
export function buildTopupBody(i: TopupRequestInput): Record<string, unknown> {
  return {
    applicationCode: i.applicationCode,
    paymentTypeCode: NAJIKI_TOPUP_PAYMENT_TYPE,
    // Najiki generates its own `reference` and ignores ours, but it echoes
    // `externalEntityId` and `metadata` back in the notification. That is how we
    // find the pending transaction again.
    externalEntityId: i.reference,
    idempotencyKey: i.reference, // Najiki requires >= 8 chars; CHURCH-<uuid> is 43
    amount: i.amount,
    currency: 'UGX',
    phoneNumber: i.phoneNumber,
    description: 'ChurchOS SMS Wallet Top-up',
    // No tenantCode on purpose: SMS_TOPUP is platform money and an unknown tenant is a 404.
    metadata: { churchId: i.tenantId, churchReference: i.reference, source: 'admin-dashboard' },
  };
}

/** Najiki answers `{paymentId, reference, status}`; older code looked for `paymentIntentId`. */
export function parseCreatePaymentResponse(json: unknown): { paymentId: string | null; najikiReference: string | null; status: string | null } {
  const r = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 128) : null);
  return { paymentId: s(r.paymentId) ?? s(r.paymentIntentId), najikiReference: s(r.reference), status: s(r.status) };
}

// ── Notification signature ──────────────────────────────────────────────────

export function parseSignatureHeader(header: string | null | undefined): { t: string; v: string } | null {
  if (!header) return null;
  let t = '';
  let v = '';
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (k === 't') t = val;
    else if (k === 'v') v = val.toLowerCase();
  }
  return /^\d{10,16}$/.test(t) && /^[0-9a-f]{64}$/.test(v) ? { t, v } : null;
}

export function verifyNajikiSignature(input: {
  secrets: string[];
  rawBody: string;
  signatureHeader: string | null | undefined;
  timestampHeader?: string | null;
  now?: number;
  maxSkewMs?: number;
}): boolean {
  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) return false;
  if (input.timestampHeader && input.timestampHeader.trim() !== parsed.t) return false;
  const now = input.now ?? Date.now();
  if (Math.abs(now - Number(parsed.t)) > (input.maxSkewMs ?? NAJIKI_MAX_SKEW_MS)) return false;

  const provided = Buffer.from(parsed.v, 'hex');
  let ok = false;
  for (const secret of input.secrets) {
    if (!secret) continue;
    const expected = crypto.createHmac('sha256', secret).update(`${parsed.t}.${input.rawBody}`).digest();
    if (crypto.timingSafeEqual(expected, provided)) ok = true; // no early exit: constant work per secret
  }
  return ok;
}

// ── Notification payload ────────────────────────────────────────────────────

export type NajikiEvent =
  | { kind: 'payment'; outcome: 'success' | 'failed'; reference: string | null; paymentId: string | null; amount: number | null; currency: string | null; payload: Record<string, unknown> }
  | { kind: 'sms'; outcome: 'delivered' | 'failed'; smsId: string; error: string | null }
  | { kind: 'ignored'; reason: string };

const str = (v: unknown, max = 128) => (typeof v === 'string' && v ? v.slice(0, max) : null);

/**
 * Najiki posts two kinds of notification to the same URL:
 *   payment: {paymentIntentId, reference, status: success|failed|expired|cancelled, amount, currency, externalEntityId, metadata}
 *   sms:     {eventType: 'SMS_DELIVERY_UPDATE', smsId, status: delivered|failed, error?}
 */
export function classifyNajikiPayload(p: Record<string, unknown>): NajikiEvent {
  const status = typeof p.status === 'string' ? p.status.toLowerCase() : '';

  if (p.eventType === 'SMS_DELIVERY_UPDATE') {
    const smsId = str(p.smsId);
    if (!smsId) return { kind: 'ignored', reason: 'sms event without smsId' };
    if (status === 'delivered') return { kind: 'sms', outcome: 'delivered', smsId, error: null };
    if (status === 'failed') return { kind: 'sms', outcome: 'failed', smsId, error: str(p.error, 300) };
    return { kind: 'ignored', reason: `sms status ${status || 'missing'}` };
  }

  const outcome = status === 'success' ? 'success' : ['failed', 'expired', 'cancelled', 'canceled'].includes(status) ? 'failed' : null;
  if (!outcome) return { kind: 'ignored', reason: `payment status ${status || 'missing'}` };

  // Our reference travels back in externalEntityId / metadata.churchReference.
  const meta = p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata) ? (p.metadata as Record<string, unknown>) : {};
  const reference = str(meta.churchReference) ?? str(p.externalEntityId);

  let amount: number | null = null;
  if (p.amount !== undefined && p.amount !== null) {
    const n = Number(p.amount);
    amount = Number.isFinite(n) ? n : Number.NaN;
  }
  return {
    kind: 'payment',
    outcome,
    reference,
    paymentId: str(p.paymentIntentId) ?? str(p.paymentId),
    amount,
    currency: typeof p.currency === 'string' ? p.currency.toUpperCase() : null,
    payload: p,
  };
}
