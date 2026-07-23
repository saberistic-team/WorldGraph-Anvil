import { CommerceWorkspace } from '../commerce-workspace';

export default async function ResourcesPage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <CommerceWorkspace section="resources" worldId={worldId} />;
}
