'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertTenantAdmin, AuthError } from '@/lib/auth/tenant';
import { normalizeUgPhone } from '@/lib/utils';
import {
  field, slugField, uuidField, cleanDate, cleanEmail, cleanGender, text, boolish, checkBulk,
  isRedirectError, GENERIC_SAVE_ERROR,
} from '@/lib/form-utils';

function back(slug: string | null, path: string, error: string): never {
  const q = new URLSearchParams({ error }).toString();
  redirect(slug ? `/${slug}/admin/${path}?${q}` : `/?${q}`);
}

function describe(err: unknown, fallback: string): string {
  return err instanceof AuthError ? err.message : fallback;
}

export async function addMember(formData: FormData) {
  const slug = slugField(formData);
  let error = '';

  try {
    const { supabase, church } = await assertTenantAdmin(slug ?? '');

    const fullName = `${field(formData, 'firstName', 60)} ${field(formData, 'lastName', 60)}`.trim();
    if (!fullName) back(church.slug, 'members', 'Name is required.');

    const phone = field(formData, 'phone', 32);
    let formattedPhone: string | null = null;
    if (phone) {
      formattedPhone = normalizeUgPhone(phone);
      if (!formattedPhone) back(church.slug, 'members', 'Invalid phone number format. Please enter a valid Ugandan number.');
    }

    // Silently skip duplicates (existing behaviour): same phone already a member or convert.
    let duplicate = false;
    if (formattedPhone) {
      const [{ data: m }, { data: c }] = await Promise.all([
        supabase.schema('church').from('members').select('id').eq('church_id', church.id).eq('phone_number', formattedPhone).limit(1).maybeSingle(),
        supabase.schema('church').from('new_converts').select('id').eq('church_id', church.id).eq('contact', formattedPhone).limit(1).maybeSingle(),
      ]);
      duplicate = !!(m || c);
    }

    if (!duplicate) {
      const { error: dbErr } = await supabase.schema('church').from('members').insert({
        church_id: church.id,
        full_name: fullName,
        phone_number: formattedPhone || '', // column is NOT NULL in some deployments
        email: cleanEmail(formData.get('email')),
        gender: cleanGender(formData.get('gender')),
        birthday: cleanDate(formData.get('birthday')),
        is_youth: formData.get('isYouth') === 'true',
        status: 'active',
      });
      if (dbErr) {
        console.error('[members] insert failed:', dbErr.code);
        error = GENERIC_SAVE_ERROR;
      }
    }
    if (!error) revalidatePath(`/${church.slug}/admin/members`);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error('[members] addMember failed:', (err as Error).message);
    error = describe(err, 'Failed to add member.');
  }

  if (error) back(slug, 'members', error);
}

export async function editMember(formData: FormData) {
  const slug = slugField(formData);
  const memberId = uuidField(formData, 'memberId');
  let error = '';

  try {
    const { supabase, church } = await assertTenantAdmin(slug ?? '');
    if (!memberId) back(church.slug, 'members', 'Invalid member.');

    const fullName = `${field(formData, 'firstName', 60)} ${field(formData, 'lastName', 60)}`.trim();
    if (!fullName) back(church.slug, `members/edit/${memberId}`, 'Name is required.');

    const phone = field(formData, 'phone', 32);
    let formattedPhone = '';
    if (phone) {
      const normalized = normalizeUgPhone(phone);
      if (!normalized) back(church.slug, `members/edit/${memberId}`, 'Invalid phone number format. Please enter a valid Ugandan number.');
      formattedPhone = normalized as string;
    }

    // Tenant-scoped: the id alone is never enough.
    const { error: dbErr } = await supabase
      .schema('church')
      .from('members')
      .update({
        full_name: fullName,
        phone_number: formattedPhone,
        gender: cleanGender(formData.get('gender')),
        birthday: cleanDate(formData.get('birthday')),
        is_youth: formData.get('isYouth') === 'true',
      })
      .eq('id', memberId)
      .eq('church_id', church.id);

    if (dbErr) {
      console.error('[members] update failed:', dbErr.code);
      error = GENERIC_SAVE_ERROR;
    } else {
      revalidatePath(`/${church.slug}/admin/members`);
      redirect(`/${church.slug}/admin/members`);
    }
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error('[members] editMember failed:', (err as Error).message);
    error = describe(err, 'Failed to update member.');
  }

  if (error) back(slug, memberId ? `members/edit/${memberId}` : 'members', error);
}

export async function bulkAddMembers(churchSlug: string, membersData: unknown[]) {
  try {
    const bad = checkBulk(membersData);
    if (bad) return { error: bad };
    const { supabase, church } = await assertTenantAdmin(churchSlug);

    const payload = (membersData as Record<string, unknown>[]).map((m) => {
      const rawPhone = text(m.phone ?? m.phone_number ?? m.phoneNumber, 32) ?? '';
      const phone = rawPhone ? normalizeUgPhone(rawPhone) ?? rawPhone : '';
      const first = text(m.first_name ?? m.firstName, 60) ?? '';
      const last = text(m.last_name ?? m.lastName, 60) ?? '';
      const fullName = text(m.full_name ?? m.fullName ?? m.name, 120) ?? (`${first} ${last}`.trim() || 'Unknown');
      return {
        church_id: church.id,
        full_name: fullName,
        phone_number: phone,
        email: cleanEmail(m.email),
        gender: cleanGender(m.gender),
        birthday: cleanDate(m.birthday ?? m.dob),
        is_youth: boolish(m.is_youth ?? m.isYouth ?? m.youth),
        status: 'active',
      };
    });

    const { error } = await supabase.schema('church').from('members').insert(payload);
    if (error) {
      console.error('[members] bulk insert failed:', error.code);
      return { error: GENERIC_SAVE_ERROR };
    }
    revalidatePath(`/${church.slug}/admin/members`);
    return { success: true };
  } catch (err) {
    console.error('[members] bulkAddMembers failed:', (err as Error).message);
    return { error: describe(err, 'Failed to import members.') };
  }
}
