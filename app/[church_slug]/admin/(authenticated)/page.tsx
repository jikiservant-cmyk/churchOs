import { getChurchBySlug } from '@/lib/db';
import { createClient } from '@/lib/supabase/server';
import { ArrowUpRight, ArrowDownRight, MessageSquarePlus, Wallet, Users, TrendingUp } from 'lucide-react';

export default async function AdminDashboard({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const resolvedParams = await params;
  const church = await getChurchBySlug(resolvedParams.church_slug) || {
    id: 'unknown',
    name: resolvedParams.church_slug,
    slug: resolvedParams.church_slug,
    themeColor: 'bg-slate-900',
    logoUrl: `https://picsum.photos/seed/${resolvedParams.church_slug}/200/200`
  };

  const supabase = await createClient();

  // Fetch real data for stats and members
  let { count: memberCount, error: memberCountError } = await supabase
    .schema('church')
    .from('members')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', church.id);

  if (memberCountError && memberCountError.message.includes('tenant_id')) {
     const fallback = await supabase
       .schema('church')
       .from('members')
       .select('id', { count: 'exact', head: true })
       .eq('church_id', church.id);
     memberCount = fallback.count;
  }

  let { data: recentMembers, error: recentMembersError } = await supabase
    .schema('church')
    .from('members')
    .select('full_name, created_at')
    .eq('tenant_id', church.id)
    .order('created_at', { ascending: false })
    .limit(5);

  if (recentMembersError && recentMembersError.message.includes('tenant_id')) {
     const fallback = await supabase
       .schema('church')
       .from('members')
       .select('full_name, created_at')
       .eq('church_id', church.id)
       .order('created_at', { ascending: false })
       .limit(5);
     recentMembers = fallback.data;
  }

  const realMemberCount = memberCount || 0;
  const mappedMembers = recentMembers?.map(m => ({
    name: m.full_name,
    since: new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    role: 'Member'
  })) || [];

  // Fetch Events
  const { data: dbEvents } = await supabase.schema('church').from('events').select('*').eq('tenant_id', church.id).order('created_at', { ascending: true }).limit(5);
  const events = dbEvents || [];

  // Fetch Prayers
  const { data: dbPrayers } = await supabase.schema('church').from('prayers').select('*').eq('tenant_id', church.id).order('created_at', { ascending: false }).limit(5);
  const prayers = dbPrayers?.map(p => {
    const diffHours = Math.floor((new Date().getTime() - new Date(p.created_at).getTime()) / (1000 * 60 * 60));
    const ago = diffHours < 24 ? `${diffHours}h ago` : diffHours < 48 ? 'Yesterday' : `${Math.floor(diffHours/24)}d ago`;
    return { name: p.submitter_name, text: p.body, ago, status: p.status };
  }) || [];

  // Fetch Small Groups
  const { data: dbGroups } = await supabase.schema('church').from('small_groups').select('*').eq('tenant_id', church.id).limit(5);
  const groups = dbGroups || [];

  // Fetch Donations
  const { data: dbDonations } = await supabase.schema('church').from('donations').select('category, amount_cents').eq('tenant_id', church.id);
  
  // Aggregate donations by category
  let totalDonations = 0;
  const givingMap: Record<string, number> = {};
  if (dbDonations) {
    dbDonations.forEach(d => {
      totalDonations += (d.amount_cents / 100);
      givingMap[d.category] = (givingMap[d.category] || 0) + (d.amount_cents / 100);
    });
  }
  
  const givingTarget = 20000; // Hardcoded default target for display, or could fetch from a settings table if it existed
  
  const giving = Object.entries(givingMap).map(([label, amount]) => ({
    label, 
    amount,
    pct: totalDonations > 0 ? Math.round((amount / totalDonations) * 100) : 0
  })).sort((a,b) => b.amount - a.amount);

  const topStats = [
    { label: "Total Members", value: realMemberCount.toLocaleString(), note: "Active directory" },
    { label: "Small Groups", value: groups.length.toString(), note: "Registered fellowships" },
    { label: "Monthly Giving", value: `$${totalDonations.toLocaleString()}`, note: `${Math.round((totalDonations/givingTarget)*100)}% of goal` },
    { label: "Open Prayers", value: prayers.filter(p => p.status !== 'answered').length.toString(), note: "Awaiting intercession" },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Greetings */}
      <div className="mb-10">
        <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-3xl font-bold text-[#1E1208] leading-tight">
          Good morning, Pastor
        </h2>
        <p className="text-[13px] text-[#9A7E65] mt-1.5 font-medium">
          Wednesday, April 22 · Next service in <span className="text-[#B5622A] font-bold">4 days</span>
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {topStats.map((s, i) => (
          <div key={i} className="bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl p-6 transition-all hover:translate-y-[-2px] hover:shadow-lg">
            <p className="text-[10px] font-bold text-[#C8B89A] uppercase tracking-widest mb-3">
              {s.label}
            </p>
            <h3 style={{ fontFamily: "'Playfair Display', serif" }} className="text-3xl font-bold text-[#1E1208] leading-none mb-2">
              {s.value}
            </h3>
            <p className="text-[11px] text-[#9A7E65] font-medium">{s.note}</p>
          </div>
        ))}
      </div>

      {/* Events + Groups Row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 mb-5">
        {/* Upcoming Events */}
        <div className="lg:col-span-7 bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl overflow-hidden shadow-sm">
          <div className="px-6 py-5 flex items-center justify-between">
            <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#1E1208]">Upcoming Events</h4>
            <button className="text-[11px] font-bold text-[#9A7E65] hover:text-[#B5622A] transition-colors uppercase tracking-wider">View all</button>
          </div>
          <div className="border-t border-[rgba(90,55,20,0.08)]">
            {events.length === 0 ? (
              <div className="px-6 py-8 text-center border-b border-[rgba(90,55,20,0.08)]">
                <p className="text-[13px] text-[#9A7E65]">No upcoming events scheduled.</p>
              </div>
            ) : events.map((e, index) => (
              <div key={index} className="px-6 py-4 flex items-center gap-4 border-b border-[rgba(90,55,20,0.08)] last:border-0 hover:bg-[rgba(90,55,20,0.02)] transition-colors">
                <div className="w-11 h-11 flex flex-col items-center justify-center bg-[#F5EAD8] border border-[rgba(181,98,42,0.18)] rounded-xl shrink-0">
                  <span className="text-[9px] font-bold text-[#B5622A] uppercase tracking-widest leading-none mb-0.5">{e.day}</span>
                  <span className="text-[11px] font-bold text-[#9A7E65]">{e.start_time?.split(':')[0] || 'TBD'}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[14px] font-bold text-[#1E1208] truncate">{e.title}</p>
                  <p className="text-[12px] text-[#9A7E65] mt-0.5">{e.start_time}</p>
                </div>
                <div className="text-right">
                   <p style={{ fontFamily: "'Playfair Display', serif" }} className="text-base font-bold text-[#1E1208]">{e.attending_count}</p>
                   <p className="text-[10px] text-[#C8B89A] font-medium leading-none">attending</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Small Groups */}
        <div className="lg:col-span-5 bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl overflow-hidden shadow-sm">
          <div className="px-6 py-5 flex items-center justify-between">
            <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#1E1208]">Small Groups</h4>
            <button className="text-[11px] font-bold text-[#9A7E65] hover:text-[#B5622A] transition-colors uppercase tracking-wider">Manage</button>
          </div>
          <div className="border-t border-[rgba(90,55,20,0.08)]">
            {groups.length === 0 ? (
              <div className="px-6 py-8 text-center border-b border-[rgba(90,55,20,0.08)]">
                <p className="text-[13px] text-[#9A7E65]">No active small groups.</p>
              </div>
            ) : groups.map((g, index) => (
              <div key={index} className="px-6 py-4 flex items-center justify-between border-b border-[rgba(90,55,20,0.08)] last:border-0 hover:bg-[rgba(90,55,20,0.02)] transition-colors">
                <div className="min-w-0">
                  <p className="text-[14px] font-bold text-[#1E1208] truncate">{g.name}</p>
                  <p className="text-[12px] text-[#9A7E65] mt-0.5">{g.leader_name} · {g.meeting_day}</p>
                </div>
                <div style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#B5622A]">
                   {g.member_count}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Members + Prayer Row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 mb-5">
        {/* New Members */}
        <div className="lg:col-span-5 bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl overflow-hidden shadow-sm">
          <div className="px-6 py-5 flex items-center justify-between">
            <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#1E1208]">New Members</h4>
            <button className="text-[11px] font-bold text-[#9A7E65] hover:text-[#B5622A] transition-colors uppercase tracking-wider">View all</button>
          </div>
          <div className="border-t border-[rgba(90,55,20,0.08)]">
            {mappedMembers.length === 0 ? (
              <div className="px-6 py-8 text-center border-b border-[rgba(90,55,20,0.08)]">
                <p className="text-[13px] text-[#9A7E65]">No new members this month.</p>
              </div>
            ) : mappedMembers.map((m, index) => (
              <div key={index} className="px-6 py-4 flex items-center gap-3 border-b border-[rgba(90,55,20,0.08)] last:border-0 hover:bg-[rgba(90,55,20,0.02)] transition-colors">
                <div className="w-9 h-9 rounded-full bg-[rgba(90,55,20,0.12)] flex items-center justify-center text-[13px] font-bold text-[#7A4F30] shrink-0">
                  {m.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                   <p className="text-[14px] font-bold text-[#1E1208] truncate">{m.name}</p>
                   <p className="text-[12px] text-[#9A7E65]">Joined {m.since}</p>
                </div>
                <span className="px-2 py-0.5 bg-[rgba(90,55,20,0.08)] text-[10px] font-bold text-[#9A7E65] rounded-full uppercase tracking-wider">Member</span>
              </div>
            ))}
          </div>
        </div>

        {/* Prayer Wall */}
        <div className="lg:col-span-7 bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl overflow-hidden shadow-sm">
          <div className="px-6 py-5 flex items-center justify-between">
            <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#1E1208]">Prayer Wall</h4>
            <button className="px-4 py-1.5 bg-[#2B1A0E] text-[#F5E6CE] text-[11px] font-bold rounded-lg hover:bg-[#3D2614] transition-colors uppercase tracking-widest">+ Add</button>
          </div>
          <div className="border-t border-[rgba(90,55,20,0.08)]">
            {prayers.length === 0 ? (
              <div className="px-6 py-8 text-center border-b border-[rgba(90,55,20,0.08)]">
                <p className="text-[13px] text-[#9A7E65]">No open prayer requests.</p>
              </div>
            ) : prayers.map((p, index) => (
              <div key={index} className="px-6 py-4 flex flex-start gap-3 border-b border-[rgba(90,55,20,0.08)] last:border-0 hover:bg-[rgba(90,55,20,0.02)] transition-colors">
                 <div className="mt-2 w-1.5 h-1.5 rounded-full bg-[rgba(90,55,20,0.2)] shrink-0" />
                 <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-[#9A7E65] mb-0.5">
                      {p.name} <span className="text-[#C8B89A] font-medium ml-1.5">· {p.ago}</span>
                    </p>
                    <p className="text-[13px] text-[#1E1208] leading-relaxed font-medium">{p.text}</p>
                 </div>
                 <button className="self-center px-3 py-1 border border-[rgba(90,55,20,0.2)] text-[10px] font-bold text-[#9A7E65] rounded-lg hover:border-[#B5622A] hover:text-[#B5622A] hover:bg-[rgba(181,98,42,0.07)] transition-all">Answered?</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Giving Summary */}
      <div className="bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl p-8 shadow-sm">
        <div className="flex items-end justify-between mb-6">
          <div>
            <h4 style={{ fontFamily: "'Playfair Display', serif" }} className="text-lg font-bold text-[#1E1208]">Monthly Giving</h4>
            <p className="text-[12px] text-[#9A7E65] font-medium mt-0.5">Summary for April 2026</p>
          </div>
          <div className="text-right">
             <span style={{ fontFamily: "'Playfair Display', serif" }} className="text-2xl font-bold text-[#1E1208]">$18,640</span>
             <span className="text-[12px] text-[#9A7E65] font-medium ml-2">of $22,000 goal</span>
          </div>
        </div>
        
        <div className="h-2 w-full bg-[rgba(90,55,20,0.12)] rounded-full overflow-hidden mb-8">
           <div className="h-full bg-[#B5622A] rounded-full" style={{ width: '84.7%' }} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
          {giving.length === 0 ? (
            <div className="md:col-span-3 text-center py-4">
              <p className="text-[13px] text-[#9A7E65]">No recent donations recorded.</p>
            </div>
          ) : giving.map((g, index) => (
            <div key={index} className="flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-[#9A7E65] uppercase tracking-widest">{g.label}</span>
                <span className="text-sm font-bold text-[#1E1208]">${g.amount.toLocaleString()}</span>
              </div>
              <div className="h-1 w-full bg-[rgba(90,55,20,0.08)] rounded-full overflow-hidden">
                <div 
                  className="h-full bg-[#B5622A] rounded-full transition-all duration-1000" 
                  style={{ width: `${g.pct}%`, opacity: 0.5 + (g.pct / 200) }} 
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
