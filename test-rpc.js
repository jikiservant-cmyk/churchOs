const { createClient } = require('@supabase/supabase-js');

async function run() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Pick a member and event to test
  const { data: member } = await supabase.schema('church').from('members').select('id, church_id').limit(1).single();
  const { data: event } = await supabase.schema('church').from('events').select('id').eq('church_id', member.church_id).limit(1).single();

  console.log('Member:', member);
  console.log('Event:', event);

  if (member && event) {
    const { error } = await supabase.schema('church').rpc('check_in_member_manual', {
      p_member_id: member.id,
      p_event_id: event.id,
      p_attendance_status: 'present'
    });
    console.log('RPC ERROR 1 (string):', error);
  }
}

run();
