'use client';

import { useState } from 'react';
import { Copy, Check, Activity } from 'lucide-react';
import { toast } from 'sonner';

interface CopyPortalLinkProps {
  churchSlug: string;
}

export function CopyPortalLink({ churchSlug }: CopyPortalLinkProps) {
  const [copied, setCopied] = useState(false);

  const portalUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/${churchSlug}/usher`;

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      
      setCopied(true);
      toast.success('Link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handleCopy = () => copyToClipboard(portalUrl);

  const handleOpen = () => {
    window.open(portalUrl, '_blank');
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleCopy}
        className="flex items-center gap-2 px-4 py-2 bg-[#B5622A] text-white rounded-xl text-[11px] font-black uppercase tracking-widest hover:bg-[#944F22] shadow-md transition-all active:scale-95"
      >
        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        {copied ? 'Copied Link' : 'Copy Link'}
      </button>

      <button
        onClick={handleOpen}
        className="flex items-center gap-2 px-4 py-2 bg-white border border-[#E9E1D2] text-[#B5622A] rounded-xl text-[11px] font-black uppercase tracking-widest hover:bg-[#FAF7F0] shadow-sm transition-all active:scale-95"
      >
        <Activity className="w-4 h-4" />
        Open
      </button>
    </div>
  );
}
