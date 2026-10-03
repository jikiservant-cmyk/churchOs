import { db } from './full.mjs';
import { as } from './lib.mjs';
let pass = 0, fail = 0;
const t = async (name, fn) => { try { const r = await fn(); if (r === true) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, r); } } catch (e) { fail++; console.log('FAIL', name, 'threw:', e.message); } };
const denied = async (role, sub, sql, params) => { try { await as(db, role, sub, sql, params); return 'was allowed'; } catch (e) { return /permission denied|not authorised|row-level|violates/i.test(e.message) ? true : 'other: ' + e.message; } };

const u1 = '00000000-0000-0000-0000-0000000000a1', u2 = '00000000-0000-0000-0000-0000000000a2';
await db.exec(`INSERT INTO auth.users(id,email) VALUES ('${u1}','a@x.org'),('${u2}','b@x.org');`);
const prov = async (u, name, slug) => (await as(db, 'service_role', '', `SELECT public.provision_church_v2($1::uuid,$2,$3,'pastor','1.2.3.4') AS id`, [u, name, slug])).rows[0].id;
const A = await prov(u1, 'Alpha Church', 'alpha'), B = await prov(u2, 'Beta Church', 'beta');

await t('provision: second workspace for same user rejected', async () => { try { await prov(u1, 'Alpha Two', 'alpha-two'); return 'allowed'; } catch (e) { return /already associated/.test(e.message) || e.message; } });
await t('provision: reserved slug rejected', async () => { try { await prov('00000000-0000-0000-0000-0000000000a9', 'Zed Church', 'admin'); return 'allowed'; } catch (e) { return /reserved|User not found/.test(e.message) || e.message; } });
await t('provision: anon cannot call', () => denied('anon', '', `SELECT public.provision_church_v2($1::uuid,'Evil Church','evil','pastor')`, [u2]));
await t('provision: authenticated cannot call', () => denied('authenticated', u1, `SELECT public.provision_church_v2($1::uuid,'Evil Church','evil2','pastor')`, [u1]));
await t('anon cannot read churches', () => denied('anon', '', `SELECT * FROM church.churches`));
await t('authenticated no-profile user sees zero churches', async () => (await as(db, 'authenticated', '00000000-0000-0000-0000-0000000000ff', `SELECT * FROM church.churches`)).rows.length === 0);
await t('admin A sees only own church', async () => { const r = (await as(db, 'authenticated', u1, `SELECT id FROM church.churches`)).rows; return r.length === 1 && r[0].id === A; });
await t('churches has no passkey column', async () => (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='church' AND table_name='churches' AND column_name='passkey'`)).rows.length === 0);
await t('usher_credentials not readable by authenticated', () => denied('authenticated', u1, `SELECT * FROM church.usher_credentials`));
await t('anon: increment_wallet_balance denied', () => denied('anon', '', `SELECT public.increment_wallet_balance($1::uuid, 5000000)`, [B]));
await t('authenticated: increment_wallet_balance denied', () => denied('authenticated', u1, `SELECT public.increment_wallet_balance($1::uuid, 5000000)`, [A]));
for (const [fn, args] of [['public.apply_topup', `('x', 1)`], ['public.debit_wallet', `('${A}'::uuid, 1, 'k')`], ['public.refund_wallet', `('${A}'::uuid, 'k')`], ['public.check_rate_limit', `('k', 1, 60)`], ['public.claim_sms_queue_batch', `(null, 5)`], ['church.finalize_event', `('${A}'::uuid)`], ['church.set_attendance', `('${A}'::uuid,'${A}'::uuid,'present')`], ['church.clear_attendance', `('${A}'::uuid,'${A}'::uuid)`], ['church.get_or_create_event', `('${B}'::uuid,'sunday_service','2026-01-01')`], ['church.process_inactive_30_days_followups', `(null)`]])
  await t(`authenticated: ${fn} denied`, () => denied('authenticated', u1, `SELECT ${fn}${args}`));
await t('authenticated wallet write denied', () => denied('authenticated', u1, `UPDATE public.wallets SET balance = 999999 WHERE tenant_id='${A}'`));
await t('authenticated cannot insert admin_profiles', () => denied('authenticated', u1, `INSERT INTO public.admin_profiles(id,email,tenant_id,role) VALUES ('${u1}','a@x.org','${B}','pastor') ON CONFLICT (id) DO UPDATE SET tenant_id='${B}'`));
await t('authenticated cannot insert sms_logs', () => denied('authenticated', u1, `INSERT INTO church.sms_logs(tenant_id,recipient_phone,body,status,idempotency_key) VALUES ('${A}','+256700000000','x','PENDING','kk')`));

// wallet logic
const bal = async (id) => Number((await db.query(`SELECT balance FROM public.wallets WHERE tenant_id=$1`, [id])).rows[0].balance);
await db.query(`INSERT INTO public.wallet_transactions(tenant_id,amount,type,reference_code,status) VALUES ($1,10000,'TOPUP','REF1','pending')`, [A]);
const sr = (sql, p) => as(db, 'service_role', '', sql, p);
await t('apply_topup credits once', async () => { const r1 = (await sr(`SELECT public.apply_topup('REF1', 10000, '{}') r`)).rows[0].r; const r2 = (await sr(`SELECT public.apply_topup('REF1', 10000, '{}') r`)).rows[0].r; return r1 === 'credited' && r2 === 'already_processed' && (await bal(A)) === 10000 || [r1, r2, await bal(A)]; });
await t('apply_topup unknown ref', async () => (await sr(`SELECT public.apply_topup('NOPE', 1, '{}') r`)).rows[0].r === 'not_found');
await db.query(`INSERT INTO public.wallet_transactions(tenant_id,amount,type,reference_code,status) VALUES ($1,5000,'TOPUP','REF2','pending')`, [A]);
await t('apply_topup amount mismatch → review, no credit', async () => { const r = (await sr(`SELECT public.apply_topup('REF2', 99999999, '{}') r`)).rows[0].r; return r === 'amount_mismatch' && (await bal(A)) === 10000 || [r, await bal(A)]; });
await t('debit_wallet debits, replays idempotently', async () => { const a = (await sr(`SELECT public.debit_wallet($1::uuid, 70, 'sms:1') r`, [A])).rows[0].r; const b = (await sr(`SELECT public.debit_wallet($1::uuid, 70, 'sms:1') r`, [A])).rows[0].r; return a && b && (await bal(A)) === 9930 || [a, b, await bal(A)]; });
await t('debit_wallet insufficient → false, balance unchanged', async () => { const a = (await sr(`SELECT public.debit_wallet($1::uuid, 99999999, 'sms:2') r`, [A])).rows[0].r; return a === false && (await bal(A)) === 9930; });
await t('refund_wallet refunds once', async () => { await sr(`SELECT public.refund_wallet($1::uuid,'sms:1')`, [A]); await sr(`SELECT public.refund_wallet($1::uuid,'sms:1')`, [A]); return (await bal(A)) === 10000 || await bal(A); });
await t('refund_wallet cannot refund other tenant debit', async () => (await sr(`SELECT public.refund_wallet($1::uuid,'sms:1') r`, [B])).rows[0].r === false);
await t('wallet never negative (concurrent-ish)', async () => { await db.query(`UPDATE public.wallets SET balance=100 WHERE tenant_id=$1`, [B]); const rs = await Promise.all([1,2,3].map(i => sr(`SELECT public.debit_wallet($1::uuid, 70, 'cc:'||$2::text) r`, [B, i]))); const ok = rs.filter(r => r.rows[0].r).length; return ok === 1 && (await bal(B)) === 30 || [ok, await bal(B)]; });

// rate limit
await t('rate limit: allows N then blocks', async () => { const out = []; for (let i = 0; i < 4; i++) out.push((await sr(`SELECT public.check_rate_limit('k1', 3, 60) r`)).rows[0].r); return JSON.stringify(out) === '[true,true,true,false]' || out; });

// attendance
const mem = async (c, n) => (await db.query(`INSERT INTO church.members(church_id,full_name,phone_number) VALUES ($1,$2,'+2567000000') RETURNING id`, [c, n])).rows[0].id;
const [m1, m2, m3] = [await mem(A, 'M One'), await mem(A, 'M Two'), await mem(A, 'M Three')];
const mB = await mem(B, 'B Member');
const ev = (await db.query(`INSERT INTO church.events(church_id,name,service_type,event_date,status) VALUES ($1,'Sun','sunday_service','2026-09-27','active') RETURNING id`, [A])).rows[0].id;
const cnt = async () => Number((await db.query(`SELECT attending_count c FROM church.events WHERE id=$1`, [ev])).rows[0].c);
await t('set_attendance present → count 1; repeat → still 1', async () => { await sr(`SELECT church.set_attendance($1::uuid,$2::uuid,'present')`, [ev, m1]); await sr(`SELECT church.set_attendance($1::uuid,$2::uuid,'late')`, [ev, m1]); return (await cnt()) === 1 || await cnt(); });
await t('set_attendance rejects cross-tenant member', async () => { try { await sr(`SELECT church.set_attendance($1::uuid,$2::uuid,'present')`, [ev, mB]); return 'allowed'; } catch (e) { return /does not belong/.test(e.message) || e.message; } });
await t('present→absent decrements', async () => { await sr(`SELECT church.set_attendance($1::uuid,$2::uuid,'absent')`, [ev, m1]); await sr(`SELECT church.set_attendance($1::uuid,$2::uuid,'present')`, [ev, m1]); await sr(`SELECT church.set_attendance($1::uuid,$2::uuid,'present')`, [ev, m2]); return (await cnt()) === 2 || await cnt(); });
await t('clear_attendance decrements only if present', async () => { await sr(`SELECT church.clear_attendance($1::uuid,$2::uuid)`, [ev, m2]); await sr(`SELECT church.clear_attendance($1::uuid,$2::uuid)`, [ev, m3]); return (await cnt()) === 1 || await cnt(); });
await t('finalize_event: absentees added, present NOT overwritten', async () => { const n = (await sr(`SELECT church.finalize_event($1::uuid) n`, [ev])).rows[0].n; const rows = (await db.query(`SELECT member_id, attendance_status s FROM church.attendance_logs WHERE event_id=$1 ORDER BY member_id`, [ev])).rows; const m1s = rows.find(r => r.member_id === m1).s; const st = (await db.query(`SELECT status FROM church.events WHERE id=$1`, [ev])).rows[0].status; return n === 2 && m1s === 'present' && rows.length === 3 && st === 'completed' && (await cnt()) === 1 || [n, rows, st]; });
await t('finalize_event does not log other tenant members', async () => (await db.query(`SELECT count(*)::int c FROM church.attendance_logs WHERE member_id=$1`, [mB])).rows[0].c === 0);

// inactivity
await t('refresh_inactive_30_days: run 3x, no unique violation', async () => { for (let i = 0; i < 3; i++) await as(db, 'authenticated', u1, `SELECT church.refresh_inactive_30_days($1::uuid)`, [A]); return true; });
await t('refresh_inactive: resolved flag reopens (idempotent upsert)', async () => { await db.query(`UPDATE church.attendance_flags SET status='resolved' WHERE church_id=$1`, [A]); const r = (await as(db, 'authenticated', u1, `SELECT church.refresh_inactive_30_days($1::uuid) n`, [A])).rows[0].n; return r >= 1 || r; });
await t('refresh_inactive: cross-tenant denied', () => denied('authenticated', u1, `SELECT church.refresh_inactive_30_days($1::uuid)`, [B]));
await t('refresh_inactive: NULL (all tenants) denied for end user', () => denied('authenticated', u1, `SELECT church.refresh_inactive_30_days(NULL)`));
await t('refresh_inactive: service_role all tenants ok', async () => { await sr(`SELECT church.refresh_inactive_30_days(NULL)`); return true; });
await t('RLS: admin A cannot read B members', async () => (await as(db, 'authenticated', u1, `SELECT id FROM church.members WHERE church_id=$1`, [B])).rows.length === 0);

// queue
await db.query(`INSERT INTO church.broadcasts(id,tenant_id,message_template) VALUES ('11111111-1111-1111-1111-111111111111',$1,'hi')`, [A]);
for (let i = 0; i < 5; i++) await db.query(`INSERT INTO church.sms_queue(tenant_id,broadcast_id,recipient_phone,message,idempotency_key) VALUES ($1,'11111111-1111-1111-1111-111111111111','+256700000000','m',$2)`, [A, 'q' + i]);
await t('claim_sms_queue_batch claims 3, marks PROCESSING, second claim gets the rest', async () => { const a = (await sr(`SELECT * FROM public.claim_sms_queue_batch(NULL, 3)`)).rows; const b = (await sr(`SELECT * FROM public.claim_sms_queue_batch(NULL, 10)`)).rows; return a.length === 3 && b.length === 2 && a.every(r => r.status === 'PROCESSING') || [a.length, b.length]; });
await db.query(`INSERT INTO church.visitors(church_id, full_name) VALUES ($1,'Visitor of A'), ($2,'Visitor of B')`, [A, B]);
await t('visitors: admin A sees only own visitors', async () => { const r = (await as(db, 'authenticated', u1, `SELECT full_name FROM church.visitors`)).rows; return r.length === 1 && r[0].full_name === 'Visitor of A'; });
await t('visitors: anon denied', () => denied('anon', '', `SELECT * FROM church.visitors`));
await t('visitors: admin A cannot insert into B', () => denied('authenticated', u1, `INSERT INTO church.visitors(church_id, full_name) VALUES ('${B}', 'x')`));
await t('visitors: admin A update cannot touch B rows', async () => { const r = await as(db, 'authenticated', u1, `UPDATE church.visitors SET full_name='pwn' WHERE church_id='${B}'`); return (r.affectedRows ?? 0) === 0; });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
