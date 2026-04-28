'use client';

import { useState } from 'react';
import { sendMissedYouMessages } from '@/lib/attendance-actions';
import { Send, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function GlobalSendMissedMessagesButton({ churchId, churchSlug }: { churchId: string, churchSlug: string }) {
  const [isSending, setIsSending] = useState(false);
  const [result, setResult] = useState<{ success?: boolean; count?: number; error?: string } | null>(null);
  const router = useRouter();

  const handleSend = async () => {
    setIsSending(true);
    setResult(null);
    try {
      const resp = await sendMissedYouMessages(churchId, churchSlug);
      setResult(resp);
      if (resp.success) {
        router.refresh();
      }
    } catch (e: any) {
      setResult({ error: e.message || 'An error occurred' });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-3">
      <button 
        onClick={handleSend}
        disabled={isSending}
        className="flex items-center gap-2 bg-[#B5622A] text-white px-5 py-2.5 rounded-xl font-bold text-[12px] uppercase tracking-widest hover:bg-[#944F22] transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        Message Flagged Absentees
      </button>
      
      {result?.success && (
        <p className="text-sm font-medium text-green-700 bg-green-50 px-4 py-2 rounded-lg border border-green-200">
          Successfully sent {result.count} messages.
        </p>
      )}
      
      {result?.error && (
        <p className="text-sm font-medium text-red-700 bg-red-50 px-4 py-2 rounded-lg border border-red-200">
          Failed to send: {result.error}
        </p>
      )}
    </div>
  );
}
