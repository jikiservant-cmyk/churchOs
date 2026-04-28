'use client';

import { useState } from 'react';
import { sendMissedYouMessages } from '@/lib/attendance-actions';
import { Send, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function SendMissedMessagesButton({ eventId, churchId, churchSlug }: { eventId: string, churchId: string, churchSlug: string }) {
  const [isSending, setIsSending] = useState(false);
  const [result, setResult] = useState<{ success?: boolean; count?: number; error?: string } | null>(null);
  const router = useRouter();

  const handleSend = async () => {
    setIsSending(true);
    setResult(null);
    try {
      const resp = await sendMissedYouMessages(churchId, churchSlug, eventId);
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
    <div className="flex flex-col items-center gap-3 mt-8">
      <button 
        onClick={handleSend}
        disabled={isSending}
        className="flex items-center gap-2 bg-[#B5622A] text-white px-6 py-3 rounded-2xl font-bold text-[13px] uppercase tracking-widest hover:bg-[#944F22] transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        Send &quot;Missed You&quot; SMS to Absentees
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
