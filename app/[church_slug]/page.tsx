import { getChurchBySlug } from '@/lib/db';
import GivingPortal from '@/components/GivingPortal';
import { notFound } from 'next/navigation';

export default async function GivingPage({
  params,
}: {
  params: Promise<{ church_slug: string }>;
}) {
  const resolvedParams = await params;
  const church = await getChurchBySlug(resolvedParams.church_slug);

  if (!church) {
    notFound();
  }

  return <GivingPortal church={church} />;
}
