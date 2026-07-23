import { WorldGraphExplorer } from './world-graph-explorer';

export default async function WorldGraphPage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <WorldGraphExplorer worldId={worldId} />;
}
