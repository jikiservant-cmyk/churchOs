import { createAdminClient } from '@/lib/supabase/server';

/**
 * Best-effort audit trail (church.audit_log). Never throws, never stores PII —
 * pass ids and counts, not names / phone numbers / message bodies.
 */
export async function audit(
  action: string,
  opts: { tenantId?: string | null; actor?: string | null; meta?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    const admin = await createAdminClient();
    const { error } = await admin.schema('church').from('audit_log').insert({
      tenant_id: opts.tenantId ?? null,
      actor: opts.actor ?? null,
      action,
      meta: opts.meta ?? {},
    });
    if (error) console.error('[audit] insert failed:', error.code, error.message);
  } catch (err) {
    console.error('[audit] unavailable:', (err as Error).message);
  }
}
