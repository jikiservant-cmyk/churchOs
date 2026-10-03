/**
 * Shared security primitives: input validation, constant-time compares,
 * client IP resolution, same-origin checks and DB-backed rate limiting.
 *
 * Nothing in here trusts client-supplied tenant identifiers — see
 * lib/auth/tenant.ts for tenant authorisation.
 */
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';

// ── Validation ──────────────────────────────────────────────────────────────

/** Workspace slug: lowercase letters/digits/hyphens, 3–63 chars, no leading/trailing hyphen. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalises and validates a slug. Returns null when invalid.
 * IMPORTANT: slugs must never be passed to PostgREST `ilike` raw — `%` and `_`
 * are wildcards, so `/%/admin` would match an arbitrary tenant.
 */
export function normalizeSlug(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  return SLUG_RE.test(s) ? s : null;
}

export function isUuid(input: unknown): input is string {
  return typeof input === 'string' && UUID_RE.test(input);
}

/** Escapes `%`, `_` and `\` so user input can be used inside an ilike pattern. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Strips characters that would let a value break out of a PostgREST filter list. */
export function sanitizeSearch(input: unknown, max = 80): string {
  if (typeof input !== 'string') return '';
  return escapeLike(input.replace(/[,()"']/g, ' ').trim().slice(0, max));
}

// ── Constant-time compare ───────────────────────────────────────────────────

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── Client identity ─────────────────────────────────────────────────────────

/**
 * Best-effort client IP. Prefers headers that the hosting platform overwrites
 * (they cannot be spoofed by the client), then the right-most X-Forwarded-For
 * entry (appended by the nearest proxy). Never use the left-most XFF value.
 */
export function getClientIp(h: Headers): string {
  const vercel = h.get('x-vercel-forwarded-for');
  if (vercel) return vercel.split(',')[0].trim();
  const real = h.get('x-real-ip');
  if (real) return real.trim();
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return 'unknown';
}

// ── CSRF: same-origin check for cookie-authenticated route handlers ─────────

function allowedOrigins(req: Request): Set<string> {
  const set = new Set<string>();
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  if (host) {
    set.add(`https://${host}`);
    set.add(`http://${host}`);
  }
  for (const v of [process.env.NEXT_PUBLIC_APP_URL, process.env.APP_URL, ...(process.env.ALLOWED_ORIGINS || '').split(',')]) {
    const t = v?.trim().replace(/\/+$/, '');
    if (t && /^https?:\/\//.test(t)) set.add(t);
  }
  return set;
}

/**
 * Returns true when the request demonstrably originates from our own site.
 * Browsers always send `Origin` on cross-site POSTs; if it is missing we fall
 * back to `Sec-Fetch-Site`. Requests with neither are rejected (fail closed).
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin) return allowedOrigins(req).has(origin.replace(/\/+$/, ''));
  const site = req.headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none';
}

// ── Rate limiting (Postgres-backed, shared across all instances) ────────────

/**
 * Fixed-window rate limiter backed by `public.check_rate_limit` (service-role
 * only; see supabase/migrations). Returns true when the request is ALLOWED.
 *
 * `failClosed` (default) denies when the limiter itself is unavailable — use
 * that for auth, payments and SMS. Pass `false` for low-risk endpoints.
 */
export async function rateLimit(
  key: string,
  max: number,
  windowSeconds: number,
  opts: { failClosed?: boolean } = {},
): Promise<boolean> {
  const failClosed = opts.failClosed ?? true;
  try {
    const admin = await createAdminClient();
    const { data, error } = await admin.rpc('check_rate_limit', {
      p_key: key,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      console.error('[rateLimit] RPC error:', error.code, error.message);
      return !failClosed;
    }
    return data === true;
  } catch (err) {
    console.error('[rateLimit] unavailable:', (err as Error).message);
    return !failClosed;
  }
}

// ── Logging helpers ─────────────────────────────────────────────────────────

/** Masks a phone number for logs: +256772123456 → +2567****3456 */
export function maskPhone(p: string | null | undefined): string {
  if (!p) return '';
  return p.length <= 7 ? '****' : `${p.slice(0, 5)}****${p.slice(-4)}`;
}
