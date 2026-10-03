import type { Metadata } from 'next';
import { logout } from '@/lib/auth-actions';
import { requireOverseer } from '@/lib/auth/overseer';
import { churchStatus, sortChurches, type ChurchRow } from '@/lib/denominations';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Overseer dashboard', robots: { index: false, follow: false } };

type Church = ChurchRow & {
  slug?: string | null;
  pastor_email?: string | null;
  member_count?: number | null;
  sms_sent_30d?: number | null;
  last_event_date?: string | null;
  joined_at?: string | null;
};
type Totals = {
  church_count?: number | null;
  member_total?: number | null;
  attendance_30d_total?: number | null;
  sms_30d_total?: number | null;
  active_churches_30d?: number | null;
};

const num = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('en-US'));
const date = (v: unknown) => {
  if (!v || (typeof v !== 'string' && typeof v !== 'number')) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const sum = (rows: Church[], k: keyof Church) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

const BADGE = {
  active: ['Active', 'bg-green-100 text-green-800'],
  inactive: ['Inactive', 'bg-amber-100 text-amber-800'],
  never: ['No activity', 'bg-stone-200 text-stone-600'],
} as const;

function Stat({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-[rgba(90,55,20,0.15)] bg-white/60 p-4">
      <div className="text-[10px] font-bold uppercase tracking-widest text-[#9A7E65]">{title}</div>
      <div className="mt-1 text-3xl font-bold text-[#1E1208]">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-[#9A7E65]">{hint}</div>}
    </div>
  );
}

/** Overseer dashboard. Aggregates only; the RPCs authorise on auth.uid() and requireOverseer() gates the page. */
export default async function OverseerPage() {
  const { supabase, ctx } = await requireOverseer();

  const [summary, totalsRes] = await Promise.all([
    supabase.rpc('overseer_church_summary'),
    supabase.rpc('overseer_denomination_totals'),
  ]);
  if (summary.error) console.error('[overseer] church summary failed:', summary.error.code, summary.error.message);
  if (totalsRes.error) console.error('[overseer] totals failed:', totalsRes.error.code, totalsRes.error.message);

  const churches = sortChurches(Array.isArray(summary.data) ? (summary.data as Church[]) : []);
  const rpcTotals = (Array.isArray(totalsRes.data) ? totalsRes.data[0] : totalsRes.data) as Totals | null;
  // Fall back to the church list if the totals call failed, so the cards are never blank.
  const totals: Totals = rpcTotals ?? {
    church_count: churches.length,
    member_total: sum(churches, 'member_count'),
    attendance_30d_total: sum(churches, 'attendance_30d'),
    sms_30d_total: sum(churches, 'sms_sent_30d'),
    active_churches_30d: churches.filter((c) => churchStatus(c.last_active_at) === 'active').length,
  };
  const maxAttendance = Math.max(1, ...churches.map((c) => Number(c.attendance_30d ?? 0)));

  return (
    <div style={{ fontFamily: "'Outfit', sans-serif" }} className="min-h-screen bg-[#F0E6D3] p-4 md:p-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 style={{ fontFamily: "'Playfair Display', serif" }} className="text-3xl font-bold text-[#1E1208]">
              {ctx.denomination_name ?? 'Overseer dashboard'}
            </h1>
            <p className="mt-1 text-sm text-[#9A7E65]">Overseer dashboard · last 30 days</p>
          </div>
          <form action={logout}>
            <button className="text-xs font-bold uppercase tracking-widest text-[#B5622A]">Sign out</button>
          </form>
        </header>

        {(summary.error || totalsRes.error) && (
          <p className="rounded-lg bg-[#B5622A]/10 p-3 text-sm text-[#B5622A]">Some figures could not be loaded. Please refresh.</p>
        )}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat title="Churches" value={num(totals.church_count)} />
          <Stat
            title="Active churches"
            value={num(totals.active_churches_30d)}
            hint={totals.church_count ? `of ${num(totals.church_count)}` : undefined}
          />
          <Stat title="Members" value={num(totals.member_total)} />
          <Stat title="Attendance" value={num(totals.attendance_30d_total)} hint="last 30 days" />
          <Stat title="SMS sent" value={num(totals.sms_30d_total)} hint="last 30 days" />
        </section>

        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[#9A7E65]">Churches you oversee</h2>
          {churches.length === 0 ? (
            <p className="rounded-xl border border-[rgba(90,55,20,0.15)] bg-white/60 p-6 text-sm text-[#9A7E65]">
              No churches are linked to your denomination yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-[rgba(90,55,20,0.15)] bg-white/60">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[rgba(90,55,20,0.15)] text-[10px] uppercase tracking-widest text-[#9A7E65]">
                    <th className="px-4 py-3 font-bold">Church</th>
                    <th className="px-4 py-3 font-bold">Pastor</th>
                    <th className="px-4 py-3 text-right font-bold">Members</th>
                    <th className="px-4 py-3 font-bold">Attendance (30d)</th>
                    <th className="px-4 py-3 text-right font-bold">SMS (30d)</th>
                    <th className="px-4 py-3 font-bold">Last event</th>
                    <th className="px-4 py-3 font-bold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {churches.map((c, i) => {
                    const att = Number(c.attendance_30d ?? 0);
                    const [badgeText, badgeClass] = BADGE[churchStatus(c.last_active_at)];
                    return (
                      <tr key={c.church_id ?? i} className="border-b border-[rgba(90,55,20,0.08)] last:border-0">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-[#1E1208]">{c.church_name ?? '—'}</div>
                          {c.slug && <div className="text-xs text-[#9A7E65]">/{c.slug}</div>}
                        </td>
                        <td className="px-4 py-3 text-[#1E1208]">{c.pastor_email ?? '—'}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-[#1E1208]">{num(c.member_count)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-24 overflow-hidden rounded-full bg-[rgba(90,55,20,0.1)]">
                              <div className="h-full rounded-full bg-[#B5622A]" style={{ width: `${Math.round((att / maxAttendance) * 100)}%` }} />
                            </div>
                            <span className="tabular-nums text-[#1E1208]">{num(c.attendance_30d)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-[#1E1208]">{num(c.sms_sent_30d)}</td>
                        <td className="px-4 py-3 text-[#1E1208]">{date(c.last_event_date)}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${badgeClass}`}>{badgeText}</span>
                          <div className="mt-1 text-[11px] text-[#9A7E65]">{date(c.last_active_at)}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
