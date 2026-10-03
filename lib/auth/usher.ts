/**
 * Usher (passkey) sessions.
 *
 * Ushers have no Supabase account; they present a per-church passkey and get a
 * signed, httpOnly JWT cookie scoped to ONE church. The token embeds the
 * passkey's rotation timestamp, so rotating the passkey instantly revokes every
 * outstanding usher session for that church.
 */
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { createAdminClient } from '@/lib/supabase/server';
import { normalizeSlug, isUuid } from '@/lib/security';

const ISSUER = 'churchos';
const AUDIENCE = 'churchos-usher';
const TTL_SECONDS = 60 * 60 * 12; // 12h: one service day

export interface UsherSession {
  church_id: string;
  church_name: string;
  church_slug: string;
  role: 'usher';
}

function getJwtSecret(): Uint8Array {
  // Deliberately NO fallback to SUPABASE_SERVICE_ROLE_KEY: that key must never
  // double as a signing secret.
  const secret = process.env.USHER_JWT_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith('REPLACE_ME')) {
    throw new Error('USHER_JWT_SECRET must be set to a random string of at least 32 characters.');
  }
  return new TextEncoder().encode(secret);
}

export function usherCookieName(slug: string) {
  return `usher_session_${slug}`;
}

export async function issueUsherSession(church: { id: string; name: string; slug: string }, rotatedAt: string) {
  const token = await new SignJWT({
    church_id: church.id,
    church_name: church.name,
    church_slug: church.slug,
    role: 'usher',
    pv: new Date(rotatedAt).getTime(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(getJwtSecret());

  const cookieStore = await cookies();
  cookieStore.set(usherCookieName(church.slug), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || process.env.ALLOW_CROSS_SITE_COOKIES === 'true',
    sameSite: process.env.ALLOW_CROSS_SITE_COOKIES === 'true' ? 'none' : 'lax',
    path: '/',
    maxAge: TTL_SECONDS,
  });
}

/** Returns the verified session for this church slug, or null. */
export async function getUsherSession(rawSlug: string): Promise<UsherSession | null> {
  const slug = normalizeSlug(rawSlug);
  if (!slug) return null;

  const token = (await cookies()).get(usherCookieName(slug))?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.role !== 'usher' || payload.church_slug !== slug || !isUuid(payload.church_id)) return null;

    // Revocation: the token must match the CURRENT passkey generation.
    const admin = await createAdminClient();
    const { data: cred } = await admin
      .schema('church')
      .from('usher_credentials')
      .select('rotated_at')
      .eq('church_id', payload.church_id)
      .maybeSingle();
    if (!cred || new Date(cred.rotated_at).getTime() !== payload.pv) return null;

    return {
      church_id: payload.church_id as string,
      church_name: String(payload.church_name ?? ''),
      church_slug: slug,
      role: 'usher',
    };
  } catch {
    return null; // expired / tampered / misconfigured → treat as signed out
  }
}

export async function clearUsherSession(rawSlug: string) {
  const slug = normalizeSlug(rawSlug);
  if (slug) (await cookies()).delete(usherCookieName(slug));
}
