import { createPrimitiveEmbeddingProfile, localHashEmbeddingVector } from '@worldgraph/catalog';
import type { RuntimeConfig } from '@worldgraph/config';

import type { LocalQueryVectorSource, PrimitiveIndexProfile } from './primitives/service.js';

type PrimitiveSemanticRuntimeConfig = Pick<
  RuntimeConfig,
  | 'primitiveEmbeddingCostBudgetMicrounits'
  | 'primitiveSemanticContributionEnabled'
  | 'primitiveSemanticProfile'
>;

export interface ApiPrimitiveSemanticProfile {
  indexProfile: PrimitiveIndexProfile;
  queryVectors: LocalQueryVectorSource;
}

export function createApiPrimitiveSemanticProfile(
  config: PrimitiveSemanticRuntimeConfig,
): ApiPrimitiveSemanticProfile {
  const profile = createPrimitiveEmbeddingProfile(
    config.primitiveSemanticProfile,
    config.primitiveEmbeddingCostBudgetMicrounits,
  );
  if (config.primitiveSemanticContributionEnabled && !profile.enabled) {
    throw new Error('PRIMITIVE_SEMANTIC_CONTRIBUTION_PROFILE_MISMATCH');
  }
  const indexProfile: PrimitiveIndexProfile = {
    configurationId: profile.configurationId,
    model: profile.model,
    provider: profile.provider,
  };
  const queryVectors: LocalQueryVectorSource = {
    configurationId: profile.configurationId,
    enabled: profile.enabled && config.primitiveSemanticContributionEnabled,
    execution: 'local',
    model: profile.model,
    provider: profile.provider,
    vectorize: async (normalizedText, signal) => localHashEmbeddingVector(normalizedText, signal),
  };
  return { indexProfile, queryVectors };
}
