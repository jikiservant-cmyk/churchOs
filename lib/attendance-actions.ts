'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { AttendanceFlagStatus } from './attendance-types';
import { getChurchBySlug } from '@/lib/db';
import { assertTenantAdmin, getTenantAdminForChurchId, AuthError } from '@/lib/auth/tenant';
import { issueUsherSession, getUsherSession, clearUsherSession } from '@/lib/auth/usher';
import { generatePasskey, hashPasskey, verifyPasskey, normalizePasskeyInput } from '@/lib/passkey';
import { normalizeSlug, isUuid, getClientIp, rateLimit } from '@/lib/security';
import { audit } from '@/lib/audit';
import { enqueueBroadcast, processQueueBatch } from '@/lib/queue-actions';

type Fail = { error: string };
/** Uniform action result so clients can read `.success` / `.error` without narrowing. */
type R<T extends object = object> = Promise<{ success?: boolean; error?: string } & T>;

function failure(err: unknown, fallback: string): Fail {
  if (err instanceof AuthError) return { error: err.message };
  console.error(`[attendance] ${fallback}:`, (err as Error)?.message);
  return { error: fallback };
}

// ── Usher passkey login ─────────────────────────────────────────────────────

const GENERIC_PASSKEY_ERROR = 'Invalid passkey. Please check and try again.';

export async function validateUsherPasskey(churchSlug: string, passkeyInput: string) {
  const slug = normalizeSlug(churchSlug);
  const passkey = normalizePasskeyInput(passkeyInput);
  if (!slug || !passkey) return { success: false, error: GENERIC_PASSKEY_ERROR };

  // Brute-force protection: per (IP, church) and per church overall.
  const ip = getClientIp(await headers());
  const allowed =
    (await rateLimit(`usher:ip:${ip}:${slug}`, 8, 15 * 60)) &&
    (await rateLimit(`usher:slug:${slug}`, 40, 60 * 60));
  if (!allowed) return { success: false, error: 'Too many attempts. Please wait a few minutes and try again.' };

  try {
    const church = await getChurchBySlug(slug);
    const admin = await createAdminClient();
    const { data: cred } = church
      ? await admin.schema('church').from('usher_credentials').select('passkey_hash, rotated_at').eq('church_id', church.id).maybeSingle()
      : { data: null };

    // Same response for "no such church", "no passkey set" and "wrong passkey".
    if (!church || !cred || !(await verifyPasskey(passkey, cred.passkey_hash))) {
      return { success: false, error: GENERIC_PASSKEY_ERROR };
    }

    await issueUsherSession(church, cred.rotated_at);
    return { success: true, churchName: church.name };
  } catch (err) {
    console.error('[validateUsherPasskey] failed:', (err as Error).message);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}

export async function logoutUsher(churchSlug: string) {
  await clearUsherSession(churchSlug);
  return { success: true };
}

/**
 * Generates a NEW random passkey. Only the hash is stored, so the plaintext is
 * returned exactly once. Rotating revokes all active usher sessions.
 */
export async function rotateUsherPasskey(churchSlug: string): R<{ passkey?: string }> {
  try {
    const { church, user } = await assertTenantAdmin(churchSlug);
    if (!(await rateLimit(`passkey-rotate:${church.id}`, 10, 60 * 60))) {
      return { error: 'Too many passkey changes. Try again later.' };
    }
    const passkey = generatePasskey();
    const admin = await createAdminClient();
    const { error } = await admin
      .schema('church')
      .from('usher_credentials')
      .upsert({ church_id: church.id, passkey_hash: await hashPasskey(passkey), rotated_at: new Date().toISOString() }, { onConflict: 'church_id' });
    if (error) throw new Error(error.message);

    await audit('usher_passkey.rotated', { tenantId: church.id, actor: user.id });
    revalidatePath(`/${church.slug}/admin/attendance`);
    return { success: true, passkey };
  } catch (err) {
    return failure(err, 'Failed to update passkey.');
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

const SERVICE_TYPES = ['sunday_service', 'bible_study', 'prayer_meeting', 'youth_service'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

export async function createEvent(formData: FormData, churchId: string, churchSlug: string): R {
  try {
    const { church, supabase, user } = await assertTenantAdmin(churchSlug);
    if (churchId !== church.id) return { error: 'Access denied.' };

    const name = String(formData.get('name') ?? '').trim();
    const serviceType = String(formData.get('service_type') ?? '');
    const eventDate = String(formData.get('event_date') ?? '');
    const startTime = String(formData.get('start_time') ?? '');
    const location = String(formData.get('location') ?? '').trim();

    if (name.length < 1 || name.length > 100) return { error: 'Service name must be 1–100 characters.' };
    if (!(SERVICE_TYPES as readonly string[]).includes(serviceType)) return { error: 'Invalid service type.' };
    if (!DATE_RE.test(eventDate) || Number.isNaN(Date.parse(eventDate))) return { error: 'Invalid date.' };
    if (!TIME_RE.test(startTime)) return { error: 'Invalid start time.' };
    if (location.length > 200) return { error: 'Location is too long.' };

    // Insert only. The previous upsert silently reset an existing event's status
    // to 'upcoming' (re-opening completed services).
    const { data, error } = await supabase
      .schema('church')
      .from('events')
      .upsert(
        { church_id: church.id, name, service_type: serviceType, event_date: eventDate, start_time: startTime, location: location || null, status: 'upcoming', created_by: user.id },
        { onConflict: 'church_id,service_type,event_date,start_time', ignoreDuplicates: true },
      )
      .select('id');

    if (error) {
      console.error('[createEvent] failed:', error.code, error.message);
      return { error: 'Failed to create the service.' };
    }
    if (!data || data.length === 0) return { error: 'A service of this type already exists at that date and time.' };

    revalidatePath(`/${church.slug}/admin/attendance`);
    return { success: true };
  } catch (err) {
    return failure(err, 'Failed to create the service.');
  }
}

const STATUS_ORDER = ['upcoming', 'active', 'completed'] as const;

export async function updateEventStatus(eventId: string, status: 'upcoming' | 'active' | 'completed', churchSlug: string): R {
  try {
    if (!isUuid(eventId) || !(STATUS_ORDER as readonly string[]).includes(status)) return { error: 'Invalid request.' };

    // 1. Authorise FIRST (previously admin-client writes ran before any check).
    const { church, supabase } = await assertTenantAdmin(churchSlug);

    // 2. The event must belong to the caller's church (RLS + explicit filter).
    const { data: event } = await supabase
      .schema('church')
      .from('events')
      .select('id, status')
      .eq('id', eventId)
      .eq('church_id', church.id)
      .maybeSingle();
    if (!event) return { error: 'Event not found.' };

    if (STATUS_ORDER.indexOf(status) <= STATUS_ORDER.indexOf(event.status)) {
      return { error: `Service is already ${event.status}.` };
    }

    if (status === 'completed') {
      // Atomic: mark absentees (never overwriting existing rows), recount, complete.
      const admin = await createAdminClient();
      const { error } = await admin.schema('church').rpc('finalize_event', { p_event_id: eventId });
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase
        .schema('church')
        .from('events')
        .update({ status })
        .eq('id', eventId)
        .eq('church_id', church.id);
      if (error) throw new Error(error.message);
    }

    revalidatePath(`/${church.slug}/admin/attendance`);
    revalidatePath(`/${church.slug}/admin/attendance/${eventId}`);
    revalidatePath(`/${church.slug}/usher/dashboard`);
    return { success: true };
  } catch (err) {
    return failure(err, 'Could not update the service.');
  }
}

// ── Check-in (admin OR usher) ───────────────────────────────────────────────

async function authorizeCheckIn(churchSlug: string, eventId: string) {
  const slug = normalizeSlug(churchSlug);
  if (!slug || !isUuid(eventId)) throw new AuthError('Invalid request.', 404);

  const admin = await createAdminClient();
  const { data: event } = await admin
    .schema('church')
    .from('events')
    .select('id, church_id, status')
    .eq('id', eventId)
    .maybeSingle();
  if (!event) throw new AuthError('Event not found.', 404);

  // 1. Usher session scoped to this church (and this event's church).
  const usher = await getUsherSession(slug);
  if (usher && usher.church_id === event.church_id) {
    // Ushers may only touch a service that is live right now.
    if (event.status !== 'active') throw new AuthError('This service is not active.', 403);
    return { admin, event, actor: `usher:${event.church_id}`, actorUserId: null as string | null, slug };
  }

  // 2. Logged-in admin of this church.
  const { church, user } = await assertTenantAdmin(slug);
  if (church.id !== event.church_id) throw new AuthError('You are not authorised for this service.', 403);
  return { admin, event, actor: user.id, actorUserId: user.id, slug };
}

function revalidateAttendance(slug: string, eventId: string) {
  revalidatePath(`/${slug}/usher/dashboard`);
  revalidatePath(`/${slug}/admin/attendance`);
  revalidatePath(`/${slug}/admin/attendance/${eventId}`);
}

const ATTENDANCE_STATUSES = ['present', 'late', 'absent', 'excused'] as const;

export async function markAttendance(
  churchSlug: string,
  eventId: string,
  memberId: string,
  status: 'present' | 'late' | 'absent' | 'excused' = 'present',
): R {
  try {
    if (!isUuid(memberId) || !(ATTENDANCE_STATUSES as readonly string[]).includes(status)) return { error: 'Invalid request.' };
    const { admin, event, actorUserId, slug } = await authorizeCheckIn(churchSlug, eventId);
    if (!(await rateLimit(`checkin:${event.church_id}`, 600, 60, { failClosed: false }))) {
      return { error: 'Too many check-ins. Slow down a moment.' };
    }

    // Single transaction: tenant-consistency check, upsert, and count update.
    const { error } = await admin.schema('church').rpc('set_attendance', {
      p_event_id: eventId,
      p_member_id: memberId,
      p_status: status,
      p_recorded_by: actorUserId,
    });
    if (error) {
      console.error('[markAttendance] rpc failed:', error.code, error.message);
      return { error: /does not belong/i.test(error.message) ? 'Member not found.' : 'Failed to record check-in.' };
    }

    revalidateAttendance(slug, eventId);
    return { success: true };
  } catch (err) {
    return failure(err, 'Failed to record check-in.');
  }
}

export async function removeAttendance(churchSlug: string, eventId: string, memberId: string): R {
  try {
    if (!isUuid(memberId)) return { error: 'Invalid request.' };
    const { admin, event, slug } = await authorizeCheckIn(churchSlug, eventId);

    // Tenant scope: the member must belong to the event's church.
    const { data: member } = await admin.schema('church').from('members').select('id').eq('id', memberId).eq('church_id', event.church_id).maybeSingle();
    if (!member) return { error: 'Member not found.' };

    const { error } = await admin.schema('church').rpc('clear_attendance', { p_event_id: eventId, p_member_id: memberId });
    if (error) {
      console.error('[removeAttendance] rpc failed:', error.code, error.message);
      return { error: 'Failed to remove check-in.' };
    }
    revalidateAttendance(slug, eventId);
    return { success: true };
  } catch (err) {
    return failure(err, 'Failed to remove check-in.');
  }
}

// ── Inactivity / follow-up flags ────────────────────────────────────────────

export async function runInactivityDetection(churchId: string, churchSlug: string): R<{ count?: unknown }> {
  try {
    const { church, supabase } = await assertTenantAdmin(churchSlug);
    if (churchId !== church.id) return { error: 'Access denied.' };
    if (!(await rateLimit(`inactivity:${church.id}`, 12, 60 * 60))) return { error: 'Please wait before refreshing again.' };

    // Runs as the user: the SQL function itself rejects any other tenant.
    const { data, error } = await supabase.schema('church').rpc('refresh_inactive_30_days', { p_church_id: church.id });
    if (error) {
      console.error('[runInactivityDetection] failed:', error.code, error.message);
      return { error: 'Failed to refresh alerts.' };
    }
    revalidatePath(`/${church.slug}/admin/attendance`);
    return { success: true, count: data };
  } catch (err) {
    return failure(err, 'Failed to refresh alerts.');
  }
}

export async function getAttendanceFlags(churchId: string) {
  const ctx = await getTenantAdminForChurchId(churchId);
  if (!ctx) return { error: 'Access denied.' };

  const { data, error } = await ctx.supabase
    .schema('church')
    .from('attendance_flags')
    .select('id, member_id, flag_type, status, notes, created_at, members:member_id ( full_name, phone_number )')
    .eq('church_id', ctx.churchId)
    .in('status', ['open', 'followed_up'])
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('[getAttendanceFlags] failed:', error.code, error.message);
    return { error: 'Failed to load alerts.' };
  }
  return { data };
}

const FLAG_STATUSES: AttendanceFlagStatus[] = ['open', 'followed_up', 'resolved'];

export async function updateAttendanceFlagStatus(flagId: string, status: AttendanceFlagStatus, churchSlug: string): R {
  try {
    if (!isUuid(flagId) || !FLAG_STATUSES.includes(status)) return { error: 'Invalid request.' };
    const { church, supabase } = await assertTenantAdmin(churchSlug);
    const { data, error } = await supabase
      .schema('church')
      .from('attendance_flags')
      .update({ status })
      .eq('id', flagId)
      .eq('church_id', church.id)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data?.length) return { error: 'Alert not found.' };

    revalidatePath(`/${church.slug}/admin/attendance`);
    return { success: true };
  } catch (err) {
    return failure(err, 'Failed to update alert.');
  }
}

// ── "We missed you" messages (queued, not sent inline) ──────────────────────

const DEFAULT_MISSED_TEMPLATE =
  'Hello {first_name}! We missed you at church. We pray you are well and hope to see you again soon. Blessings from your church family.';

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function sendMissedYouMessages(churchId: string, churchSlug: string, eventId?: string, customMessage?: string): R<{ count?: number }> {
  try {
    const { church, supabase, user } = await assertTenantAdmin(churchSlug);
    if (churchId !== church.id) return { error: 'Access denied.' };
    if (eventId !== undefined && !isUuid(eventId)) return { error: 'Invalid request.' };

    const template = (customMessage ?? '').trim() || DEFAULT_MISSED_TEMPLATE;
    if (template.length > 480) return { error: 'Message is too long (max 480 characters).' };
    if (!(await rateLimit(`missed:${church.id}`, 6, 60 * 60))) return { error: 'Too many bulk sends. Try again later.' };

    // Best effort: refresh "missed 3 Sundays" flags (deployed edge function).
    try {
      await supabase.functions.invoke('sync_missed_3_sundays_flags', { method: 'POST' });
    } catch (e) {
      console.error('[sendMissedYouMessages] flag sync failed:', (e as Error).message);
    }

    // Target event: explicit, else the latest completed one — always inside this church.
    let targetEventId = eventId;
    if (!targetEventId) {
      const { data: latest } = await supabase
        .schema('church').from('events').select('id')
        .eq('church_id', church.id).eq('status', 'completed')
        .order('event_date', { ascending: false }).limit(1).maybeSingle();
      targetEventId = latest?.id;
    } else {
      const { data: ev } = await supabase.schema('church').from('events').select('id').eq('id', targetEventId).eq('church_id', church.id).maybeSingle();
      if (!ev) return { error: 'Event not found.' };
    }

    const toMessage = new Set<string>();
    const present = new Set<string>();
    if (targetEventId) {
      const { data: logs, error } = await supabase
        .schema('church').from('attendance_logs').select('member_id, attendance_status')
        .eq('church_id', church.id).eq('event_id', targetEventId)
        .in('attendance_status', ['absent', 'present', 'late']);
      if (error) throw new Error(error.message);
      for (const l of logs ?? []) {
        if (l.attendance_status === 'absent') toMessage.add(l.member_id);
        else present.add(l.member_id);
      }
    }

    const { data: openFlags, error: flagsError } = await supabase
      .schema('church').from('attendance_flags').select('id, member_id')
      .eq('church_id', church.id).eq('flag_type', 'missed_3_sundays').eq('status', 'open');
    if (flagsError) throw new Error(flagsError.message);

    const flagIds: string[] = [];
    for (const f of openFlags ?? []) {
      if (!present.has(f.member_id)) {
        toMessage.add(f.member_id);
        flagIds.push(f.id);
      }
    }
    if (toMessage.size === 0) return { success: true, count: 0 };

    const members: { id: string; full_name: string; phone_number: string | null }[] = [];
    for (const ids of chunk([...toMessage], 100)) {
      const { data, error } = await supabase
        .schema('church').from('members').select('id, full_name, phone_number')
        .eq('church_id', church.id).in('id', ids);
      if (error) throw new Error(error.message);
      members.push(...(data ?? []));
    }
    const recipients = members.filter((m) => !!m.phone_number).map((m) => ({ id: m.id, full_name: m.full_name, phone_number: m.phone_number as string }));
    if (recipients.length === 0) return { success: true, count: 0 };

    // Cheap pre-flight; the authoritative check is the atomic per-message debit.
    const { data: wallet } = await supabase.schema('public').from('wallets').select('balance, sms_rate').eq('tenant_id', church.id).maybeSingle();
    if (!wallet) return { error: 'Billing account not found.' };
    if (wallet.balance < wallet.sms_rate) return { error: 'Insufficient SMS balance. Please top up.' };

    const { data: row } = await supabase.schema('church').from('churches').select('sender_id').eq('id', church.id).maybeSingle();
    const isSandbox = process.env.AT_USERNAME?.toLowerCase() === 'sandbox';
    const senderId = !isSandbox && row?.sender_id ? String(row.sender_id).trim() : '';

    const { enqueued } = await enqueueBroadcast({
      tenantId: church.id,
      message: template,
      audience: 'missed_you',
      senderId,
      recipients,
      createdBy: user.id,
    });

    // Close follow-up flags for everyone we just queued a message for.
    if (flagIds.length) {
      const queuedIds = new Set(recipients.map((r) => r.id));
      const done = (openFlags ?? []).filter((f) => queuedIds.has(f.member_id)).map((f) => f.id);
      for (const ids of chunk(done, 100)) {
        await supabase.schema('church').from('attendance_flags').update({ status: 'followed_up' }).eq('church_id', church.id).in('id', ids);
      }
    }

    await audit('missed_you.enqueued', { tenantId: church.id, actor: user.id, meta: { count: enqueued } });

    // Deliver after the response is sent (no inline loop inside the request).
    after(async () => {
      try {
        await processQueueBatch({ tenantId: church.id, batchSize: 15 });
      } catch (e) {
        console.error('[sendMissedYouMessages] background processing failed:', (e as Error).message);
      }
    });

    revalidatePath(`/${church.slug}/admin/attendance`);
    return { success: true, count: enqueued };
  } catch (err) {
    return failure(err, 'Failed to queue messages.');
  }
}
