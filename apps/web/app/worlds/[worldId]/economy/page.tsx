import { WorldEconomy } from './world-economy';

export default async function WorldEconomyPage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <WorldEconomy worldId={worldId} />;
}
