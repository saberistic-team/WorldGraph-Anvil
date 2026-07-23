import { createHash } from 'node:crypto';

import { normalizeRetrievalQuery } from './retrieval.js';

export const LOCAL_HASH_EMBEDDING_CONFIGURATION_ID = 'local-hash-1536-v1' as const;
export const LOCAL_HASH_EMBEDDING_DIMENSIONS = 1536 as const;
export const LOCAL_HASH_EMBEDDING_MODEL = 'feature-hash-1536-v1' as const;
export const LOCAL_HASH_EMBEDDING_PROVIDER = 'worldgraph-local' as const;
export const MAX_LOCAL_HASH_EMBEDDING_TEXT_LENGTH = 40_000 as const;

const LOCAL_HASH_DOMAIN = 'worldgraph:primitive-local-hash-embedding:v1\0';
const MAX_LOCAL_HASH_FEATURES = 8_192;

export interface EmbeddingRequest {
  contentHash: string;
  normalizedText: string;
}

export interface EmbeddingResult {
  costEstimateMicrounits?: number | null;
  dimensions: 1536;
  latencyMs: number;
  model: string;
  provider: string;
  tokenEstimate: number | null;
  vector: number[];
}

export interface EmbeddingProvider {
  readonly configurationId: string;
  readonly enabled: boolean;
  embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult>;
}

export type PrimitiveSemanticProfileName = 'disabled' | 'local_hash';

export interface PrimitiveEmbeddingProfile extends EmbeddingProvider {
  readonly maximumCostMicrounits: number;
  readonly model: string | null;
  readonly profile: PrimitiveSemanticProfileName;
  readonly provider: string | null;
}

export class EmbeddingProviderError extends Error {
  public constructor(
    public readonly code:
      | 'PROVIDER_DISABLED'
      | 'PROVIDER_FAILED'
      | 'PROVIDER_RATE_LIMITED'
      | 'PROVIDER_TIMEOUT'
      | 'VECTOR_INVALID',
  ) {
    super(code);
    this.name = 'EmbeddingProviderError';
  }
}

export const disabledEmbeddingProvider: PrimitiveEmbeddingProfile = {
  configurationId: 'disabled-v1',
  embed: async () => {
    throw new EmbeddingProviderError('PROVIDER_DISABLED');
  },
  enabled: false,
  maximumCostMicrounits: 0,
  model: null,
  profile: 'disabled',
  provider: null,
};

function assertZeroCostBudget(maximumCostMicrounits: number): void {
  if (!Number.isSafeInteger(maximumCostMicrounits) || maximumCostMicrounits !== 0) {
    throw new Error('PRIMITIVE_EMBEDDING_COST_BUDGET_UNSUPPORTED');
  }
}

function hashFeature(feature: string): Buffer {
  return createHash('sha256').update(LOCAL_HASH_DOMAIN).update(feature).digest();
}

/**
 * Deterministic, local-only feature hashing shared by primitive documents and
 * retrieval queries. It intentionally has no network, secret, model, or cost
 * dependency. Vectors are derived ranking aids and never registry authority.
 */
export function localHashEmbeddingVector(text: string, signal?: AbortSignal): number[] {
  if (signal?.aborted) throw new EmbeddingProviderError('PROVIDER_TIMEOUT');
  if (text.length === 0 || text.length > MAX_LOCAL_HASH_EMBEDDING_TEXT_LENGTH) {
    throw new EmbeddingProviderError('VECTOR_INVALID');
  }

  const normalized = normalizeRetrievalQuery(text);
  if (!normalized) throw new EmbeddingProviderError('VECTOR_INVALID');
  const tokens = normalized.split(' ').filter(Boolean);
  const features: string[] = [];
  for (
    let index = 0;
    index < tokens.length && features.length < MAX_LOCAL_HASH_FEATURES;
    index += 1
  ) {
    const token = tokens[index]!;
    features.push(`u:${token}`);
    if (index > 0 && features.length < MAX_LOCAL_HASH_FEATURES) {
      features.push(`b:${tokens[index - 1]!}:${token}`);
    }
  }

  const vector = new Float64Array(LOCAL_HASH_EMBEDDING_DIMENSIONS);
  for (const feature of features) {
    const digest = hashFeature(feature);
    const bucket = digest.readUInt16BE(0) % LOCAL_HASH_EMBEDDING_DIMENSIONS;
    const sign = (digest[2]! & 1) === 0 ? 1 : -1;
    vector[bucket] = vector[bucket]! + sign;
  }
  let normSquared = 0;
  for (const value of vector) normSquared += value * value;
  if (normSquared === 0) {
    const fallback = hashFeature(`fallback:${normalized}`);
    vector[fallback.readUInt16BE(0) % LOCAL_HASH_EMBEDDING_DIMENSIONS] = 1;
    normSquared = 1;
  }
  const norm = Math.sqrt(normSquared);
  const result = Array.from(vector, (value) => Math.fround(value / norm));
  if (signal?.aborted) throw new EmbeddingProviderError('PROVIDER_TIMEOUT');
  return result;
}

export function createPrimitiveEmbeddingProfile(
  profile: PrimitiveSemanticProfileName,
  maximumCostMicrounits: number,
): PrimitiveEmbeddingProfile {
  assertZeroCostBudget(maximumCostMicrounits);
  if (profile === 'disabled') return disabledEmbeddingProvider;
  if (profile !== 'local_hash') throw new Error('PRIMITIVE_SEMANTIC_PROFILE_UNSUPPORTED');
  return {
    configurationId: LOCAL_HASH_EMBEDDING_CONFIGURATION_ID,
    embed: async (request, signal) => {
      if (!/^[a-f0-9]{64}$/u.test(request.contentHash)) {
        throw new EmbeddingProviderError('VECTOR_INVALID');
      }
      const vector = localHashEmbeddingVector(request.normalizedText, signal);
      return {
        costEstimateMicrounits: 0,
        dimensions: LOCAL_HASH_EMBEDDING_DIMENSIONS,
        latencyMs: 0,
        model: LOCAL_HASH_EMBEDDING_MODEL,
        provider: LOCAL_HASH_EMBEDDING_PROVIDER,
        tokenEstimate: normalizeRetrievalQuery(request.normalizedText).split(' ').filter(Boolean)
          .length,
        vector,
      };
    },
    enabled: true,
    maximumCostMicrounits,
    model: LOCAL_HASH_EMBEDDING_MODEL,
    profile,
    provider: LOCAL_HASH_EMBEDDING_PROVIDER,
  };
}

export function assertEmbedding(result: EmbeddingResult): EmbeddingResult {
  const rounded = result.vector.map((value) => Math.fround(value));
  const vectorValid = result.vector.every(
    (value, index) => Number.isFinite(value) && Number.isFinite(rounded[index]),
  );
  if (
    result.dimensions !== 1536 ||
    result.vector.length !== 1536 ||
    !vectorValid ||
    !rounded.some((value) => value !== 0) ||
    !Number.isFinite(result.latencyMs) ||
    result.latencyMs < 0 ||
    !result.model.trim() ||
    result.model.length > 160 ||
    !result.provider.trim() ||
    result.provider.length > 120 ||
    (result.costEstimateMicrounits !== undefined &&
      result.costEstimateMicrounits !== null &&
      (!Number.isSafeInteger(result.costEstimateMicrounits) ||
        result.costEstimateMicrounits < 0)) ||
    (result.tokenEstimate !== null &&
      (!Number.isSafeInteger(result.tokenEstimate) || result.tokenEstimate < 0))
  ) {
    throw new EmbeddingProviderError('VECTOR_INVALID');
  }
  return result;
}
