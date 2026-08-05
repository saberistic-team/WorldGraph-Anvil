import {
  COMPILER_VERSION,
  PREVIOUS_COMPILER_VERSION,
  RETAINED_COMPILER_VERSION,
} from '@worldgraph/contracts';
import {
  createDeterministicFallback,
  createDeterministicGovernedHarborCityFallback,
  createDeterministicHarborCityFallback,
  governedHarborCityManifestCatalog,
  harborCityManifestCatalog,
  starterManifestCatalog,
} from '@worldgraph/manifests';
import { describe, expect, it } from 'vitest';

import { compilerVersionForManifest } from './service.js';

describe('compilation manifest lane selection', () => {
  it('keeps absent and schema-1 economy extensions on sealed compiler 1.1', () => {
    const legacy = createDeterministicFallback({
      catalog: starterManifestCatalog(),
      prompt: 'A deterministic guild city.',
      providerConfigurationId: 'disabled-v1',
      seed: 'legacy-lane',
    }).envelope.manifest;

    expect(compilerVersionForManifest(legacy)).toBe(RETAINED_COMPILER_VERSION);

    const extensionV1 = structuredClone(legacy);
    extensionV1.extensions['worldgraph.economy'] = { schemaVersion: 1 };
    expect(compilerVersionForManifest(extensionV1)).toBe(RETAINED_COMPILER_VERSION);
  });

  it('selects compiler 1.2 only for the schema-2 economy extension', () => {
    const current = createDeterministicHarborCityFallback({
      catalog: harborCityManifestCatalog(),
      prompt: 'A harbor city with a closed-loop production economy.',
      seed: 'current-lane',
    }).envelope.manifest;

    current.extensions['worldgraph.governance'] = null;
    expect(compilerVersionForManifest(current)).toBe(PREVIOUS_COMPILER_VERSION);
  });

  it('selects compiler 1.3 only for the schema-1 governance extension', () => {
    const governed = createDeterministicGovernedHarborCityFallback({
      catalog: governedHarborCityManifestCatalog(),
      prompt: 'A governed harbor city with a closed-loop production economy.',
      seed: 'governance-lane',
    }).envelope.manifest;

    expect(compilerVersionForManifest(governed)).toBe(COMPILER_VERSION);
  });
});
