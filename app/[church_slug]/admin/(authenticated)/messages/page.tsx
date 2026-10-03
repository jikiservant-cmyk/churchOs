import { requireTenantAdmin } from '@/lib/auth/tenant';
import { maskPhone } from '@/lib/security';
import { normalizeUgPhone } from '@/lib/utils';
import {
  History,
} from 'lucide-react';
import BroadcastComposer from '@/components/BroadcastComposer';
import BroadcastHistory from '@/components/BroadcastHistory';
import SMSWalletWidget from '@/components/SMSWalletWidget';

export default async function MessagesPage(props: {
  params: Promise<{ church_slug: string }>;
}) {
  const { church_slug } = await props.params;
  const { church, supabase } = await requireTenantAdmin(church_slug);

  const [{ data: balanceData }, memberRes, convertRes] = await Promise.all([
    supabase.schema('public').from('wallets').select('balance, sms_rate').eq('tenant_id', church.id).maybeSingle(),
    supabase.schema('church').from('members').select('id, full_name, phone_number, gender, is_youth').eq('church_id', church.id).not('phone_number', 'is', null).limit(5000),
    supabase.schema('church').from('new_converts').select('id, name, contact').eq('church_id', church.id).not('contact', 'is', null).limit(5000),
  ]);
  if (memberRes.error) console.error('[messages page] members query failed:', memberRes.error.code);
  if (convertRes.error) console.error('[messages page] converts query failed:', convertRes.error.code);

  // The browser only ever receives a MASKED number for display. The send
  // endpoints look real numbers up server-side by id, so the full contact
  // list is no longer shipped to the client (or into the RSC payload).
  const display = (raw: string | null) => (raw && normalizeUgPhone(raw) ? maskPhone(normalizeUgPhone(raw)) : null);

  const realMembers = (memberRes.data || []).flatMap((m) => {
    const phone = display(m.phone_number);
    return phone ? [{ id: m.id, full_name: m.full_name, phone_number: phone, source: 'member' as const, gender: m.gender, is_youth: m.is_youth }] : [];
  });
  const newConverts = (convertRes.data || []).flatMap((nc) => {
    const phone = display(nc.contact);
    return phone ? [{ id: nc.id, full_name: nc.name, phone_number: phone, source: 'new_convert' as const }] : [];
  });
  const members = [...realMembers, ...newConverts];

  const balanceUgx = balanceData?.balance || 0;
  const smsRate = balanceData?.sms_rate || 70;
  const remainingSMS = Math.floor(balanceUgx / smsRate);
  const leftoverUGX = balanceUgx % smsRate;

  // Recent SMS logs for broadcast history
  const { data: smsLogsData } = await supabase
    .schema('church')
    .from('sms_logs')
    .select('id, created_at, body, status')
    .eq('tenant_id', church.id)
    .order('created_at', { ascending: false })
    .limit(200);
  const smsLogs: any[] = smsLogsData || [];

  // Group by date, then by message to represent a "broadcast" per day
  const groupedByDateAndMsg = (smsLogs || []).reduce((acc: any, log: any) => {
    const msgContent = log.body || "";
    let dateStr = "Unknown Date";
    try {
      if (log.created_at) {
        const d = new Date(log.created_at);
        if (!isNaN(d.getTime())) {
          dateStr = d.toLocaleDateString(undefined, {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          });
        }
      }
    } catch {}

    if (!acc[dateStr]) acc[dateStr] = {};

    if (!acc[dateStr][msgContent]) {
      acc[dateStr][msgContent] = {
        message: msgContent,
        created_at: log.created_at || new Date().toISOString(),
        count: 0,
        successCount: 0,
        failedCount: 0,
      };
    }
    
    acc[dateStr][msgContent].count++;
    if (log.status?.toLowerCase() === "failed") {
      acc[dateStr][msgContent].failedCount++;
    } else {
      acc[dateStr][msgContent].successCount++;
    }
    return acc;
  }, {});

  const broadcastDates = Object.entries(groupedByDateAndMsg).map(([dateStr, msgsMap]: [string, any]) => {
    const messages = Object.values(msgsMap).sort(
      (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const maxDate = Math.max(...messages.map((m: any) => new Date(m.created_at).getTime()));
    return {
      dateStr,
      messages,
      sortTime: maxDate,
    };
  }).sort((a, b) => b.sortTime - a.sortTime);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1
            style={{ fontFamily: "'Playfair Display', serif" }}
            className="text-3xl font-bold text-[#1E1208]"
          >
            Broadcast SMS
          </h1>
          <p className="text-[13px] text-[#9A7E65] mt-1.5 font-medium">
            Send messages to your congregation instantly.
          </p>
        </div>

        {/* SMS Wallet Widget */}
        <SMSWalletWidget 
          remainingSMS={remainingSMS}
          balanceUgx={balanceUgx}
          leftoverUGX={leftoverUGX}
          churchId={church.id}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Composer (Left Column) */}
        <div className="lg:col-span-2 space-y-6">
          <BroadcastComposer members={members} churchId={church.id} />
        </div>

        {/* History (Right Column) */}
        <div className="bg-[#F0E6D3] rounded-2xl shadow-sm border border-[rgba(90,55,20,0.13)] p-6 h-fit max-h-[600px] overflow-auto flex flex-col">
          <h2
            style={{ fontFamily: "'Playfair Display', serif" }}
            className="text-lg font-bold text-[#1E1208] mb-6 flex items-center gap-2 sticky top-0 bg-[#F0E6D3] z-10 pb-2 border-b border-[rgba(90,55,20,0.05)]"
          >
            <History className="w-5 h-5 text-[#B5622A]" />
            Recent Broadcasts
          </h2>

          <BroadcastHistory broadcastDates={broadcastDates} />
        </div>
      </div>
    </div>
  );
}
