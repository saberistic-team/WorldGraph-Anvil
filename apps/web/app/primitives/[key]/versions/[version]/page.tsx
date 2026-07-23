import { PrimitiveDetail } from './primitive-detail';

export default async function PrimitiveVersionPage({
  params,
}: {
  params: Promise<{ key: string; version: string }>;
}) {
  const { key, version } = await params;
  return <PrimitiveDetail primitiveKey={key} version={version} />;
}
