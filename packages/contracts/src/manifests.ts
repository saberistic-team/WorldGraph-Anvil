import { Type, type Static } from '@sinclair/typebox';

import { PrimitiveKindSchema, StablePrimitiveKeySchema, StrictSemverSchema } from './catalog.js';
import type { JsonValue } from './canonical-json.js';
import {
  MANIFEST_GENERATOR_SCHEMA_VERSION,
  MANIFEST_PROMPT_TEMPLATE_VERSION,
  MANIFEST_QUEUE_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_VALIDATOR_VERSION,
} from './versions.js';

export const MANIFEST_GENERATION_QUEUE = 'manifest-generation' as const;
export const MAX_MANIFEST_GENERATION_WARNINGS = 32 as const;

export const ManifestHashSchema = Type.String({
  maxLength: 64,
  minLength: 64,
  pattern: '^[a-f0-9]{64}$',
});
export const ManifestUuidSchema = Type.String({ format: 'uuid' });
export const ManifestLocalKeySchema = Type.String({
  maxLength: 64,
  minLength: 1,
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
});
export const ManifestJsonPointerSchema = Type.String({
  maxLength: 500,
  pattern: '^(?:/(?:[^~/]|~0|~1)*)*$',
});
export const ManifestBoundedTextSchema = Type.String({
  maxLength: 500,
  minLength: 1,
  pattern: '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]+$',
});

// `propertyNames` always evaluates string instances. Omitting its redundant
// `type` keeps fast-json-stringify from widening it to string-or-object.
function jsonValueSchema(depth: number): Record<string, unknown> {
  const primitives = [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { maxLength: 32_000, type: 'string' },
  ];
  if (depth === 0) return { anyOf: primitives };
  const child = jsonValueSchema(depth - 1);
  return {
    anyOf: [
      ...primitives,
      { items: child, maxItems: 200, type: 'array' },
      {
        additionalProperties: child,
        maxProperties: 200,
        propertyNames: {
          maxLength: 160,
          minLength: 1,
          not: { enum: ['__proto__', 'constructor', 'prototype'] },
          pattern: '^[^\\u0000-\\u001F\\u007F]+$',
        },
        type: 'object',
      },
    ],
  };
}

export const ManifestJsonValueSchema = Type.Unsafe<JsonValue>(jsonValueSchema(6));

export const ManifestJsonObjectSchema = Type.Unsafe<Record<string, JsonValue>>({
  additionalProperties: ManifestJsonValueSchema,
  maxProperties: 200,
  propertyNames: {
    maxLength: 160,
    minLength: 1,
    not: { enum: ['__proto__', 'constructor', 'prototype'] },
    pattern: '^[^\\u0000-\\u001F\\u007F]+$',
  },
  type: 'object',
});

export const ManifestPrimitiveReferenceV1Schema = Type.Object(
  {
    contentHash: ManifestHashSchema,
    key: StablePrimitiveKeySchema,
    kind: PrimitiveKindSchema,
    parameters: ManifestJsonObjectSchema,
    primitiveVersionId: ManifestUuidSchema,
    ref: ManifestLocalKeySchema,
    version: StrictSemverSchema,
  },
  { additionalProperties: false },
);

const NamedBlueprintFields = {
  key: ManifestLocalKeySchema,
  name: Type.String({
    maxLength: 100,
    minLength: 1,
    pattern: '^[^\\u0000-\\u001F\\u007F]+$',
  }),
  parameters: ManifestJsonObjectSchema,
  primitiveRef: ManifestLocalKeySchema,
} as const;

export const ManifestDistrictV1Schema = Type.Object(NamedBlueprintFields, {
  additionalProperties: false,
});

export const ManifestConnectionV1Schema = Type.Object(
  {
    fromDistrictKey: ManifestLocalKeySchema,
    key: ManifestLocalKeySchema,
    kind: Type.Union([Type.Literal('walkway'), Type.Literal('transit'), Type.Literal('service')]),
    toDistrictKey: ManifestLocalKeySchema,
  },
  { additionalProperties: false },
);

export const ManifestInstitutionV1Schema = Type.Object(
  {
    ...NamedBlueprintFields,
    districtKey: Type.Union([ManifestLocalKeySchema, Type.Null()]),
    organizationKeys: Type.Array(ManifestLocalKeySchema, { maxItems: 32, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const ManifestOrganizationV1Schema = Type.Object(
  {
    ...NamedBlueprintFields,
    homeDistrictKey: ManifestLocalKeySchema,
  },
  { additionalProperties: false },
);

export const ManifestActorV1Schema = Type.Object(
  {
    controller: Type.Union([Type.Literal('player'), Type.Literal('system')]),
    homeDistrictKey: ManifestLocalKeySchema,
    key: ManifestLocalKeySchema,
    name: Type.String({
      maxLength: 100,
      minLength: 1,
      pattern: '^[^\\u0000-\\u001F\\u007F]+$',
    }),
    organizationKey: Type.Union([ManifestLocalKeySchema, Type.Null()]),
    parameters: ManifestJsonObjectSchema,
    rolePrimitiveRef: ManifestLocalKeySchema,
  },
  { additionalProperties: false },
);

export const ManifestRelationshipEndpointV1Schema = Type.Object(
  {
    key: ManifestLocalKeySchema,
    kind: Type.Union([
      Type.Literal('actor'),
      Type.Literal('district'),
      Type.Literal('institution'),
      Type.Literal('organization'),
    ]),
  },
  { additionalProperties: false },
);

export const ManifestRelationshipV1Schema = Type.Object(
  {
    key: ManifestLocalKeySchema,
    source: ManifestRelationshipEndpointV1Schema,
    target: ManifestRelationshipEndpointV1Schema,
    type: Type.Union([
      Type.Literal('governs'),
      Type.Literal('member-of'),
      Type.Literal('located-in'),
      Type.Literal('supplies'),
      Type.Literal('rivals'),
      Type.Literal('cooperates-with'),
    ]),
  },
  { additionalProperties: false },
);

export const ManifestExtensionsV1Schema = Type.Unsafe<Record<string, JsonValue>>({
  additionalProperties: false,
  maxProperties: 16,
  patternProperties: {
    '^[a-z][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)+$': ManifestJsonValueSchema,
  },
  type: 'object',
});

export const ManifestEconomyStableKeySchema = Type.String({
  maxLength: 240,
  minLength: 3,
  pattern: '^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$',
});
const ManifestEconomyAmountSchema = Type.String({
  maxLength: 26,
  minLength: 1,
  pattern: '^(?:0|[1-9][0-9]{0,18})(?:\\.[0-9]{1,6})?$',
});
const ManifestEconomyTickSchema = Type.String({
  maxLength: 19,
  pattern: '^(?:0|[1-9][0-9]{0,18})$',
});
const ManifestEconomyPositiveTickSchema = Type.String({
  maxLength: 19,
  pattern: '^[1-9][0-9]{0,18}$',
});
const ManifestEconomyPositiveMinorSchema = Type.String({
  maxLength: 19,
  pattern: '^[1-9][0-9]{0,18}$',
});
const ManifestEconomyDisplayNameSchema = Type.String({
  maxLength: 100,
  minLength: 1,
  pattern: '^[^\\u0000-\\u001F\\u007F]+$',
});

const ManifestEconomyTaxPolicyCommonFields = {
  authorityInstitutionKey: ManifestLocalKeySchema,
  effectiveFromTick: ManifestEconomyTickSchema,
  effectiveUntilTick: Type.Union([ManifestEconomyTickSchema, Type.Null()]),
  primitiveRef: ManifestLocalKeySchema,
  roundingMode: Type.Literal('floor'),
  stableKey: ManifestEconomyStableKeySchema,
  treasuryWalletStableKey: ManifestEconomyStableKeySchema,
} as const;

const ManifestEconomyTaxPolicyV2Schema = Type.Union([
  Type.Object(
    {
      ...ManifestEconomyTaxPolicyCommonFields,
      collectionMode: Type.Union([
        Type.Literal('added_to_payer'),
        Type.Literal('withheld_from_recipient'),
      ]),
      taxType: Type.Literal('transaction'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ManifestEconomyTaxPolicyCommonFields,
      collectionMode: Type.Union([
        Type.Literal('added_to_payer'),
        Type.Literal('withheld_from_recipient'),
      ]),
      taxType: Type.Literal('sales'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ManifestEconomyTaxPolicyCommonFields,
      collectionMode: Type.Literal('withheld_from_recipient'),
      taxType: Type.Literal('payroll'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ManifestEconomyTaxPolicyCommonFields,
      collectionMode: Type.Literal('withheld_from_recipient'),
      taxType: Type.Literal('marketplace_fee'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ManifestEconomyTaxPolicyCommonFields,
      collectionMode: Type.Literal('added_to_payer'),
      fixedAmountMinor: ManifestEconomyPositiveMinorSchema,
      intervalTicks: ManifestEconomyPositiveTickSchema,
      payerOrganizationKey: ManifestLocalKeySchema,
      payerWalletStableKey: ManifestEconomyStableKeySchema,
      taxType: Type.Literal('periodic_flat'),
    },
    { additionalProperties: false },
  ),
]);

/** Typed, data-only M09 initial-condition intent carried by Manifest V1 extensions. */
export const WorldgraphEconomyExtensionV2Schema = Type.Object(
  {
    businesses: Type.Array(
      Type.Object(
        {
          displayName: ManifestEconomyDisplayNameSchema,
          organizationKey: ManifestLocalKeySchema,
          stableKey: ManifestEconomyStableKeySchema,
          walletStableKey: ManifestEconomyStableKeySchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 64, minItems: 1 },
    ),
    employmentOffers: Type.Array(
      Type.Object(
        {
          businessStableKey: ManifestEconomyStableKeySchema,
          cadenceTicks: ManifestEconomyPositiveTickSchema,
          currencyStableKey: ManifestEconomyStableKeySchema,
          maxPaymentsPerPeriod: Type.Integer({ maximum: 1_000, minimum: 1 }),
          roleKey: Type.String({ maxLength: 80, minLength: 1, pattern: '^[a-z][a-z0-9-]*$' }),
          stableKey: ManifestEconomyStableKeySchema,
          wageMinor: Type.String({ maxLength: 19, pattern: '^[1-9][0-9]{0,18}$' }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 128, minItems: 1 },
    ),
    facilities: Type.Array(
      Type.Object(
        {
          assetStableKey: ManifestEconomyStableKeySchema,
          assetType: Type.Literal('workshop'),
          buildingPrimitiveRef: ManifestLocalKeySchema,
          businessStableKey: ManifestEconomyStableKeySchema,
          displayName: ManifestEconomyDisplayNameSchema,
          initialOwnerOrganizationKey: ManifestLocalKeySchema,
          recipeVersionStableKeys: Type.Array(ManifestEconomyStableKeySchema, {
            maxItems: 16,
            minItems: 1,
            uniqueItems: true,
          }),
          stableKey: ManifestEconomyStableKeySchema,
          transferable: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 128, minItems: 1 },
    ),
    inventories: Type.Array(
      Type.Object(
        {
          containerAssetStableKey: Type.Union([ManifestEconomyStableKeySchema, Type.Null()]),
          ownerOrganizationKey: ManifestLocalKeySchema,
          quantity: ManifestEconomyAmountSchema,
          resourceStableKey: ManifestEconomyStableKeySchema,
          stableKey: ManifestEconomyStableKeySchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 512, minItems: 1 },
    ),
    recipes: Type.Array(
      Type.Object(
        {
          primitiveRef: ManifestLocalKeySchema,
          stableKey: ManifestEconomyStableKeySchema,
          version: Type.Integer({ maximum: 1_000_000, minimum: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64, minItems: 1 },
    ),
    resources: Type.Array(
      Type.Object(
        {
          displayName: ManifestEconomyDisplayNameSchema,
          initialQuantity: ManifestEconomyAmountSchema,
          primitiveRef: ManifestLocalKeySchema,
          quantityScale: Type.Integer({ maximum: 6, minimum: 0 }),
          stableKey: ManifestEconomyStableKeySchema,
          tags: Type.Array(Type.String({ maxLength: 40, minLength: 1, pattern: '^[a-z0-9-]+$' }), {
            maxItems: 16,
            uniqueItems: true,
          }),
          unit: Type.String({ maxLength: 40, minLength: 1, pattern: '^[a-z][a-z0-9-]*$' }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64, minItems: 1 },
    ),
    schemaVersion: Type.Literal(2),
    taxPolicies: Type.Array(ManifestEconomyTaxPolicyV2Schema, { maxItems: 64, minItems: 1 }),
    treasury: Type.Object(
      {
        currencyStableKey: ManifestEconomyStableKeySchema,
        institutionKey: ManifestLocalKeySchema,
        walletStableKey: ManifestEconomyStableKeySchema,
      },
      { additionalProperties: false },
    ),
    unconfiguredFacilityAssets: Type.Array(
      Type.Object(
        {
          assetType: Type.Literal('workshop'),
          buildingPrimitiveRef: ManifestLocalKeySchema,
          displayName: ManifestEconomyDisplayNameSchema,
          initialOwnerOrganizationKey: ManifestLocalKeySchema,
          stableKey: ManifestEconomyStableKeySchema,
          transferable: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64, minItems: 1 },
    ),
  },
  { $id: 'WorldgraphEconomyExtensionV2', additionalProperties: false },
);

export const WorldManifestV1Schema = Type.Object(
  {
    actors: Type.Array(ManifestActorV1Schema, { maxItems: 64 }),
    assumptions: Type.Array(ManifestBoundedTextSchema, { maxItems: 32, uniqueItems: true }),
    connections: Type.Array(ManifestConnectionV1Schema, { maxItems: 128 }),
    districts: Type.Array(ManifestDistrictV1Schema, { maxItems: 32, minItems: 2 }),
    economy: Type.Object(
      {
        currencyPrimitiveRef: ManifestLocalKeySchema,
        productionPrimitiveRefs: Type.Array(ManifestLocalKeySchema, {
          maxItems: 16,
          uniqueItems: true,
        }),
        resourcePrimitiveRefs: Type.Array(ManifestLocalKeySchema, {
          maxItems: 32,
          minItems: 1,
          uniqueItems: true,
        }),
        taxPrimitiveRefs: Type.Array(ManifestLocalKeySchema, {
          maxItems: 16,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
    extensions: ManifestExtensionsV1Schema,
    institutions: Type.Array(ManifestInstitutionV1Schema, { maxItems: 64, minItems: 1 }),
    manifestSchemaVersion: Type.Literal(MANIFEST_SCHEMA_VERSION),
    metadata: Type.Object(
      {
        archetype: Type.Literal('city-state'),
        description: Type.String({
          maxLength: 1_000,
          minLength: 1,
          pattern: '^[^\\u0000-\\u001F\\u007F]+$',
        }),
        name: Type.String({
          maxLength: 100,
          minLength: 2,
          pattern: '^[^\\u0000-\\u001F\\u007F]+$',
        }),
      },
      { additionalProperties: false },
    ),
    organizations: Type.Array(ManifestOrganizationV1Schema, { maxItems: 64, minItems: 1 }),
    primitiveRefs: Type.Array(ManifestPrimitiveReferenceV1Schema, { maxItems: 128, minItems: 1 }),
    relationships: Type.Array(ManifestRelationshipV1Schema, { maxItems: 256, minItems: 1 }),
    seed: Type.String({
      maxLength: 128,
      minLength: 1,
      pattern: '^[A-Za-z0-9._:-]+$',
    }),
    simulation: Type.Object(
      {
        eventPrimitiveRefs: Type.Array(ManifestLocalKeySchema, {
          maxItems: 32,
          uniqueItems: true,
        }),
        rulePrimitiveRefs: Type.Array(ManifestLocalKeySchema, {
          maxItems: 32,
          minItems: 1,
          uniqueItems: true,
        }),
        settings: ManifestJsonObjectSchema,
      },
      { additionalProperties: false },
    ),
    visual: Type.Object(
      {
        direction: Type.String({
          maxLength: 500,
          minLength: 1,
          pattern: '^[^\\u0000-\\u001F\\u007F]+$',
        }),
        stylePrimitiveRef: ManifestLocalKeySchema,
        terrainPrimitiveRef: ManifestLocalKeySchema,
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'WorldManifestV1', additionalProperties: false },
);

export const ManifestSourceLocationSchema = Type.Object(
  {
    column: Type.Integer({ minimum: 1 }),
    endColumn: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    endLine: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    line: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const ManifestFixBase = {
  pointer: ManifestJsonPointerSchema,
  rationale: Type.String({ maxLength: 300, minLength: 1 }),
} as const;

export const ManifestSuggestedFixSchema = Type.Union([
  Type.Object(
    { ...ManifestFixBase, kind: Type.Literal('add'), value: ManifestJsonValueSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...ManifestFixBase, kind: Type.Literal('replace'), value: ManifestJsonValueSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...ManifestFixBase, kind: Type.Literal('remove') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ManifestFixBase,
      kind: Type.Literal('select-primitive'),
      primitiveKind: PrimitiveKindSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ManifestDiagnosticSchema = Type.Object(
  {
    code: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    fixes: Type.Array(ManifestSuggestedFixSchema, { maxItems: 8 }),
    location: Type.Union([ManifestSourceLocationSchema, Type.Null()]),
    message: Type.String({ maxLength: 500, minLength: 1 }),
    pointer: ManifestJsonPointerSchema,
    relatedPointers: Type.Array(ManifestJsonPointerSchema, { maxItems: 16, uniqueItems: true }),
    severity: Type.Union([Type.Literal('error'), Type.Literal('warning'), Type.Literal('info')]),
  },
  { additionalProperties: false },
);

export const ManifestFieldProvenanceSchema = Type.Object(
  {
    pointer: ManifestJsonPointerSchema,
    sourceHash: ManifestHashSchema,
    sourceRef: Type.String({ maxLength: 160, minLength: 1 }),
    sourceType: Type.Union([
      Type.Literal('prompt'),
      Type.Literal('primitive'),
      Type.Literal('model'),
      Type.Literal('fallback'),
      Type.Literal('manual'),
    ]),
  },
  { additionalProperties: false },
);

export const ManifestGenerationWarningSchema = Type.Object(
  {
    code: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    message: Type.String({ maxLength: 500, minLength: 1 }),
    pointer: ManifestJsonPointerSchema,
  },
  { additionalProperties: false },
);

export const ManifestGenerationEnvelopeV1Schema = Type.Object(
  {
    assumptions: Type.Array(ManifestBoundedTextSchema, { maxItems: 32, uniqueItems: true }),
    generatorSchemaVersion: Type.Literal(MANIFEST_GENERATOR_SCHEMA_VERSION),
    manifest: WorldManifestV1Schema,
    promptTemplateVersion: Type.Literal(MANIFEST_PROMPT_TEMPLATE_VERSION),
    provenance: Type.Array(ManifestFieldProvenanceSchema, { maxItems: 512 }),
    suggestedFixes: Type.Array(ManifestSuggestedFixSchema, { maxItems: 32 }),
    unresolvedQuestions: Type.Array(ManifestBoundedTextSchema, { maxItems: 32, uniqueItems: true }),
    warnings: Type.Array(ManifestGenerationWarningSchema, {
      maxItems: MAX_MANIFEST_GENERATION_WARNINGS,
    }),
  },
  { $id: 'ManifestGenerationEnvelopeV1', additionalProperties: false },
);

export const ManifestGenerationStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);
export const ManifestGenerationStageSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('intent'),
  Type.Literal('retrieval'),
  Type.Literal('generation'),
  Type.Literal('repair'),
  Type.Literal('fallback'),
  Type.Literal('validation'),
  Type.Literal('persisting'),
  Type.Literal('complete'),
]);

const StartManifestGenerationBase = {
  prompt: Type.String({
    maxLength: 2_000,
    minLength: 10,
    pattern: '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]+$',
  }),
  seed: Type.Optional(Type.String({ maxLength: 128, minLength: 1, pattern: '^[A-Za-z0-9._:-]+$' })),
} as const;
export const StartManifestGenerationRequestSchema = Type.Union([
  Type.Object(StartManifestGenerationBase, { additionalProperties: false }),
  Type.Object(
    {
      ...StartManifestGenerationBase,
      expectedParentContentHash: ManifestHashSchema,
      parentRevisionId: ManifestUuidSchema,
    },
    { additionalProperties: false },
  ),
]);

export const StartManifestGenerationResponseSchema = Type.Object(
  {
    rowVersion: Type.Integer({ minimum: 1 }),
    runId: ManifestUuidSchema,
    status: ManifestGenerationStatusSchema,
  },
  { additionalProperties: false },
);

export const CancelManifestGenerationRequestSchema = Type.Object(
  { expectedRowVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const ManifestGenerationRunViewSchema = Type.Object(
  {
    attempts: Type.Integer({ maximum: 3, minimum: 0 }),
    catalogSnapshotHash: Type.Union([ManifestHashSchema, Type.Null()]),
    completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    costEstimateMicrounits: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    errorCode: Type.Union([
      Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
      Type.Null(),
    ]),
    generatorSchemaVersion: Type.Literal(MANIFEST_GENERATOR_SCHEMA_VERSION),
    id: ManifestUuidSchema,
    inputHash: ManifestHashSchema,
    inputTokenCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    outcome: Type.Union([
      Type.Object(
        {
          assumptions: Type.Array(ManifestBoundedTextSchema, { maxItems: 32, uniqueItems: true }),
          mode: Type.Union([Type.Literal('provider'), Type.Literal('fallback')]),
          suggestedFixes: Type.Array(ManifestSuggestedFixSchema, { maxItems: 32 }),
          unresolvedQuestions: Type.Array(ManifestBoundedTextSchema, {
            maxItems: 32,
            uniqueItems: true,
          }),
          warnings: Type.Array(ManifestGenerationWarningSchema, {
            maxItems: MAX_MANIFEST_GENERATION_WARNINGS,
          }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    outputRevisionId: Type.Union([ManifestUuidSchema, Type.Null()]),
    outputTokenCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    progressPercent: Type.Integer({ maximum: 100, minimum: 0 }),
    promptTemplateVersion: Type.Literal(MANIFEST_PROMPT_TEMPLATE_VERSION),
    provider: Type.Union([Type.String({ maxLength: 120, minLength: 1 }), Type.Null()]),
    providerCallCount: Type.Integer({ maximum: 9, minimum: 0 }),
    model: Type.Union([Type.String({ maxLength: 160, minLength: 1 }), Type.Null()]),
    queuedAt: Type.String({ format: 'date-time' }),
    rowVersion: Type.Integer({ minimum: 1 }),
    repairAttempts: Type.Integer({ maximum: 2, minimum: 0 }),
    resolvedInputHash: Type.Union([ManifestHashSchema, Type.Null()]),
    stage: ManifestGenerationStageSchema,
    startedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    status: ManifestGenerationStatusSchema,
    worldId: ManifestUuidSchema,
  },
  { additionalProperties: false },
);

export const CancelManifestGenerationResponseSchema = ManifestGenerationRunViewSchema;

const ManifestRevisionBaseInput = {
  baseRevisionId: Type.Union([ManifestUuidSchema, Type.Null()]),
  expectedHash: Type.Union([ManifestHashSchema, Type.Null()]),
} as const;
export const CreateManifestRevisionRequestSchema = Type.Union([
  Type.Object(
    {
      ...ManifestRevisionBaseInput,
      format: Type.Literal('json'),
      jsonOrYaml: WorldManifestV1Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ManifestRevisionBaseInput,
      format: Type.Literal('yaml'),
      jsonOrYaml: Type.String({ maxLength: 131_072, minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const ManifestRevisionSourceSchema = Type.Union([
  Type.Literal('generation'),
  Type.Literal('manual'),
  Type.Literal('import'),
]);
export const ManifestApprovalStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('approved'),
  Type.Literal('superseded'),
  Type.Literal('rejected'),
]);

export const ManifestRevisionSummarySchema = Type.Object(
  {
    approvalStatus: ManifestApprovalStatusSchema,
    approvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    approvedBy: Type.Union([ManifestUuidSchema, Type.Null()]),
    contentHash: ManifestHashSchema,
    createdAt: Type.String({ format: 'date-time' }),
    createdBy: ManifestUuidSchema,
    generationRunId: Type.Union([ManifestUuidSchema, Type.Null()]),
    id: ManifestUuidSchema,
    manifestSchemaVersion: Type.Literal(MANIFEST_SCHEMA_VERSION),
    parentRevisionId: Type.Union([ManifestUuidSchema, Type.Null()]),
    revisionNumber: Type.Integer({ minimum: 1 }),
    rowVersion: Type.Integer({ minimum: 1 }),
    source: ManifestRevisionSourceSchema,
    worldId: ManifestUuidSchema,
  },
  { additionalProperties: false },
);

export const ManifestRevisionViewSchema = Type.Object(
  { ...ManifestRevisionSummarySchema.properties, manifest: WorldManifestV1Schema },
  { additionalProperties: false },
);

export const CreateManifestRevisionResponseSchema = Type.Object(
  {
    revision: ManifestRevisionSummarySchema,
    validationReportId: Type.Union([ManifestUuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const ValidateManifestRevisionRequestSchema = Type.Object(
  { expectedContentHash: ManifestHashSchema },
  { additionalProperties: false },
);

export const ManifestValidationReportViewSchema = Type.Object(
  {
    catalogSnapshotHash: ManifestHashSchema,
    createdAt: Type.String({ format: 'date-time' }),
    diagnostics: Type.Array(ManifestDiagnosticSchema, { maxItems: 128 }),
    id: ManifestUuidSchema,
    manifestRevisionId: ManifestUuidSchema,
    reportHash: ManifestHashSchema,
    valid: Type.Boolean(),
    validatorVersion: Type.Literal(MANIFEST_VALIDATOR_VERSION),
  },
  { additionalProperties: false },
);

export const ValidateManifestRevisionResponseSchema = Type.Object(
  { report: ManifestValidationReportViewSchema },
  { additionalProperties: false },
);

const ManifestCursorSchema = Type.String({
  maxLength: 1_024,
  minLength: 16,
  pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
});

export const ManifestRevisionListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(ManifestCursorSchema),
    limit: Type.Optional(Type.String({ maxLength: 3, pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
  },
  { additionalProperties: false },
);

export const ManifestRevisionListResponseSchema = Type.Object(
  {
    items: Type.Array(ManifestRevisionSummarySchema, { maxItems: 100 }),
    nextCursor: Type.Union([ManifestCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const ManifestProvenanceViewSchema = Type.Object(
  {
    entries: Type.Array(ManifestFieldProvenanceSchema, { maxItems: 512 }),
    manifestRevisionId: ManifestUuidSchema,
  },
  { additionalProperties: false },
);

export const GetManifestRevisionResponseSchema = Type.Object(
  {
    provenance: ManifestProvenanceViewSchema,
    report: Type.Union([ManifestValidationReportViewSchema, Type.Null()]),
    revision: ManifestRevisionViewSchema,
    yaml: Type.String({ maxLength: 131_072, minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ManifestDiffEntrySchema = Type.Union([
  Type.Object(
    {
      after: ManifestJsonValueSchema,
      kind: Type.Literal('added'),
      pointer: ManifestJsonPointerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      before: ManifestJsonValueSchema,
      kind: Type.Literal('removed'),
      pointer: ManifestJsonPointerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      after: ManifestJsonValueSchema,
      before: ManifestJsonValueSchema,
      kind: Type.Literal('changed'),
      pointer: ManifestJsonPointerSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ManifestRevisionDiffQuerySchema = Type.Object(
  {
    cursor: Type.Optional(ManifestCursorSchema),
    fromRevisionId: ManifestUuidSchema,
    limit: Type.Optional(
      Type.String({ maxLength: 3, pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$' }),
    ),
    toRevisionId: ManifestUuidSchema,
  },
  { additionalProperties: false },
);

export const ManifestRevisionDiffViewSchema = Type.Object(
  {
    counts: Type.Object(
      {
        added: Type.Integer({ minimum: 0 }),
        changed: Type.Integer({ minimum: 0 }),
        removed: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    entries: Type.Array(ManifestDiffEntrySchema, { maxItems: 200 }),
    fromContentHash: ManifestHashSchema,
    fromRevisionId: ManifestUuidSchema,
    nextCursor: Type.Union([ManifestCursorSchema, Type.Null()]),
    toContentHash: ManifestHashSchema,
    toRevisionId: ManifestUuidSchema,
  },
  { additionalProperties: false },
);

export const ApproveManifestRevisionRequestSchema = Type.Object(
  {
    acknowledgedWarningCodes: Type.Array(
      Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
      { maxItems: 64, uniqueItems: true },
    ),
    confirmationName: Type.String({ maxLength: 100, minLength: 2 }),
    expectedContentHash: ManifestHashSchema,
    expectedWorldVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const ApproveManifestRevisionResponseSchema = Type.Object(
  {
    contentHash: ManifestHashSchema,
    manifestSchemaVersion: Type.Literal(MANIFEST_SCHEMA_VERSION),
    revisionId: ManifestUuidSchema,
    worldId: ManifestUuidSchema,
    worldRowVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const ManifestGenerationRequestedSchema = Type.Object(
  {
    generatorSchemaVersion: Type.Literal(MANIFEST_GENERATOR_SCHEMA_VERSION),
    inputHash: ManifestHashSchema,
    promptTemplateVersion: Type.Literal(MANIFEST_PROMPT_TEMPLATE_VERSION),
    providerConfigurationId: Type.String({ maxLength: 120, minLength: 1 }),
    runId: ManifestUuidSchema,
    schemaVersion: Type.Literal(MANIFEST_QUEUE_SCHEMA_VERSION),
    type: Type.Literal('ManifestGenerationRequested'),
    validatorVersion: Type.Literal(MANIFEST_VALIDATOR_VERSION),
  },
  { $id: 'ManifestGenerationRequestedV1', additionalProperties: false },
);

export type ManifestPrimitiveReferenceV1 = Static<typeof ManifestPrimitiveReferenceV1Schema>;
export type WorldgraphEconomyExtensionV2 = Static<typeof WorldgraphEconomyExtensionV2Schema>;
export type WorldManifestV1 = Static<typeof WorldManifestV1Schema>;
export type ManifestSuggestedFix = Static<typeof ManifestSuggestedFixSchema>;
export type ManifestDiagnostic = Static<typeof ManifestDiagnosticSchema>;
export type ManifestFieldProvenance = Static<typeof ManifestFieldProvenanceSchema>;
export type ManifestGenerationWarning = Static<typeof ManifestGenerationWarningSchema>;
export type ManifestGenerationEnvelopeV1 = Static<typeof ManifestGenerationEnvelopeV1Schema>;
export type StartManifestGenerationRequest = Static<typeof StartManifestGenerationRequestSchema>;
export type StartManifestGenerationResponse = Static<typeof StartManifestGenerationResponseSchema>;
export type CancelManifestGenerationRequest = Static<typeof CancelManifestGenerationRequestSchema>;
export type ManifestGenerationRunView = Static<typeof ManifestGenerationRunViewSchema>;
export type CreateManifestRevisionRequest = Static<typeof CreateManifestRevisionRequestSchema>;
export type CreateManifestRevisionResponse = Static<typeof CreateManifestRevisionResponseSchema>;
export type ManifestRevisionSummary = Static<typeof ManifestRevisionSummarySchema>;
export type ManifestRevisionView = Static<typeof ManifestRevisionViewSchema>;
export type ManifestValidationReportView = Static<typeof ManifestValidationReportViewSchema>;
export type ManifestRevisionListQuery = Static<typeof ManifestRevisionListQuerySchema>;
export type ManifestRevisionListResponse = Static<typeof ManifestRevisionListResponseSchema>;
export type ManifestProvenanceView = Static<typeof ManifestProvenanceViewSchema>;
export type GetManifestRevisionResponse = Static<typeof GetManifestRevisionResponseSchema>;
export type ManifestDiffEntry = Static<typeof ManifestDiffEntrySchema>;
export type ManifestRevisionDiffQuery = Static<typeof ManifestRevisionDiffQuerySchema>;
export type ManifestRevisionDiffView = Static<typeof ManifestRevisionDiffViewSchema>;
export type ApproveManifestRevisionRequest = Static<typeof ApproveManifestRevisionRequestSchema>;
export type ApproveManifestRevisionResponse = Static<typeof ApproveManifestRevisionResponseSchema>;
export type ManifestGenerationRequested = Static<typeof ManifestGenerationRequestedSchema>;
