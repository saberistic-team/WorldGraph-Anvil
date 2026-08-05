import { GovernanceWorkspace } from '../governance-workspace';

export default async function GovernProposalsPage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <GovernanceWorkspace section="proposals" worldId={worldId} />;
}
