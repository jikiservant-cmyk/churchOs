import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildTopupBody, parseCreatePaymentResponse, najikiAuthHeaders, parseSignatureHeader, verifyNajikiSignature, classifyNajikiPayload } from '../lib/najiki.ts';

// Verbatim copy of najiki-finance2 src/lib/notification-signature.ts#buildNotificationHeaders
function najikiSign(secret, payloadString, now = Date.now()) {
  const sig = crypto.createHmac('sha256', secret).update(`${now}.${payloadString}`).digest('hex');
  return { 'X-Najiki-Timestamp': String(now), 'X-Najiki-Signature': `t=${now},v=${sig}` };
}

// Mirrors Najiki's CreatePaymentRequestSchema (src/lib/schemas.ts)
function najikiAccepts(b) {
  return typeof b.applicationCode === 'string' && b.applicationCode.length > 0
    && typeof b.paymentTypeCode === 'string' && b.paymentTypeCode.length > 0
    && typeof b.externalEntityId === 'string' && b.externalEntityId.length > 0
    && typeof b.amount === 'number' && b.amount > 0
    && typeof b.phoneNumber === 'string' && b.phoneNumber.length >= 9 && b.phoneNumber.length <= 15
    && typeof b.idempotencyKey === 'string' && b.idempotencyKey.length >= 8;
}

const REF = 'CHURCH-3f1c2b7e-0000-4000-8000-123456789abc';

test('top-up body satisfies every required Najiki field and carries our reference', () => {
  const b = buildTopupBody({ applicationCode: 'church', reference: REF, tenantId: 't-1', amount: 5000, phoneNumber: '0771234567' });
  assert.ok(najikiAccepts(b));
  assert.equal(b.paymentTypeCode, 'SMS_TOPUP');
  assert.equal(b.externalEntityId, REF);
  assert.equal(b.metadata.churchReference, REF);
  assert.equal('tenantCode' in b, false);
  assert.equal(najikiAuthHeaders('k').Authorization, 'Bearer k');
  assert.equal('X-API-Key' in najikiAuthHeaders('k'), false);
});

test('create-payment response: Najiki returns paymentId (not paymentIntentId)', () => {
  assert.deepEqual(parseCreatePaymentResponse({ paymentId: 'p1', reference: 'NJK-1', status: 'processing' }), { paymentId: 'p1', najikiReference: 'NJK-1', status: 'processing' });
  assert.equal(parseCreatePaymentResponse(null).paymentId, null);
});

test('signature: accepts what Najiki produces, with webhook secret or legacy api key', () => {
  const body = JSON.stringify({ status: 'success', amount: 5000 });
  const h = najikiSign('whsec', body);
  const ok = (secrets, hdr = h, raw = body, now) => verifyNajikiSignature({ secrets, rawBody: raw, signatureHeader: hdr['X-Najiki-Signature'], timestampHeader: hdr['X-Najiki-Timestamp'], now });
  assert.equal(ok(['whsec']), true);
  assert.equal(ok(['apikey', 'whsec']), true);
  assert.equal(ok(['wrong']), false);
  assert.equal(ok(['whsec'], h, body + ' '), false, 'body tampering');
  assert.equal(ok(['whsec'], { ...h, 'X-Najiki-Timestamp': '1' }), false, 'timestamp header mismatch');
  assert.equal(ok(['whsec'], h, body, Date.now() + 3 * 24 * 3600e3), false, 'too old');
  assert.equal(ok(['whsec'], najikiSign('whsec', body, Date.now() - 3600e3)), true, 'hour-old QStash retry still ok');
});

test('signature: the old plain-HMAC form and junk are rejected', () => {
  const body = '{"a":1}';
  const plain = crypto.createHmac('sha256', 's').update(body).digest('hex');
  for (const hdr of [plain, `sha256=${plain}`, '', null, 't=abc,v=zz', `t=${Date.now()},v=${plain.slice(2)}`]) {
    assert.equal(verifyNajikiSignature({ secrets: ['s'], rawBody: body, signatureHeader: hdr }), false);
  }
  assert.equal(parseSignatureHeader(`t=1700000000000,v=${plain}`).t, '1700000000000');
  assert.equal(verifyNajikiSignature({ secrets: [''], rawBody: body, signatureHeader: najikiSign('', body)['X-Najiki-Signature'] }), false);
});

test('payment notification: matches on our reference via externalEntityId / metadata, UGX amount', () => {
  // shape from najiki payments.ts notification payload
  const e = classifyNajikiPayload({ paymentIntentId: 'pi_1', reference: 'NJK-777', status: 'success', amount: 5000, currency: 'UGX', providerPaymentId: 'x', failureReason: null, externalEntityId: REF, metadata: { churchReference: REF } });
  assert.equal(e.kind, 'payment'); assert.equal(e.outcome, 'success');
  assert.equal(e.reference, REF); assert.equal(e.paymentId, 'pi_1'); assert.equal(e.amount, 5000); assert.equal(e.currency, 'UGX');
  assert.equal(classifyNajikiPayload({ status: 'success', externalEntityId: REF }).reference, REF);
  assert.equal(classifyNajikiPayload({ status: 'success', reference: 'NJK-777' }).reference, null, "Najiki's own reference is never ours");
});

test('payment statuses: expired/cancelled/failed all fail; unknown ignored; bad amount is NaN', () => {
  for (const s of ['failed', 'expired', 'cancelled', 'EXPIRED']) assert.equal(classifyNajikiPayload({ status: s, externalEntityId: REF }).outcome, 'failed');
  assert.equal(classifyNajikiPayload({ status: 'processing' }).kind, 'ignored');
  assert.ok(Number.isNaN(classifyNajikiPayload({ status: 'success', amount: 'abc', externalEntityId: REF }).amount));
});

test('sms delivery notification shapes (sms-queue.ts)', () => {
  assert.deepEqual(classifyNajikiPayload({ eventType: 'SMS_DELIVERY_UPDATE', smsId: 's1', reference: 'r', status: 'delivered', providerId: 'p', recipient: '+256', applicationCode: 'church' }), { kind: 'sms', outcome: 'delivered', smsId: 's1', error: null });
  const f = classifyNajikiPayload({ eventType: 'SMS_DELIVERY_UPDATE', smsId: 's2', status: 'failed', error: 'boom' });
  assert.equal(f.kind, 'sms'); assert.equal(f.outcome, 'failed'); assert.equal(f.error, 'boom');
  assert.equal(classifyNajikiPayload({ eventType: 'SMS_DELIVERY_UPDATE', status: 'failed' }).kind, 'ignored');
  // an SMS failure must never be mistaken for a top-up failure
  assert.notEqual(classifyNajikiPayload({ eventType: 'SMS_DELIVERY_UPDATE', smsId: 's', status: 'failed', reference: REF }).kind, 'payment');
});
