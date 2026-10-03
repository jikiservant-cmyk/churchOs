import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { denominationsEnabled, firstRow, type LoginContext } from '@/lib/denominations';

/**
 * Gate for overseer-only pages. The decision comes from the database
 * (`my_login_context`, which reads auth.uid()), never from a cookie, URL or form field.
 * Anyone who is not a signed-in overseer is sent back to the login page.
 *
 * The overseer RPCs enforce the same rule server-side, so this is not the only barrier.
 */
export async function requireOverseer() {
  if (!denominationsEnabled()) redirect('/');

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const { data, error } = await supabase.rpc('my_login_context');
  if (error) console.error('[overseer] my_login_context failed:', error.code, error.message);
  const ctx = firstRow<LoginContext>(data);
  if (ctx?.account_type !== 'overseer') redirect('/');

  return { supabase, user, ctx };
}
