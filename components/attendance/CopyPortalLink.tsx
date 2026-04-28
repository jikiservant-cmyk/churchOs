'use client';

import { useState } from 'react';
import { Copy, Check, Share2, Activity } from 'lucide-react';
import { toast } from 'sonner';

interface CopyPortalLinkProps {
  churchSlug: string;
  passkey: string;
}

export function CopyPortalLink({ churchSlug, passkey }: CopyPortalLinkProps) {
  const [copied, setCopied] = useState(false);

  const portalUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/${churchSlug}/usher`;

  const handleCopy = async () => {
    const textToCopy = `Church Attendance Portal\nLink: ${portalUrl}\nPasskey: ${passkey}`;
    
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      toast.success('Portal link and passkey copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error('Failed to copy link');
    }
  };

  const handleOpen = () => {
    window.open(portalUrl, '_blank');
  };

  return (
    <div className="flex items-center gap-2">
      <div className="hidden sm:flex flex-col items-end px-3 py-1 bg-[#FAF7F0] border border-[#E9E1D2] rounded-xl">
        <span className="text-[8px] font-black uppercase tracking-widest text-[#9A7E65]">Passkey</span>
        <span className="text-[12px] font-black text-[#B5622A] tracking-[0.2em]">{passkey}</span>
      </div>
      
      <button
        onClick={handleCopy}
        className="flex items-center gap-2 px-4 py-2 bg-[#B5622A] text-white rounded-xl text-[11px] font-black uppercase tracking-widest hover:bg-[#944F22] shadow-md transition-all active:scale-95"
      >
        {copied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
        {copied ? 'Copied' : 'Share Portal'}
      </button>

      <button
        onClick={handleOpen}
        className="flex items-center gap-2 px-4 py-2 bg-white border border-[#E9E1D2] text-[#B5622A] rounded-xl text-[11px] font-black uppercase tracking-widest hover:bg-[#FAF7F0] shadow-sm transition-all active:scale-95"
      >
        <Activity className="w-4 h-4" />
        Open Link
      </button>
    </div>
  );
}
