'use client';

import { useState, useRef } from 'react';
import { Send, AlertCircle, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { normalizeUgPhone } from '@/lib/utils';
import { useRouter } from 'next/navigation';

export default function BroadcastComposer({ members, churchId }: { 
  members: { id: string, full_name: string, phone_number: string, source: string, gender?: string, is_youth?: boolean }[], 
  churchId: string 
}) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [audience, setAudience] = useState<'all' | 'men' | 'women' | 'youth' | 'new_converts'>('all');
  const [progress, setProgress] = useState({ active: false, total: 0, sent: 0, failed: 0 });
  const sendingRef = useRef(false);
  const router = useRouter();

  const filteredMembers = members.filter(m => {
    if (audience === 'all') return true;
    if (audience === 'men') return m.source === 'member' && m.gender === 'Male';
    if (audience === 'women') return m.source === 'member' && m.gender === 'Female';
    if (audience === 'youth') return m.source === 'member' && m.is_youth === true;
    if (audience === 'new_converts') return m.source === 'new_convert';
    return true;
  });
  
  const audienceLabels = {
    all: 'All Contacts',
    men: 'Men Only',
    women: 'Women Only',
    youth: 'Youth Only',
    new_converts: 'New Converts'
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || filteredMembers.length === 0 || sendingRef.current) return;
    
    sendingRef.current = true;
    setIsSending(true);
    setProgress({ active: true, total: filteredMembers.length, sent: 0, failed: 0 });
    
    try {
      const tenantId = churchId; // church uuid
      const finalMessage = message;
      let haltedReason = '';

      for (const m of filteredMembers) {
        try {
          if (!m.phone_number) {
            setProgress(p => ({ ...p, failed: p.failed + 1 }));
            continue;
          }

          const phone = normalizeUgPhone(m.phone_number);
          const idempotencyKey = typeof crypto !== 'undefined' && crypto.randomUUID 
            ? crypto.randomUUID() 
            : Math.random().toString(36).substring(2, 15);

          // We use a manual fetch instead of supabase.functions.invoke to aggressively prevent 
          // the Supabase SDK from crashing the browser runtime if the edge function returns a raw HTML 404 
          // (e.g. "An unexpected response was received from the server").
          try {
            const res = await fetch('/api/sms/send', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              signal: AbortSignal.timeout(15000), // 15 second timeout to prevent hanging fetches
              body: JSON.stringify({ phoneNumber: phone, message: finalMessage, churchId: tenantId, idempotencyKey: idempotencyKey })
            });

            if (!res.ok) {
              const text = await res.text().catch(() => '');
              let errorData: any = {};
              try {
                if (text && (text.startsWith('{') || text.startsWith('['))) {
                  errorData = JSON.parse(text);
                }
              } catch (parseErr) {
                console.warn('[BroadcastComposer] Could not parse error response as JSON:', text.substring(0, 50));
              }

              if (res.status === 402) {
                // Graceful billing interruption: Break the loop and inform the user peacefully
                const safeError = errorData.error?.replace(/\.$/, '') || 'Insufficient SMS balance';
                haltedReason = `Broadcast paused: ${safeError}. You have ${errorData.remaining || 0} SMS credits remaining. Please top up your account to finish sending.`;
                break;
              }

              console.error(`SMS failed for ${m.full_name}. Status: ${res.status}. Error:`, text);
              setProgress(p => ({ ...p, failed: p.failed + 1 }));
            } else {
              setProgress(p => ({ ...p, sent: p.sent + 1 }));
            }
          } catch (invokeCatch: any) {
             const isNetworkError = invokeCatch?.name === 'TypeError' || invokeCatch?.message?.includes('fetch');
             console.error(`[BroadcastComposer] ${isNetworkError ? 'Network Error' : 'Fetch exception'} for ${m.full_name}:`, invokeCatch?.message || invokeCatch);
             setProgress(p => ({ ...p, failed: p.failed + 1 }));
             
             if (isNetworkError) {
               // If it's a network error, maybe wait a bit longer before retrying next member
               await new Promise(r => setTimeout(r, 1000));
             }
          }
        } catch (internalErr: any) {
          const errorMessage = internalErr?.message || 'Unknown internal error';
          console.error(`Skipping ${m.full_name} due to crash:`, errorMessage);
          setProgress(p => ({ ...p, failed: p.failed + 1 }));
        }

        // Slight artificial delay to prevent rate-limiting the local Next.js API router
        await new Promise(r => setTimeout(r, 100));
      }

      if (haltedReason) {
        // We broke out of the loop intentionally due to billing
        alert(haltedReason);
        router.refresh(); // Refresh to show newly depleted balance
      } else {
        // Normal completion
        await new Promise(r => setTimeout(r, 600)); 
        alert(`Broadcast Complete! 🚀`);
        setMessage('');
        router.refresh(); // Refresh to show newly depleted balance
      }
    } catch (err: any) {
      console.error(err);
      alert(err.message || "Failed to securely connect for broadcast. Please try again.");
    } finally {
      setIsSending(false);
      setProgress(p => ({ ...p, active: false }));
      sendingRef.current = false;
    }
  };

  return (
    <div className="bg-[#F0E6D3] rounded-2xl border border-[rgba(90,55,20,0.13)] p-8 shadow-sm">
      <h2 style={{ fontFamily: "'Playfair Display', serif" }} className="text-xl font-bold text-[#1E1208] mb-6 flex items-center gap-2">
        <Send className="w-5 h-5 text-[#B5622A]" />
        New Broadcast
      </h2>

      <form onSubmit={handleSend} className="space-y-6">
        <div className="bg-[rgba(181,98,42,0.05)] border border-[rgba(181,98,42,0.12)] rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-[#B5622A] shrink-0 mt-0.5" />
            <div>
              <h4 className="text-[13px] font-bold text-[#7A4F30] uppercase tracking-wider">Recipient Audience</h4>
              <p className="text-[12px] text-[#9A7E65] mt-1 font-medium leading-relaxed">
                This message will be sent to <span className="text-[#B5622A] font-bold">{filteredMembers.length} {audienceLabels[audience]}</span> who have valid contact information.
              </p>
            </div>
          </div>
          <div className="shrink-0 w-full sm:w-auto">
            <select
              value={audience}
              onChange={(e: any) => setAudience(e.target.value)}
              className="w-full sm:w-auto px-4 py-2 bg-white border border-[rgba(181,98,42,0.2)] rounded-lg text-sm font-bold text-[#1E1208] outline-none focus:border-[#B5622A] cursor-pointer shadow-sm disabled:opacity-50"
              disabled={isSending}
            >
              <option value="all">All Contacts</option>
              <option value="men">Men Only</option>
              <option value="women">Women Only</option>
              <option value="youth">Youth Only</option>
              <option value="new_converts">New Converts</option>
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-[10px] font-bold text-[#C8B89A] uppercase tracking-widest">Message Content</label>
          <textarea 
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message here... (e.g., Don't forget tomorrow's special Sunday service!)"
            className="w-full px-5 py-4 bg-[rgba(255,220,170,0.05)] border border-[rgba(90,55,20,0.1)] rounded-2xl text-[14px] focus:border-[#B5622A] outline-none transition-all resize-none text-[#1E1208] font-medium placeholder:text-[#C8B89A]"
            required
          ></textarea>
          <div className="flex justify-between items-center mt-2 px-1">
            <span className="text-[10px] text-[#9A7E65] font-medium tracking-wide">1 SMS ≈ 160 characters</span>
            <div className="flex items-center gap-3">
              {message.length > 160 && (
                <span className="text-[9px] font-bold text-[#B5622A] animate-pulse uppercase tracking-widest bg-[rgba(181,98,42,0.1)] px-2 py-0.5 rounded">
                  {Math.ceil(message.length / 160)} Parts
                </span>
              )}
              <span className={`text-[11px] font-bold tracking-tight ${message.length > 160 ? 'text-[#B5622A]' : 'text-[#9A7E65]'}`}>
                {message.length} <span className="text-[9px] text-[#C8B89A] font-medium uppercase ml-0.5">chars</span>
              </span>
            </div>
          </div>
        </div>
        
        {progress.active && (
          <div className="pt-2 animate-in fade-in duration-500">
            <div className="flex justify-between items-center text-[11px] font-bold text-[#7A4F30] mb-2.5 uppercase tracking-wider">
              <span>Broadcasting...</span>
              <span>{Math.round(((progress.sent + progress.failed) / progress.total) * 100)}%</span>
            </div>
            <div className="w-full bg-[rgba(90,55,20,0.08)] rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-[#B5622A] h-1.5 rounded-full transition-all duration-300 relative shadow-[0_0_8px_rgba(181,98,42,0.3)]" 
                style={{ width: `${((progress.sent + progress.failed) / progress.total) * 100}%` }}
              >
                <div className="absolute top-0 bottom-0 left-0 right-0 bg-white/10 animate-pulse" />
              </div>
            </div>
            <div className="flex justify-between items-center text-[10px] text-[#9A7E65] font-bold mt-2 uppercase tracking-widest">
              <span>{progress.sent + progress.failed} / {progress.total} Processed</span>
              {progress.failed > 0 && <span className="text-[#B5622A]">{progress.failed} Failed</span>}
            </div>
          </div>
        )}

        <div className="pt-4">
          <button 
            type="submit"
            disabled={filteredMembers.length === 0 || !message.trim() || isSending}
            className="w-full sm:w-auto px-10 py-4 bg-[#2B1A0E] text-[#F5E6CE] rounded-xl text-sm font-bold hover:bg-[#3D2614] transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg flex items-center justify-center gap-3 uppercase tracking-widest"
          >
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Send Broadcast ({filteredMembers.length} {audienceLabels[audience]})
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
