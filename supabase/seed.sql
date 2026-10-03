-- Demo data for local development ONLY. Never run against production.
-- (Previously embedded in supabase-schema.sql; it created a tenant whose usher
-- passkey was the well-known default '1234'.)
INSERT INTO church.churches (id, name, slug, theme_color, logo_url)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Grace Church Kampala', 
  'grace', 
  'bg-green-600', 
  'https://picsum.photos/seed/grace/200/200'
) ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug;

