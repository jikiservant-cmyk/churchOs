'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export type AuthState = {
  error?: string;
  success?: boolean;
  redirectTo?: string;
};

export async function login(prevState: AuthState, formData: FormData): Promise<AuthState> {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const churchSlug = formData.get('churchSlug') as string;

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { error: 'Supabase not configured' };
  }

  const supabase = await createClient();
  
  // 1. Sign in with Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError || !authData.user) {
    return { error: authError?.message || 'Login failed' };
  }

  // 2. Verify Role and find Church Slug in admin_profiles
  // We check for 'pastor' role specifically as requested.
  // We prioritize lookup by ID first, then fallback to email if necessary.
  
  const handleError = (msg: string, err: any) => {
    if (err) {
      console.error(`${msg}:`, {
        message: err.message,
        code: err.code,
        details: err.details,
        hint: err.hint,
        error: err
      });
    } else {
      console.warn(msg);
    }
  };

  let profile = null;
  let profileError = null;

  try {
    // Attempt 1: Fetch by ID (primary method)
    const { data: idData, error: idError } = await supabase
      .from('admin_profiles')
      .select('role, tenant_id, email')
      .eq('id', authData.user.id)
      .maybeSingle();
    
    if (idData) {
      profile = idData;
    } else {
      profileError = idError;
    }

    // Attempt 2: Fallback to Email (as requested by user)
    if (!profile && !profileError) {
      const { data: emailData, error: emailError } = await supabase
        .from('admin_profiles')
        .select('role, tenant_id, email')
        .eq('email', email)
        .maybeSingle();
      
      if (emailData) {
        profile = emailData;
        console.log('[Auth] Profile found via email fallback:', email);
      } else {
        profileError = emailError;
      }
    }
  } catch (err) {
    console.error('[Auth] Critical error during profile lookup:', err);
    profileError = err;
  }

  if (profileError || !profile) {
    if (profileError) {
      handleError('[Auth] Profile lookup failed', profileError);
    } else {
      console.warn('[Auth] No profile found for user after all attempts:', email);
    }
    
    // If no profile exists, the user might be authenticated in Auth but not authorized in our app.
    await supabase.auth.signOut();
    return { error: 'Access Denied: You are not registered as a pastor in our system.' };
  }

  if (profile.role !== 'pastor') {
    await supabase.auth.signOut();
    return { error: 'Access Denied: You do not have the required permissions.' };
  }

  // 3. Get the correct church slug
  let targetSlug = churchSlug;
  
  if (profile.tenant_id) {
    try {
      const { data: church, error: slugError } = await supabase
        .schema('church')
        .from('churches')
        .select('slug')
        .eq('id', profile.tenant_id)
        .maybeSingle();
      
      if (slugError) {
        handleError('[Auth] Error resolving church slug by ID', slugError);
      } else if (church?.slug) {
        targetSlug = church.slug;
      } else {
        console.warn(`[Auth] No slug found in churches table for tenant_id: ${profile.tenant_id}`);
      }
    } catch (err) {
      console.error('[Auth] Exception during church slug resolution:', err);
    }
  }

  console.log(`[Auth] User authorized as pastor. Redirecting to /${targetSlug}/admin (Profile tenant: ${profile.tenant_id})`);
  return { success: true, redirectTo: `/${targetSlug}/admin` };
}

export async function logout(formData: FormData) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  
  redirect(`/`);
}
