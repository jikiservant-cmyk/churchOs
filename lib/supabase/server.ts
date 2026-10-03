import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/**
 * Cookie policy. Production uses SameSite=Lax (CSRF-safe). `None` is only
 * enabled when the app is deliberately embedded in a cross-site iframe
 * (e.g. an IDE preview) via ALLOW_CROSS_SITE_COOKIES=true.
 */
export function sessionCookieOptions<T extends Record<string, unknown>>(options: T) {
  const crossSite = process.env.ALLOW_CROSS_SITE_COOKIES === 'true';
  return {
    ...options,
    sameSite: crossSite ? ('none' as const) : ('lax' as const),
    secure: crossSite || process.env.NODE_ENV === 'production',
  };
}

function placeholderClient() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Supabase environment variables are not configured.');
  }
  // Dev-only: a dummy client that fails on actual requests but lets SSR boot.
  return createServerClient(
    'https://placeholder.supabase.co',
    'placeholder-key',
    { cookies: { getAll: () => [], setAll: () => {} } }
  );
}

export async function createClient() {
  const cookieStore = await cookies();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) return placeholderClient();

  return createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, sessionCookieOptions(options))
            });
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  );
}

/**
 * Service-role client. BYPASSES RLS — only use after the caller has been
 * authorised (see lib/auth/tenant.ts) and always scope queries by tenant id.
 * Stateless: it never reads or writes the user's cookies.
 */
export async function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) return placeholderClient() as unknown as ReturnType<typeof createSupabaseClient>;

  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
