'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertTenantAdmin, AuthError } from '@/lib/auth/tenant';
import { normalizeUgPhone } from '@/lib/utils';
import {
  field, slugField, uuidField, cleanDate, cleanEmail, cleanGender, text, checkBulk,
  isRedirectError, GENERIC_SAVE_ERROR,
} from '@/lib/form-utils';

function back(slug: string | null, path: string, error: string): never {
  const q = new URLSearchParams({ error }).toString();
  redirect(slug ? `/${slug}/admin/${path}?${q}` : `/?${q}`);
}

const describe = (err: unknown, fallback: string) => (err instanceof AuthError ? err.message : fallback);

function phoneOrRaw(raw: string | null): string | null {
  if (!raw) return null;
  return normalizeUgPhone(raw) ?? raw;
}

function fromForm(fd: FormData) {
  const type = field(fd, 'visitorType', 40);
  return {
    full_name: field(fd, 'fullName', 120),
    phone_number: phoneOrRaw(field(fd, 'phoneNumber', 32) || null),
    email: cleanEmail(fd.get('email')),
    gender: cleanGender(fd.get('gender')),
    birthday: cleanDate(fd.get('birthday')),
    visitor_type: type || 'first_time',
    source: field(fd, 'source', 100) || null,
    home_church_name: field(fd, 'homeChurchName', 120) || null,
    home_church_city: field(fd, 'homeChurchCity', 120) || null,
    home_church_pastor: field(fd, 'homeChurchPastor', 120) || null,
    notes: field(fd, 'notes', 1000) || null,
  };
}

export async function addVisitor(formData: FormData) {
  const slug = slugField(formData);
  let error = '';

  try {
    const { supabase, church } = await assertTenantAdmin(slug ?? '');
    const payload = fromForm(formData);
    if (!payload.full_name) back(church.slug, 'visitors', 'Name is required.');

    const { error: dbErr } = await supabase.schema('church').from('visitors').insert({ church_id: church.id, ...payload });
    if (dbErr) {
      console.error('[visitors] insert failed:', dbErr.code);
      error = GENERIC_SAVE_ERROR;
    } else {
      revalidatePath(`/${church.slug}/admin/visitors`);
    }
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error('[visitors] add failed:', (err as Error).message);
    error = describe(err, 'Failed to add visitor.');
  }

  if (error) back(slug, 'visitors', error);
}

export async function editVisitor(formData: FormData) {
  const slug = slugField(formData);
  const visitorId = uuidField(formData, 'visitorId');
  let error = '';

  try {
    const { supabase, church } = await assertTenantAdmin(slug ?? '');
    if (!visitorId) back(church.slug, 'visitors', 'Invalid visitor.');
    const payload = fromForm(formData);
    if (!payload.full_name) back(church.slug, `visitors/edit/${visitorId}`, 'Name is required.');

    const { error: dbErr } = await supabase
      .schema('church')
      .from('visitors')
      .update(payload)
      .eq('id', visitorId)
      .eq('church_id', church.id);

    if (dbErr) {
      console.error('[visitors] update failed:', dbErr.code);
      error = GENERIC_SAVE_ERROR;
    } else {
      revalidatePath(`/${church.slug}/admin/visitors`);
      redirect(`/${church.slug}/admin/visitors`);
    }
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error('[visitors] edit failed:', (err as Error).message);
    error = describe(err, 'Failed to update visitor.');
  }

  if (error) back(slug, visitorId ? `visitors/edit/${visitorId}` : 'visitors', error);
}

export async function bulkAddVisitors(churchSlug: string, visitorsData: unknown[]) {
  try {
    const bad = checkBulk(visitorsData);
    if (bad) return { error: bad };
    const { supabase, church } = await assertTenantAdmin(churchSlug);

    const payload = (visitorsData as Record<string, unknown>[]).map((v) => ({
      church_id: church.id,
      full_name: text(v.fullName ?? v.full_name ?? v.name, 120) ?? 'Unknown',
      phone_number: phoneOrRaw(text(v.phoneNumber ?? v.phone_number, 32)),
      email: cleanEmail(v.email),
      gender: cleanGender(v.gender),
      birthday: cleanDate(v.birthday),
      visitor_type: text(v.visitorType ?? v.visitor_type, 40) ?? 'first_time',
      source: text(v.source, 100),
      home_church_name: text(v.homeChurchName ?? v.home_church_name, 120),
      home_church_city: text(v.homeChurchCity ?? v.home_church_city, 120),
      home_church_pastor: text(v.homeChurchPastor ?? v.home_church_pastor, 120),
      notes: text(v.notes, 1000),
    }));

    const { error } = await supabase.schema('church').from('visitors').insert(payload);
    if (error) {
      console.error('[visitors] bulk insert failed:', error.code);
      return { error: GENERIC_SAVE_ERROR };
    }
    revalidatePath(`/${church.slug}/admin/visitors`);
    return { success: true };
  } catch (err) {
    console.error('[visitors] bulk failed:', (err as Error).message);
    return { error: describe(err, 'Failed to import visitors.') };
  }
}
