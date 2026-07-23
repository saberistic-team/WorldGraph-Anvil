import { describe, expect, it } from 'vitest';

import {
  PrimitiveDependencyViewSchema,
  PrimitiveIndexRequestedSchema,
  PrimitiveListResponseSchema,
  PrimitiveRetrievalRequestSchema,
  PrimitiveRetrievalResponseSchema,
  ReindexPrimitiveVersionRequestSchema,
  UpdatePrimitiveDraftRequestSchema,
} from './catalog.js';
import { createValidator } from './validation.js';

const id = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const hash = 'a'.repeat(64);
const timestamp = '2026-07-21T12:00:00.000Z';

const listItem = {
  contentHash: hash,
  createdAt: timestamp,
  displayName: 'Guild Council',
  id,
  indexErrorCode: null,
  indexState: 'disabled',
  key: 'worldgraph.government.guild-council',
  kind: 'government',
  lifecycle: 'published',
  publishedAt: timestamp,
  rowVersion: 2,
  tags: ['city-state', 'council'],
  updatedAt: timestamp,
  version: '1.0.0',
} as const;

describe('primitive API contracts', () => {
  it('requires exact dependency locks and accepts terminal index states', () => {
    const dependency = createValidator(PrimitiveDependencyViewSchema);
    expect(
      dependency.is({
        dependencyFamilyId: id,
        key: 'worldgraph.organization.guild',
        parameterMapping: {},
        required: true,
        resolvedContentHash: hash,
        resolvedVersion: '1.0.0',
        resolvedVersionId: id,
        versionRange: '>=1.0.0 <2.0.0',
      }),
    ).toBe(true);
    expect(
      dependency.is({
        dependencyFamilyId: id,
        key: 'worldgraph.organization.guild',
        parameterMapping: {},
        required: true,
        resolvedVersion: '1.0.0',
        resolvedVersionId: id,
        versionRange: '*',
      }),
    ).toBe(false);
    expect(
      createValidator(PrimitiveListResponseSchema).is({ items: [listItem], nextCursor: null }),
    ).toBe(true);
  });

  it('validates bounded retrieval provenance without accepting raw or malformed filters', () => {
    const request = createValidator(PrimitiveRetrievalRequestSchema);
    expect(request.is({ query: 'floating guild city', tags: ['city-state'] })).toBe(true);
    expect(request.is({ query: 'floating guild city', tags: ['City State'] })).toBe(false);

    const response = createValidator(PrimitiveRetrievalResponseSchema);
    const payload = {
      normalizedQueryHash: hash,
      provider: {
        configurationId: 'disabled-v1',
        degradedReason: 'PROVIDER_DISABLED',
        model: null,
        name: null,
        semanticAvailable: false,
      },
      ranking: {
        k: 60,
        strategy: 'weighted_rrf_v1',
        weights: { lexical: 1, tag: 0.6, vector: 0.35 },
      },
      results: [
        {
          dependencyClosure: [
            {
              contentHash: hash,
              familyId: id,
              key: 'worldgraph.organization.guild',
              primitiveVersionId: id,
              version: '1.0.0',
            },
          ],
          index: {
            contentHash: hash,
            indexSchemaVersion: 1,
            lastErrorCode: null,
            model: null,
            provider: null,
            providerConfigurationId: 'disabled-v1',
            status: 'disabled',
          },
          primitive: listItem,
          rank: 1,
          reason: {
            lexicalRank: 1,
            lexicalScore: 12,
            matchedTags: ['council'],
            matchedTerms: ['guild', 'council'],
            score: 0.02,
            tagRank: 1,
            tagScore: 1,
            vectorRank: null,
            vectorSimilarity: null,
          },
        },
      ],
      retrievalRunId: id,
      warnings: [{ code: 'SEMANTIC_PROVIDER_DISABLED', message: 'Semantic ranking is disabled.' }],
    };
    expect(response.is(payload)).toBe(true);
    expect(response.is({ ...payload, rawQuery: 'must not be echoed' })).toBe(false);
    expect(response.is({ ...payload, warnings: Array(17).fill(payload.warnings[0]) })).toBe(false);
  });

  it('keeps admin and queue inputs strict, trimmed, and versioned', () => {
    const update = createValidator(UpdatePrimitiveDraftRequestSchema);
    expect(update.is({ expectedRowVersion: 1 })).toBe(false);
    const reindex = createValidator(ReindexPrimitiveVersionRequestSchema);
    expect(reindex.is({ expectedRowVersion: 2 })).toBe(true);
    expect(reindex.is({ contentHash: hash, expectedRowVersion: 2 })).toBe(false);

    const queue = createValidator(PrimitiveIndexRequestedSchema);
    expect(
      queue.is({
        contentHash: hash,
        indexSchemaVersion: 1,
        primitiveVersionId: id,
        providerConfigurationId: 'disabled-v1',
        schemaVersion: 1,
        type: 'PrimitiveIndexRequested',
      }),
    ).toBe(true);
    expect(
      queue.is({
        contentHash: hash,
        indexSchemaVersion: 1,
        primitiveVersionId: id,
        providerConfigurationId: ' disabled-v1 ',
        schemaVersion: 1,
        type: 'PrimitiveIndexRequested',
      }),
    ).toBe(false);
  });
});
