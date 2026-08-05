import {
  GOVERNANCE_PRIMITIVES,
  HARBOR_CITY_ECONOMY_PRIMITIVES,
  STARTER_PRIMITIVES,
} from '@worldgraph/catalog';
import {
  compilePreviousArtifactForCompatibility,
  compileRetainedArtifactForCompatibility,
  compileWorld,
  createCompilerInputBundle,
  createPreviousCompilerInputBundle,
  createRetainedCompilerInputBundle,
  memberPrincipalKey,
} from '@worldgraph/compiler';
import {
  COMPILER_VERSION,
  PREVIOUS_COMPILER_VERSION,
  RETAINED_COMPILER_VERSION,
  type CompiledArtifactV2,
  type CompiledArtifactV3,
  type CompiledArtifactV5,
  type WorldManifestV1,
} from '@worldgraph/contracts';
import {
  createDeterministicFallback,
  createDeterministicGovernedHarborCityFallback,
  createDeterministicHarborCityFallback,
  governedHarborCityManifestCatalog,
  harborCityManifestCatalog,
} from '@worldgraph/manifests';
import { describe, expect, it } from 'vitest';

import { persistCompiledSeedPlansInActivationTransaction } from './world-compilation-repository.js';

const worldId = '078f0000-0000-7000-8000-000000000001';
const userId = '078f0000-0000-7000-8000-000000000002';
const worldVersionId = '078f0000-0000-7000-8000-000000000003';
const runId = '078f0000-0000-7000-8000-000000000004';
const artifactId = '078f0000-0000-7000-8000-000000000005';
const economyPlanId = '078f0000-0000-7000-8000-000000000006';
const governancePlanId = '078f0000-0000-7000-8000-000000000007';
const seed = 'activation-persistence-test';
const primitiveCatalog = [
  ...STARTER_PRIMITIVES,
  ...HARBOR_CITY_ECONOMY_PRIMITIVES,
  ...GOVERNANCE_PRIMITIVES,
];

function exactPrimitives(manifest: WorldManifestV1) {
  const byId = new Map(primitiveCatalog.map((primitive) => [primitive.versionId, primitive]));
  return manifest.primitiveRefs.map((reference) => {
    const primitive = byId.get(reference.primitiveVersionId);
    if (!primitive) throw new Error(`Missing primitive ${reference.primitiveVersionId}`);
    return {
      contentHash: primitive.contentHash,
      definition: primitive.input,
      lifecycle: 'published' as const,
      primitiveVersionId: primitive.versionId,
    };
  });
}

function inputOptions(manifest: WorldManifestV1) {
  return {
    activeMembers: [
      { principalKey: memberPrincipalKey(worldId, userId), role: 'creator' as const },
    ],
    compilerConfig: {
      adapterRegistryVersion: 1 as const,
      deprecatedPrimitivePolicy: 'reject' as const,
      maxEntities: 2_000,
      maxRelationships: 8_000,
    },
    manifest,
    primitives: exactPrimitives(manifest),
    seed,
  };
}

function artifactV5(): CompiledArtifactV5 {
  const fallback = createDeterministicGovernedHarborCityFallback({
    catalog: governedHarborCityManifestCatalog(),
    prompt: 'A governed harbor city with civic proposals and elections.',
    seed,
  });
  const result = compileWorld(createCompilerInputBundle(inputOptions(fallback.envelope.manifest)));
  if (!result.artifact) throw new Error(JSON.stringify(result.diagnostics));
  return result.artifact;
}

function artifactV3(): CompiledArtifactV3 {
  const fallback = createDeterministicHarborCityFallback({
    catalog: harborCityManifestCatalog(),
    prompt: 'A harbor city with a closed-loop production economy.',
    seed,
  });
  const result = compilePreviousArtifactForCompatibility(
    createPreviousCompilerInputBundle(inputOptions(fallback.envelope.manifest)),
  );
  if (!result.artifact) throw new Error(JSON.stringify(result.diagnostics));
  return result.artifact;
}

function artifactV2(): CompiledArtifactV2 {
  const fallback = createDeterministicFallback({
    catalog: harborCityManifestCatalog(),
    prompt: 'A deterministic harbor city with public institutions.',
    seed,
  });
  fallback.envelope.manifest.extensions['worldgraph.economy'] = { schemaVersion: 1 };
  const result = compileRetainedArtifactForCompatibility(
    createRetainedCompilerInputBundle(inputOptions(fallback.envelope.manifest)),
  );
  if (!result.artifact) throw new Error(JSON.stringify(result.diagnostics));
  return result.artifact;
}

function recordingClient() {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Parameters<typeof persistCompiledSeedPlansInActivationTransaction>[0];
  return { client, queries };
}

const identity = {
  compilationRunId: runId,
  compiledArtifactId: artifactId,
  worldId,
  worldVersionId,
};

describe('compiled seed plan activation persistence', () => {
  it('persists Artifact V4 economy and governance sources on the same activation client', async () => {
    const artifact = artifactV5();
    const { client, queries } = recordingClient();
    const ids = [economyPlanId, governancePlanId];

    await persistCompiledSeedPlansInActivationTransaction(client, identity, artifact, () =>
      ids.shift()!,
    );

    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain('insert into compiled_economy_seed_plans');
    expect(queries[0]?.values).toEqual([
      economyPlanId,
      worldId,
      worldVersionId,
      runId,
      artifactId,
      2,
      'compiler_1_2',
      COMPILER_VERSION,
      'CompiledEconomySeedAdapterV2',
      JSON.stringify(artifact.world.economySeedPlan),
      artifact.world.economySeedPlanHash,
      artifact.contentHash,
    ]);
    expect(queries[1]?.sql).toContain('insert into compiled_governance_seed_plans');
    expect(queries[1]?.sql).toContain("'compiler_1_3'");
    expect(queries[1]?.values).toEqual([
      governancePlanId,
      worldId,
      worldVersionId,
      COMPILER_VERSION,
      artifact.contentHash,
      JSON.stringify(artifact.world.governanceSeedPlan),
      artifact.world.governanceSeedPlanHash,
    ]);
  });

  it.each([
    {
      adapterId: 'CompiledEconomySeedAdapterV2',
      artifact: artifactV3,
      compilerVersion: PREVIOUS_COMPILER_VERSION,
      planSchemaVersion: 2,
      sourceKind: 'compiler_1_2',
    },
    {
      adapterId: 'CompiledEconomySeedAdapterV1',
      artifact: artifactV2,
      compilerVersion: RETAINED_COMPILER_VERSION,
      planSchemaVersion: 1,
      sourceKind: 'compiler_1_1',
    },
  ])(
    'keeps $compilerVersion activation on its sealed economy-only persistence lane',
    async (testCase) => {
      const artifact = testCase.artifact();
      const { client, queries } = recordingClient();

      await persistCompiledSeedPlansInActivationTransaction(
        client,
        identity,
        artifact,
        () => economyPlanId,
      );

      expect(queries).toHaveLength(1);
      expect(queries[0]?.sql).toContain('insert into compiled_economy_seed_plans');
      expect(queries[0]?.sql).not.toContain('compiled_governance_seed_plans');
      expect(queries[0]?.values.slice(5, 9)).toEqual([
        testCase.planSchemaVersion,
        testCase.sourceKind,
        testCase.compilerVersion,
        testCase.adapterId,
      ]);
      expect(queries[0]?.values.slice(9)).toEqual([
        JSON.stringify(artifact.world.economySeedPlan),
        artifact.world.economySeedPlanHash,
        artifact.contentHash,
      ]);
    },
  );
});
