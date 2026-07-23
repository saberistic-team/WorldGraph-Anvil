import { CommerceWorkspace } from '../commerce-workspace';

export default async function MarketplacePage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <CommerceWorkspace section="market" worldId={worldId} />;
}
