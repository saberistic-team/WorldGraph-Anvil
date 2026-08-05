import { GovernanceWorkspace } from '../governance-workspace';

export default async function GovernAuditPage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <GovernanceWorkspace section="audit" worldId={worldId} />;
}
