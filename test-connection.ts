console.log('SCRIPT STARTING');
import { createAdminClient } from './lib/supabase/server';

async function getPasskey() {
  console.log('GETTING PASSKEY');
  try {
    const supabase = await createAdminClient();
    console.log('CLIENT CREATED');
    const { data, error } = await supabase
      .schema('church')
      .from('churches')
      .select('name, slug, passkey')
      .ilike('slug', 'ghw')
      .maybeSingle();

    if (error) {
      console.error('DATABASE ERROR:', error.message);
    } else if (data) {
      console.log('--- Church Details ---');
      console.log('Name:', data.name);
      console.log('Slug:', data.slug);
      console.log('Passkey:', data.passkey);
    } else {
      console.log('No church found with slug "ghw"');
    }
  } catch (err) {
    console.error('Unexpected error:', err);
  }
}

getPasskey();
