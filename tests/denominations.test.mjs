import test from 'node:test';
import assert from 'node:assert/strict';
import { INVITE_RE, firstRow, denominationsEnabled, APP_RESERVED_SLUGS } from '../lib/denominations.ts';

test('invite codes: safe charset only', () => {
  for (const ok of ['ABCD1234', 'grace-fellowship_01']) assert.match(ok, INVITE_RE);
  for (const bad of ['', 'abc', 'a b c d', "x'; drop table--", 'x'.repeat(65), '<script>']) assert.doesNotMatch(bad, INVITE_RE);
});

test('firstRow handles table-returning RPC shapes', () => {
  assert.deepEqual(firstRow([{ account_type: 'pastor' }]), { account_type: 'pastor' });
  assert.equal(firstRow([]), null);
  assert.equal(firstRow(null), null);
  assert.deepEqual(firstRow({ a: 1 }), { a: 1 });
});

test('feature flag is off unless exactly "true"; overseer slug is reserved', () => {
  const prev = process.env.DENOMINATIONS_ENABLED;
  delete process.env.DENOMINATIONS_ENABLED; assert.equal(denominationsEnabled(), false);
  process.env.DENOMINATIONS_ENABLED = '1'; assert.equal(denominationsEnabled(), false);
  process.env.DENOMINATIONS_ENABLED = 'true'; assert.equal(denominationsEnabled(), true);
  if (prev === undefined) delete process.env.DENOMINATIONS_ENABLED; else process.env.DENOMINATIONS_ENABLED = prev;
  assert.ok(APP_RESERVED_SLUGS.has('overseer'));
});
