import { ManifestStudio } from './manifest-studio';

export default async function ManifestStudioPage({
  params,
}: {
  params: Promise<{ worldId: string }>;
}) {
  const { worldId } = await params;
  return <ManifestStudio worldId={worldId} />;
}
