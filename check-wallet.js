import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkWalletSchema() {
  console.log('--- Checking wallets table ---');
  const { data: wData, error: wError } = await supabase.from('wallets').select('*').limit(1);
  if (wError) {
    console.error('Error fetching wallets:', wError);
  } else if (wData && wData.length > 0) {
    console.log('wallets columns:', Object.keys(wData[0]));
  } else {
    console.log('wallets table is empty.');
    const checkCol = async (col) => {
      const { error } = await supabase.from('wallets').select(col).limit(0);
      return !error;
    };
    console.log('church_id exists:', await checkCol('church_id'));
    console.log('tenant_id exists:', await checkCol('tenant_id'));
  }

  const checkSchemaTable = async (table) => {
    console.log(`\n--- Checking church.${table} table ---`);
    const { data, error } = await supabase.schema('church').from(table).select('*').limit(1);
    if (error) {
      console.error(`Error fetching ${table}:`, error);
    } else if (data && data.length > 0) {
      console.log(`${table} columns:`, Object.keys(data[0]));
    } else {
      console.log(`${table} table is empty.`);
      const checkCol = async (col) => {
        const { error } = await supabase.schema('church').from(table).select(col).limit(0);
        return !error;
      };
      console.log('church_id exists:', await checkCol('church_id'));
      console.log('tenant_id exists:', await checkCol('tenant_id'));
    }
  };

  await checkSchemaTable('members');
  await checkSchemaTable('events');
  await checkSchemaTable('prayers');
  await checkSchemaTable('donations');
  await checkSchemaTable('new_converts');
}

checkWalletSchema();
