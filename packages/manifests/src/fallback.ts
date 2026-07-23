import { satisfiesVersionRange } from '@worldgraph/catalog';
import {
  MANIFEST_GENERATOR_SCHEMA_VERSION,
  MANIFEST_PROMPT_TEMPLATE_VERSION,
  canonicalizeJson,
  type JsonValue,
  type ManifestGenerationEnvelopeV1,
  type PrimitiveKind,
  type WorldManifestV1,
} from '@worldgraph/contracts';

import {
  manifestCatalogSnapshotHash,
  manifestContentHash,
  manifestGenerationInputHash,
  manifestGenerationRequestHash,
  normalizeManifestPrompt,
  resolveManifestGenerationSeed,
  sha256,
} from './canonical.js';
import type { ManifestCatalogSnapshot, ManifestPrimitiveDefinition } from './catalog.js';
import { validateManifestGenerationEnvelope } from './validation.js';

const PREFERRED_KEYS: Readonly<Record<PrimitiveKind, string>> = {
  building: 'worldgraph.building.modular-guild-hall',
  currency: 'worldgraph.currency.closed-loop-credits',
  district: 'worldgraph.district.floating-mixed-use',
  election: 'worldgraph.election.council-ballot',
  event_template: 'worldgraph.event-template.council-session',
  government: 'worldgraph.government.guild-council',
  legal_right: 'worldgraph.legal-right.civic-charter',
  office: 'worldgraph.office.councillor',
  organization: 'worldgraph.organization.guild',
  player_role: 'worldgraph.player-role.citizen',
  production_recipe: 'worldgraph.production-recipe.energy-reclamation',
  resource: 'worldgraph.resource.energy',
  simulation_rule: 'worldgraph.simulation-rule.discrete-city-clock',
  tax: 'worldgraph.tax.flat-transaction-levy',
  terrain: 'worldgraph.terrain.floating-platform',
  visual_style: 'worldgraph.visual-style.low-poly-floating-city',
};

const REFS: Readonly<Record<PrimitiveKind, string>> = {
  building: 'guild-hall',
  currency: 'currency',
  district: 'district',
  election: 'council-election',
  event_template: 'council-session',
  government: 'government',
  legal_right: 'civic-charter',
  office: 'councillor-office',
  organization: 'guild',
  player_role: 'citizen-role',
  production_recipe: 'energy-production',
  resource: 'energy',
  simulation_rule: 'city-clock',
  tax: 'transaction-tax',
  terrain: 'terrain',
  visual_style: 'visual-style',
};

export interface DeterministicFallbackInput {
  catalog: ManifestCatalogSnapshot;
  expectedParentContentHash?: string | null;
  parentRevisionId?: string | null;
  prompt: string;
  providerConfigurationId?: string | null;
  seed?: string;
}

export interface DeterministicFallbackResult {
  catalogSnapshotHash: string;
  contentHash: string;
  envelope: ManifestGenerationEnvelopeV1;
  requestHash: string;
  resolvedInputHash: string;
  seed: string;
}

export class DeterministicFallbackUnavailableError extends Error {
  public readonly code = 'NO_COMPATIBLE_PRIMITIVES' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'DeterministicFallbackUnavailableError';
  }
}

function cloneObject(input: Record<string, JsonValue>): Record<string, JsonValue> {
  const cloned = canonicalizeJson(input);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== 'object') {
    throw new DeterministicFallbackUnavailableError('Primitive defaults are not a JSON object.');
  }
  return cloned;
}

function isCompatible(primitive: ManifestPrimitiveDefinition): boolean {
  return (
    primitive.lifecycle === 'published' &&
    primitive.compatibility.archetype === 'city-state' &&
    primitive.compatibility.engine === 'anvil' &&
    primitive.compatibility.mvp === true
  );
}

function selectPrimitives(
  catalog: ManifestCatalogSnapshot,
): Map<PrimitiveKind, ManifestPrimitiveDefinition> {
  const selected = new Map<PrimitiveKind, ManifestPrimitiveDefinition>();
  const sorted = [...catalog.primitives].sort((left, right) => {
    const leftIdentity = `${left.key}@${left.version}`;
    const rightIdentity = `${right.key}@${right.version}`;
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
  for (const kind of Object.keys(PREFERRED_KEYS) as PrimitiveKind[]) {
    const candidates = sorted.filter(
      (primitive) => primitive.kind === kind && isCompatible(primitive),
    );
    const primitive =
      candidates.find((candidate) => candidate.key === PREFERRED_KEYS[kind]) ?? candidates[0];
    if (!primitive) {
      throw new DeterministicFallbackUnavailableError(
        `The fallback requires one compatible published ${kind} primitive.`,
      );
    }
    selected.set(kind, primitive);
  }
  for (const primitive of selected.values()) {
    for (const dependency of primitive.dependencies) {
      if (!dependency.required) continue;
      const dependencyMatch = [...selected.values()].some(
        (candidate) =>
          candidate.key === dependency.key &&
          satisfiesVersionRange(candidate.version, dependency.versionRange),
      );
      if (!dependencyMatch) {
        throw new DeterministicFallbackUnavailableError(
          `Fallback dependency ${dependency.key} ${dependency.versionRange} is unavailable.`,
        );
      }
    }
  }
  return selected;
}

function generatedMetadata(normalizedPrompt: string): WorldManifestV1['metadata'] {
  const lower = normalizedPrompt.toLocaleLowerCase('en-US');
  const floating = lower.includes('floating');
  const guild = lower.includes('guild');
  const energyScarce = lower.includes('energy') && lower.includes('scarce');
  const closedLoop = lower.includes('closed-loop') || lower.includes('closed loop');
  return {
    archetype: 'city-state',
    description: [
      floating ? 'A bounded floating city-state' : 'A bounded city-state',
      guild ? 'organized around competing civic guilds' : 'organized around civic institutions',
      energyScarce ? 'under explicit energy scarcity' : 'with bounded resources',
      closedLoop ? 'and a closed-loop credit economy.' : 'and an internal credit economy.',
    ].join(' '),
    name: floating && guild ? 'Floating Guild City' : 'New City-State',
  };
}

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function manifestFieldPointers(value: unknown, pointer = ''): string[] {
  const current = pointer === '' ? [] : [pointer];
  if (Array.isArray(value)) {
    return [
      ...current,
      ...value.flatMap((entry, index) => manifestFieldPointers(entry, `${pointer}/${index}`)),
    ];
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return [
      ...current,
      ...entries.flatMap(([key, entry]) =>
        manifestFieldPointers(entry, `${pointer}/${pointerToken(key)}`),
      ),
    ];
  }
  return current;
}

function primitiveForField(
  manifest: WorldManifestV1,
  pointer: string,
): WorldManifestV1['primitiveRefs'][number] | undefined {
  const parts = pointer.slice(1).split('/');
  const byRef = new Map(manifest.primitiveRefs.map((primitive) => [primitive.ref, primitive]));
  const indexedRef = (
    values: readonly string[],
    rawIndex: string | undefined,
  ): WorldManifestV1['primitiveRefs'][number] | undefined => {
    if (rawIndex === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(rawIndex)) return undefined;
    const ref = values[Number(rawIndex)];
    return ref === undefined ? undefined : byRef.get(ref);
  };

  switch (parts[0]) {
    case 'primitiveRefs': {
      const index = parts[1];
      return index && /^(?:0|[1-9][0-9]*)$/u.test(index)
        ? manifest.primitiveRefs[Number(index)]
        : undefined;
    }
    case 'districts': {
      const district = manifest.districts[Number(parts[1])];
      return district && (parts[2] === 'parameters' || parts[2] === 'primitiveRef')
        ? byRef.get(district.primitiveRef)
        : undefined;
    }
    case 'institutions': {
      const institution = manifest.institutions[Number(parts[1])];
      return institution && (parts[2] === 'parameters' || parts[2] === 'primitiveRef')
        ? byRef.get(institution.primitiveRef)
        : undefined;
    }
    case 'organizations': {
      const organization = manifest.organizations[Number(parts[1])];
      return organization && (parts[2] === 'parameters' || parts[2] === 'primitiveRef')
        ? byRef.get(organization.primitiveRef)
        : undefined;
    }
    case 'actors': {
      const actor = manifest.actors[Number(parts[1])];
      return actor && (parts[2] === 'parameters' || parts[2] === 'rolePrimitiveRef')
        ? byRef.get(actor.rolePrimitiveRef)
        : undefined;
    }
    case 'economy':
      if (parts[1] === 'currencyPrimitiveRef') {
        return byRef.get(manifest.economy.currencyPrimitiveRef);
      }
      if (parts[1] === 'productionPrimitiveRefs') {
        return indexedRef(manifest.economy.productionPrimitiveRefs, parts[2]);
      }
      if (parts[1] === 'resourcePrimitiveRefs') {
        return indexedRef(manifest.economy.resourcePrimitiveRefs, parts[2]);
      }
      if (parts[1] === 'taxPrimitiveRefs') {
        return indexedRef(manifest.economy.taxPrimitiveRefs, parts[2]);
      }
      return undefined;
    case 'simulation':
      if (parts[1] === 'eventPrimitiveRefs') {
        return indexedRef(manifest.simulation.eventPrimitiveRefs, parts[2]);
      }
      if (parts[1] === 'rulePrimitiveRefs') {
        return indexedRef(manifest.simulation.rulePrimitiveRefs, parts[2]);
      }
      return undefined;
    case 'visual':
      if (parts[1] === 'stylePrimitiveRef') {
        return byRef.get(manifest.visual.stylePrimitiveRef);
      }
      if (parts[1] === 'terrainPrimitiveRef') {
        return byRef.get(manifest.visual.terrainPrimitiveRef);
      }
      return undefined;
    default:
      return undefined;
  }
}

export function completeFallbackProvenance(
  manifest: WorldManifestV1,
  templateHash: string,
  promptHash: string,
  templateSourceRef = `fallback-template-v${MANIFEST_PROMPT_TEMPLATE_VERSION}`,
): ManifestGenerationEnvelopeV1['provenance'] {
  const provenance: ManifestGenerationEnvelopeV1['provenance'] = manifestFieldPointers(
    manifest,
  ).map((pointer) => {
    const primitive = primitiveForField(manifest, pointer);
    if (primitive) {
      return {
        pointer,
        sourceHash: primitive.contentHash,
        sourceRef: `${primitive.key}@${primitive.version}`,
        sourceType: 'primitive' as const,
      };
    }
    if (pointer === '/seed') {
      return {
        pointer,
        sourceHash: sha256(manifest.seed),
        sourceRef: 'deterministic-seed',
        sourceType: 'fallback' as const,
      };
    }
    return {
      pointer,
      sourceHash: templateHash,
      sourceRef: templateSourceRef,
      sourceType: 'fallback' as const,
    };
  });
  for (const pointer of ['/metadata/description', '/metadata/name'] as const) {
    provenance.push({
      pointer,
      sourceHash: promptHash,
      sourceRef: `prompt:${promptHash.slice(0, 32)}`,
      sourceType: 'prompt',
    });
  }
  if (provenance.length > 512) {
    throw new DeterministicFallbackUnavailableError(
      'Fallback field provenance exceeds the generation envelope limit.',
    );
  }
  return provenance;
}

export function createDeterministicFallback(
  input: DeterministicFallbackInput,
): DeterministicFallbackResult {
  const normalizedPrompt = normalizeManifestPrompt(input.prompt);
  if (normalizedPrompt.length < 1 || normalizedPrompt.length > 2_000) {
    throw new DeterministicFallbackUnavailableError('Prompt length is outside fallback limits.');
  }
  const catalogSnapshotHash = manifestCatalogSnapshotHash(input.catalog);
  const providerConfigurationId = input.providerConfigurationId ?? 'deterministic-fallback-v1';
  const seed = resolveManifestGenerationSeed({
    prompt: normalizedPrompt,
    providerConfigurationId,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
  });
  const selected = selectPrimitives(input.catalog);
  const primitiveRefs: WorldManifestV1['primitiveRefs'] = [...selected.entries()]
    .sort(([left], [right]) => (REFS[left] < REFS[right] ? -1 : REFS[left] > REFS[right] ? 1 : 0))
    .map(([kind, primitive]) => ({
      contentHash: primitive.contentHash,
      key: primitive.key,
      kind,
      parameters: cloneObject(primitive.defaults),
      primitiveVersionId: primitive.versionId,
      ref: REFS[kind],
      version: primitive.version,
    }));
  const parameters = (kind: PrimitiveKind): Record<string, JsonValue> =>
    cloneObject(selected.get(kind)!.defaults);
  const assumptions = [
    'Council seats represent guild participation; the exact allocation requires creator review.',
    'Energy reclamation is bounded and does not remove the scarcity constraint.',
    'Initial actors are blueprints only and create no runtime identity or state.',
  ];
  const manifest: WorldManifestV1 = {
    actors: [
      {
        controller: 'player',
        homeDistrictKey: 'civic-platform',
        key: 'artisan-delegate',
        name: 'Artisan Delegate',
        organizationKey: 'artisan-guild',
        parameters: parameters('player_role'),
        rolePrimitiveRef: REFS.player_role,
      },
      {
        controller: 'player',
        homeDistrictKey: 'energy-harbor',
        key: 'energy-steward',
        name: 'Energy Steward',
        organizationKey: 'energy-guild',
        parameters: parameters('player_role'),
        rolePrimitiveRef: REFS.player_role,
      },
    ],
    assumptions,
    connections: [
      {
        fromDistrictKey: 'civic-platform',
        key: 'civic-energy-walkway',
        kind: 'walkway',
        toDistrictKey: 'energy-harbor',
      },
    ],
    districts: [
      {
        key: 'civic-platform',
        name: 'Civic Platform',
        parameters: parameters('district'),
        primitiveRef: REFS.district,
      },
      {
        key: 'energy-harbor',
        name: 'Energy Harbor',
        parameters: parameters('district'),
        primitiveRef: REFS.district,
      },
    ],
    economy: {
      currencyPrimitiveRef: REFS.currency,
      productionPrimitiveRefs: [REFS.production_recipe],
      resourcePrimitiveRefs: [REFS.resource],
      taxPrimitiveRefs: [REFS.tax],
    },
    extensions: {
      'worldgraph.fallback': {
        catalogSnapshotHash,
        limitations: [
          'Council seat allocation is not inferred.',
          'Scarcity thresholds retain reviewed primitive defaults.',
        ],
        promptHash: sha256(normalizedPrompt),
        templateVersion: MANIFEST_PROMPT_TEMPLATE_VERSION,
      },
    },
    institutions: [
      {
        districtKey: 'civic-platform',
        key: 'guild-council',
        name: 'Guild Council',
        organizationKeys: ['artisan-guild', 'energy-guild'],
        parameters: parameters('government'),
        primitiveRef: REFS.government,
      },
      {
        districtKey: 'civic-platform',
        key: 'council-election',
        name: 'Council Election',
        organizationKeys: ['artisan-guild', 'energy-guild'],
        parameters: parameters('election'),
        primitiveRef: REFS.election,
      },
      {
        districtKey: 'civic-platform',
        key: 'councillor-office',
        name: 'Councillor Office',
        organizationKeys: ['artisan-guild', 'energy-guild'],
        parameters: parameters('office'),
        primitiveRef: REFS.office,
      },
      {
        districtKey: null,
        key: 'civic-charter',
        name: 'Civic Charter',
        organizationKeys: [],
        parameters: parameters('legal_right'),
        primitiveRef: REFS.legal_right,
      },
    ],
    manifestSchemaVersion: 1,
    metadata: generatedMetadata(normalizedPrompt),
    organizations: [
      {
        homeDistrictKey: 'civic-platform',
        key: 'artisan-guild',
        name: 'Artisan Guild',
        parameters: parameters('organization'),
        primitiveRef: REFS.organization,
      },
      {
        homeDistrictKey: 'energy-harbor',
        key: 'energy-guild',
        name: 'Energy Guild',
        parameters: parameters('organization'),
        primitiveRef: REFS.organization,
      },
    ],
    primitiveRefs,
    relationships: [
      {
        key: 'artisan-membership',
        source: { key: 'artisan-delegate', kind: 'actor' },
        target: { key: 'artisan-guild', kind: 'organization' },
        type: 'member-of',
      },
      {
        key: 'energy-membership',
        source: { key: 'energy-steward', kind: 'actor' },
        target: { key: 'energy-guild', kind: 'organization' },
        type: 'member-of',
      },
      {
        key: 'council-governance',
        source: { key: 'guild-council', kind: 'institution' },
        target: { key: 'civic-platform', kind: 'district' },
        type: 'governs',
      },
      {
        key: 'guild-rivalry',
        source: { key: 'artisan-guild', kind: 'organization' },
        target: { key: 'energy-guild', kind: 'organization' },
        type: 'rivals',
      },
    ],
    seed,
    simulation: {
      eventPrimitiveRefs: [REFS.event_template],
      rulePrimitiveRefs: [REFS.simulation_rule],
      settings: { catchUpPolicy: 'bounded', deterministic: true },
    },
    visual: {
      direction: 'Readable low-poly floating platforms with aqua, brass, and slate accents.',
      stylePrimitiveRef: REFS.visual_style,
      terrainPrimitiveRef: REFS.terrain,
    },
  };
  const templateHash = sha256(`worldgraph-fallback:${MANIFEST_PROMPT_TEMPLATE_VERSION}`);
  const provenance = completeFallbackProvenance(manifest, templateHash, sha256(normalizedPrompt));
  const envelope: ManifestGenerationEnvelopeV1 = {
    assumptions: [...assumptions],
    generatorSchemaVersion: MANIFEST_GENERATOR_SCHEMA_VERSION,
    manifest,
    promptTemplateVersion: MANIFEST_PROMPT_TEMPLATE_VERSION,
    provenance,
    suggestedFixes: [],
    unresolvedQuestions: [
      'How should the seven council seats be allocated between competing guilds?',
      'Which creator-approved threshold should trigger emergency energy rationing?',
    ],
    warnings: [
      {
        code: 'FALLBACK_TEMPLATE_USED',
        message: 'A deterministic reviewed template was used instead of provider output.',
        pointer: '',
      },
      {
        code: 'HIGH_IMPACT_RULES_REQUIRE_REVIEW',
        message:
          'Governance allocation and emergency scarcity rules require explicit creator review.',
        pointer: '/assumptions',
      },
    ],
  };
  const validation = validateManifestGenerationEnvelope(envelope, input.catalog);
  if (!validation.valid || !validation.contentHash) {
    throw new DeterministicFallbackUnavailableError(
      `Deterministic fallback did not validate: ${validation.diagnostics.map((entry) => entry.code).join(',')}`,
    );
  }
  return {
    catalogSnapshotHash,
    contentHash: manifestContentHash(manifest),
    envelope,
    requestHash: manifestGenerationRequestHash({
      ...(input.expectedParentContentHash === undefined
        ? {}
        : { expectedParentContentHash: input.expectedParentContentHash }),
      ...(input.parentRevisionId === undefined ? {} : { parentRevisionId: input.parentRevisionId }),
      prompt: normalizedPrompt,
      providerConfigurationId,
      seed,
    }),
    resolvedInputHash: manifestGenerationInputHash({
      catalog: input.catalog,
      ...(input.expectedParentContentHash === undefined
        ? {}
        : { expectedParentContentHash: input.expectedParentContentHash }),
      ...(input.parentRevisionId === undefined ? {} : { parentRevisionId: input.parentRevisionId }),
      prompt: normalizedPrompt,
      providerConfigurationId,
      seed,
    }),
    seed,
  };
}
