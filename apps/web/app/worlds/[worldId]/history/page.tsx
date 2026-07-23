import { WorldHistory } from './world-history';

export default async function WorldHistoryPage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <WorldHistory worldId={worldId} />;
}
