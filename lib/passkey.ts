import crypto from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

/** Unambiguous alphabet (no 0/O/1/I). 32 symbols × 8 chars = 40 bits of entropy. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PASSKEY_LENGTH = 8;

const N = 16384, R = 8, P = 1, KEYLEN = 32;

/** Cryptographically random passkey (replaces the old client-side Math.random()). */
export function generatePasskey(length = PASSKEY_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** Uppercases and strips separators; returns null if the shape is impossible. */
export function normalizePasskeyInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 6 && s.length <= 12 ? s : null;
}

/** scrypt$N$r$p$salt$hash (base64) — self-describing so parameters can be raised later. */
export async function hashPasskey(passkey: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(passkey, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPasskey(passkey: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(passkey, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
