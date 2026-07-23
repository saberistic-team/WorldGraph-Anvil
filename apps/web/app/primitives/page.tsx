import { PrimitiveCatalog, type PrimitiveFilters } from './catalog-client';

type SearchValue = string | string[] | undefined;

function first(value: SearchValue): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default async function PrimitivesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, SearchValue>>;
}) {
  const parameters = await searchParams;
  const filters: PrimitiveFilters = {
    cursor: first(parameters.cursor),
    kind: first(parameters.kind),
    query: first(parameters.q),
    tag: first(parameters.tag),
  };
  return <PrimitiveCatalog filters={filters} />;
}
