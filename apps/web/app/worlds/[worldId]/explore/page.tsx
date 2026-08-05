import { WorldExplore } from './world-explore';

export default async function ExplorePage({ params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  return <WorldExplore worldId={worldId} />;
}
