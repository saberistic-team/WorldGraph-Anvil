import { Type, type Static } from '@sinclair/typebox';

import { WorldRoleSchema } from './authority.js';
import { EconomyHashSchema, EconomySeedPlanV1Schema, EconomySeedPlanV2Schema } from './economy.js';
import { GeographyHashSchema, GeographySeedPlanV1Schema } from './geography.js';
import { GovernanceHashSchema, GovernanceSeedPlanV1Schema } from './governance.js';
import {
  PrimitiveDraftInputSchema,
  PrimitiveKindSchema,
  StablePrimitiveKeySchema,
  StrictSemverSchema,
} from './catalog.js';
import {
  ManifestJsonObjectSchema,
  ManifestLocalKeySchema,
  WorldManifestV1Schema,
} from './manifests.js';
import { createValidator } from './validation.js';
import {
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION,
  GOVERNANCE_COMPILER_VERSION,
  LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION,
  LEGACY_COMPILER_VERSION,
  MANIFEST_SCHEMA_VERSION,
  PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION,
  PREVIOUS_COMPILER_VERSION,
  PRIMITIVE_SCHEMA_VERSION,
  RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION,
  RETAINED_COMPILER_VERSION,
  WORLD_COMPILATION_QUEUE_SCHEMA_VERSION,
  WORLD_GRAPH_SCHEMA_VERSION,
} from './versions.js';

export const WORLD_COMPILATION_QUEUE = 'world-compilation' as const;

export const CompilerHashSchema = Type.String({
  maxLength: 64,
  minLength: 64,
  pattern: '^[a-f0-9]{64}$',
});
export const CompilerUuidSchema = Type.String({ format: 'uuid' });
export const CompilerSeedSchema = Type.String({
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9._:-]+$',
});
export const WorldLogicalKeySchema = Type.String({
  maxLength: 240,
  minLength: 3,
  pattern: '^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$',
});
export const MemberPrincipalKeySchema = Type.String({
  maxLength: 39,
  minLength: 39,
  pattern: '^member-[a-f0-9]{32}$',
});

export const CompilerStageSchema = Type.Union([
  Type.Literal('resolve'),
  Type.Literal('validate'),
  Type.Literal('normalize'),
  Type.Literal('lower'),
  Type.Literal('link'),
  Type.Literal('emit'),
]);
export const SupportedCompilerVersionSchema = Type.Union([
  Type.Literal(LEGACY_COMPILER_VERSION),
  Type.Literal(RETAINED_COMPILER_VERSION),
  Type.Literal(PREVIOUS_COMPILER_VERSION),
  Type.Literal(GOVERNANCE_COMPILER_VERSION),
  Type.Literal(COMPILER_VERSION),
]);
export const SupportedCompiledArtifactSchemaVersionSchema = Type.Union([
  Type.Literal(LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION),
  Type.Literal(RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION),
  Type.Literal(PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION),
  Type.Literal(GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION),
  Type.Literal(COMPILED_ARTIFACT_SCHEMA_VERSION),
]);

export const CompilerDiagnosticV1Schema = Type.Object(
  {
    code: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    message: Type.String({ maxLength: 500, minLength: 1 }),
    pointer: Type.String({
      maxLength: 500,
      pattern: '^(?:/(?:[^~/]|~0|~1)*)*$',
    }),
    relatedKeys: Type.Array(Type.String({ maxLength: 240, minLength: 1 }), {
      maxItems: 16,
      uniqueItems: true,
    }),
    retryable: Type.Boolean(),
    severity: Type.Union([Type.Literal('error'), Type.Literal('warning'), Type.Literal('info')]),
    stage: CompilerStageSchema,
  },
  { $id: 'CompilerDiagnosticV1', additionalProperties: false },
);

export const CompilerConfigurationV1Schema = Type.Object(
  {
    adapterRegistryVersion: Type.Literal(1),
    deprecatedPrimitivePolicy: Type.Literal('reject'),
    maxEntities: Type.Integer({ maximum: 5_000, minimum: 1 }),
    maxRelationships: Type.Integer({ maximum: 10_000, minimum: 1 }),
  },
  { $id: 'CompilerConfigurationV1', additionalProperties: false },
);

export const ExactPrimitiveInputV1Schema = Type.Object(
  {
    canonicalBytes: Type.String({ maxLength: 131_072, minLength: 2 }),
    contentHash: CompilerHashSchema,
    definition: PrimitiveDraftInputSchema,
    lifecycle: Type.Union([Type.Literal('published'), Type.Literal('deprecated')]),
    primitiveVersionId: CompilerUuidSchema,
  },
  { $id: 'ExactPrimitiveInputV1', additionalProperties: false },
);

export const ActiveMemberPrincipalV1Schema = Type.Object(
  {
    principalKey: MemberPrincipalKeySchema,
    role: WorldRoleSchema,
  },
  { $id: 'ActiveMemberPrincipalV1', additionalProperties: false },
);

export const CompilerInputBundleV1Schema = Type.Object(
  {
    activeMembers: Type.Array(ActiveMemberPrincipalV1Schema, { maxItems: 100 }),
    compilerConfig: CompilerConfigurationV1Schema,
    compilerConfigVersion: Type.Literal(COMPILER_CONFIG_SCHEMA_VERSION),
    compilerVersion: Type.Literal(COMPILER_VERSION),
    inputHash: CompilerHashSchema,
    manifest: WorldManifestV1Schema,
    manifestCanonicalBytes: Type.String({ maxLength: 131_072, minLength: 2 }),
    manifestContentHash: CompilerHashSchema,
    manifestSchemaVersion: Type.Literal(MANIFEST_SCHEMA_VERSION),
    primitiveSchemaVersion: Type.Literal(PRIMITIVE_SCHEMA_VERSION),
    primitives: Type.Array(ExactPrimitiveInputV1Schema, { maxItems: 128, minItems: 1 }),
    seed: CompilerSeedSchema,
  },
  { $id: 'CompilerInputBundleV1', additionalProperties: false },
);
export const LegacyCompilerInputBundleV1Schema = Type.Object(
  {
    ...CompilerInputBundleV1Schema.properties,
    compilerVersion: Type.Literal(LEGACY_COMPILER_VERSION),
  },
  { $id: 'LegacyCompilerInputBundleV1', additionalProperties: false },
);
export const PreviousCompilerInputBundleV1Schema = Type.Object(
  {
    ...CompilerInputBundleV1Schema.properties,
    compilerVersion: Type.Literal(PREVIOUS_COMPILER_VERSION),
  },
  { $id: 'PreviousCompilerInputBundleV1', additionalProperties: false },
);
export const GovernanceCompilerInputBundleV1Schema = Type.Object(
  {
    ...CompilerInputBundleV1Schema.properties,
    compilerVersion: Type.Literal(GOVERNANCE_COMPILER_VERSION),
  },
  { $id: 'GovernanceCompilerInputBundleV1', additionalProperties: false },
);
export const RetainedCompilerInputBundleV1Schema = Type.Object(
  {
    ...CompilerInputBundleV1Schema.properties,
    compilerVersion: Type.Literal(RETAINED_COMPILER_VERSION),
  },
  { $id: 'RetainedCompilerInputBundleV1', additionalProperties: false },
);

export const WorldEntityTypeSchema = Type.Union([
  Type.Literal('district'),
  Type.Literal('institution'),
  Type.Literal('organization'),
  Type.Literal('actor_blueprint'),
  Type.Literal('account_principal'),
  Type.Literal('player_character'),
  Type.Literal('primitive_instance'),
  Type.Literal('currency_definition_intent'),
  Type.Literal('resource_definition_intent'),
  Type.Literal('production_definition_intent'),
  Type.Literal('tax_definition_intent'),
  Type.Literal('economy_configuration'),
  Type.Literal('simulation_configuration'),
  Type.Literal('visual_plan'),
]);

export const WorldRelationshipTypeSchema = Type.Union([
  Type.Literal('account_controls'),
  Type.Literal('connected_to'),
  Type.Literal('cooperates_with'),
  Type.Literal('governs'),
  Type.Literal('instantiates'),
  Type.Literal('located_in'),
  Type.Literal('member_of'),
  Type.Literal('participates_in'),
  Type.Literal('rivals'),
  Type.Literal('supplies'),
  Type.Literal('uses_primitive'),
]);

export const ControllerIntentV1Schema = Type.Object(
  {
    controlScope: Type.Literal('primary'),
    entityLogicalKey: WorldLogicalKeySchema,
    principalKey: MemberPrincipalKeySchema,
  },
  { $id: 'ControllerIntentV1', additionalProperties: false },
);

export const VisualPlanDistrictV1Schema = Type.Object(
  {
    districtLogicalKey: WorldLogicalKeySchema,
    rotationMilliDegrees: Type.Integer({ maximum: 359_999, minimum: 0 }),
    xMilliunits: Type.Integer({ maximum: 1_000_000, minimum: -1_000_000 }),
    yMilliunits: Type.Integer({ maximum: 1_000_000, minimum: -1_000_000 }),
  },
  { additionalProperties: false },
);

const VisualPlanV1Fields = {
  direction: Type.String({ maxLength: 500, minLength: 1 }),
  districts: Type.Array(VisualPlanDistrictV1Schema, { maxItems: 32 }),
  schemaVersion: Type.Literal(1),
  stylePrimitiveLogicalKey: WorldLogicalKeySchema,
  terrainPrimitiveLogicalKey: WorldLogicalKeySchema,
} as const;
export const VisualPlanV1Schema = Type.Object(VisualPlanV1Fields, {
  $id: 'VisualPlanV1',
  additionalProperties: false,
});

const SafeGraphNameSchema = Type.String({
  maxLength: 100,
  minLength: 1,
  pattern: '^[^\\u0000-\\u001F\\u007F]+$',
});
const NullableWorldLogicalKeySchema = Type.Union([WorldLogicalKeySchema, Type.Null()]);
const PlayableWorldRoleSchema = Type.Union([
  Type.Literal('creator'),
  Type.Literal('administrator'),
  Type.Literal('player'),
]);
const PrimitiveIntentStateV1Schema = Type.Object(
  {
    parameters: ManifestJsonObjectSchema,
    primitiveRef: ManifestLocalKeySchema,
  },
  { additionalProperties: false },
);
const EmptyRelationshipAttributesV1Schema = Type.Object({}, { additionalProperties: false });
const ManifestRelationshipAttributesV1Schema = Type.Object(
  { manifestRelationshipKey: ManifestLocalKeySchema },
  { additionalProperties: false },
);

const WorldEntityStatePairV1Variants = [
  Type.Object(
    {
      entityType: Type.Literal('district'),
      state: Type.Object(
        {
          name: SafeGraphNameSchema,
          parameters: ManifestJsonObjectSchema,
          primitiveRef: ManifestLocalKeySchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('institution'),
      state: Type.Object(
        {
          districtLogicalKey: NullableWorldLogicalKeySchema,
          name: SafeGraphNameSchema,
          organizationLogicalKeys: Type.Array(WorldLogicalKeySchema, {
            maxItems: 32,
            uniqueItems: true,
          }),
          parameters: ManifestJsonObjectSchema,
          primitiveRef: ManifestLocalKeySchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('organization'),
      state: Type.Object(
        {
          homeDistrictLogicalKey: WorldLogicalKeySchema,
          name: SafeGraphNameSchema,
          parameters: ManifestJsonObjectSchema,
          primitiveRef: ManifestLocalKeySchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('actor_blueprint'),
      state: Type.Object(
        {
          controller: Type.Union([Type.Literal('player'), Type.Literal('system')]),
          homeDistrictLogicalKey: WorldLogicalKeySchema,
          name: SafeGraphNameSchema,
          organizationLogicalKey: NullableWorldLogicalKeySchema,
          parameters: ManifestJsonObjectSchema,
          rolePrimitiveRef: ManifestLocalKeySchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('account_principal'),
      state: Type.Object(
        {
          membershipRole: PlayableWorldRoleSchema,
          principalKey: MemberPrincipalKeySchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('player_character'),
      state: Type.Object(
        {
          blueprintLogicalKey: WorldLogicalKeySchema,
          homeDistrictLogicalKey: WorldLogicalKeySchema,
          membershipRole: PlayableWorldRoleSchema,
          name: SafeGraphNameSchema,
          organizationLogicalKey: NullableWorldLogicalKeySchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('primitive_instance'),
      state: Type.Object(
        {
          behaviorRef: Type.Union([Type.String({ maxLength: 160, minLength: 1 }), Type.Null()]),
          contentHash: CompilerHashSchema,
          key: StablePrimitiveKeySchema,
          kind: PrimitiveKindSchema,
          parameters: ManifestJsonObjectSchema,
          ref: ManifestLocalKeySchema,
          version: StrictSemverSchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { entityType: Type.Literal('currency_definition_intent'), state: PrimitiveIntentStateV1Schema },
    { additionalProperties: false },
  ),
  Type.Object(
    { entityType: Type.Literal('resource_definition_intent'), state: PrimitiveIntentStateV1Schema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('production_definition_intent'),
      state: PrimitiveIntentStateV1Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { entityType: Type.Literal('tax_definition_intent'), state: PrimitiveIntentStateV1Schema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('economy_configuration'),
      state: Type.Object(
        {
          currencyLogicalKey: WorldLogicalKeySchema,
          productionLogicalKeys: Type.Array(WorldLogicalKeySchema, {
            maxItems: 16,
            uniqueItems: true,
          }),
          resourceLogicalKeys: Type.Array(WorldLogicalKeySchema, {
            maxItems: 32,
            uniqueItems: true,
          }),
          taxLogicalKeys: Type.Array(WorldLogicalKeySchema, {
            maxItems: 16,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('simulation_configuration'),
      state: Type.Object(
        {
          eventPrimitiveRefs: Type.Array(ManifestLocalKeySchema, {
            maxItems: 32,
            uniqueItems: true,
          }),
          rulePrimitiveRefs: Type.Array(ManifestLocalKeySchema, {
            maxItems: 32,
            uniqueItems: true,
          }),
          settings: ManifestJsonObjectSchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      entityType: Type.Literal('visual_plan'),
      state: Type.Object(VisualPlanV1Fields, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
] as const;

/** The authoritative schema-version/type pair for every compiler-emitted entity state. */
export type WorldEntityStatePairV1 = Static<(typeof WorldEntityStatePairV1Variants)[number]>;
export const WorldEntityStatePairV1Schema = Type.Unsafe<WorldEntityStatePairV1>({
  $id: 'WorldEntityStatePairV1',
  discriminator: { propertyName: 'entityType' },
  oneOf: [...WorldEntityStatePairV1Variants],
  type: 'object',
});

const WorldRelationshipAttributesPairV1Variants = [
  Type.Object(
    {
      attributes: EmptyRelationshipAttributesV1Schema,
      relationshipType: Type.Literal('account_controls'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: Type.Object(
        {
          bidirectional: Type.Literal(true),
          connectionKind: Type.Union([
            Type.Literal('walkway'),
            Type.Literal('transit'),
            Type.Literal('service'),
          ]),
        },
        { additionalProperties: false },
      ),
      relationshipType: Type.Literal('connected_to'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: ManifestRelationshipAttributesV1Schema,
      relationshipType: Type.Literal('cooperates_with'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: ManifestRelationshipAttributesV1Schema,
      relationshipType: Type.Literal('governs'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: EmptyRelationshipAttributesV1Schema,
      relationshipType: Type.Literal('instantiates'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: Type.Union([
        EmptyRelationshipAttributesV1Schema,
        ManifestRelationshipAttributesV1Schema,
      ]),
      relationshipType: Type.Literal('located_in'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: Type.Union([
        EmptyRelationshipAttributesV1Schema,
        ManifestRelationshipAttributesV1Schema,
      ]),
      relationshipType: Type.Literal('member_of'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: Type.Object(
        { basis: Type.Literal('institution-participation') },
        { additionalProperties: false },
      ),
      relationshipType: Type.Literal('participates_in'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: ManifestRelationshipAttributesV1Schema,
      relationshipType: Type.Literal('rivals'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: ManifestRelationshipAttributesV1Schema,
      relationshipType: Type.Literal('supplies'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      attributes: EmptyRelationshipAttributesV1Schema,
      relationshipType: Type.Literal('uses_primitive'),
    },
    { additionalProperties: false },
  ),
] as const;

/** The authoritative schema-version/type pair for every compiler-emitted relationship payload. */
export type WorldRelationshipAttributesPairV1 = Static<
  (typeof WorldRelationshipAttributesPairV1Variants)[number]
>;
export const WorldRelationshipAttributesPairV1Schema =
  Type.Unsafe<WorldRelationshipAttributesPairV1>({
    $id: 'WorldRelationshipAttributesPairV1',
    discriminator: { propertyName: 'relationshipType' },
    oneOf: [...WorldRelationshipAttributesPairV1Variants],
    type: 'object',
  });

function entityEnvelopeVariant(
  variant: (typeof WorldEntityStatePairV1Variants)[number],
): ReturnType<typeof Type.Object> {
  return Type.Object(
    {
      entitySchemaVersion: Type.Literal(1),
      entityType: variant.properties.entityType,
      logicalKey: WorldLogicalKeySchema,
      state: variant.properties.state,
    },
    { additionalProperties: false },
  );
}

function relationshipEnvelopeVariant(
  variant: (typeof WorldRelationshipAttributesPairV1Variants)[number],
): ReturnType<typeof Type.Object> {
  return Type.Object(
    {
      attributes: variant.properties.attributes,
      logicalKey: WorldLogicalKeySchema,
      relationshipSchemaVersion: Type.Literal(1),
      relationshipType: variant.properties.relationshipType,
      sourceLogicalKey: WorldLogicalKeySchema,
      targetLogicalKey: WorldLogicalKeySchema,
    },
    { additionalProperties: false },
  );
}

export type WorldEntityV1 = WorldEntityStatePairV1 & {
  entitySchemaVersion: 1;
  logicalKey: string;
};
export type WorldRelationshipV1 = WorldRelationshipAttributesPairV1 & {
  logicalKey: string;
  relationshipSchemaVersion: 1;
  sourceLogicalKey: string;
  targetLogicalKey: string;
};
export const WorldEntityV1Schema = Type.Unsafe<WorldEntityV1>({
  $id: 'WorldEntityV1',
  discriminator: { propertyName: 'entityType' },
  oneOf: [...WorldEntityStatePairV1Variants].map(entityEnvelopeVariant),
  type: 'object',
});
export const WorldRelationshipV1Schema = Type.Unsafe<WorldRelationshipV1>({
  $id: 'WorldRelationshipV1',
  discriminator: { propertyName: 'relationshipType' },
  oneOf: [...WorldRelationshipAttributesPairV1Variants].map(relationshipEnvelopeVariant),
  type: 'object',
});
export const WorldEntityStatePairV1Validator = createValidator<WorldEntityStatePairV1>(
  WorldEntityStatePairV1Schema,
);
export const WorldRelationshipAttributesPairV1Validator =
  createValidator<WorldRelationshipAttributesPairV1>(WorldRelationshipAttributesPairV1Schema);

export const CompiledWorldV1Schema = Type.Object(
  {
    artifactSchemaVersion: Type.Literal(LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION),
    compilerConfigVersion: Type.Literal(COMPILER_CONFIG_SCHEMA_VERSION),
    compilerVersion: Type.Literal(LEGACY_COMPILER_VERSION),
    controllers: Type.Array(ControllerIntentV1Schema, { maxItems: 100 }),
    counts: Type.Object(
      {
        controllers: Type.Integer({ maximum: 100, minimum: 0 }),
        entities: Type.Integer({ maximum: 5_000, minimum: 0 }),
        relationships: Type.Integer({ maximum: 10_000, minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    entities: Type.Array(WorldEntityV1Schema, { maxItems: 5_000 }),
    inputHash: CompilerHashSchema,
    manifestContentHash: CompilerHashSchema,
    manifestSchemaVersion: Type.Literal(MANIFEST_SCHEMA_VERSION),
    metadata: Type.Object(
      {
        archetype: Type.Literal('city-state'),
        description: Type.String({ maxLength: 1_000, minLength: 1 }),
        name: Type.String({ maxLength: 100, minLength: 2 }),
      },
      { additionalProperties: false },
    ),
    relationships: Type.Array(WorldRelationshipV1Schema, { maxItems: 10_000 }),
    seed: CompilerSeedSchema,
    visualPlan: VisualPlanV1Schema,
    worldGraphSchemaVersion: Type.Literal(WORLD_GRAPH_SCHEMA_VERSION),
  },
  { $id: 'CompiledWorldV1', additionalProperties: false },
);

export const CompiledArtifactV1Schema = Type.Object(
  {
    artifactKind: Type.Literal('compiled_world'),
    artifactSchemaVersion: Type.Literal(LEGACY_COMPILED_ARTIFACT_SCHEMA_VERSION),
    canonicalBytes: Type.String({ maxLength: 4_194_304, minLength: 2 }),
    contentHash: CompilerHashSchema,
    inputHash: CompilerHashSchema,
    world: CompiledWorldV1Schema,
  },
  { $id: 'CompiledArtifactV1', additionalProperties: false },
);

export const CompiledWorldV2Schema = Type.Object(
  {
    ...CompiledWorldV1Schema.properties,
    artifactSchemaVersion: Type.Literal(RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION),
    compilerVersion: Type.Literal(RETAINED_COMPILER_VERSION),
    economySeedPlan: EconomySeedPlanV1Schema,
    economySeedPlanHash: EconomyHashSchema,
  },
  { $id: 'CompiledWorldV2', additionalProperties: false },
);

export const CompiledArtifactV2Schema = Type.Object(
  {
    artifactKind: Type.Literal('compiled_world'),
    artifactSchemaVersion: Type.Literal(RETAINED_COMPILED_ARTIFACT_SCHEMA_VERSION),
    canonicalBytes: Type.String({ maxLength: 4_194_304, minLength: 2 }),
    contentHash: CompilerHashSchema,
    inputHash: CompilerHashSchema,
    world: CompiledWorldV2Schema,
  },
  { $id: 'CompiledArtifactV2', additionalProperties: false },
);

export const CompiledWorldV3Schema = Type.Object(
  {
    ...CompiledWorldV1Schema.properties,
    artifactSchemaVersion: Type.Literal(PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION),
    compilerVersion: Type.Literal(PREVIOUS_COMPILER_VERSION),
    economySeedPlan: EconomySeedPlanV2Schema,
    economySeedPlanHash: EconomyHashSchema,
  },
  { $id: 'CompiledWorldV3', additionalProperties: false },
);

export const CompiledArtifactV3Schema = Type.Object(
  {
    artifactKind: Type.Literal('compiled_world'),
    artifactSchemaVersion: Type.Literal(PREVIOUS_COMPILED_ARTIFACT_SCHEMA_VERSION),
    canonicalBytes: Type.String({ maxLength: 4_194_304, minLength: 2 }),
    contentHash: CompilerHashSchema,
    inputHash: CompilerHashSchema,
    world: CompiledWorldV3Schema,
  },
  { $id: 'CompiledArtifactV3', additionalProperties: false },
);

export const CompiledWorldV4Schema = Type.Object(
  {
    ...CompiledWorldV1Schema.properties,
    artifactSchemaVersion: Type.Literal(GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION),
    compilerVersion: Type.Literal(GOVERNANCE_COMPILER_VERSION),
    economySeedPlan: EconomySeedPlanV2Schema,
    economySeedPlanHash: EconomyHashSchema,
    governanceSeedPlan: GovernanceSeedPlanV1Schema,
    governanceSeedPlanHash: GovernanceHashSchema,
  },
  { $id: 'CompiledWorldV4', additionalProperties: false },
);

export const CompiledArtifactV4Schema = Type.Object(
  {
    artifactKind: Type.Literal('compiled_world'),
    artifactSchemaVersion: Type.Literal(GOVERNANCE_COMPILED_ARTIFACT_SCHEMA_VERSION),
    canonicalBytes: Type.String({ maxLength: 4_194_304, minLength: 2 }),
    contentHash: CompilerHashSchema,
    inputHash: CompilerHashSchema,
    world: CompiledWorldV4Schema,
  },
  { $id: 'CompiledArtifactV4', additionalProperties: false },
);

export const CompiledWorldV5Schema = Type.Object(
  {
    ...CompiledWorldV1Schema.properties,
    artifactSchemaVersion: Type.Literal(COMPILED_ARTIFACT_SCHEMA_VERSION),
    compilerVersion: Type.Literal(COMPILER_VERSION),
    economySeedPlan: EconomySeedPlanV2Schema,
    economySeedPlanHash: EconomyHashSchema,
    geographySeedPlan: GeographySeedPlanV1Schema,
    geographySeedPlanHash: GeographyHashSchema,
    governanceSeedPlan: GovernanceSeedPlanV1Schema,
    governanceSeedPlanHash: GovernanceHashSchema,
  },
  { $id: 'CompiledWorldV5', additionalProperties: false },
);

export const CompiledArtifactV5Schema = Type.Object(
  {
    artifactKind: Type.Literal('compiled_world'),
    artifactSchemaVersion: Type.Literal(COMPILED_ARTIFACT_SCHEMA_VERSION),
    canonicalBytes: Type.String({ maxLength: 4_194_304, minLength: 2 }),
    contentHash: CompilerHashSchema,
    inputHash: CompilerHashSchema,
    world: CompiledWorldV5Schema,
  },
  { $id: 'CompiledArtifactV5', additionalProperties: false },
);

export const CompiledWorldSchema = Type.Union(
  [
    CompiledWorldV1Schema,
    CompiledWorldV2Schema,
    CompiledWorldV3Schema,
    CompiledWorldV4Schema,
    CompiledWorldV5Schema,
  ],
  { $id: 'CompiledWorld' },
);
export const CompiledArtifactSchema = Type.Union(
  [
    CompiledArtifactV1Schema,
    CompiledArtifactV2Schema,
    CompiledArtifactV3Schema,
    CompiledArtifactV4Schema,
    CompiledArtifactV5Schema,
  ],
  { $id: 'CompiledArtifact' },
);

export const WorldCompilationStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);
export const WorldCompilationStageSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('validating'),
  Type.Literal('compiling'),
  Type.Literal('seeding'),
  Type.Literal('activated'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);

export const StartWorldCompilationRequestSchema = Type.Object(
  {
    expectedManifestHash: CompilerHashSchema,
    manifestRevisionId: CompilerUuidSchema,
    seed: CompilerSeedSchema,
  },
  { additionalProperties: false },
);
export const StartWorldCompilationResponseSchema = Type.Object(
  {
    rowVersion: Type.Integer({ minimum: 1 }),
    runId: CompilerUuidSchema,
    stage: WorldCompilationStageSchema,
    status: WorldCompilationStatusSchema,
  },
  { additionalProperties: false },
);
export const RetryWorldCompilationRequestSchema = Type.Object(
  { expectedRowVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export const CancelWorldCompilationRequestSchema = Type.Object(
  { expectedRowVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const WorldCompilationRunViewSchema = Type.Object(
  {
    artifactHash: Type.Union([CompilerHashSchema, Type.Null()]),
    completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    compilerConfigVersion: Type.Literal(COMPILER_CONFIG_SCHEMA_VERSION),
    compilerVersion: SupportedCompilerVersionSchema,
    diagnostics: Type.Array(CompilerDiagnosticV1Schema, { maxItems: 128 }),
    id: CompilerUuidSchema,
    inputHash: CompilerHashSchema,
    manifestRevisionId: CompilerUuidSchema,
    progressPercent: Type.Integer({ maximum: 100, minimum: 0 }),
    queuedAt: Type.String({ format: 'date-time' }),
    requestedByUserId: CompilerUuidSchema,
    rowVersion: Type.Integer({ minimum: 1 }),
    seed: CompilerSeedSchema,
    stage: WorldCompilationStageSchema,
    startedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    status: WorldCompilationStatusSchema,
    worldId: CompilerUuidSchema,
  },
  { $id: 'WorldCompilationRunViewV1', additionalProperties: false },
);

export const RuntimeRevisionMetadataSchema = Type.Object(
  {
    activeWorldVersionId: CompilerUuidSchema,
    stateRevision: Type.Integer({ minimum: 0 }),
    worldVersionNumber: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export const RuntimeSummaryViewSchema = Type.Object(
  {
    ...RuntimeRevisionMetadataSchema.properties,
    activatedAt: Type.String({ format: 'date-time' }),
    artifactHash: CompilerHashSchema,
    compilerConfigVersion: Type.Literal(COMPILER_CONFIG_SCHEMA_VERSION),
    compilerVersion: SupportedCompilerVersionSchema,
    controllerCount: Type.Integer({ minimum: 0 }),
    entityCount: Type.Integer({ minimum: 0 }),
    lastLedgerSequence: Type.Integer({ minimum: 0 }),
    lifecycle: Type.Literal('active'),
    manifestContentHash: CompilerHashSchema,
    manifestRevisionId: CompilerUuidSchema,
    manifestSchemaVersion: Type.Literal(MANIFEST_SCHEMA_VERSION),
    relationshipCount: Type.Integer({ minimum: 0 }),
    seed: CompilerSeedSchema,
    worldGraphSchemaVersion: Type.Literal(WORLD_GRAPH_SCHEMA_VERSION),
    worldId: CompilerUuidSchema,
  },
  { $id: 'RuntimeSummaryViewV1', additionalProperties: false },
);

const WorldEntityViewBaseSchema = Type.Object(
  {
    createdWorldVersionId: CompilerUuidSchema,
    entitySchemaVersion: Type.Literal(1),
    entityType: WorldEntityTypeSchema,
    logicalKey: WorldLogicalKeySchema,
    retiredWorldVersionId: Type.Union([CompilerUuidSchema, Type.Null()]),
    rowVersion: Type.Integer({ minimum: 0 }),
    state: ManifestJsonObjectSchema,
    worldId: CompilerUuidSchema,
  },
  { additionalProperties: false },
);
export const WorldEntityViewSchema = Type.Unsafe<Static<typeof WorldEntityViewBaseSchema>>({
  discriminator: { propertyName: 'entityType' },
  oneOf: [...WorldEntityStatePairV1Variants].map((variant) =>
    Type.Object(
      {
        ...WorldEntityViewBaseSchema.properties,
        entityType: variant.properties.entityType,
        state: variant.properties.state,
      },
      { additionalProperties: false },
    ),
  ),
  type: 'object',
});
export const WorldEntityDetailResponseSchema = Type.Object(
  {
    entity: WorldEntityViewSchema,
    runtime: RuntimeRevisionMetadataSchema,
  },
  { additionalProperties: false },
);
const WorldRelationshipViewBaseSchema = Type.Object(
  {
    attributes: ManifestJsonObjectSchema,
    createdWorldVersionId: CompilerUuidSchema,
    logicalKey: WorldLogicalKeySchema,
    relationshipSchemaVersion: Type.Literal(1),
    relationshipType: WorldRelationshipTypeSchema,
    retiredWorldVersionId: Type.Union([CompilerUuidSchema, Type.Null()]),
    rowVersion: Type.Integer({ minimum: 0 }),
    sourceLogicalKey: WorldLogicalKeySchema,
    targetLogicalKey: WorldLogicalKeySchema,
    worldId: CompilerUuidSchema,
  },
  { additionalProperties: false },
);
export const WorldRelationshipViewSchema = Type.Unsafe<
  Static<typeof WorldRelationshipViewBaseSchema>
>({
  discriminator: { propertyName: 'relationshipType' },
  oneOf: [...WorldRelationshipAttributesPairV1Variants].map((variant) =>
    Type.Object(
      {
        ...WorldRelationshipViewBaseSchema.properties,
        attributes: variant.properties.attributes,
        relationshipType: variant.properties.relationshipType,
      },
      { additionalProperties: false },
    ),
  ),
  type: 'object',
});

const RuntimeCursorSchema = Type.String({ maxLength: 1_024, minLength: 16 });
const RuntimeLimitSchema = Type.String({
  maxLength: 3,
  pattern: '^(?:[1-9]|[1-9][0-9]|100)$',
});
export const WorldEntityListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(RuntimeCursorSchema),
    entityType: Type.Optional(WorldEntityTypeSchema),
    limit: Type.Optional(RuntimeLimitSchema),
    query: Type.Optional(Type.String({ maxLength: 100, minLength: 1 })),
  },
  { additionalProperties: false },
);
export const WorldRelationshipListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(RuntimeCursorSchema),
    limit: Type.Optional(RuntimeLimitSchema),
    relationshipType: Type.Optional(WorldRelationshipTypeSchema),
    sourceLogicalKey: Type.Optional(WorldLogicalKeySchema),
    targetLogicalKey: Type.Optional(WorldLogicalKeySchema),
  },
  { additionalProperties: false },
);
export const WorldNeighborQuerySchema = Type.Object(
  {
    cursor: Type.Optional(RuntimeCursorSchema),
    direction: Type.Optional(
      Type.Union([Type.Literal('inbound'), Type.Literal('outbound'), Type.Literal('both')]),
    ),
    limit: Type.Optional(RuntimeLimitSchema),
    relationshipType: Type.Optional(WorldRelationshipTypeSchema),
  },
  { additionalProperties: false },
);

export const WorldEntityListResponseSchema = Type.Object(
  {
    items: Type.Array(WorldEntityViewSchema, { maxItems: 100 }),
    nextCursor: Type.Union([RuntimeCursorSchema, Type.Null()]),
    runtime: RuntimeRevisionMetadataSchema,
  },
  { additionalProperties: false },
);
export const WorldRelationshipListResponseSchema = Type.Object(
  {
    items: Type.Array(WorldRelationshipViewSchema, { maxItems: 100 }),
    nextCursor: Type.Union([RuntimeCursorSchema, Type.Null()]),
    runtime: RuntimeRevisionMetadataSchema,
  },
  { additionalProperties: false },
);
export const WorldNeighborItemSchema = Type.Object(
  {
    direction: Type.Union([Type.Literal('inbound'), Type.Literal('outbound')]),
    neighbor: WorldEntityViewSchema,
    relationship: WorldRelationshipViewSchema,
  },
  { additionalProperties: false },
);
export const WorldNeighborResponseSchema = Type.Object(
  {
    entity: WorldEntityViewSchema,
    items: Type.Array(WorldNeighborItemSchema, { maxItems: 100 }),
    nextCursor: Type.Union([RuntimeCursorSchema, Type.Null()]),
    runtime: RuntimeRevisionMetadataSchema,
  },
  { additionalProperties: false },
);

export const WorldCompilationRequestedQueueSchema = Type.Object(
  {
    compilerConfigVersion: Type.Literal(COMPILER_CONFIG_SCHEMA_VERSION),
    compilerVersion: Type.Union([
      Type.Literal(RETAINED_COMPILER_VERSION),
      Type.Literal(PREVIOUS_COMPILER_VERSION),
      Type.Literal(GOVERNANCE_COMPILER_VERSION),
      Type.Literal(COMPILER_VERSION),
    ]),
    inputHash: CompilerHashSchema,
    manifestRevisionId: CompilerUuidSchema,
    runId: CompilerUuidSchema,
    schemaVersion: Type.Literal(WORLD_COMPILATION_QUEUE_SCHEMA_VERSION),
    type: Type.Literal('WorldCompilationRequested'),
  },
  { $id: 'WorldCompilationRequestedQueueV1', additionalProperties: false },
);

export type CompilerStage = Static<typeof CompilerStageSchema>;
export type CompilerDiagnosticV1 = Static<typeof CompilerDiagnosticV1Schema>;
export type CompilerConfigurationV1 = Static<typeof CompilerConfigurationV1Schema>;
export type ExactPrimitiveInputV1 = Static<typeof ExactPrimitiveInputV1Schema>;
export type ActiveMemberPrincipalV1 = Static<typeof ActiveMemberPrincipalV1Schema>;
export type CompilerInputBundleV1 = Static<typeof CompilerInputBundleV1Schema>;
export type LegacyCompilerInputBundleV1 = Static<typeof LegacyCompilerInputBundleV1Schema>;
export type PreviousCompilerInputBundleV1 = Static<typeof PreviousCompilerInputBundleV1Schema>;
export type GovernanceCompilerInputBundleV1 = Static<typeof GovernanceCompilerInputBundleV1Schema>;
export type RetainedCompilerInputBundleV1 = Static<typeof RetainedCompilerInputBundleV1Schema>;
export type WorldEntityType = Static<typeof WorldEntityTypeSchema>;
export type WorldRelationshipType = Static<typeof WorldRelationshipTypeSchema>;
export type ControllerIntentV1 = Static<typeof ControllerIntentV1Schema>;
export type VisualPlanV1 = Static<typeof VisualPlanV1Schema>;
export type CompiledWorldV1 = Static<typeof CompiledWorldV1Schema>;
export type CompiledArtifactV1 = Static<typeof CompiledArtifactV1Schema>;
export type CompiledWorldV2 = Static<typeof CompiledWorldV2Schema>;
export type CompiledArtifactV2 = Static<typeof CompiledArtifactV2Schema>;
export type CompiledWorldV3 = Static<typeof CompiledWorldV3Schema>;
export type CompiledArtifactV3 = Static<typeof CompiledArtifactV3Schema>;
export type CompiledWorldV4 = Static<typeof CompiledWorldV4Schema>;
export type CompiledArtifactV4 = Static<typeof CompiledArtifactV4Schema>;
export type CompiledWorldV5 = Static<typeof CompiledWorldV5Schema>;
export type CompiledArtifactV5 = Static<typeof CompiledArtifactV5Schema>;
export type CompiledWorld = Static<typeof CompiledWorldSchema>;
export type CompiledArtifact = Static<typeof CompiledArtifactSchema>;
export type WorldCompilationStatus = Static<typeof WorldCompilationStatusSchema>;
export type WorldCompilationStage = Static<typeof WorldCompilationStageSchema>;
export type StartWorldCompilationRequest = Static<typeof StartWorldCompilationRequestSchema>;
export type StartWorldCompilationResponse = Static<typeof StartWorldCompilationResponseSchema>;
export type RetryWorldCompilationRequest = Static<typeof RetryWorldCompilationRequestSchema>;
export type CancelWorldCompilationRequest = Static<typeof CancelWorldCompilationRequestSchema>;
export type WorldCompilationRunView = Static<typeof WorldCompilationRunViewSchema>;
export type RuntimeRevisionMetadata = Static<typeof RuntimeRevisionMetadataSchema>;
export type RuntimeSummaryView = Static<typeof RuntimeSummaryViewSchema>;
export type WorldEntityView = Static<typeof WorldEntityViewSchema>;
export type WorldEntityDetailResponse = Static<typeof WorldEntityDetailResponseSchema>;
export type WorldRelationshipView = Static<typeof WorldRelationshipViewSchema>;
export type WorldEntityListQuery = Static<typeof WorldEntityListQuerySchema>;
export type WorldRelationshipListQuery = Static<typeof WorldRelationshipListQuerySchema>;
export type WorldNeighborQuery = Static<typeof WorldNeighborQuerySchema>;
export type WorldEntityListResponse = Static<typeof WorldEntityListResponseSchema>;
export type WorldRelationshipListResponse = Static<typeof WorldRelationshipListResponseSchema>;
export type WorldNeighborResponse = Static<typeof WorldNeighborResponseSchema>;
export type WorldCompilationRequestedQueue = Static<typeof WorldCompilationRequestedQueueSchema>;
