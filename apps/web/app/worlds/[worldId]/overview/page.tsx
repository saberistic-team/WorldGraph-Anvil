import { WorldOverview } from './world-overview';

export default async function WorldOverviewPage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <WorldOverview worldId={worldId} />;
}
