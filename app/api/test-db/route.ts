import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET() {
  const supabase = await createClient();
  const res = await supabase.rpc('get_church_schema_info'); // Just testing standard ways, or I'll just check if transactions query fails
  
  const { data: members } = await supabase.schema('church').from('members').select('id', { count: 'exact', head: true });
  const { data: transactions, error: txError } = await supabase.schema('church').from('transactions').select('*').limit(5);

  return NextResponse.json({ members, transactions, txError });
}
