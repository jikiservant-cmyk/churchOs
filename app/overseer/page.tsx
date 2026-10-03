import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { logout } from '@/lib/auth-actions';
import { denominationsEnabled, firstRow, type LoginContext } from '@/lib/denominations';

export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

const label = (k: string) => k.replace(/_/g, ' ');
const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function Table({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="text-sm text-[#9A7E65]">Nothing to show yet.</p>;
  const cols = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto rounded-xl border border-[rgba(90,55,20,0.15)] bg-white/60">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[rgba(90,55,20,0.15)] text-[10px] uppercase tracking-widest text-[#9A7E65]">
            {cols.map((c) => <th key={c} className="px-4 py-3 font-bold">{label(c)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-[rgba(90,55,20,0.08)] last:border-0">
              {cols.map((c) => <td key={c} className="px-4 py-3 text-[#1E1208]">{cell(r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const toRows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : d ? [d as Row] : []);

/** Overseer landing page. Aggregates only; authorisation is enforced inside the RPCs (auth.uid()). */
export default async function OverseerPage() {
  if (!denominationsEnabled()) redirect('/');

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const { data: ctxData } = await supabase.rpc('my_login_context');
  const ctx = firstRow<LoginContext>(ctxData);
  if (ctx?.account_type !== 'overseer') redirect('/');

  const [{ data: churches, error: e1 }, { data: totals, error: e2 }] = await Promise.all([
    supabase.rpc('overseer_church_summary'),
    supabase.rpc('overseer_denomination_totals'),
  ]);
  if (e1) console.error('[overseer] church summary failed:', e1.code, e1.message);
  if (e2) console.error('[overseer] totals failed:', e2.code, e2.message);

  return (
    <div style={{ fontFamily: "'Outfit', sans-serif" }} className="min-h-screen bg-[#F0E6D3] p-6 md:p-10">
      <div className="mx-auto max-w-5xl space-y-8">
        <header className="flex items-center justify-between">
          <h1 style={{ fontFamily: "'Playfair Display', serif" }} className="text-3xl font-bold text-[#1E1208]">
            {ctx.denomination_name ?? 'Overseer'}
          </h1>
          <form action={logout}>
            <button className="text-xs font-bold uppercase tracking-widest text-[#B5622A]">Sign out</button>
          </form>
        </header>
        {(e1 || e2) && <p className="text-sm text-[#B5622A]">Some data could not be loaded.</p>}
        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[#9A7E65]">Totals</h2>
          <Table rows={toRows(totals)} />
        </section>
        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[#9A7E65]">Churches</h2>
          <Table rows={toRows(churches)} />
        </section>
      </div>
    </div>
  );
}
