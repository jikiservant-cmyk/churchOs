import { getChurchBySlug } from '@/lib/db';
import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import AdminSidebar from '@/components/AdminSidebar';
import { Suspense } from 'react';

export default async function AdminLayout({ 
  children, 
  params 
}: { 
  children: React.ReactNode, 
  params: Promise<{ church_slug: string }> 
}) {
  const resolvedParams = await params;
  const church = await getChurchBySlug(resolvedParams.church_slug);

  if (!church) {
    notFound();
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect(`/?error=Session Expired`);
  }

  // Role Check
  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'pastor') {
    redirect(`/?error=Access Denied`);
  }

  // Church Mismatch Check
  if (profile.tenant_id && church.id !== profile.tenant_id) {
    const { data: correctChurch } = await supabase
      .schema('church')
      .from('churches')
      .select('slug')
      .eq('id', profile.tenant_id)
      .maybeSingle();
      
    if (correctChurch?.slug && correctChurch.slug !== resolvedParams.church_slug) {
      redirect(`/${correctChurch.slug}/admin`);
    }
  }

  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }}
      className="min-h-screen bg-[#E4D5BC] flex"
    >
      <AdminSidebar church={church} churchSlug={resolvedParams.church_slug} />
      <main className="flex-1 overflow-y-auto px-6 py-8 md:px-12 md:py-10">
        <Suspense fallback={<div>Loading content...</div>}>
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </Suspense>
      </main>
    </div>
  );
}
