'use client';

import { useEffect } from 'react';

export default function SWRegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator && window.location.hostname !== 'localhost') {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
          /* registration is best-effort */
        });
      });
    }
  }, []);

  return null;
}
