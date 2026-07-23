import { HARBOR_CITY_ECONOMY_PRIMITIVES, STARTER_PRIMITIVES } from '@worldgraph/catalog';
import type {
  CompilerInputBundleV1,
  LegacyCompilerInputBundleV1,
  PreviousCompilerInputBundleV1,
} from '@worldgraph/contracts';
import {
  createDeterministicFallback,
  createDeterministicHarborCityFallback,
  harborCityManifestCatalog,
  starterManifestCatalog,
} from '@worldgraph/manifests';

import {
  createCompilerInputBundle,
  createLegacyCompilerInputBundle,
  createPreviousCompilerInputBundle,
} from './input.js';
import { memberPrincipalKey } from './keys.js';

export const GOLDEN_MANIFEST_PROMPT =
  'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.';
export const HARBOR_CITY_MANIFEST_PROMPT =
  'A harbor city with guild workshops, iron and energy production, paid jobs, a fixed-price market, and public sales tax.';
export const GOLDEN_COMPILER_SEED = 'demo-seed';
export const GOLDEN_WORLD_ID = '018f8652-3cb6-7d52-904b-cce7901d7e25';
export const GOLDEN_CREATOR_USER_ID = '018f8652-3cb6-7d52-904b-cce7901d7e26';
export const GOLDEN_PLAYER_USER_ID = '018f8652-3cb6-7d52-904b-cce7901d7e27';

function goldenSource(activeMembers: CompilerInputBundleV1['activeMembers']) {
  const fallback = createDeterministicFallback({
    catalog: starterManifestCatalog(),
    prompt: GOLDEN_MANIFEST_PROMPT,
    providerConfigurationId: 'disabled-v1',
    seed: GOLDEN_COMPILER_SEED,
  });
  return {
    activeMembers,
    manifest: fallback.envelope.manifest,
    primitives: STARTER_PRIMITIVES.map((primitive) => ({
      contentHash: primitive.contentHash,
      definition: primitive.input,
      lifecycle: 'published' as const,
      primitiveVersionId: primitive.versionId,
    })),
    seed: GOLDEN_COMPILER_SEED,
  };
}

export function createGoldenCompilerInput(): CompilerInputBundleV1 {
  const fallback = createDeterministicHarborCityFallback({
    catalog: harborCityManifestCatalog(),
    prompt: HARBOR_CITY_MANIFEST_PROMPT,
    seed: GOLDEN_COMPILER_SEED,
  });
  const pinnedKeys = new Set(fallback.envelope.manifest.primitiveRefs.map((entry) => entry.key));
  return createCompilerInputBundle({
    activeMembers: [
      {
        principalKey: memberPrincipalKey(GOLDEN_WORLD_ID, GOLDEN_CREATOR_USER_ID),
        role: 'creator',
      },
      {
        principalKey: memberPrincipalKey(GOLDEN_WORLD_ID, GOLDEN_PLAYER_USER_ID),
        role: 'player',
      },
    ],
    manifest: fallback.envelope.manifest,
    primitives: [...STARTER_PRIMITIVES, ...HARBOR_CITY_ECONOMY_PRIMITIVES]
      .filter((primitive) => pinnedKeys.has(primitive.input.key))
      .map((primitive) => ({
        contentHash: primitive.contentHash,
        definition: primitive.input,
        lifecycle: 'published' as const,
        primitiveVersionId: primitive.versionId,
      })),
    seed: GOLDEN_COMPILER_SEED,
  });
}

export function createLegacyGoldenCompilerInput(): LegacyCompilerInputBundleV1 {
  return createLegacyCompilerInputBundle(
    goldenSource([
      {
        principalKey: memberPrincipalKey(GOLDEN_WORLD_ID, GOLDEN_CREATOR_USER_ID),
        role: 'creator',
      },
    ]),
  );
}

export function createPreviousGoldenCompilerInput(): PreviousCompilerInputBundleV1 {
  return createPreviousCompilerInputBundle(
    goldenSource([
      {
        principalKey: memberPrincipalKey(GOLDEN_WORLD_ID, GOLDEN_CREATOR_USER_ID),
        role: 'creator',
      },
      {
        principalKey: memberPrincipalKey(GOLDEN_WORLD_ID, GOLDEN_PLAYER_USER_ID),
        role: 'player',
      },
    ]),
  );
}
