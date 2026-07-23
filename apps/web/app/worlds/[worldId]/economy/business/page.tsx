import { CommerceWorkspace } from '../commerce-workspace';

export default async function BusinessPage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <CommerceWorkspace section="business" worldId={worldId} />;
}
