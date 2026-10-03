import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

export function splitSql(sql) {
  const out = []; let cur = ''; let i = 0; const n = sql.length;
  let dollar = null;
  while (i < n) {
    const c = sql[i], c2 = sql.slice(i, i + 2);
    if (dollar) {
      if (sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; }
      cur += c; i++; continue;
    }
    if (c2 === '--') { const j = sql.indexOf('\n', i); const e = j < 0 ? n : j; cur += sql.slice(i, e); i = e; continue; }
    if (c2 === '/*') { const j = sql.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; cur += sql.slice(i, e); i = e; continue; }
    if (c === "'") { let j = i + 1; while (j < n) { if (sql[j] === "'" && sql[j + 1] === "'") j += 2; else if (sql[j] === "'") break; else j++; } cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === '"') { const j = sql.indexOf('"', i + 1); cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === '$') { const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i)); if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; } }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(s => s.replace(/--[^\n]*/g, '').trim());
}

export async function newDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid primary key default gen_random_uuid(), email text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  return db;
}

export async function runFile(db, file, { quiet = false } = {}) {
  const stmts = splitSql(fs.readFileSync(file, 'utf8'));
  const errors = []; let ok = 0;
  for (const s of stmts) {
    if (/^\s*create\s+extension/i.test(s) || /cron\.schedule/i.test(s)) continue;
    try { await db.exec(s); ok++; } catch (e) { errors.push({ stmt: s.replace(/\s+/g, ' ').slice(0, 140), err: e.message }); }
  }
  if (!quiet) console.log(`${file}: ${stmts.length} stmts, ${ok} ok, ${errors.length} errors`);
  return errors;
}

// Run a query as a role with a JWT subject
export async function as(db, role, sub, sql, params) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${sub || ''}', false), set_config('request.jwt.claim.role', '${role}', false);`);
  try { return await db.query(sql, params); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','',false);`); }
}
