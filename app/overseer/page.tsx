import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { logout } from '@/lib/auth-actions';
import { denominationsEnabled, firstRow, type LoginContext } from '@/lib/denominations';

export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

// Columns returned by overseer_church_summary / overseer_denomination_totals.
// Unknown extra columns are still shown (after the known ones) so a DB change never hides data.
const LABELS: Record<string, string> = {
  church_name: 'Church', slug: 'URL', pastor_email: 'Pastor', member_count: 'Members',
  attendance_30d: 'Attendance (30d)', last_event_date: 'Last event', sms_sent_30d: 'SMS (30d)',
  last_active_at: 'Last active', joined_at: 'Created',
  church_count: 'Churches', member_total: 'Members', attendance_30d_total: 'Attendance (30d)',
  sms_30d_total: 'SMS (30d)', active_churches_30d: 'Active churches (30d)',
};
const HIDDEN = new Set(['church_id']);
const ORDER = Object.keys(LABELS);

const label = (k: string) => LABELS[k] ?? k.replace(/_/g, ' ');
const isDate = (k: string) => /(_at|_date)$/.test(k);
function cell(k: string, v: unknown) {
  if (v === null || v === undefined || v === '') return '—';
  if (isDate(k) && (typeof v === 'string' || typeof v === 'number')) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  if (typeof v === 'number') return v.toLocaleString('en-US');
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
const columns = (rows: Row[]) => {
  const keys = Object.keys(rows[0]).filter((k) => !HIDDEN.has(k));
  return [...ORDER.filter((k) => keys.includes(k)), ...keys.filter((k) => !ORDER.includes(k))];
};

function Totals({ row }: { row: Row | undefined }) {
  if (!row) return <p className="text-sm text-[#9A7E65]">Nothing to show yet.</p>;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {columns([row]).map((c) => (
        <div key={c} className="rounded-xl border border-[rgba(90,55,20,0.15)] bg-white/60 p-4">
          <div className="text-[10px] font-bold uppercase tracking-widest text-[#9A7E65]">{label(c)}</div>
          <div className="mt-1 text-2xl font-bold text-[#1E1208]">{cell(c, row[c])}</div>
        </div>
      ))}
    </div>
  );
}

function Table({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="text-sm text-[#9A7E65]">No churches linked yet.</p>;
  const cols = columns(rows);
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
            <tr key={String(r.church_id ?? i)} className="border-b border-[rgba(90,55,20,0.08)] last:border-0">
              {cols.map((c) => <td key={c} className="px-4 py-3 text-[#1E1208]">{cell(c, r[c])}</td>)}
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
          <Totals row={toRows(totals)[0]} />
        </section>
        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[#9A7E65]">Churches</h2>
          <Table rows={toRows(churches)} />
        </section>
      </div>
    </div>
  );
}
