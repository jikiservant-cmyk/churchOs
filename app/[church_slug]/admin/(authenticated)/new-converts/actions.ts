'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { normalizeUgPhone } from '@/lib/utils';

export async function addNewConvert(formData: FormData) {
  const supabase = await createClient();
  let searchParams = '';
  
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
    searchParams = new URLSearchParams({
      error: `Demo mode: Cannot save because church "${churchSlug}" doesn't natively exist in the database yet.`,
    }).toString();
  } else {
    let formattedPhone = contact.trim();
    if (formattedPhone) {
      try {
        formattedPhone = normalizeUgPhone(formattedPhone);
      } catch (err: any) {
        console.error(err);
      }

      let hasConflict = false;

      // Check if phone number already exists in members
      const { data: existingMember } = await supabase
        .schema('church')
        .from('members')
        .select('id')
        .eq('church_id', finalChurchId)
        .eq('phone_number', formattedPhone)
        .maybeSingle();

      if (existingMember) {
        hasConflict = true;
        // Silently ignore
      }

      if (!hasConflict) {
        // Check if phone number already exists in new_converts
        const { data: existingConvert } = await supabase
          .schema('church')
          .from('new_converts')
          .select('id')
          .eq('church_id', finalChurchId)
          .eq('contact', formattedPhone)
          .maybeSingle();
        
        if (existingConvert) {
          hasConflict = true;
          // Silently ignore
        }
      }

      if (!hasConflict) {
        const payload = {
          church_id: finalChurchId,
          name: name.trim(),
          contact: formattedPhone,
        };

        const { error } = await supabase
          .schema('church')
          .from('new_converts')
          .insert(payload);

        if (error) {
          console.error('Error adding new convert:', error);
          searchParams = new URLSearchParams({
            error: `DB Insert Error: ${error.message}${error.details ? ` (${error.details})` : ''}`,
          }).toString();
        }
      }
    }
  }

  if (searchParams) {
    redirect(`/${churchSlug}/admin/new-converts?${searchParams}`);
  }

  revalidatePath(`/${churchSlug}/admin/new-converts`);
}
