'use server';

import { cookies, headers } from 'next/headers';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { getClientIp, normalizeSlug, rateLimit } from '@/lib/security';
import { APP_RESERVED_SLUGS, INVITE_COOKIE, INVITE_RE, denominationsEnabled } from '@/lib/denominations';

export type ProvisionState = {
  error?: string;
  success?: boolean;
  tenantId?: string;
  slug?: string;
  appType?: 'church';
};

export async function provisionTenant(_prev: ProvisionState, formData: FormData): Promise<ProvisionState> {
  const name = String(formData.get('name') ?? '').normalize('NFKC').trim();
  const slug = normalizeSlug(String(formData.get('slug') ?? '').normalize('NFKC').toLowerCase().trim());

  if (name.length < 3 || name.length > 50) {
    return { error: 'Church name must be between 3 and 50 characters' };
  }
  if (!slug || slug.length < 3 || slug.length > 30 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { error: 'Invalid workspace URL. Use lowercase letters, numbers and hyphens (e.g. grace-church)' };
  }

  if (APP_RESERVED_SLUGS.has(slug)) return { error: 'This workspace URL is reserved' };

  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return { error: 'You must be logged in to provision a church.' };

  // Abuse control: per user and (when the IP is known) per network.
  // Replaces "one church per IP", which blocked churches behind shared NAT / mobile carriers.
  const ip = getClientIp(await headers());
  const allowed =
    (await rateLimit(`provision-user:${user.id}`, 5, 60 * 60)) &&
    (ip === 'unknown' || (await rateLimit(`provision-ip:${ip}`, 5, 60 * 60)));
  if (!allowed) return { error: 'Too many attempts. Please try again later.' };

  try {
    let tenantId: string | null;
    let rpcError: { code?: string; message: string } | null;

    if (denominationsEnabled()) {
      // v3 authorises on auth.uid(), so it must run as the signed-in user (not the
      // service role). The invite code, if any, was stored by middleware from ?invite=.
      const cookieStore = await cookies();
      const rawInvite = cookieStore.get(INVITE_COOKIE)?.value ?? '';
      const res = await supabase.rpc('provision_church_v3', {
        p_user_id: user.id,
        p_name: name,
        p_slug: slug,
        p_role: 'pastor',
        p_invite_code: INVITE_RE.test(rawInvite) ? rawInvite : null,
      });
      tenantId = res.data as string | null;
      rpcError = res.error;
      if (!rpcError) cookieStore.delete(INVITE_COOKIE);
    } else {
      const admin = await createAdminClient();
      const res = await admin.rpc('provision_church_v2', {
        p_user_id: user.id,
        p_name: name,
        p_slug: slug,
        p_role: 'pastor',
        p_ip: ip === 'unknown' ? null : ip,
      });
      tenantId = res.data as string | null;
      rpcError = res.error;
    }

    if (rpcError) {
      // P0001 = our own RAISE EXCEPTION messages; 23505 = slug taken. Everything else stays generic.
      if (rpcError.code === 'P0001' || rpcError.code === '23505') return { error: rpcError.message };
      console.error('[provision] rpc failed:', rpcError.code, rpcError.message);
      return { error: 'Provisioning failed. Please try again.' };
    }
    if (!tenantId) throw new Error('no tenant id returned');

    return { success: true, tenantId, slug, appType: 'church' };
  } catch (err) {
    console.error('[provision] failed:', (err as Error).message);
    return { error: 'Provisioning failed. Please try again.' };
  }
}
