import { GovernanceWorkspace } from '../governance-workspace';

export default async function GovernOverridePage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <GovernanceWorkspace section="override" worldId={worldId} />;
}
