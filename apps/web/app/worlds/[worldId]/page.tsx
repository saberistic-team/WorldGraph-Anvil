import { WorldDetail } from './world-detail';

export default async function WorldPage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <WorldDetail worldId={worldId} />;
}
