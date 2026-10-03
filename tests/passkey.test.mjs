import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePasskey, hashPasskey, verifyPasskey, normalizePasskeyInput, PASSKEY_LENGTH } from '../lib/passkey.ts';

test('generatePasskey: right length, unambiguous alphabet, not constant', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = generatePasskey();
    assert.equal(p.length, PASSKEY_LENGTH);
    assert.match(p, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
    seen.add(p);
  }
  assert.ok(seen.size > 190, 'passkeys should not repeat');
});

test('hash/verify round trip; wrong passkey and malformed hashes fail', async () => {
  const h = await hashPasskey('ABCD2345');
  assert.ok(!h.includes('ABCD2345'));
  assert.equal(await verifyPasskey('ABCD2345', h), true);
  assert.equal(await verifyPasskey('ABCD2346', h), false);
  assert.equal(await verifyPasskey('ABCD2345', null), false);
  assert.equal(await verifyPasskey('ABCD2345', 'plaintext'), false);
  assert.equal(await verifyPasskey('ABCD2345', 'scrypt$1$2$3$x'), false);
});

test('two hashes of the same passkey differ (random salt)', async () => {
  assert.notEqual(await hashPasskey('ABCD2345'), await hashPasskey('ABCD2345'));
});

test('normalizePasskeyInput', () => {
  assert.equal(normalizePasskeyInput(' abcd-2345 '), 'ABCD2345');
  assert.equal(normalizePasskeyInput('abc'), null);
  assert.equal(normalizePasskeyInput(1234), null);
  assert.equal(normalizePasskeyInput('A'.repeat(40)), null);
});
