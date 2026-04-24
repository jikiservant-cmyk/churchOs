import { getChurchBySlug } from '@/lib/db';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { Bell } from 'lucide-react';
import Image from 'next/image';
import AdminSidebar from '@/components/AdminSidebar';

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ church_slug: string }>;
}) {
  const resolvedParams = await params;
  const church = await getChurchBySlug(resolvedParams.church_slug) || {
    id: 'unknown',
    name: resolvedParams.church_slug,
    slug: resolvedParams.church_slug,
    themeColor: 'bg-slate-900',
    logoUrl: `https://picsum.photos/seed/${resolvedParams.church_slug}/200/200`
  };

  let profile: any = null;

  // Supabase Auth Check
    if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      const supabase = await createClient();
      let shouldRedirect = false;
      let redirectUrl = `/?error=Session Expired. Please login.`;
  
      try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) {
        shouldRedirect = true;
      } else {
        // Role Check and Church Matching
        let profileError = null;

        const { data: idProfile, error: idError } = await supabase
          .from('admin_profiles')
          .select('role, tenant_id, email')
          .eq('id', user.id)
          .maybeSingle();
        
        if (idProfile) {
          profile = idProfile;
        } else {
          profileError = idError;
        }

        // Fallback to email if ID lookup failed (RLS or unsynced profile)
        if (!profile && !profileError && user.email) {
          const { data: emailProfile, error: emailError } = await supabase
            .from('admin_profiles')
            .select('role, tenant_id, email')
            .eq('email', user.email)
            .maybeSingle();
          
          if (emailProfile) {
            profile = emailProfile;
          } else {
            profileError = emailError;
          }
        }

        if (profileError) {
          console.error('[AdminLayout] Profile lookup error:', {
            message: profileError.message,
            code: profileError.code,
            details: profileError.details,
            error: profileError
          });
        }

        if (profileError || profile?.role !== 'pastor') {
          shouldRedirect = true;
          redirectUrl = `/?error=Access Denied`;
        } else if (profile?.tenant_id && church.id !== profile.tenant_id) {
          // If the current church is a fallback/placeholder, we should be more lenient
          const isFallback = church.id === 'unknown' || church.id === 'placeholder' || church.id === 'fallback-id';

          // Try to find their actual church slug
          let correctSlug = null;
          try {
            const { data: correctChurch } = await supabase
              .schema('church')
              .from('churches')
              .select('slug')
              .eq('id', profile.tenant_id)
              .maybeSingle();
              
            correctSlug = correctChurch?.slug;
          } catch (e) {
             console.error('[AdminLayout] Failed to resolve correct church slug:', e);
          }

          if (correctSlug) {
            // Found their home!
            if (correctSlug !== resolvedParams.church_slug) {
              redirect(`/${correctSlug}/admin`);
            }
          } else if (!isFallback) {
            // They belong to a specific church but are visiting another one
            // AND we couldn't find a slug for their church (orphaned ID?)
            shouldRedirect = true;
            redirectUrl = `/?error=Church mismatch`;
          }
        }
      }
    } catch (e) {
       console.error("Layout Auth Crash:", e);
       shouldRedirect = true;
    }

    if (shouldRedirect) {
      redirect(redirectUrl);
    }
  }

  return (
    <div 
      style={{ fontFamily: "'Outfit', sans-serif" }}
      className="min-h-screen bg-[#E4D5BC] flex"
    >
      {/* Sidebar (Client Component for sliding toggle) */}
      <AdminSidebar church={church} churchSlug={resolvedParams.church_slug} />

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 max-h-screen overflow-hidden">
        {/* Top Header */}
        <header className="h-16 lg:h-20 bg-transparent flex items-center justify-between px-8 md:px-12 relative z-10">
          <div className="flex flex-col">
            <h1 style={{ fontFamily: "'Playfair Display', serif" }} className="text-xl font-bold text-[#1E1208] md:hidden">
              {church.name}
            </h1>
          </div>

          <div className="flex items-center gap-4 ml-auto">
            <button className="w-9 h-9 flex items-center justify-center bg-[#F0E6D3] border border-[rgba(90,55,20,0.15)] rounded-lg text-[#1E1208] hover:border-[#B5622A] transition-all relative">
              <Bell className="w-4 h-4" />
              <span className="absolute top-2 right-2 w-2 h-2 bg-[#B5622A] rounded-full border-2 border-[#F0E6D3]"></span>
            </button>
            <div className="w-9 h-9 rounded-lg bg-[#2B1A0E] flex items-center justify-center text-[#F5E6CE] font-bold text-sm cursor-pointer shadow-lg">
               {profile?.email?.[0].toUpperCase() || 'P'}
            </div>
          </div>
        </header>

        {/* Page Content */}
        <div className="flex-1 overflow-auto p-6 md:p-10">
          {children}
        </div>
      </main>
    </div>
  );
}
