import { createClient } from '@/lib/supabase/server';
import LoginForm from '@/components/LoginForm';
import { getChurchBySlug } from '@/lib/db';
import { redirect } from 'next/navigation';
import { denominationsEnabled, firstRow, type LoginContext } from '@/lib/denominations';
import { Suspense } from 'react';

export const dynamic = 'force-dynamic';

export default async function RootLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; slug?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams || {};
  const supabase = await createClient();
  
  // Normalize params to strings
  const targetSlug = Array.isArray(resolvedSearchParams.slug) ? resolvedSearchParams.slug[0] : resolvedSearchParams.slug;
  let loginError = Array.isArray(resolvedSearchParams.error) ? resolvedSearchParams.error[0] : resolvedSearchParams.error;

  let redirectTo: string | null = null;

  // 1. Check if user is already logged in
  // ONLY redirect if there's no error in the URL (to avoid redirect loops)
  if (!loginError) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      
      if (user && denominationsEnabled()) {
        const { data: ctxData } = await supabase.rpc('my_login_context');
        if (firstRow<LoginContext>(ctxData)?.account_type === 'overseer') redirectTo = '/overseer';
      }

      if (user && !redirectTo) {
        // Attempt to find their church via their profile
        const { data: profile } = await supabase
          .from('admin_profiles')
          .select('role, tenant_id')
          .eq('id', user.id)
          .maybeSingle();

        // Verify they are a pastor
        const churchId = profile?.tenant_id;
        if (profile?.role === 'pastor' && churchId) {
           const { data: church } = await supabase
             .schema('church')
             .from('churches')
             .select('slug')
             .eq('id', churchId)
             .maybeSingle();
             
           if (church?.slug) {
             redirectTo = `/${church.slug}/admin`;
           }
        } else if (profile && profile.role !== 'pastor') {
           loginError = 'Access Denied: You do not have pastor permissions';
        }
      }
    } catch (err: any) {
      console.error('[RootPage] auth check failed:', (err as Error).message);
    }
  }

  // Perform redirect if needed, outside of try/catch
  if (redirectTo) {
    redirect(redirectTo);
  }

  // 3. Resolve Church Object for Branding
  // Only brand the page when a slug is explicitly requested. (It used to fall back
  // to the oldest church in the database, leaking another tenant's branding.)
  const finalSlug = targetSlug || 'admin';
  const churchData = targetSlug ? await getChurchBySlug(targetSlug) : null;

  const displayChurch = churchData || {
    id: 'placeholder',
    name: 'Church Management',
    slug: finalSlug,
    themeColor: 'bg-slate-900',
    logoUrl: `https://picsum.photos/seed/church-admin/200/200`
  };

  return (
    <Suspense fallback={<div className="min-h-screen bg-[#F5E6CE] animate-pulse" />}>
      <LoginForm 
        church={displayChurch} 
        churchSlug={finalSlug} 
        error={loginError} 
      />
    </Suspense>
  );
}
