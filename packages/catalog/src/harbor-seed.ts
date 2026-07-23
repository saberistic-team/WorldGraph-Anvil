import type { PrimitiveDependencyInput, PrimitiveDraftInput } from '@worldgraph/contracts';

import { assertReviewedPrimitiveIndexPolicy } from './search.js';
import { BEHAVIOR_REFS_BY_KIND, primitiveContentHash, validatePrimitive } from './validation.js';
import harborSeedLock from './harbor-city-catalog.lock.json';

export const HARBOR_CITY_CATALOG_ID = 'worldgraph.harbor-city-economy' as const;
export const HARBOR_CITY_CATALOG_VERSION = '1.0.0' as const;
export const HARBOR_CITY_DEPENDENCY_RANGE = '>=1.0.0 <2.0.0' as const;

export interface HarborCityPrimitive {
  contentHash: string;
  familyId: string;
  input: PrimitiveDraftInput;
  versionId: string;
}

interface HarborSeedInput {
  defaults: Record<string, unknown>;
  dependencies?: PrimitiveDependencyInput[];
  displayName: string;
  documentation: string;
  familyId: string;
  key: string;
  kind: 'production_recipe' | 'resource';
  properties: Record<string, unknown>;
  tags: string[];
  versionId: string;
}

const provenance = {
  author: 'WorldGraph',
  license: 'LicenseRef-WorldGraph-Seed-1.0',
  reviewId: 'm09-harbor-city-economy-2026-07-22',
  reviewStatus: 'approved',
  sourceId: HARBOR_CITY_CATALOG_ID,
  sourceType: 'bundled',
  sourceVersion: HARBOR_CITY_CATALOG_VERSION,
};

const dependency = (key: string): PrimitiveDependencyInput => ({
  key,
  parameterMapping: {},
  required: true,
  versionRange: HARBOR_CITY_DEPENDENCY_RANGE,
});

function define(input: HarborSeedInput): HarborCityPrimitive {
  const primitive: PrimitiveDraftInput = {
    behaviorRef: BEHAVIOR_REFS_BY_KIND[input.kind],
    compatibility: { archetype: 'city-state', engine: 'anvil', mvp: true },
    defaults: input.defaults,
    dependencies: input.dependencies ?? [],
    displayName: input.displayName,
    documentation: input.documentation,
    key: input.key,
    kind: input.kind,
    parameterSchema: {
      additionalProperties: false,
      properties: input.properties,
      required: Object.keys(input.defaults),
      type: 'object',
    },
    primitiveSchemaVersion: 1,
    provenance,
    tags: [...new Set(['city-state', 'harbor-city', ...input.tags])].sort(),
    version: '1.0.0',
    visualHints: {},
  };
  const validation = validatePrimitive(primitive);
  if (!validation.valid) {
    throw new Error(
      `Invalid harbor-city primitive ${input.key}: ${JSON.stringify(validation.issues)}`,
    );
  }
  return {
    contentHash: primitiveContentHash(primitive),
    familyId: input.familyId,
    input: primitive,
    versionId: input.versionId,
  };
}

/**
 * Reviewed M09 additions. The sealed 16-entry STARTER_PRIMITIVES catalog is
 * intentionally not extended so M03-M08 closures and golden bytes stay exact.
 */
export const HARBOR_CITY_ECONOMY_PRIMITIVES: readonly HarborCityPrimitive[] = [
  define({
    defaults: {
      capacity: 1000000,
      quantityScale: 0,
      scarcity: 'finite',
      unit: 'ore-unit',
    },
    displayName: 'Iron Ore',
    documentation:
      '# Iron Ore\n\nA finite whole-unit mineral input for deterministic harbor production.',
    familyId: 'f530791a-78f9-5c77-92f3-28160fcae615',
    key: 'worldgraph.resource.iron-ore',
    kind: 'resource',
    properties: {
      capacity: { maximum: 1000000000, minimum: 1, type: 'integer' },
      quantityScale: { const: 0 },
      scarcity: { const: 'finite' },
      unit: { const: 'ore-unit' },
    },
    tags: ['iron', 'mineral', 'ore', 'production', 'resource'],
    versionId: 'dfefbd71-6554-57d8-94b3-f1868de55c04',
  }),
  define({
    defaults: {
      capacity: 1000000,
      quantityScale: 0,
      scarcity: 'manufactured',
      unit: 'part',
    },
    displayName: 'Metal Part',
    documentation: '# Metal Part\n\nA whole-unit manufactured output used by the harbor workshop.',
    familyId: '57b13c36-8dad-5bc4-a6d4-21984fb9eef6',
    key: 'worldgraph.resource.metal-part',
    kind: 'resource',
    properties: {
      capacity: { maximum: 1000000000, minimum: 1, type: 'integer' },
      quantityScale: { const: 0 },
      scarcity: { const: 'manufactured' },
      unit: { const: 'part' },
    },
    tags: ['fabricated', 'metal', 'part', 'production', 'resource'],
    versionId: '900fe5f1-8edc-5779-8725-867cc443afdc',
  }),
  define({
    defaults: {
      durationTicks: 12,
      facilityAssetType: 'workshop',
      inputs: [
        { quantity: '2', resourceKey: 'worldgraph.resource.iron-ore' },
        { quantity: '1', resourceKey: 'worldgraph.resource.energy' },
      ],
      outputs: [{ quantity: '1', resourceKey: 'worldgraph.resource.metal-part' }],
    },
    dependencies: [
      dependency('worldgraph.resource.energy'),
      dependency('worldgraph.resource.iron-ore'),
      dependency('worldgraph.resource.metal-part'),
      dependency('worldgraph.building.modular-guild-hall'),
      dependency('worldgraph.simulation-rule.discrete-city-clock'),
    ],
    displayName: 'Metal Part Fabrication',
    documentation:
      '# Metal Part Fabrication\n\nA twelve-tick recipe that consumes two iron ore and one energy to produce one metal part.',
    familyId: '9a5ee3d9-b33f-5077-b98a-a5d2f141ed2f',
    key: 'worldgraph.production-recipe.metal-part-fabrication',
    kind: 'production_recipe',
    properties: {
      durationTicks: { const: 12 },
      facilityAssetType: { const: 'workshop' },
      inputs: {
        const: [
          { quantity: '2', resourceKey: 'worldgraph.resource.iron-ore' },
          { quantity: '1', resourceKey: 'worldgraph.resource.energy' },
        ],
      },
      outputs: {
        const: [{ quantity: '1', resourceKey: 'worldgraph.resource.metal-part' }],
      },
    },
    tags: ['fabrication', 'harbor', 'metal', 'production', 'recipe'],
    versionId: 'b611dafc-b313-5262-9995-08abcdf708c7',
  }),
];

export const HARBOR_CITY_ECONOMY_PRIMITIVE_BY_KEY = new Map(
  HARBOR_CITY_ECONOMY_PRIMITIVES.map((primitive) => [primitive.input.key, primitive]),
);

export function assertHarborCityCatalogLock(): void {
  for (const primitive of HARBOR_CITY_ECONOMY_PRIMITIVES) {
    const identity = `${primitive.input.key}@${primitive.input.version}`;
    assertReviewedPrimitiveIndexPolicy(primitive.input);
    if ((harborSeedLock.primitives as Record<string, string>)[identity] !== primitive.contentHash) {
      throw new Error(`Harbor-city primitive lock mismatch: ${identity}`);
    }
  }
  if (
    harborSeedLock.catalog !== `${HARBOR_CITY_CATALOG_ID}@${HARBOR_CITY_CATALOG_VERSION}` ||
    harborSeedLock.schemaVersion !== 1 ||
    Object.keys(harborSeedLock.primitives).length !== HARBOR_CITY_ECONOMY_PRIMITIVES.length
  ) {
    throw new Error('Harbor-city primitive lock metadata or cardinality mismatch.');
  }
}
