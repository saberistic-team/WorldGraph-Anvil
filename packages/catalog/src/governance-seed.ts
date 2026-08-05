import type { PrimitiveDependencyInput, PrimitiveDraftInput } from '@worldgraph/contracts';

import governanceSeedLock from './governance-catalog.lock.json';
import { assertReviewedPrimitiveIndexPolicy } from './search.js';
import { BEHAVIOR_REFS_BY_KIND, primitiveContentHash, validatePrimitive } from './validation.js';

export const GOVERNANCE_CATALOG_ID = 'worldgraph.governance-core' as const;
export const GOVERNANCE_CATALOG_VERSION = '1.0.0' as const;

export interface GovernancePrimitive {
  contentHash: string;
  familyId: string;
  input: PrimitiveDraftInput;
  versionId: string;
}

const dependency = (key: string): PrimitiveDependencyInput => ({
  key,
  parameterMapping: {},
  required: true,
  versionRange: '>=1.0.0 <2.0.0',
});

const election: PrimitiveDraftInput = {
  behaviorRef: BEHAVIOR_REFS_BY_KIND.election,
  compatibility: { archetype: 'city-state', engine: 'anvil', mvp: true },
  defaults: { method: 'plurality', votingTicks: 24 },
  dependencies: [
    dependency('worldgraph.government.guild-council'),
    dependency('worldgraph.office.councillor'),
    dependency('worldgraph.player-role.citizen'),
  ],
  displayName: 'Council Ballot',
  documentation:
    '# Council Plurality Ballot\n\nA deterministic first-past-the-post plurality election for council seats.',
  key: 'worldgraph.election.council-ballot',
  kind: 'election',
  parameterSchema: {
    additionalProperties: false,
    properties: {
      method: { const: 'plurality' },
      votingTicks: { maximum: 720, minimum: 1, type: 'integer' },
    },
    required: ['method', 'votingTicks'],
    type: 'object',
  },
  primitiveSchemaVersion: 1,
  provenance: {
    author: 'WorldGraph',
    license: 'LicenseRef-WorldGraph-Seed-1.0',
    reviewId: 'm10-governance-core-2026-08-03',
    reviewStatus: 'approved',
    sourceId: GOVERNANCE_CATALOG_ID,
    sourceType: 'bundled',
    sourceVersion: GOVERNANCE_CATALOG_VERSION,
  },
  tags: ['ballot', 'city-state', 'council', 'election', 'first-past-the-post', 'plurality'],
  version: '1.1.0',
  visualHints: {},
};

const validation = validatePrimitive(election);
if (!validation.valid) {
  throw new Error(`Invalid governance primitive: ${JSON.stringify(validation.issues)}`);
}

/**
 * Reviewed M10 governance addition. It deliberately publishes a new immutable
 * version instead of changing the sealed ranked-choice 1.0.0 definition.
 */
export const GOVERNANCE_PRIMITIVES: readonly GovernancePrimitive[] = [
  {
    contentHash: primitiveContentHash(election),
    familyId: '00f3c407-1cf7-53e0-a4eb-9a3327e61eca',
    input: election,
    versionId: '8822358c-f68c-5b38-9e02-6860976188ef',
  },
];

export function assertGovernanceCatalogLock(): void {
  for (const primitive of GOVERNANCE_PRIMITIVES) {
    const identity = `${primitive.input.key}@${primitive.input.version}`;
    assertReviewedPrimitiveIndexPolicy(primitive.input);
    if (
      (governanceSeedLock.primitives as Record<string, string>)[identity] !== primitive.contentHash
    ) {
      throw new Error(`Governance primitive lock mismatch: ${identity}`);
    }
  }
  if (
    governanceSeedLock.catalog !== `${GOVERNANCE_CATALOG_ID}@${GOVERNANCE_CATALOG_VERSION}` ||
    governanceSeedLock.schemaVersion !== 1 ||
    Object.keys(governanceSeedLock.primitives).length !== GOVERNANCE_PRIMITIVES.length
  ) {
    throw new Error('Governance primitive lock metadata or cardinality mismatch.');
  }
}
