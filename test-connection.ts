import { createClient } from './lib/supabase/server.ts';

async function testConnection() {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from('tenants').select('*').limit(1);
    
    if (error) {
      console.error('Connection failed:', error.message);
      if (error.message.includes('relation "public.tenants" does not exist')) {
        console.log('--- ACTION REQUIRED ---');
        console.log('The database connection is working, but the tables are missing.');
        console.log('Please make sure you ran the SQL from supabase-schema.sql in the Supabase SQL Editor.');
      }
    } else {
      console.log('Connection successful! Found', data?.length, 'tenants.');
    }
  } catch (err) {
    console.error('Unexpected error:', err);
  }
}

testConnection();
