// lib/sms-queue.ts
// Async SMS queue — replaces direct Africa's Talking calls in the request lifecycle.
//
// Instead of:
//   await at.SMS.send({ to: [phone], message: body }); // blocks for 500–2000ms
//
// Use:
//   await queueSms(supabase, { tenantId, recipients: [phone], message: body });
//   // Returns immediately. The Edge Function processes the queue every 30s.
//
// See: supabase/functions/process-sms-queue/index.ts for the Edge Function.
// See: migrations/003_sms_queue_table.sql for the table schema.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface QueueSmsOptions {
  tenantId:        string;
  recipients:      string[];    // Array of phone numbers
  message:         string;
  senderId?:       string;      // Africa's Talking sender ID (optional)
  idempotencyKey?: string;      // Prevents duplicate sends; auto-generated if omitted
  scheduledAt?:    Date;        // Schedule for the future (defaults to now)
}

export interface QueueSmsResult {
  queued: number;
  errors: string[];
}

const BATCH_SIZE = 100; // Insert up to 100 rows per Supabase call

/**
 * Enqueue one or more SMS messages for async delivery.
 * Returns immediately — does NOT wait for the SMS to be sent.
 *
 * The Edge Function (process-sms-queue) picks up pending rows on a 30-second cron.
 */
export async function queueSms(
  supabase: SupabaseClient,
  options: QueueSmsOptions
): Promise<QueueSmsResult> {
  const {
    tenantId,
    recipients,
    message,
    senderId,
    idempotencyKey,
    scheduledAt,
  } = options;

  if (!recipients.length) {
    return { queued: 0, errors: ['No recipients provided'] };
  }

  const errors: string[] = [];
  let queued = 0;
  const baseKey = idempotencyKey ?? `${tenantId}-${Date.now()}`;

  // Batch inserts to avoid hitting Supabase row limits
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients
      .slice(i, i + BATCH_SIZE)
      .map((phone, idx) => ({
        tenant_id:        tenantId,
        recipient_phone:  phone.trim(),
        body:             message,
        sender_id:        senderId ?? null,
        status:           'pending',
        idempotency_key:  `${baseKey}-${i + idx}`,
        scheduled_at:     (scheduledAt ?? new Date()).toISOString(),
      }));

    const { data, error } = await supabase
      .from('sms_queue')
      .insert(batch)
      .select('id');

    if (error) {
      console.error('[sms-queue] Insert error:', error);
      errors.push(error.message);
    } else {
      queued += data?.length ?? 0;
    }
  }

  return { queued, errors };
}

/**
 * Cancel pending messages in the queue for a tenant.
 * Useful if an admin accidentally triggers a bulk send.
 */
export async function cancelPendingSms(
  supabase: SupabaseClient,
  tenantId: string
): Promise<{ cancelled: number; error: string | null }> {
  const { data, error } = await supabase
    .from('sms_queue')
    .update({ status: 'cancelled' })
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .select('id');

  return {
    cancelled: data?.length ?? 0,
    error: error?.message ?? null,
  };
}

/**
 * Get a summary of SMS queue status for a tenant.
 * Useful for a dashboard widget showing pending/sent/failed counts.
 */
export async function getSmsQueueStats(
  supabase: SupabaseClient,
  tenantId: string,
  since?: Date
) {
  let query = supabase
    .from('sms_queue')
    .select('status')
    .eq('tenant_id', tenantId);

  if (since) {
    query = query.gte('created_at', since.toISOString());
  }

  const { data, error } = await query;
  if (error) return { data: null, error: error.message };

  const stats = (data ?? []).reduce(
    (acc, row) => {
      acc[row.status as string] = (acc[row.status as string] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return {
    data: {
      pending:    stats['pending']    ?? 0,
      processing: stats['processing'] ?? 0,
      sent:       stats['sent']       ?? 0,
      failed:     stats['failed']     ?? 0,
      cancelled:  stats['cancelled']  ?? 0,
      total:      data.length,
    },
    error: null,
  };
}
