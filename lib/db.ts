import { createClient } from './supabase/server';

export interface Church {
  id: string;
  name: string;
  slug: string;
  themeColor: string;
  logoUrl: string;
}

export const getChurchBySlug = async (slug: string): Promise<Church | null> => {
  // If Supabase is configured, try to fetch from it
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    try {
      const supabase = await createClient();
      const { data, error } = await supabase
        .schema('church')
        .from('churches')
        .select('*')
        .eq('slug', slug)
        .maybeSingle();

      if (!error && data) {
        return {
          id: data.id,
          name: data.name || data.slug,
          slug: data.slug,
          themeColor: data.theme_color || 'bg-blue-600',
          logoUrl: data.logo_url || `https://picsum.photos/seed/${slug}/200/200`,
        };
      }
      
      if (error) {
        if (error.message?.includes('Could not find the table') || error.message?.includes('Invalid schema')) {
          console.info(`[Supabase] Schema 'church' or table 'churches' not accessible. Falling back to mock data.`);
        } else {
          console.warn(`[Supabase] Fetch failed for slug ${slug}:`, error.message);
        }
      }
    } catch (err) {
      console.error('Supabase client error:', err);
    }
  }

  // If no DB match, return null. The logic in actions handles the redirect.
  return null;
};
