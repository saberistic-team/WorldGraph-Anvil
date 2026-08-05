import { GovernanceWorkspace } from '../governance-workspace';

export default async function GovernLawsPage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <GovernanceWorkspace section="laws" worldId={worldId} />;
}
