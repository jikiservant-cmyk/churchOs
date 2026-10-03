import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { normalizeSlug } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }

  // Only ever redirect to a validated same-site path (was: raw form value → open redirect).
  let slug: string | null = null;
  try {
    slug = normalizeSlug((await req.formData()).get('churchSlug'));
  } catch {
    slug = null;
  }
  const path = slug ? `/${slug}/admin/login` : '/';
  return NextResponse.redirect(new URL(path, req.url), 303);
}
