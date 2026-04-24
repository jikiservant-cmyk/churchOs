import { createClient } from "@/lib/supabase/server";
import { topUpWallet } from "@/lib/wallet-actions";
import {
  History,
  Smartphone,
  CheckCircle2,
  XCircle,
  Wallet,
  AlertCircle,
} from "lucide-react";
import BroadcastComposer from "@/components/BroadcastComposer";
import { getChurchBySlug } from "@/lib/db";
import { formatDistanceToNow } from "date-fns";

export default async function MessagesPage(props: {
  params: Promise<{ church_slug: string }>;
}) {
  const resolvedParams = await props.params;
  const supabase = await createClient();

  let churchObj = await getChurchBySlug(resolvedParams.church_slug);

  // If slug lookup failed, try to resolve by the logged-in user's profile
  if (!churchObj) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from("admin_profiles")
        .select("tenant_id")
        .eq("id", user.id)
        .maybeSingle();

      if (profile?.tenant_id) {
        const { data: profileChurch } = await supabase
          .schema("church")
          .from("churches")
          .select("*")
          .eq("id", profile.tenant_id)
          .maybeSingle();

        if (profileChurch) {
          churchObj = {
            id: profileChurch.id,
            name: profileChurch.name,
            slug: profileChurch.slug,
            themeColor: profileChurch.theme_color || "bg-blue-600",
            logoUrl:
              profileChurch.logo_url ||
              `https://picsum.photos/seed/${profileChurch.slug}/200/200`,
          };
        }
      }
    }
  }

  const church = churchObj || {
    id: "placeholder",
    name: resolvedParams.church_slug,
    slug: resolvedParams.church_slug,
    themeColor: "bg-slate-900",
    logoUrl: `https://picsum.photos/seed/${resolvedParams.church_slug}/200/200`,
  };

  let members: any = [];
  let balanceData: any = null;

  const isPlaceholder =
    !churchObj || church.id === "placeholder" || church.id === "unknown";

  if (church && !isPlaceholder) {
    // 1. Fetch balance from the unified wallet
    const { data: balance } = await supabase
      .schema("public")
      .from("wallets")
      .select("*")
      .eq("tenant_id", church.id)
      .maybeSingle();

    balanceData = balance;

    // 2. Fetch members
    let { data: memberData, error: memberError } = await supabase
      .schema("church")
      .from("members")
      .select("*")
      .eq("tenant_id", church.id)
      .not("phone_number", "is", null);

    if (memberError && memberError.message.includes("tenant_id")) {
      console.warn(
        "[MessagesPage] Fallback: Trying member fetch with church_id instead of tenant_id",
      );
      const fallbackFetch = await supabase
        .schema("church")
        .from("members")
        .select("*")
        .eq("church_id", church.id)
        .not("phone_number", "is", null);

      memberData = fallbackFetch.data;
      memberError = fallbackFetch.error;
    }

    if (memberError) {
      console.error(
        "[MessagesPage] Member fetch error details:",
        memberError.message,
        memberError.details,
        memberError.hint,
      );
    }

    // 3. Fetch new converts
    let { data: newConvertsData, error: convertsError } = await supabase
      .schema("church")
      .from("new_converts")
      .select("*")
      .eq("church_id", church.id)
      .not("contact", "is", null);

    if (convertsError && convertsError.message.includes("church_id")) {
      const fallbackConverts = await supabase
        .schema("church")
        .from("new_converts")
        .select("*")
        .eq("tenant_id", church.id)
        .not("contact", "is", null);

      newConvertsData = fallbackConverts.data;
      convertsError = fallbackConverts.error;
    }

    if (convertsError) {
      console.error(
        "[MessagesPage] New converts fetch error details:",
        convertsError.message,
        convertsError.details,
        convertsError.hint,
      );
    }

    // Unify them into a generic Recipient array
    const realMembers = (memberData || []).map((m) => ({
      id: m.id,
      full_name: m.full_name,
      phone_number: m.phone_number,
      source: "member" as const,
      gender: m.gender,
      is_youth: m.is_youth,
    }));

    const newConverts = (newConvertsData || []).map((nc) => ({
      id: nc.id,
      full_name: nc.name,
      phone_number: nc.contact, // map contact to phone_number
      source: "new_convert" as const,
    }));

    members = [...realMembers, ...newConverts];
  }

  const validMembersCount = members?.length || 0;
  const balanceUgx = balanceData?.balance || 0;
  const smsRate = balanceData?.sms_rate || 70;
  const remainingSMS = Math.floor(balanceUgx / smsRate);
  const leftoverUGX = balanceUgx % smsRate;

  // Fetch recent SMS logs for broadcast history
  let smsLogs: any = [];
  if (church && !isPlaceholder) {
    const { data } = await supabase
      .schema("church")
      .from("sms_logs")
      .select("id, created_at, body, status")
      .order("created_at", { ascending: false })
      .limit(200);
    smsLogs = data || [];
  }

  // Group by message to represent a "broadcast"
  const broadcastGroups = Object.values(
    (smsLogs || []).reduce((acc: any, log: any) => {
      const msgContent = log.body || "";
      if (!acc[msgContent]) {
        acc[msgContent] = {
          message: msgContent,
          created_at: log.created_at || new Date().toISOString(),
          count: 0,
          successCount: 0,
          failedCount: 0,
        };
      }
      acc[msgContent].count++;
      if (log.status?.toLowerCase() === "failed") {
        acc[msgContent].failedCount++;
      } else {
        // assume sent, delivered, or pending are successful intents
        acc[msgContent].successCount++;
      }
      return acc;
    }, {}),
  ).sort(
    (a: any, b: any) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

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
        <div className="bg-[#F0E6D3] border border-[rgba(90,55,20,0.13)] rounded-2xl p-4 shadow-sm flex items-center gap-4 min-w-[280px]">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center ${remainingSMS < 20 ? "bg-red-50 text-[#B5622A]" : "bg-[rgba(90,55,20,0.05)] text-[#B5622A]"}`}
          >
            <Wallet className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-bold text-[#C8B89A] uppercase tracking-widest">
                SMS Balance
              </p>
              {remainingSMS < 50 && (
                <span className="flex items-center gap-1 text-[10px] font-bold text-[#B5622A] animate-pulse">
                  <AlertCircle className="w-3 h-3" /> Low Balance
                </span>
              )}
            </div>
            <h3 className="text-lg font-black text-[#1E1208] leading-tight">
              {remainingSMS}{" "}
              <span className="text-sm font-bold text-[#C8B89A]">
                SMS remaining
              </span>
            </h3>
            <p className="text-[10px] font-medium text-[#9A7E65] mt-0.5">
              UGX {balanceUgx.toLocaleString()} ({leftoverUGX} leftover)
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <form action={topUpWallet}>
              <input type="hidden" name="churchId" value={church.id} />
              <input type="hidden" name="amount" value="10000" />
              <button
                type="submit"
                className="w-full px-4 py-2 bg-[#2B1A0E] text-[#F5E6CE] text-[11px] font-bold rounded-xl hover:bg-[#3D2614] transition-all shadow-md active:scale-95 uppercase tracking-wider"
              >
                Top Up
              </button>
            </form>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Composer (Left Column) */}
        <div className="lg:col-span-2 space-y-6">
          {church && !isPlaceholder ? (
            <BroadcastComposer members={members || []} churchId={church.id} />
          ) : (
            <div className="bg-[#F0E6D3] rounded-2xl border border-dashed border-[#B5622A]/30 p-12 text-center">
              <div className="w-16 h-16 bg-[#B5622A]/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-8 h-8 text-[#B5622A]" />
              </div>
              <h3
                style={{ fontFamily: "'Playfair Display', serif" }}
                className="text-xl font-bold text-[#1E1208] mb-2"
              >
                Church Connection Required
              </h3>
              <p className="text-[#9A7E65] text-sm max-w-sm mx-auto mb-6">
                We couldn&apos;t securely verify which church you are sending
                for. Please try refreshing or visiting your church&apos;s direct
                admin portal.
              </p>
              <a
                href="."
                className="inline-block px-6 py-2 bg-[#2B1A0E] text-[#F5E6CE] text-xs font-bold rounded-lg uppercase tracking-widest hover:bg-[#3D2614] transition-all"
              >
                Refresh Dashboard
              </a>
            </div>
          )}
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

          {broadcastGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center flex-1">
              <div className="w-12 h-12 bg-[rgba(90,55,20,0.05)] rounded-full flex items-center justify-center mb-3">
                <Smartphone className="w-6 h-6 text-[#C8B89A]" />
              </div>
              <h3 className="text-[#1E1208] font-bold text-sm">No History</h3>
              <p className="text-[#9A7E65] text-xs mt-1 max-w-[200px]">
                You haven&apos;t sent any bulk SMS broadcasts recently.
              </p>
            </div>
          ) : (
            <ul className="space-y-4">
              {broadcastGroups.map((broadcast: any, idx: number) => (
                <li
                  key={idx}
                  className="border-b border-[rgba(90,55,20,0.05)] pb-4 last:border-0 last:pb-0"
                >
                  <div className="flex justify-between items-start mb-1.5">
                    <span className="text-[10px] font-bold text-[#C8B89A] uppercase tracking-wider">
                      {(() => {
                        try {
                          const d = new Date(broadcast.created_at);
                          if (isNaN(d.getTime())) return "Recently";
                          return formatDistanceToNow(d, { addSuffix: true });
                        } catch (e) {
                          return "Recently";
                        }
                      })()}
                    </span>
                    {broadcast.failedCount > 0 &&
                    broadcast.successCount === 0 ? (
                      <span className="flex items-center gap-1 text-[9px] font-bold text-[#B5622A] bg-red-50/50 px-2 py-0.5 rounded-full uppercase tracking-widest">
                        <XCircle className="w-3 h-3" /> Failed
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-700 bg-emerald-50/30 px-2 py-0.5 rounded-full uppercase tracking-widest">
                        <CheckCircle2 className="w-3 h-3" /> Delivered
                      </span>
                    )}
                  </div>
                  <p className="text-[13.5px] leading-relaxed font-medium text-[#1E1208] line-clamp-2">
                    {broadcast.message}
                  </p>
                  <p className="text-[11px] text-[#9A7E65] mt-2 font-medium">
                    Sent to {broadcast.count} member
                    {broadcast.count !== 1 ? "s" : ""}
                    {broadcast.failedCount > 0 && (
                      <span className="text-[#B5622A]">
                        {" "}
                        ({broadcast.failedCount} failed)
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
