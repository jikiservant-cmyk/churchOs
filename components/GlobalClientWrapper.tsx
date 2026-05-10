'use client';

import { useEffect, useState } from 'react';
import SplashScreen from './SplashScreen';
import SWRegistration from './SWRegistration';

export default function GlobalClientWrapper({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ClientOnlyComponents />
      {children}
    </>
  );
}

function ClientOnlyComponents() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <>
      <SplashScreen />
      <SWRegistration />
    </>
  );
}
