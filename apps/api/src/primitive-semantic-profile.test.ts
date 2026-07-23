import { describe, expect, it } from 'vitest';

import { createApiPrimitiveSemanticProfile } from './primitive-semantic-profile.js';

describe('API primitive semantic profile wiring', () => {
  it('keeps semantic indexing and query contribution disabled by default', () => {
    const wiring = createApiPrimitiveSemanticProfile({
      primitiveEmbeddingCostBudgetMicrounits: 0,
      primitiveSemanticContributionEnabled: false,
      primitiveSemanticProfile: 'disabled',
    });
    expect(wiring).toMatchObject({
      indexProfile: { configurationId: 'disabled-v1', model: null, provider: null },
      queryVectors: {
        configurationId: 'disabled-v1',
        enabled: false,
        execution: 'local',
        model: null,
        provider: null,
      },
    });
  });

  it('wires one matching local-only profile for publication, indexing, and query vectors', async () => {
    const wiring = createApiPrimitiveSemanticProfile({
      primitiveEmbeddingCostBudgetMicrounits: 0,
      primitiveSemanticContributionEnabled: true,
      primitiveSemanticProfile: 'local_hash',
    });
    expect(wiring).toMatchObject({
      indexProfile: {
        configurationId: 'local-hash-1536-v1',
        model: 'feature-hash-1536-v1',
        provider: 'worldgraph-local',
      },
      queryVectors: {
        configurationId: 'local-hash-1536-v1',
        enabled: true,
        execution: 'local',
        model: 'feature-hash-1536-v1',
        provider: 'worldgraph-local',
      },
    });
    await expect(
      wiring.queryVectors.vectorize('floating city council', new AbortController().signal),
    ).resolves.toHaveLength(1536);
  });

  it('can index local vectors while semantic rank contribution remains off', () => {
    const wiring = createApiPrimitiveSemanticProfile({
      primitiveEmbeddingCostBudgetMicrounits: 0,
      primitiveSemanticContributionEnabled: false,
      primitiveSemanticProfile: 'local_hash',
    });
    expect(wiring.indexProfile.configurationId).toBe('local-hash-1536-v1');
    expect(wiring.queryVectors.enabled).toBe(false);
  });

  it('fails closed if an unsupported contribution/profile combination bypasses config loading', () => {
    expect(() =>
      createApiPrimitiveSemanticProfile({
        primitiveEmbeddingCostBudgetMicrounits: 0,
        primitiveSemanticContributionEnabled: true,
        primitiveSemanticProfile: 'disabled',
      }),
    ).toThrow('PRIMITIVE_SEMANTIC_CONTRIBUTION_PROFILE_MISMATCH');
  });
});
