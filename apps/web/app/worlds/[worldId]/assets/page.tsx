import { WorldAssets } from './world-assets';

export default async function WorldAssetsPage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <WorldAssets worldId={worldId} />;
}
