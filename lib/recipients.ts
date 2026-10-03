import type { SupabaseClient } from '@supabase/supabase-js';
import { isUuid } from '@/lib/security';
import { MAX_BROADCAST_RECIPIENTS } from '@/lib/queue-actions';

export interface RecipientRef {
  id: string;
  source: 'member' | 'new_convert';
}
export interface ResolvedRecipient {
  id: string;
  full_name: string;
  phone_number: string;
}

/** Validates the untrusted `[{id, source}]` array from the client. */
export function parseRecipientRefs(input: unknown): RecipientRef[] | { error: string } {
  if (!Array.isArray(input) || input.length === 0) return { error: 'No recipients selected.' };
  if (input.length > MAX_BROADCAST_RECIPIENTS) return { error: `Too many recipients (max ${MAX_BROADCAST_RECIPIENTS}).` };
  const seen = new Set<string>();
  const out: RecipientRef[] = [];
  for (const r of input) {
    if (!r || typeof r !== 'object') return { error: 'Invalid recipient.' };
    const { id, source } = r as Record<string, unknown>;
    if (!isUuid(id) || (source !== 'member' && source !== 'new_convert')) return { error: 'Invalid recipient.' };
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, source });
  }
  return out;
}

/**
 * Loads names + phone numbers from the DATABASE for the given ids, restricted to
 * the church. The client never supplies phone numbers (previously it could make
 * the server text arbitrary numbers at the church's expense).
 * Pass a user-scoped client so RLS applies as a second line of defence.
 */
export async function resolveRecipients(
  supabase: SupabaseClient,
  churchId: string,
  refs: RecipientRef[],
): Promise<ResolvedRecipient[]> {
  const memberIds = refs.filter((r) => r.source === 'member').map((r) => r.id);
  const convertIds = refs.filter((r) => r.source === 'new_convert').map((r) => r.id);
  const out: ResolvedRecipient[] = [];

  for (let i = 0; i < memberIds.length; i += 100) {
    const { data, error } = await supabase
      .schema('church').from('members').select('id, full_name, phone_number')
      .eq('church_id', churchId).in('id', memberIds.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const m of data ?? []) if (m.phone_number) out.push({ id: m.id, full_name: m.full_name, phone_number: m.phone_number });
  }
  for (let i = 0; i < convertIds.length; i += 100) {
    const { data, error } = await supabase
      .schema('church').from('new_converts').select('id, name, contact')
      .eq('church_id', churchId).in('id', convertIds.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const c of data ?? []) if (c.contact) out.push({ id: c.id, full_name: c.name, phone_number: c.contact });
  }
  return out;
}

/** Shared sender-id rule (AT sandbox rejects custom sender ids). */
export function effectiveSenderId(raw: unknown): string {
  const isSandbox = process.env.AT_USERNAME?.toLowerCase() === 'sandbox';
  return !isSandbox && typeof raw === 'string' ? raw.trim() : '';
}
