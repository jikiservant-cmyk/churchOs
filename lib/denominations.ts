/**
 * Denomination support. Everything here is behind DENOMINATIONS_ENABLED so the
 * app keeps using provision_church_v2 until the migration is confirmed on the
 * Supabase project this deployment points at.
 *
 * Not a 'use server' module (plain helpers only).
 */
export const INVITE_COOKIE = 'denom_invite';
export const INVITE_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function denominationsEnabled(): boolean {
  return process.env.DENOMINATIONS_ENABLED === 'true';
}

/** Workspace slugs that would be shadowed by a static route. */
export const APP_RESERVED_SLUGS = new Set(['overseer']);

export type LoginContext = {
  account_type: 'overseer' | 'pastor' | string | null;
  denomination_slug?: string | null;
  denomination_name?: string | null;
};

/** `my_login_context` returns a one-row table. */
export function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  return (data as T) ?? null;
}

// ── Overseer dashboard helpers ──────────────────────────────────────────────
export type ChurchRow = {
  church_id?: string;
  church_name?: string | null;
  attendance_30d?: number | null;
  last_active_at?: string | null;
  [k: string]: unknown;
};

export const ACTIVE_WINDOW_DAYS = 30;

/** A church counts as active when it had activity inside the window. */
export function churchStatus(lastActiveAt: string | null | undefined, now: number = Date.now()): 'active' | 'inactive' | 'never' {
  if (!lastActiveAt) return 'never';
  const t = new Date(lastActiveAt).getTime();
  if (Number.isNaN(t)) return 'never';
  return now - t <= ACTIVE_WINDOW_DAYS * 86_400_000 ? 'active' : 'inactive';
}

/** Highest attendance first; ties and missing values fall back to name. */
export function sortChurches<T extends ChurchRow>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.attendance_30d ?? 0) - Number(a.attendance_30d ?? 0) ||
      String(a.church_name ?? '').localeCompare(String(b.church_name ?? '')),
  );
}
