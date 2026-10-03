/**
 * Data-access-layer authorisation for tenant (church) admins.
 *
 * Every admin page, server action and API route MUST call one of these and use
 * the returned user-scoped Supabase client (RLS enforced). Do NOT rely on the
 * admin layout: Next.js does not guarantee layouts re-run for every RSC
 * request, and Server Actions never pass through layouts at all.
 */
import { cache } from 'react';
import { redirect, notFound } from 'next/navigation';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getChurchBySlug, type Church } from '@/lib/db';
import { normalizeSlug, isUuid } from '@/lib/security';

const ADMIN_ROLES = ['pastor'] as const;

export class AuthError extends Error {
  status: 401 | 403 | 404;
  constructor(message: string, status: 401 | 403 | 404 = 403) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export interface TenantAdminContext {
  user: User;
  church: Church;
  /** User-scoped client. RLS applies. Prefer this over the service-role client. */
  supabase: SupabaseClient;
}

type Result =
  | { ok: true; ctx: TenantAdminContext }
  | { ok: false; reason: 'no-session' | 'forbidden' | 'not-found' };

const resolveBySlug = cache(async (slug: string): Promise<Result> => {
  const normalized = normalizeSlug(slug);
  if (!normalized) return { ok: false, reason: 'not-found' };

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { ok: false, reason: 'no-session' };

  const church = await getChurchBySlug(normalized);
  if (!church) return { ok: false, reason: 'not-found' };

  // Own-profile read through RLS (policy: id = auth.uid()).
  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (
    !profile ||
    profile.tenant_id !== church.id ||
    !ADMIN_ROLES.includes(String(profile.role).toLowerCase() as (typeof ADMIN_ROLES)[number])
  ) {
    return { ok: false, reason: 'forbidden' };
  }

  return { ok: true, ctx: { user, church, supabase } };
});

/** For Server Actions / helpers: throws AuthError instead of redirecting. */
export async function assertTenantAdmin(slug: string): Promise<TenantAdminContext> {
  const r = await resolveBySlug(slug);
  if (r.ok) return r.ctx;
  if (r.reason === 'no-session') throw new AuthError('Please sign in again.', 401);
  if (r.reason === 'not-found') throw new AuthError('Church not found.', 404);
  throw new AuthError('You are not authorised to manage this church.', 403);
}

/** For pages/layouts: redirects or 404s on failure. */
export async function requireTenantAdmin(slug: string): Promise<TenantAdminContext> {
  const r = await resolveBySlug(slug);
  if (r.ok) return r.ctx;
  if (r.reason === 'not-found') notFound();
  if (r.reason === 'no-session') redirect('/?error=Session%20Expired');
  redirect('/?error=Access%20Denied');
}

/**
 * For API routes keyed by churchId. The tenant is taken from the caller's own
 * admin profile; a client-supplied churchId is only accepted if it matches.
 * Returns null when the caller is not an admin of that church.
 */
export async function getTenantAdminForChurchId(
  churchId: unknown,
): Promise<{ user: User; churchId: string; supabase: SupabaseClient } | null> {
  if (!isUuid(churchId)) return null;
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;

  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (
    !profile ||
    profile.tenant_id !== churchId ||
    !ADMIN_ROLES.includes(String(profile.role).toLowerCase() as (typeof ADMIN_ROLES)[number])
  ) {
    return null;
  }
  return { user, churchId: profile.tenant_id, supabase };
}

/** Like getTenantAdminForChurchId but without a client-supplied id. */
export async function getCurrentTenantAdmin(): Promise<{ user: User; churchId: string; supabase: SupabaseClient } | null> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  const { data: profile } = await supabase
    .from('admin_profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile?.tenant_id || String(profile.role).toLowerCase() !== 'pastor') return null;
  return { user, churchId: profile.tenant_id, supabase };
}
