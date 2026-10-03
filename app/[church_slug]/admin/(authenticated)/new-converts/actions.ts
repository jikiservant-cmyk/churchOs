'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertTenantAdmin, AuthError } from '@/lib/auth/tenant';
import { normalizeUgPhone } from '@/lib/utils';
import { field, slugField, uuidField, text, checkBulk, isRedirectError, GENERIC_SAVE_ERROR } from '@/lib/form-utils';

function back(slug: string | null, path: string, error: string): never {
  const q = new URLSearchParams({ error }).toString();
  redirect(slug ? `/${slug}/admin/${path}?${q}` : `/?${q}`);
}

const describe = (err: unknown, fallback: string) => (err instanceof AuthError ? err.message : fallback);

export async function addNewConvert(formData: FormData) {
  const slug = slugField(formData);
  let error = '';

  try {
    const { supabase, church } = await assertTenantAdmin(slug ?? '');
    const name = field(formData, 'name', 120);
    const contact = field(formData, 'contact', 64);
    if (!name) back(church.slug, 'new-converts', 'Name is required.');

    // Only de-duplicate when the contact is a valid phone number.
    let duplicate = false;
    const phone = contact ? normalizeUgPhone(contact) : null;
    if (phone) {
      const [{ data: m }, { data: c }] = await Promise.all([
        supabase.schema('church').from('members').select('id').eq('church_id', church.id).eq('phone_number', phone).limit(1).maybeSingle(),
        supabase.schema('church').from('new_converts').select('id').eq('church_id', church.id).eq('contact', phone).limit(1).maybeSingle(),
      ]);
      duplicate = !!(m || c);
    }

    if (!duplicate) {
      const { error: dbErr } = await supabase
        .schema('church')
        .from('new_converts')
        .insert({ church_id: church.id, name, contact: contact || null });
      if (dbErr) {
        console.error('[new-converts] insert failed:', dbErr.code);
        error = GENERIC_SAVE_ERROR;
      }
    }
    if (!error) revalidatePath(`/${church.slug}/admin/new-converts`);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error('[new-converts] add failed:', (err as Error).message);
    error = describe(err, 'Failed to add new convert.');
  }

  if (error) back(slug, 'new-converts', error);
}

export async function editNewConvert(formData: FormData) {
  const slug = slugField(formData);
  const convertId = uuidField(formData, 'convertId');
  let error = '';

  try {
    const { supabase, church } = await assertTenantAdmin(slug ?? '');
    if (!convertId) back(church.slug, 'new-converts', 'Invalid record.');
    const name = field(formData, 'name', 120);
    if (!name) back(church.slug, `new-converts/edit/${convertId}`, 'Name is required.');

    const { error: dbErr } = await supabase
      .schema('church')
      .from('new_converts')
      .update({ name, contact: field(formData, 'contact', 64) })
      .eq('id', convertId)
      .eq('church_id', church.id);

    if (dbErr) {
      console.error('[new-converts] update failed:', dbErr.code);
      error = GENERIC_SAVE_ERROR;
    } else {
      revalidatePath(`/${church.slug}/admin/new-converts`);
      redirect(`/${church.slug}/admin/new-converts`);
    }
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error('[new-converts] edit failed:', (err as Error).message);
    error = describe(err, 'Failed to update convert.');
  }

  if (error) back(slug, convertId ? `new-converts/edit/${convertId}` : 'new-converts', error);
}

export async function bulkAddNewConverts(churchSlug: string, convertsData: unknown[]) {
  try {
    const bad = checkBulk(convertsData);
    if (bad) return { error: bad };
    const { supabase, church } = await assertTenantAdmin(churchSlug);

    const payload = (convertsData as Record<string, unknown>[]).map((c) => ({
      church_id: church.id,
      name: text(c.name ?? c.full_name ?? c.fullName, 120) ?? 'Unknown',
      contact: text(c.contact ?? c.phone ?? c.phone_number, 64),
    }));

    const { error } = await supabase.schema('church').from('new_converts').insert(payload);
    if (error) {
      console.error('[new-converts] bulk insert failed:', error.code);
      return { error: GENERIC_SAVE_ERROR };
    }
    revalidatePath(`/${church.slug}/admin/new-converts`);
    return { success: true };
  } catch (err) {
    console.error('[new-converts] bulk failed:', (err as Error).message);
    return { error: describe(err, 'Failed to import new converts.') };
  }
}
