/** Small input-hygiene helpers shared by server actions (not a 'use server' module). */
import { normalizeSlug, isUuid } from '@/lib/security';

export const MAX_BULK_ROWS = 2000;

export function isRedirectError(err: unknown): boolean {
  const e = err as { message?: string; digest?: string } | null;
  return e?.message === 'NEXT_REDIRECT' || (typeof e?.digest === 'string' && e.digest.startsWith('NEXT_REDIRECT'));
}

/** Trimmed string field, hard-capped in length. */
export function field(fd: FormData, key: string, max = 200): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Validated slug from a form, or null. Never interpolate a raw form slug into a redirect. */
export function slugField(fd: FormData, key = 'churchSlug'): string | null {
  return normalizeSlug(fd.get(key));
}

export function uuidField(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  return isUuid(v) ? v : null;
}

export function cleanDate(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && !Number.isNaN(Date.parse(v.trim())) ? v.trim() : null;
}

export function cleanEmail(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().slice(0, 254) : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

export function cleanGender(v: unknown): 'male' | 'female' | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'male' || s === 'female' ? s : null;
}

export function text(v: unknown, max = 200): string | null {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '';
  return s || null;
}

export function boolish(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', '1', 'yes'].includes(v.trim().toLowerCase());
  return false;
}

/** Returns an error string if `rows` is not an acceptable bulk-upload array. */
export function checkBulk(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return 'No rows to import.';
  if (rows.length > MAX_BULK_ROWS) return `Too many rows (max ${MAX_BULK_ROWS} per import).`;
  if (rows.some((r) => !r || typeof r !== 'object')) return 'Invalid row in import.';
  return null;
}

export const GENERIC_SAVE_ERROR = 'Could not save. Please check the details and try again.';
