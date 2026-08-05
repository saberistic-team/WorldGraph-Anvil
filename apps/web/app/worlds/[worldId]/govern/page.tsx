import { GovernanceWorkspace } from './governance-workspace';

export default async function GovernPage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <GovernanceWorkspace section="overview" worldId={worldId} />;
}
