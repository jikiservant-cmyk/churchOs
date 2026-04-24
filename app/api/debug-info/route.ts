import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    return NextResponse.json({ error: 'Not logged in' });
  }

  const { data: profile } = await supabase.from('admin_profiles').select('*').eq('id', session.user.id).maybeSingle();
  const { data: churches } = await supabase.schema('church').from('churches').select('*');
  const { data: members } = await supabase.schema('church').from('members').select('*');

  return NextResponse.json({
    user: session.user.id,
    profile,
    churches,
    members: members?.length,
    membersData: members
  });
}
