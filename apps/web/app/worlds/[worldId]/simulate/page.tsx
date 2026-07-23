import { WorldSimulation } from './world-simulation';

export default async function WorldSimulationPage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <WorldSimulation worldId={worldId} />;
}
