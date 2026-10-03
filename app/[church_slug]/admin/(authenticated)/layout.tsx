import AdminSidebar from '@/components/AdminSidebar';
import { requireTenantAdmin } from '@/lib/auth/tenant';

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ church_slug: string }>;
}) {
  const { church_slug } = await params;
  // UX gate only. Every page and action ALSO calls requireTenantAdmin /
  // assertTenantAdmin itself, because layouts are not re-run on every request.
  const { church } = await requireTenantAdmin(church_slug);

  return (
    <div style={{ fontFamily: "'Outfit', sans-serif" }} className="min-h-screen bg-[#E4D5BC] flex">
      <AdminSidebar church={church} churchSlug={church.slug} />
      <main className="flex-1 overflow-y-auto px-6 py-8 md:px-12 md:py-10">
        <div className="max-w-7xl mx-auto">{children}</div>
      </main>
    </div>
  );
}
