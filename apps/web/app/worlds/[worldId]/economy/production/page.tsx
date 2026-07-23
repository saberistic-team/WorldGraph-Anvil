import { CommerceWorkspace } from '../commerce-workspace';

export default async function ProductionPage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <CommerceWorkspace section="production" worldId={worldId} />;
}
