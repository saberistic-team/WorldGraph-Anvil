import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  ALLOWED_BEHAVIOR_REFS,
  satisfiesVersionRange,
  validateBoundedJson,
} from '@worldgraph/catalog';
import {
  MANIFEST_VALIDATOR_VERSION,
  MAX_MANIFEST_GENERATION_WARNINGS,
  ManifestGenerationEnvelopeV1Schema,
  WorldManifestV1Schema,
  canonicalJson,
  createValidator,
  type JsonValue,
  type ManifestDiagnostic,
  type ManifestGenerationEnvelopeV1,
  type ManifestGenerationWarning,
  type ManifestSuggestedFix,
  type PrimitiveKind,
  type WorldManifestV1,
} from '@worldgraph/contracts';

import { manifestCatalogSnapshotHash, manifestContentHash, sha256 } from './canonical.js';
import type { ManifestCatalogSnapshot, ManifestPrimitiveDefinition } from './catalog.js';
import { worldgraphEconomyExtensionIssues } from './economy-extension.js';
import { worldgraphGovernanceExtensionIssues } from './governance-extension.js';
import type { SafeYamlLocation } from './yaml.js';

export type { ManifestCatalogSnapshot } from './catalog.js';

const manifestValidator = createValidator<WorldManifestV1>(WorldManifestV1Schema);
const envelopeValidator = createValidator<ManifestGenerationEnvelopeV1>(
  ManifestGenerationEnvelopeV1Schema,
);
const MAX_DIAGNOSTICS = 128;
export const MAX_MANIFEST_GENERATION_WARNING_REQUIREMENTS = MAX_MANIFEST_GENERATION_WARNINGS;
const CRITICAL_KINDS: readonly PrimitiveKind[] = [
  'government',
  'currency',
  'resource',
  'terrain',
  'district',
  'organization',
  'player_role',
  'visual_style',
  'simulation_rule',
];
const CRITICAL_KIND_USAGE_POINTER: Readonly<Partial<Record<PrimitiveKind, string>>> = {
  currency: '/economy/currencyPrimitiveRef',
  district: '/districts',
  government: '/institutions',
  organization: '/organizations',
  player_role: '/actors',
  resource: '/economy/resourcePrimitiveRefs',
  simulation_rule: '/simulation/rulePrimitiveRefs',
  terrain: '/visual/terrainPrimitiveRef',
  visual_style: '/visual/stylePrimitiveRef',
};
const ALLOWED_RELATIONSHIP_TUPLES = new Set<string>([
  'cooperates-with:actor->actor',
  'cooperates-with:institution->institution',
  'cooperates-with:organization->organization',
  'governs:institution->district',
  'located-in:actor->district',
  'located-in:institution->district',
  'located-in:organization->district',
  'member-of:actor->organization',
  'rivals:actor->actor',
  'rivals:institution->institution',
  'rivals:organization->organization',
  'supplies:organization->district',
  'supplies:organization->institution',
  'supplies:organization->organization',
]);

export interface ManifestValidationResult {
  catalogSnapshotHash: string;
  contentHash: string | null;
  diagnostics: readonly ManifestDiagnostic[];
  reportHash: string;
  valid: boolean;
  validatorVersion: typeof MANIFEST_VALIDATOR_VERSION;
}

function locationFor(
  pointer: string,
  locations?: ReadonlyMap<string, SafeYamlLocation>,
): SafeYamlLocation | null {
  if (!locations) return null;
  let candidate = pointer;
  for (;;) {
    const location = locations.get(candidate);
    if (location) return location;
    const separator = candidate.lastIndexOf('/');
    if (separator < 0) return locations.get('') ?? null;
    candidate = candidate.slice(0, separator);
  }
}

function diagnostic(
  severity: ManifestDiagnostic['severity'],
  code: string,
  pointer: string,
  message: string,
  locations?: ReadonlyMap<string, SafeYamlLocation>,
  fixes: ManifestSuggestedFix[] = [],
  relatedPointers: string[] = [],
): ManifestDiagnostic {
  return {
    code,
    fixes,
    location: locationFor(pointer, locations),
    message,
    pointer,
    relatedPointers,
    severity,
  };
}

function selectPrimitiveFix(pointer: string, kind: PrimitiveKind): ManifestSuggestedFix {
  return {
    kind: 'select-primitive',
    pointer,
    primitiveKind: kind,
    rationale: `Select an exact published ${kind} primitive version.`,
  };
}

function stableDiagnostics(input: readonly ManifestDiagnostic[]): ManifestDiagnostic[] {
  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  const unique = new Map<string, ManifestDiagnostic>();
  for (const entry of input) {
    unique.set(
      `${entry.severity}\u0000${entry.code}\u0000${entry.pointer}\u0000${entry.message}`,
      entry,
    );
  }
  return [...unique.values()]
    .sort((left, right) => {
      const bySeverity = severityRank[left.severity] - severityRank[right.severity];
      if (bySeverity !== 0) return bySeverity;
      if (left.pointer !== right.pointer) return left.pointer < right.pointer ? -1 : 1;
      if (left.code !== right.code) return left.code < right.code ? -1 : 1;
      return left.message < right.message ? -1 : left.message > right.message ? 1 : 0;
    })
    .slice(0, MAX_DIAGNOSTICS);
}

function parameterIssues(
  definition: ManifestPrimitiveDefinition,
  parameters: Record<string, JsonValue>,
  pointer: string,
  locations: ReadonlyMap<string, SafeYamlLocation> | undefined,
): ManifestDiagnostic[] {
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: false,
      removeAdditional: false,
      strict: true,
    });
    addFormats(ajv);
    const validate = ajv.compile(definition.parameterSchema);
    if (validate(parameters)) return [];
    return (validate.errors ?? [])
      .slice(0, 16)
      .map((error: ErrorObject) =>
        diagnostic(
          'error',
          'MANIFEST_PRIMITIVE_PARAMETERS_INVALID',
          `${pointer}${error.instancePath}`,
          `Configuration does not satisfy ${definition.key}@${definition.version}: ${error.message ?? 'invalid value'}.`,
          locations,
        ),
      );
  } catch {
    return [
      diagnostic(
        'error',
        'MANIFEST_PRIMITIVE_SCHEMA_UNSUPPORTED',
        pointer,
        `The pinned parameter schema for ${definition.key}@${definition.version} is unsupported.`,
        locations,
      ),
    ];
  }
}

function duplicateKeyDiagnostics<T extends { key: string }>(
  values: readonly T[],
  pointer: string,
  locations: ReadonlyMap<string, SafeYamlLocation> | undefined,
): ManifestDiagnostic[] {
  const seen = new Map<string, number>();
  const diagnostics: ManifestDiagnostic[] = [];
  values.forEach((value, index) => {
    const normalized = value.key.normalize('NFC');
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_DUPLICATE_LOCAL_KEY',
          `${pointer}/${index}/key`,
          `Local key ${value.key} is duplicated.`,
          locations,
          [],
          [`${pointer}/${previous}/key`],
        ),
      );
    } else seen.set(normalized, index);
  });
  return diagnostics;
}

function definitionForReference(
  catalog: ManifestCatalogSnapshot,
  reference: WorldManifestV1['primitiveRefs'][number],
): ManifestPrimitiveDefinition | undefined {
  return catalog.primitives.find(
    (candidate) =>
      candidate.key === reference.key &&
      candidate.version === reference.version &&
      candidate.versionId === reference.primitiveVersionId &&
      candidate.contentHash === reference.contentHash &&
      candidate.kind === reference.kind,
  );
}

function validateConnectivity(
  manifest: WorldManifestV1,
  locations: ReadonlyMap<string, SafeYamlLocation> | undefined,
): ManifestDiagnostic[] {
  const districtKeys = new Set(manifest.districts.map((district) => district.key));
  const adjacency = new Map([...districtKeys].map((key) => [key, new Set<string>()]));
  const diagnostics: ManifestDiagnostic[] = [];
  manifest.connections.forEach((connection, index) => {
    const pointer = `/connections/${index}`;
    if (!districtKeys.has(connection.fromDistrictKey)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_CONNECTION_DISTRICT_UNKNOWN',
          `${pointer}/fromDistrictKey`,
          `Connection source ${connection.fromDistrictKey} does not resolve.`,
          locations,
        ),
      );
    }
    if (!districtKeys.has(connection.toDistrictKey)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_CONNECTION_DISTRICT_UNKNOWN',
          `${pointer}/toDistrictKey`,
          `Connection target ${connection.toDistrictKey} does not resolve.`,
          locations,
        ),
      );
    }
    if (connection.fromDistrictKey === connection.toDistrictKey) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_CONNECTION_SELF_REFERENCE',
          pointer,
          'A district connection must join two different districts.',
          locations,
        ),
      );
    }
    if (
      districtKeys.has(connection.fromDistrictKey) &&
      districtKeys.has(connection.toDistrictKey) &&
      connection.fromDistrictKey !== connection.toDistrictKey
    ) {
      adjacency.get(connection.fromDistrictKey)!.add(connection.toDistrictKey);
      adjacency.get(connection.toDistrictKey)!.add(connection.fromDistrictKey);
    }
  });
  const first = manifest.districts[0]?.key;
  if (first) {
    const visited = new Set([first]);
    const pending = [first];
    while (pending.length > 0) {
      const current = pending.shift()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
    manifest.districts.forEach((district, index) => {
      if (!visited.has(district.key)) {
        diagnostics.push(
          diagnostic(
            'error',
            'MANIFEST_DISTRICT_GRAPH_DISCONNECTED',
            `/districts/${index}/key`,
            `District ${district.key} is disconnected from the district graph.`,
            locations,
          ),
        );
      }
    });
  }
  return diagnostics;
}

function report(
  catalog: ManifestCatalogSnapshot,
  diagnostics: readonly ManifestDiagnostic[],
  contentHash: string | null,
): ManifestValidationResult {
  const stable = stableDiagnostics(diagnostics);
  const catalogSnapshotHash = manifestCatalogSnapshotHash(catalog);
  const valid = !stable.some((entry) => entry.severity === 'error');
  return {
    catalogSnapshotHash,
    contentHash,
    diagnostics: stable,
    reportHash: sha256(
      canonicalJson({
        catalogSnapshotHash,
        contentHash,
        diagnostics: stable,
        valid,
        validatorVersion: MANIFEST_VALIDATOR_VERSION,
      }),
    ),
    valid,
    validatorVersion: MANIFEST_VALIDATOR_VERSION,
  };
}

export function mergeManifestGenerationWarnings(
  ...warningSets: readonly (readonly ManifestGenerationWarning[])[]
): ManifestGenerationWarning[] {
  const unique = new Map<string, ManifestGenerationWarning>();
  for (const warning of warningSets.flat()) {
    unique.set(`${warning.code}\u0000${warning.pointer}\u0000${warning.message}`, warning);
  }
  const warnings = [...unique.values()].sort((left, right) => {
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    if (left.pointer !== right.pointer) return left.pointer < right.pointer ? -1 : 1;
    return left.message < right.message ? -1 : left.message > right.message ? 1 : 0;
  });
  if (warnings.length > MAX_MANIFEST_GENERATION_WARNING_REQUIREMENTS) {
    throw new Error('MANIFEST_GENERATION_WARNING_LIMIT');
  }
  return warnings;
}

/**
 * Carries immutable generator warning requirements into every catalog-specific
 * validation report for a revision. The warning snapshot lives on the revision;
 * catalog lifecycle changes therefore cannot erase generation-time review debt.
 */
export function attachManifestGenerationWarnings(
  validation: ManifestValidationResult,
  warnings: readonly ManifestGenerationWarning[],
): ManifestValidationResult {
  const requirements = mergeManifestGenerationWarnings(warnings);
  const diagnostics = stableDiagnostics([
    ...validation.diagnostics,
    ...requirements.map((warning) =>
      diagnostic('warning', warning.code, warning.pointer, warning.message),
    ),
  ]);
  const retained = new Set(
    diagnostics
      .filter((entry) => entry.severity === 'warning')
      .map((entry) => `${entry.code}\u0000${entry.pointer}\u0000${entry.message}`),
  );
  if (
    requirements.some(
      (warning) => !retained.has(`${warning.code}\u0000${warning.pointer}\u0000${warning.message}`),
    )
  ) {
    throw new Error('MANIFEST_GENERATION_WARNING_LIMIT');
  }
  const valid = !diagnostics.some((entry) => entry.severity === 'error');
  return {
    ...validation,
    diagnostics,
    reportHash: sha256(
      canonicalJson({
        catalogSnapshotHash: validation.catalogSnapshotHash,
        contentHash: validation.contentHash,
        diagnostics,
        valid,
        validatorVersion: validation.validatorVersion,
      }),
    ),
    valid,
  };
}

export function validateWorldManifest(
  input: unknown,
  catalog: ManifestCatalogSnapshot,
  locations?: ReadonlyMap<string, SafeYamlLocation>,
): ManifestValidationResult {
  const diagnostics: ManifestDiagnostic[] = [];
  const manifestJsonBounds = {
    maxArrayItems: 512,
    maxDepth: 16,
    maxNodes: 4_000,
    maxProperties: 1_000,
  } as const;
  const boundedIssues = validateBoundedJson(input, manifestJsonBounds).issues;
  let contentScanInput = input;
  if (input !== null && !Array.isArray(input) && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const extensions = record.extensions;
    if (extensions !== null && !Array.isArray(extensions) && typeof extensions === 'object') {
      const safeExtensions = { ...(extensions as Record<string, unknown>) };
      const economyExtension = safeExtensions['worldgraph.economy'];
      if (
        economyExtension !== null &&
        typeof economyExtension === 'object' &&
        !Array.isArray(economyExtension) &&
        (economyExtension as Record<string, unknown>).schemaVersion === 2
      ) {
        delete safeExtensions['worldgraph.economy'];
      }
      const governanceExtension = safeExtensions['worldgraph.governance'];
      if (
        governanceExtension !== null &&
        typeof governanceExtension === 'object' &&
        !Array.isArray(governanceExtension) &&
        (governanceExtension as Record<string, unknown>).schemaVersion === 1
      ) {
        delete safeExtensions['worldgraph.governance'];
      }
      contentScanInput = { ...record, extensions: safeExtensions };
    }
  }
  const executableIssues = validateBoundedJson(contentScanInput, {
    ...manifestJsonBounds,
    rejectExecutableContent: true,
  }).issues.filter((entry) =>
    [
      'EXECUTABLE_SQL_FORBIDDEN',
      'EXECUTABLE_TEMPLATE_FORBIDDEN',
      'REMOTE_OR_EXECUTABLE_CONTENT_FORBIDDEN',
    ].includes(entry.code),
  );
  for (const boundedIssue of [...boundedIssues, ...executableIssues]) {
    diagnostics.push(
      diagnostic(
        'error',
        boundedIssue.code,
        boundedIssue.pointer === '/' ? '' : boundedIssue.pointer,
        boundedIssue.message,
        locations,
      ),
    );
  }
  const schemaIssues = manifestValidator.issues(input);
  for (const schemaIssue of schemaIssues) {
    diagnostics.push(
      diagnostic(
        'error',
        'MANIFEST_SCHEMA_INVALID',
        schemaIssue.path === '/' ? '' : schemaIssue.path,
        `Manifest schema violation (${schemaIssue.keyword}): ${schemaIssue.message}`,
        locations,
      ),
    );
  }
  if (schemaIssues.length > 0 || diagnostics.length >= MAX_DIAGNOSTICS) {
    return report(catalog, diagnostics, null);
  }
  const manifest = input as WorldManifestV1;
  diagnostics.push(...duplicateKeyDiagnostics(manifest.districts, '/districts', locations));
  diagnostics.push(...duplicateKeyDiagnostics(manifest.connections, '/connections', locations));
  diagnostics.push(...duplicateKeyDiagnostics(manifest.institutions, '/institutions', locations));
  diagnostics.push(...duplicateKeyDiagnostics(manifest.organizations, '/organizations', locations));
  diagnostics.push(...duplicateKeyDiagnostics(manifest.actors, '/actors', locations));
  diagnostics.push(...duplicateKeyDiagnostics(manifest.relationships, '/relationships', locations));

  const refs = new Map<string, WorldManifestV1['primitiveRefs'][number]>();
  const definitions = new Map<string, ManifestPrimitiveDefinition>();
  manifest.primitiveRefs.forEach((reference, index) => {
    const pointer = `/primitiveRefs/${index}`;
    if (refs.has(reference.ref)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_DUPLICATE_PRIMITIVE_REF',
          `${pointer}/ref`,
          `Primitive reference ${reference.ref} is duplicated.`,
          locations,
        ),
      );
    } else refs.set(reference.ref, reference);
    const definition = definitionForReference(catalog, reference);
    if (!definition) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_PRIMITIVE_PIN_UNKNOWN',
          pointer,
          `Pinned primitive ${reference.key}@${reference.version} does not exactly match the catalog snapshot.`,
          locations,
          [selectPrimitiveFix(pointer, reference.kind)],
        ),
      );
      return;
    }
    definitions.set(reference.ref, definition);
    if (definition.lifecycle === 'deprecated') {
      diagnostics.push(
        diagnostic(
          'warning',
          'MANIFEST_PRIMITIVE_DEPRECATED',
          pointer,
          `Pinned primitive ${definition.key}@${definition.version} is deprecated but remains immutable.`,
          locations,
        ),
      );
    }
    if (definition.behaviorRef && !ALLOWED_BEHAVIOR_REFS.has(definition.behaviorRef)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_BEHAVIOR_NOT_ALLOWLISTED',
          pointer,
          `Pinned primitive behavior for ${definition.key} is not allowlisted.`,
          locations,
        ),
      );
    }
    if (
      definition.compatibility.archetype !== 'city-state' ||
      definition.compatibility.engine !== 'anvil' ||
      definition.compatibility.mvp !== true
    ) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_PRIMITIVE_INCOMPATIBLE',
          pointer,
          `Pinned primitive ${definition.key}@${definition.version} is incompatible with the city-state MVP.`,
          locations,
        ),
      );
    }
    diagnostics.push(
      ...parameterIssues(definition, reference.parameters, `${pointer}/parameters`, locations),
    );
  });

  const usedKinds = new Set<PrimitiveKind>();
  const requireRef = (
    ref: string,
    expectedKinds: readonly PrimitiveKind[],
    pointer: string,
    parameters?: Record<string, JsonValue>,
  ): void => {
    const reference = refs.get(ref);
    if (!reference) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_PRIMITIVE_REF_UNKNOWN',
          pointer,
          `Primitive reference ${ref} does not resolve.`,
          locations,
          expectedKinds.length === 1 ? [selectPrimitiveFix(pointer, expectedKinds[0]!)] : [],
        ),
      );
      return;
    }
    if (!expectedKinds.includes(reference.kind)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_PRIMITIVE_KIND_MISMATCH',
          pointer,
          `Primitive reference ${ref} has kind ${reference.kind}, expected ${expectedKinds.join(' or ')}.`,
          locations,
          expectedKinds.length === 1 ? [selectPrimitiveFix(pointer, expectedKinds[0]!)] : [],
        ),
      );
      return;
    }
    usedKinds.add(reference.kind);
    const definition = definitions.get(ref);
    if (definition && parameters) {
      diagnostics.push(
        ...parameterIssues(
          definition,
          parameters,
          parameters === reference.parameters
            ? pointer
            : `${pointer.replace(/\/primitiveRef$/u, '')}/parameters`,
          locations,
        ),
      );
    }
  };

  manifest.districts.forEach((district, index) =>
    requireRef(
      district.primitiveRef,
      ['district'],
      `/districts/${index}/primitiveRef`,
      district.parameters,
    ),
  );
  manifest.institutions.forEach((institution, index) =>
    requireRef(
      institution.primitiveRef,
      ['government', 'election', 'office', 'legal_right'],
      `/institutions/${index}/primitiveRef`,
      institution.parameters,
    ),
  );
  manifest.organizations.forEach((organization, index) =>
    requireRef(
      organization.primitiveRef,
      ['organization'],
      `/organizations/${index}/primitiveRef`,
      organization.parameters,
    ),
  );
  manifest.actors.forEach((actor, index) =>
    requireRef(
      actor.rolePrimitiveRef,
      ['player_role'],
      `/actors/${index}/rolePrimitiveRef`,
      actor.parameters,
    ),
  );
  requireRef(manifest.economy.currencyPrimitiveRef, ['currency'], '/economy/currencyPrimitiveRef');
  manifest.economy.resourcePrimitiveRefs.forEach((ref, index) =>
    requireRef(ref, ['resource'], `/economy/resourcePrimitiveRefs/${index}`),
  );
  manifest.economy.productionPrimitiveRefs.forEach((ref, index) =>
    requireRef(ref, ['production_recipe'], `/economy/productionPrimitiveRefs/${index}`),
  );
  manifest.economy.taxPrimitiveRefs.forEach((ref, index) =>
    requireRef(ref, ['tax'], `/economy/taxPrimitiveRefs/${index}`),
  );
  manifest.simulation.rulePrimitiveRefs.forEach((ref, index) =>
    requireRef(ref, ['simulation_rule'], `/simulation/rulePrimitiveRefs/${index}`),
  );
  manifest.simulation.eventPrimitiveRefs.forEach((ref, index) =>
    requireRef(ref, ['event_template'], `/simulation/eventPrimitiveRefs/${index}`),
  );
  requireRef(manifest.visual.stylePrimitiveRef, ['visual_style'], '/visual/stylePrimitiveRef');
  requireRef(manifest.visual.terrainPrimitiveRef, ['terrain'], '/visual/terrainPrimitiveRef');

  const selectedByKey = new Map<string, WorldManifestV1['primitiveRefs'][number][]>();
  for (const reference of manifest.primitiveRefs) {
    const selected = selectedByKey.get(reference.key) ?? [];
    selected.push(reference);
    selectedByKey.set(reference.key, selected);
  }
  manifest.primitiveRefs.forEach((reference, index) => {
    const definition = definitions.get(reference.ref);
    if (!definition) return;
    definition.dependencies.forEach((dependency, dependencyIndex) => {
      if (!dependency.required) return;
      const matches = (selectedByKey.get(dependency.key) ?? []).filter((candidate) =>
        satisfiesVersionRange(candidate.version, dependency.versionRange),
      );
      if (matches.length === 0) {
        diagnostics.push(
          diagnostic(
            'error',
            'MANIFEST_PRIMITIVE_DEPENDENCY_MISSING',
            `/primitiveRefs/${index}`,
            `${definition.key} requires ${dependency.key} ${dependency.versionRange}.`,
            locations,
            [],
            [`/primitiveRefs/${index}/parameters`, `/dependency/${dependencyIndex}`],
          ),
        );
      }
    });
  });

  for (const kind of CRITICAL_KINDS) {
    if (!usedKinds.has(kind)) {
      const pinned = manifest.primitiveRefs.some((reference) => reference.kind === kind);
      const pointer = pinned
        ? (CRITICAL_KIND_USAGE_POINTER[kind] ?? '/primitiveRefs')
        : '/primitiveRefs';
      diagnostics.push(
        diagnostic(
          'error',
          pinned ? 'MANIFEST_CRITICAL_MECHANIC_UNUSED' : 'MANIFEST_CRITICAL_MECHANIC_MISSING',
          pointer,
          pinned
            ? `The pinned ${kind} primitive must be used by a city-state manifest field.`
            : `A city-state manifest requires a ${kind} primitive.`,
          locations,
          pinned ? [] : [selectPrimitiveFix('/primitiveRefs', kind)],
        ),
      );
    }
  }

  if (manifest.actors.length === 0) {
    diagnostics.push(
      diagnostic(
        'error',
        'MANIFEST_ESSENTIAL_ACTOR_MISSING',
        '/actors',
        'A city-state manifest requires at least one initial actor blueprint.',
        locations,
      ),
    );
  }

  const districtKeys = new Set(manifest.districts.map((district) => district.key));
  const organizationKeys = new Set(manifest.organizations.map((organization) => organization.key));
  const institutionKeys = new Set(manifest.institutions.map((institution) => institution.key));
  const actorKeys = new Set(manifest.actors.map((actor) => actor.key));
  manifest.organizations.forEach((organization, index) => {
    if (!districtKeys.has(organization.homeDistrictKey)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_DISTRICT_REF_UNKNOWN',
          `/organizations/${index}/homeDistrictKey`,
          `District ${organization.homeDistrictKey} does not resolve.`,
          locations,
        ),
      );
    }
  });
  manifest.institutions.forEach((institution, index) => {
    if (institution.districtKey && !districtKeys.has(institution.districtKey)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_DISTRICT_REF_UNKNOWN',
          `/institutions/${index}/districtKey`,
          `District ${institution.districtKey} does not resolve.`,
          locations,
        ),
      );
    }
    institution.organizationKeys.forEach((key, keyIndex) => {
      if (!organizationKeys.has(key)) {
        diagnostics.push(
          diagnostic(
            'error',
            'MANIFEST_ORGANIZATION_REF_UNKNOWN',
            `/institutions/${index}/organizationKeys/${keyIndex}`,
            `Organization ${key} does not resolve.`,
            locations,
          ),
        );
      }
    });
  });
  manifest.actors.forEach((actor, index) => {
    if (!districtKeys.has(actor.homeDistrictKey)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_DISTRICT_REF_UNKNOWN',
          `/actors/${index}/homeDistrictKey`,
          `District ${actor.homeDistrictKey} does not resolve.`,
          locations,
        ),
      );
    }
    if (actor.organizationKey && !organizationKeys.has(actor.organizationKey)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_ORGANIZATION_REF_UNKNOWN',
          `/actors/${index}/organizationKey`,
          `Organization ${actor.organizationKey} does not resolve.`,
          locations,
        ),
      );
    }
  });

  const endpointSets = {
    actor: actorKeys,
    district: districtKeys,
    institution: institutionKeys,
    organization: organizationKeys,
  } as const;
  manifest.relationships.forEach((relationship, index) => {
    for (const side of ['source', 'target'] as const) {
      const endpoint = relationship[side];
      if (!endpointSets[endpoint.kind].has(endpoint.key)) {
        diagnostics.push(
          diagnostic(
            'error',
            'MANIFEST_RELATIONSHIP_ENDPOINT_UNKNOWN',
            `/relationships/${index}/${side}/key`,
            `${endpoint.kind} ${endpoint.key} does not resolve.`,
            locations,
          ),
        );
      }
    }
    if (
      relationship.source.kind === relationship.target.kind &&
      relationship.source.key === relationship.target.key
    ) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_RELATIONSHIP_SELF_REFERENCE',
          `/relationships/${index}`,
          'A relationship cannot target its own source.',
          locations,
        ),
      );
    }
    const tuple = `${relationship.type}:${relationship.source.kind}->${relationship.target.kind}`;
    if (!ALLOWED_RELATIONSHIP_TUPLES.has(tuple)) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_RELATIONSHIP_TUPLE_INVALID',
          `/relationships/${index}/type`,
          `Relationship type ${relationship.type} does not allow ${relationship.source.kind} -> ${relationship.target.kind}.`,
          locations,
          [],
          [`/relationships/${index}/source`, `/relationships/${index}/target`],
        ),
      );
    }
  });
  for (const economyIssue of worldgraphEconomyExtensionIssues(manifest)) {
    diagnostics.push(
      diagnostic(
        'error',
        economyIssue.code,
        economyIssue.pointer,
        economyIssue.message,
        locations,
        [],
        economyIssue.relatedPointers,
      ),
    );
  }
  for (const governanceIssue of worldgraphGovernanceExtensionIssues(manifest)) {
    diagnostics.push(
      diagnostic(
        'error',
        governanceIssue.code,
        governanceIssue.pointer,
        governanceIssue.message,
        locations,
        [],
        governanceIssue.relatedPointers,
      ),
    );
  }
  diagnostics.push(...validateConnectivity(manifest, locations));

  return report(catalog, diagnostics, manifestContentHash(manifest));
}

function valueAtPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let value = root;
  for (const token of pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return undefined;
      value = value[Number(token)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(value, token)) return undefined;
      value = (value as Record<string, unknown>)[token];
    }
  }
  return value;
}

export function validateManifestGenerationEnvelope(
  input: unknown,
  catalog: ManifestCatalogSnapshot,
): ManifestValidationResult {
  const schemaIssues = envelopeValidator.issues(input);
  if (schemaIssues.length > 0) {
    return report(
      catalog,
      schemaIssues.map((schemaIssue) =>
        diagnostic(
          'error',
          'MANIFEST_GENERATION_ENVELOPE_INVALID',
          schemaIssue.path === '/' ? '' : schemaIssue.path,
          `Generation envelope violation (${schemaIssue.keyword}): ${schemaIssue.message}`,
        ),
      ),
      null,
    );
  }
  const envelope = input as ManifestGenerationEnvelopeV1;
  const manifestResult = validateWorldManifest(envelope.manifest, catalog);
  const diagnostics = [...manifestResult.diagnostics];
  if (canonicalJson(envelope.assumptions) !== canonicalJson(envelope.manifest.assumptions)) {
    diagnostics.push(
      diagnostic(
        'error',
        'MANIFEST_ASSUMPTIONS_MISMATCH',
        '/assumptions',
        'Envelope assumptions must exactly match the authoritative manifest assumptions.',
      ),
    );
  }
  envelope.provenance.forEach((entry, index) => {
    if (valueAtPointer(envelope.manifest, entry.pointer) === undefined) {
      diagnostics.push(
        diagnostic(
          'error',
          'MANIFEST_PROVENANCE_POINTER_UNKNOWN',
          `/provenance/${index}/pointer`,
          `Provenance pointer ${entry.pointer} does not resolve in the candidate manifest.`,
        ),
      );
    }
  });
  envelope.warnings.forEach((warning) => {
    diagnostics.push(diagnostic('warning', warning.code, warning.pointer, warning.message));
  });
  return report(catalog, diagnostics, manifestResult.contentHash);
}
