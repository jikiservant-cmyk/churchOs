import { cache } from 'react';
import { createAdminClient } from './supabase/server';
import { normalizeSlug } from './security';

export interface Church {
  id: string;
  name: string;
  slug: string;
  themeColor: string;
  logoUrl: string;
}

/**
 * Public church metadata lookup by slug (service role, explicit column list).
 *
 * - Slug is validated and matched with `eq` — never `ilike`, where `%`/`_`
 *   would act as wildcards and resolve an arbitrary tenant.
 * - Never selects secrets (no passkey / credentials columns).
 * - Memoised per request via React `cache`.
 */
export const getChurchBySlug = cache(async (rawSlug: string): Promise<Church | null> => {
  const slug = normalizeSlug(rawSlug);
  if (!slug) return null;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;

  try {
    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .schema('church')
      .from('churches')
      .select('id, name, slug, theme_color, logo_url')
      .eq('slug', slug)
      .maybeSingle();

    if (error) {
      console.error('[getChurchBySlug] query failed:', error.code, error.message);
      return null;
    }
    if (!data) return null;

    return {
      id: data.id,
      name: data.name || data.slug,
      slug: data.slug,
      themeColor: data.theme_color || 'bg-blue-600',
      logoUrl: data.logo_url || `https://picsum.photos/seed/${encodeURIComponent(data.slug)}/200/200`,
    };
  } catch (err) {
    console.error('[getChurchBySlug] unexpected error:', (err as Error).message);
    return null;
  }
});
