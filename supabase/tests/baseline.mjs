import { newDb, runFile } from './lib.mjs';
const db = await newDb();
const errs = await runFile(db, new URL('../../supabase-schema.sql', import.meta.url).pathname);
for (const e of errs) console.log('ERR:', e.err, '\n   ', e.stmt);
