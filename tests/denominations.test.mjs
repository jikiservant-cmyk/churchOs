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

import { churchStatus, sortChurches } from '../lib/denominations.ts';

test('churchStatus: 30-day activity window', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  assert.equal(churchStatus('2026-09-20T00:00:00Z', now), 'active');
  assert.equal(churchStatus('2026-08-01T00:00:00Z', now), 'inactive');
  assert.equal(churchStatus(null, now), 'never');
  assert.equal(churchStatus('garbage', now), 'never');
});

test('sortChurches: attendance desc, then name; input not mutated', () => {
  const rows = [{ church_name: 'B', attendance_30d: 5 }, { church_name: 'A', attendance_30d: 5 }, { church_name: 'C', attendance_30d: 9 }, { church_name: 'D', attendance_30d: null }];
  const out = sortChurches(rows);
  assert.deepEqual(out.map((r) => r.church_name), ['C', 'A', 'B', 'D']);
  assert.equal(rows[0].church_name, 'B');
});
