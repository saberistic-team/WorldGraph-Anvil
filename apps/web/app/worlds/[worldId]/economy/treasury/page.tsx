import { CommerceWorkspace } from '../commerce-workspace';

export default async function TreasuryPage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <CommerceWorkspace section="treasury" worldId={worldId} />;
}
