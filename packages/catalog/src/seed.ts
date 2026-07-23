import type {
  PrimitiveDependencyInput,
  PrimitiveDraftInput,
  PrimitiveKind,
} from '@worldgraph/contracts';

import { assertReviewedPrimitiveIndexPolicy } from './search.js';
import { BEHAVIOR_REFS_BY_KIND, primitiveContentHash, validatePrimitive } from './validation.js';
import seedLock from './starter-catalog.lock.json';

export const STARTER_CATALOG_ID = 'worldgraph.city-state-starter' as const;
export const STARTER_CATALOG_VERSION = '1.0.0' as const;
export const STARTER_DEPENDENCY_RANGE = '>=1.0.0 <2.0.0' as const;
export const CATALOG_CURATOR_USER_ID = '155d9b48-4e26-5672-8854-9ff24f3262fd' as const;

export interface StarterPrimitive {
  contentHash: string;
  familyId: string;
  input: PrimitiveDraftInput;
  versionId: string;
}

const provenance = {
  author: 'WorldGraph',
  license: 'LicenseRef-WorldGraph-Seed-1.0',
  reviewId: 'm03-city-state-starter-2026-07-21',
  reviewStatus: 'approved',
  sourceId: STARTER_CATALOG_ID,
  sourceType: 'bundled',
  sourceVersion: STARTER_CATALOG_VERSION,
};

const ids = {
  building: ['0b022d50-ba0f-5114-9b55-8792532df8c2', 'ff6c7833-2d03-580f-964c-4b9a57dc6105'],
  currency: ['23a19515-be1b-532e-a785-8e432eda92b3', '80ac769d-aa6f-5f2f-bdbf-c4ec455209da'],
  district: ['a93bf643-7b52-518e-bf08-3223a670b76d', '79ebe1cf-0ac2-5d31-bc7f-1b12bcbd131b'],
  election: ['00f3c407-1cf7-53e0-a4eb-9a3327e61eca', 'd1958dd9-c04d-5da0-9a21-287eba02d6ef'],
  event_template: ['1faa856e-4ba6-5637-af09-d3c6e87a8ca5', 'becab8ec-fd01-5649-b899-2160787ab665'],
  government: ['a794e89a-ef60-5009-b05a-45c484c9625c', '39845c0e-280d-5a6b-80a2-975f6ed3be29'],
  legal_right: ['7c619a87-ef19-5e83-b3cb-3bebec89f078', 'edd3782f-efc8-52a4-bc43-efebd5f08322'],
  office: ['745947fc-19b3-5fe2-b3b8-a715397cd151', 'e4a1ed5a-9226-5aab-8629-c38d2e305136'],
  organization: ['c7b8e50e-a85b-5149-8c12-8b1a810ad66e', '467236a2-a85f-5696-8ff0-5a9341e2f7f7'],
  player_role: ['13efa677-bd93-5df4-bab9-d8e0e4906772', '4289ab74-f381-551e-b508-2d9ce3a3f96f'],
  production_recipe: [
    '73ea9d35-e278-58a9-aed6-382befe294f6',
    'fcc5be59-8711-5979-a531-0a3c94dc0274',
  ],
  resource: ['781c8b5d-deef-5c8c-8cdf-b5d9951cf083', '65c0afbe-f6b9-5da3-8dfc-0981456da84d'],
  simulation_rule: ['cbc89113-5624-5937-b202-755268582101', 'bf610d3f-e138-58bd-a18f-426923333e4f'],
  tax: ['dc43dd81-0647-5bea-8ac3-cee39acf6848', '5f50c934-bb1d-51a0-9529-3f21ae2355cc'],
  terrain: ['b591b586-9837-5238-a297-540dec90871c', '82d01082-ed29-545a-9d39-29e76b40bdcb'],
  visual_style: ['c36616bc-87f5-5171-9185-0cecd7a292a8', '9bd44b38-74cc-5cfa-8af0-26c0ecacec94'],
} as const satisfies Record<PrimitiveKind, readonly [string, string]>;

const dependency = (key: string): PrimitiveDependencyInput => ({
  key,
  parameterMapping: {},
  required: true,
  versionRange: STARTER_DEPENDENCY_RANGE,
});

interface SeedInput {
  defaults: Record<string, unknown>;
  dependencies?: PrimitiveDependencyInput[];
  documentation: string;
  key: string;
  kind: PrimitiveKind;
  properties: Record<string, unknown>;
  required?: string[];
  tags: string[];
  visualHints?: Record<string, unknown>;
}

function define(input: SeedInput): StarterPrimitive {
  const [familyId, versionId] = ids[input.kind];
  const primitive: PrimitiveDraftInput = {
    behaviorRef: BEHAVIOR_REFS_BY_KIND[input.kind],
    compatibility: { archetype: 'city-state', engine: 'anvil', mvp: true },
    defaults: input.defaults,
    dependencies: input.dependencies ?? [],
    displayName: input.key
      .split('.')
      .at(-1)!
      .split('-')
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(' '),
    documentation: input.documentation,
    key: input.key,
    kind: input.kind,
    parameterSchema: {
      additionalProperties: false,
      properties: input.properties,
      required: input.required ?? Object.keys(input.defaults),
      type: 'object',
    },
    primitiveSchemaVersion: 1,
    provenance,
    tags: [...new Set(['city-state', ...input.tags])].sort(),
    version: '1.0.0',
    visualHints: input.visualHints ?? {},
  };
  const validation = validatePrimitive(primitive);
  if (!validation.valid)
    throw new Error(`Invalid bundled primitive ${input.key}: ${JSON.stringify(validation.issues)}`);
  return { contentHash: primitiveContentHash(primitive), familyId, input: primitive, versionId };
}

export const STARTER_PRIMITIVES: readonly StarterPrimitive[] = [
  define({
    defaults: { quorumBps: 6000, seatCount: 7, termTicks: 720 },
    documentation: '# Guild Council\n\nA guild-led council government for a bounded city-state.',
    key: 'worldgraph.government.guild-council',
    kind: 'government',
    properties: {
      quorumBps: { maximum: 10000, minimum: 1, type: 'integer' },
      seatCount: { maximum: 31, minimum: 3, type: 'integer' },
      termTicks: { maximum: 100000, minimum: 1, type: 'integer' },
    },
    tags: ['council', 'governance', 'guild-led'],
  }),
  define({
    defaults: {
      cashOutAllowed: false,
      code: 'GCR',
      initialSupplyPolicy: 'per-capita-at-compile',
      maxSupply: '100000000.00',
      minorUnitScale: 2,
      noCashValue: true,
    },
    documentation: '# Closed Loop Credits\n\nNon-cash credits circulate inside the city economy.',
    key: 'worldgraph.currency.closed-loop-credits',
    kind: 'currency',
    properties: {
      cashOutAllowed: { const: false },
      code: { const: 'GCR' },
      initialSupplyPolicy: { const: 'per-capita-at-compile' },
      maxSupply: { maxLength: 32, minLength: 1, type: 'string' },
      minorUnitScale: { maximum: 6, minimum: 0, type: 'integer' },
      noCashValue: { const: true },
    },
    tags: ['closed-loop', 'credits', 'economy'],
  }),
  define({
    defaults: { capacity: 10000, scarcity: 'scarce', unit: 'energy-unit' },
    documentation:
      '# Energy\n\nA finite, energy-scarce resource stock for production and services.',
    key: 'worldgraph.resource.energy',
    kind: 'resource',
    properties: {
      capacity: { maximum: 1000000000, minimum: 1, type: 'integer' },
      scarcity: { const: 'scarce' },
      unit: { const: 'energy-unit' },
    },
    tags: ['energy', 'resource', 'scarce'],
  }),
  define({
    defaults: { maxDistricts: 12, platformRadiusMeters: 600 },
    documentation: '# Floating Platform\n\nA bounded floating terrain platform for a compact city.',
    key: 'worldgraph.terrain.floating-platform',
    kind: 'terrain',
    properties: {
      maxDistricts: { maximum: 32, minimum: 2, type: 'integer' },
      platformRadiusMeters: { maximum: 5000, minimum: 100, type: 'integer' },
    },
    tags: ['floating', 'platform', 'terrain'],
    visualHints: { geometry: 'low-poly-platform' },
  }),
  define({
    defaults: { maxCatchUpTicks: 100, tickDurationSeconds: 60 },
    documentation: '# Discrete City Clock\n\nA deterministic fixed-duration simulation clock.',
    key: 'worldgraph.simulation-rule.discrete-city-clock',
    kind: 'simulation_rule',
    properties: {
      maxCatchUpTicks: { maximum: 1000, minimum: 0, type: 'integer' },
      tickDurationSeconds: { maximum: 3600, minimum: 1, type: 'integer' },
    },
    tags: ['clock', 'deterministic', 'simulation'],
  }),
  define({
    defaults: { method: 'ranked-choice', votingTicks: 24 },
    dependencies: [
      dependency('worldgraph.government.guild-council'),
      dependency('worldgraph.office.councillor'),
      dependency('worldgraph.player-role.citizen'),
    ],
    documentation: '# Council Ballot\n\nA ranked-choice election for council seats.',
    key: 'worldgraph.election.council-ballot',
    kind: 'election',
    properties: {
      method: { const: 'ranked-choice' },
      votingTicks: { maximum: 720, minimum: 1, type: 'integer' },
    },
    tags: ['ballot', 'council', 'election'],
  }),
  define({
    defaults: { rateBps: 250 },
    dependencies: [
      dependency('worldgraph.currency.closed-loop-credits'),
      dependency('worldgraph.government.guild-council'),
    ],
    documentation: '# Flat Transaction Levy\n\nA transparent levy on internal credit transfers.',
    key: 'worldgraph.tax.flat-transaction-levy',
    kind: 'tax',
    properties: { rateBps: { maximum: 5000, minimum: 0, type: 'integer' } },
    tags: ['credits', 'tax', 'transaction'],
  }),
  define({
    defaults: { cycleTicks: 12, outputAmount: 10, outputResource: 'worldgraph.resource.energy' },
    dependencies: [
      dependency('worldgraph.resource.energy'),
      dependency('worldgraph.simulation-rule.discrete-city-clock'),
    ],
    documentation:
      '# Energy Reclamation\n\nA scheduled recipe that restores a bounded amount of energy.',
    key: 'worldgraph.production-recipe.energy-reclamation',
    kind: 'production_recipe',
    properties: {
      cycleTicks: { maximum: 10000, minimum: 1, type: 'integer' },
      outputAmount: { maximum: 1000000, minimum: 1, type: 'integer' },
      outputResource: { const: 'worldgraph.resource.energy' },
    },
    tags: ['energy', 'production', 'reclamation'],
  }),
  define({
    defaults: { capacity: 1200, connectivity: 'walkable-grid' },
    dependencies: [dependency('worldgraph.terrain.floating-platform')],
    documentation:
      '# Floating Mixed Use\n\nA connected residential, civic, and production district.',
    key: 'worldgraph.district.floating-mixed-use',
    kind: 'district',
    properties: {
      capacity: { maximum: 100000, minimum: 10, type: 'integer' },
      connectivity: { const: 'walkable-grid' },
    },
    tags: ['district', 'floating', 'mixed-use'],
    visualHints: { zoneMix: ['civic', 'residential', 'workshop'] },
  }),
  define({
    defaults: { initialOwnerKind: 'organization', transferable: true },
    dependencies: [dependency('worldgraph.district.floating-mixed-use')],
    documentation: '# Modular Guild Hall\n\nA transferable organization-owned civic building.',
    key: 'worldgraph.building.modular-guild-hall',
    kind: 'building',
    properties: { initialOwnerKind: { const: 'organization' }, transferable: { const: true } },
    tags: ['building', 'guild', 'modular'],
    visualHints: { geometry: 'modular-hall' },
  }),
  define({
    defaults: { treasuryPolicy: 'member-approved' },
    dependencies: [dependency('worldgraph.government.guild-council')],
    documentation: '# Guild\n\nA member organization participating in council governance.',
    key: 'worldgraph.organization.guild',
    kind: 'organization',
    properties: { treasuryPolicy: { const: 'member-approved' } },
    tags: ['guild', 'organization', 'treasury'],
  }),
  define({
    defaults: { seatCount: 7 },
    dependencies: [
      dependency('worldgraph.organization.guild'),
      dependency('worldgraph.government.guild-council'),
    ],
    documentation: '# Councillor\n\nAn elected office holding one guild council seat.',
    key: 'worldgraph.office.councillor',
    kind: 'office',
    properties: { seatCount: { maximum: 31, minimum: 3, type: 'integer' } },
    tags: ['council', 'office', 'seat'],
  }),
  define({
    defaults: { rights: ['hold-office', 'own-asset', 'transfer-credits', 'vote'] },
    dependencies: [dependency('worldgraph.government.guild-council')],
    documentation:
      '# Civic Charter\n\nRights to vote, hold office, own assets, and transfer credits.',
    key: 'worldgraph.legal-right.civic-charter',
    kind: 'legal_right',
    properties: {
      rights: {
        items: { enum: ['hold-office', 'own-asset', 'transfer-credits', 'vote'], type: 'string' },
        maxItems: 4,
        minItems: 4,
        type: 'array',
        uniqueItems: true,
      },
    },
    tags: ['charter', 'rights', 'vote'],
  }),
  define({
    defaults: { controller: true, grantPolicy: 'membership' },
    dependencies: [
      dependency('worldgraph.legal-right.civic-charter'),
      dependency('worldgraph.organization.guild'),
      dependency('worldgraph.currency.closed-loop-credits'),
    ],
    documentation: '# Citizen\n\nA player-controlled member role with civic and economic rights.',
    key: 'worldgraph.player-role.citizen',
    kind: 'player_role',
    properties: { controller: { const: true }, grantPolicy: { const: 'membership' } },
    tags: ['citizen', 'member', 'player'],
  }),
  define({
    defaults: { geometry: 'low-poly', material: 'matte', palette: ['aqua', 'brass', 'slate'] },
    dependencies: [
      dependency('worldgraph.terrain.floating-platform'),
      dependency('worldgraph.building.modular-guild-hall'),
    ],
    documentation:
      '# Low Poly Floating City\n\nA readable low-poly visual style for a floating city.',
    key: 'worldgraph.visual-style.low-poly-floating-city',
    kind: 'visual_style',
    properties: {
      geometry: { const: 'low-poly' },
      material: { const: 'matte' },
      palette: {
        items: { enum: ['aqua', 'brass', 'slate'], type: 'string' },
        maxItems: 3,
        minItems: 3,
        type: 'array',
      },
    },
    tags: ['floating', 'low-poly', 'visual'],
    visualHints: { lighting: 'soft-daylight' },
  }),
  define({
    defaults: { intervalTicks: 720, priority: 50 },
    dependencies: [
      dependency('worldgraph.simulation-rule.discrete-city-clock'),
      dependency('worldgraph.government.guild-council'),
      dependency('worldgraph.office.councillor'),
    ],
    documentation: '# Council Session\n\nA scheduled recurring council deliberation event.',
    key: 'worldgraph.event-template.council-session',
    kind: 'event_template',
    properties: {
      intervalTicks: { maximum: 100000, minimum: 1, type: 'integer' },
      priority: { maximum: 100, minimum: 0, type: 'integer' },
    },
    tags: ['council', 'event', 'scheduled'],
  }),
];

export const STARTER_PRIMITIVE_BY_KEY = new Map(
  STARTER_PRIMITIVES.map((primitive) => [primitive.input.key, primitive]),
);

export function assertStarterCatalogLock(): void {
  for (const primitive of STARTER_PRIMITIVES) {
    const identity = `${primitive.input.key}@${primitive.input.version}`;
    assertReviewedPrimitiveIndexPolicy(primitive.input);
    if ((seedLock.primitives as Record<string, string>)[identity] !== primitive.contentHash) {
      throw new Error(`Bundled primitive lock mismatch: ${identity}`);
    }
  }
  if (
    seedLock.catalog !== `${STARTER_CATALOG_ID}@${STARTER_CATALOG_VERSION}` ||
    seedLock.schemaVersion !== 1 ||
    Object.keys(seedLock.primitives).length !== STARTER_PRIMITIVES.length
  )
    throw new Error('Bundled primitive lock metadata or cardinality mismatch.');
}
