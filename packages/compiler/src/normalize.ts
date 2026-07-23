import { canonicalJson, type WorldManifestV1 } from '@worldgraph/contracts';

import type { NormalizedCompilerInput, ResolvedCompilerInput, StageResult } from './types.js';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortByKey<T extends { key: string }>(values: T[]): T[] {
  return values.sort((left, right) => compareText(left.key, right.key));
}

export function normalizeCompilerInput(
  resolved: ResolvedCompilerInput,
): StageResult<NormalizedCompilerInput> {
  const manifest = JSON.parse(canonicalJson(resolved.bundle.manifest)) as WorldManifestV1;
  manifest.assumptions.sort(compareText);
  sortByKey(manifest.actors);
  sortByKey(manifest.connections);
  sortByKey(manifest.districts);
  sortByKey(manifest.institutions);
  for (const institution of manifest.institutions) institution.organizationKeys.sort(compareText);
  sortByKey(manifest.organizations);
  sortByKey(manifest.relationships);
  manifest.primitiveRefs.sort((left, right) => compareText(left.ref, right.ref));
  manifest.economy.productionPrimitiveRefs.sort(compareText);
  manifest.economy.resourcePrimitiveRefs.sort(compareText);
  manifest.economy.taxPrimitiveRefs.sort(compareText);
  manifest.simulation.eventPrimitiveRefs.sort(compareText);
  manifest.simulation.rulePrimitiveRefs.sort(compareText);
  return {
    diagnostics: [],
    value: {
      activeMembers: [...resolved.bundle.activeMembers].sort((left, right) =>
        compareText(left.principalKey, right.principalKey),
      ),
      bundle: resolved.bundle,
      manifest,
      orderedPrimitives: [...resolved.orderedPrimitives],
    },
  };
}
