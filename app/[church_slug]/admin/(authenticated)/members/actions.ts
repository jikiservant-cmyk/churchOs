'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { normalizeUgPhone } from '@/lib/utils';

export async function addMember(formData: FormData) {
  let churchSlug = formData.get('churchSlug') as string;
  let searchParams = '';

  try {
    const supabase = await createClient();
    
    const firstName = formData.get('firstName') as string;
    const lastName = formData.get('lastName') as string;
    const fullName = `${firstName} ${lastName}`.trim();
    const phone = formData.get('phone') as string;
    const email = formData.get('email') as string;
    const gender = formData.get('gender') as string;
    const birthday = formData.get('birthday') as string;
    const isYouth = formData.get('isYouth') === 'true';
    
    const { data: { user } } = await supabase.auth.getUser();

    const { data: church, error: lookupError } = await supabase
      .schema('church')
      .from('churches')
      .select('id')
      .eq('slug', churchSlug)
      .maybeSingle();

    // Now that RLS uses church.my_church_id(), we just need to ensure we insert the correct ID for the URL slug.
    const finalChurchId = church?.id;

    if (!finalChurchId) {
      searchParams = new URLSearchParams({
        error: `Demo mode: Cannot save because church "${churchSlug}" doesn't natively exist in the database yet.`,
      }).toString();
    } else {
      let formattedPhone = null;
      if (phone) {
        try {
          formattedPhone = normalizeUgPhone(phone);
        } catch (err: any) {
          console.error(err);
          formattedPhone = phone.trim();
        }
      }

      let hasConflict = false;
      if (formattedPhone) {
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
          // Silently ignore to avoid showing an error message as requested
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
      }

      if (!hasConflict) {
        const payload = {
          church_id: finalChurchId,
          full_name: fullName,
          phone_number: formattedPhone || '', // Use empty string instead of null to bypass NOT NULL constraints if empty
          email: email || null,
          gender: gender ? gender.toLowerCase() : null,
          birthday: birthday || null,
          is_youth: isYouth,
          status: 'active'
        };

        console.log('--- INSERTING NEW MEMBER ---', payload);
        console.log('User Role/Metadata payload:', user?.user_metadata);

        const { error } = await supabase
          .schema('church')
          .from('members')
          .insert(payload);

        if (error) {
           console.error('Error adding member:', error);
           searchParams = new URLSearchParams({
             error: `DB Insert Error: ${error.message}${error.details ? ` (${error.details})` : ''}`,
           }).toString();
        }
      }
    }
  } catch (err: any) {
      console.error('Unhandled exception in addMember:', err);
      // Do not swallow NEXT_REDIRECT
      if (err.message === 'NEXT_REDIRECT') {
        throw err;
      }
      searchParams = new URLSearchParams({ error: 'Failed to add member due to application error.' }).toString();
  }

  if (searchParams) {
    redirect(`/${churchSlug}/admin/members?${searchParams}`);
  }

  revalidatePath(`/${churchSlug}/admin/members`);
}
