'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function addNewConvert(formData: FormData) {
  const supabase = await createClient();
  
  const name = formData.get('name') as string;
  const contact = formData.get('contact') as string;
  const churchSlug = formData.get('churchSlug') as string;
  
  const { data: { user } } = await supabase.auth.getUser();
  
  const { data: church, error: lookupError } = await supabase
    .schema('church')
    .from('churches')
    .select('id')
    .eq('slug', churchSlug)
    .maybeSingle();

  const finalChurchId = church?.id;

  if (!finalChurchId) {
    const searchParams = new URLSearchParams({
      error: `Demo mode: Cannot save because church "${churchSlug}" doesn't natively exist in the database yet.`,
    });
    redirect(`/${churchSlug}/admin/new-converts?${searchParams.toString()}`);
  }

  const payload = {
    church_id: finalChurchId,
    name: name.trim(),
    contact: contact.trim(),
  };

  const { error } = await supabase
    .schema('church')
    .from('new_converts')
    .insert(payload);

  if (error) {
    console.error('Error adding new convert:', error);
    const searchParams = new URLSearchParams({
      error: `DB Insert Error: ${error.message}${error.details ? ` (${error.details})` : ''}`,
    });
    redirect(`/${churchSlug}/admin/new-converts?${searchParams.toString()}`);
  }

  revalidatePath(`/${churchSlug}/admin/new-converts`);
}
