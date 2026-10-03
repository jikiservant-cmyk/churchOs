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
