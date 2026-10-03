'use client';

import { useState } from 'react';
import { Key, Loader2, RefreshCw, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { rotateUsherPasskey } from '@/lib/attendance-actions';

/**
 * Passkeys are stored hashed, so the current one can never be displayed again.
 * "Generate" creates a new random one (shown ONCE) and signs out existing ushers.
 */
export function PasskeyManager({
  churchSlug,
  hasPasskey: initialHasPasskey,
  rotatedAt: initialRotatedAt,
}: {
  churchSlug: string;
  hasPasskey: boolean;
  rotatedAt: string | null;
}) {
  const [hasPasskey, setHasPasskey] = useState(initialHasPasskey);
  const [rotatedAt, setRotatedAt] = useState(initialRotatedAt);
  const [newPasskey, setNewPasskey] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleGenerate = async () => {
    if (hasPasskey && !window.confirm('Generate a new passkey? The current one stops working and ushers will be signed out.')) return;
    setIsSaving(true);
    try {
      const result = await rotateUsherPasskey(churchSlug);
      if (result.success && result.passkey) {
        setNewPasskey(result.passkey);
        setHasPasskey(true);
        setRotatedAt(new Date().toISOString());
        toast.success('New passkey generated. Copy it now: it will not be shown again.');
      } else {
        toast.error(result.error || 'Failed to generate passkey');
      }
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setIsSaving(false);
    }
  };

  const copy = async () => {
    if (!newPasskey) return;
    try {
      await navigator.clipboard.writeText(newPasskey);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy. Select and copy it manually.');
    }
  };

  return (
    <div className="bg-[#FAF7F0] border border-[#E9E1D2] rounded-2xl p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#FDE9D9] rounded-xl text-[#B5622A]">
            <Key className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-[#1E1208] tracking-tight">Usher Passkey</h3>
            <p className="text-[12px] text-[#9A7E65]">
              {hasPasskey
                ? `Active${rotatedAt ? ` · set ${new Date(rotatedAt).toLocaleDateString()}` : ''}. For security it cannot be viewed again; generate a new one if it is lost.`
                : 'No passkey yet. Generate one to let ushers sign in.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 bg-white border border-[#E9E1D2] rounded-xl px-4 py-2.5 shadow-sm">
          {newPasskey && (
            <>
              <span className="text-lg font-black text-[#B5622A] tracking-[0.3em] font-mono select-all">{newPasskey}</span>
              <button type="button" onClick={copy} className="text-[#2B1A0E] hover:text-[#B5622A]" title="Copy passkey">
                <Copy className="w-4 h-4" />
              </button>
              <div className="w-px h-6 bg-[#E9E1D2] mx-1" />
            </>
          )}
          <button
            onClick={handleGenerate}
            disabled={isSaving}
            type="button"
            className="flex items-center gap-2 text-[#2B1A0E] hover:text-[#B5622A] transition-colors disabled:opacity-50"
            title="Generate new passkey"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span className="text-[11px] font-bold uppercase tracking-widest">{hasPasskey ? 'Regenerate' : 'Generate'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
