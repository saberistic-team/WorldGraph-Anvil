import { Type, type Static } from '@sinclair/typebox';

export const PRIMITIVE_INDEX_SCHEMA_VERSION = 1 as const;
export const PRIMITIVE_QUEUE_SCHEMA_VERSION = 1 as const;
export const PRIMITIVE_KINDS = [
  'government',
  'election',
  'currency',
  'tax',
  'resource',
  'production_recipe',
  'terrain',
  'district',
  'building',
  'organization',
  'office',
  'legal_right',
  'player_role',
  'visual_style',
  'simulation_rule',
  'event_template',
] as const;

export const PrimitiveKindSchema = Type.Union(PRIMITIVE_KINDS.map((kind) => Type.Literal(kind)));
export const PrimitiveLifecycleSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('published'),
  Type.Literal('deprecated'),
]);
export const PrimitiveIndexStateSchema = Type.Union([
  Type.Literal('not_requested'),
  Type.Literal('queued'),
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('dead'),
  Type.Literal('stale'),
  Type.Literal('disabled'),
]);
export const StablePrimitiveKeySchema = Type.String({
  maxLength: 160,
  minLength: 5,
  pattern: '^[a-z][a-z0-9]*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*){2,}$',
});
export const StrictSemverSchema = Type.String({
  maxLength: 64,
  minLength: 5,
  pattern:
    '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
});
const SafeJsonObjectSchema = Type.Record(Type.String({ maxLength: 160 }), Type.Unknown(), {
  maxProperties: 200,
});
export const PrimitiveTagSchema = Type.String({
  maxLength: 64,
  minLength: 1,
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
});
const ContentHashSchema = Type.String({ maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$' });
const NullableUuidSchema = Type.Union([Type.String({ format: 'uuid' }), Type.Null()]);
const NullableContentHashSchema = Type.Union([ContentHashSchema, Type.Null()]);

export const PrimitiveDependencyInputSchema = Type.Object(
  {
    key: StablePrimitiveKeySchema,
    parameterMapping: Type.Optional(SafeJsonObjectSchema),
    required: Type.Optional(Type.Boolean({ default: true })),
    versionRange: Type.String({ maxLength: 100, minLength: 1 }),
  },
  { additionalProperties: false },
);

export const PrimitiveDraftInputSchema = Type.Object(
  {
    behaviorRef: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
    compatibility: SafeJsonObjectSchema,
    defaults: SafeJsonObjectSchema,
    dependencies: Type.Array(PrimitiveDependencyInputSchema, { maxItems: 32 }),
    displayName: Type.String({ maxLength: 120, minLength: 1 }),
    documentation: Type.String({ maxLength: 32_000, minLength: 1 }),
    key: StablePrimitiveKeySchema,
    kind: PrimitiveKindSchema,
    parameterSchema: SafeJsonObjectSchema,
    primitiveSchemaVersion: Type.Literal(1),
    provenance: SafeJsonObjectSchema,
    tags: Type.Array(PrimitiveTagSchema, { maxItems: 32, uniqueItems: true }),
    version: StrictSemverSchema,
    visualHints: SafeJsonObjectSchema,
  },
  { $id: 'PrimitiveDraftInputV1', additionalProperties: false },
);

export const ValidationIssueSchema = Type.Object(
  {
    code: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    message: Type.String({ maxLength: 300, minLength: 1 }),
    pointer: Type.String({ maxLength: 500 }),
  },
  { additionalProperties: false },
);

export const PrimitiveDependencyViewSchema = Type.Object(
  {
    key: StablePrimitiveKeySchema,
    dependencyFamilyId: Type.String({ format: 'uuid' }),
    parameterMapping: SafeJsonObjectSchema,
    required: Type.Boolean(),
    resolvedContentHash: NullableContentHashSchema,
    resolvedVersion: Type.Union([StrictSemverSchema, Type.Null()]),
    resolvedVersionId: NullableUuidSchema,
    versionRange: Type.String({ maxLength: 100, minLength: 1 }),
  },
  { additionalProperties: false },
);

export const PrimitiveVersionViewSchema = Type.Object(
  {
    behaviorRef: Type.Union([Type.String({ maxLength: 160 }), Type.Null()]),
    compatibility: SafeJsonObjectSchema,
    contentHash: ContentHashSchema,
    createdAt: Type.String({ format: 'date-time' }),
    defaults: SafeJsonObjectSchema,
    dependencies: Type.Array(PrimitiveDependencyViewSchema, { maxItems: 32 }),
    displayName: Type.String({ maxLength: 120, minLength: 1 }),
    documentation: Type.String({ maxLength: 32_000, minLength: 1 }),
    id: Type.String({ format: 'uuid' }),
    indexErrorCode: Type.Union([
      Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
      Type.Null(),
    ]),
    deprecatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    deprecationReason: Type.Union([Type.String({ maxLength: 500, minLength: 10 }), Type.Null()]),
    indexState: PrimitiveIndexStateSchema,
    key: StablePrimitiveKeySchema,
    kind: PrimitiveKindSchema,
    lifecycle: PrimitiveLifecycleSchema,
    parameterSchema: SafeJsonObjectSchema,
    primitiveSchemaVersion: Type.Literal(1),
    provenance: SafeJsonObjectSchema,
    publishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    rowVersion: Type.Integer({ minimum: 1 }),
    tags: Type.Array(PrimitiveTagSchema, { maxItems: 32 }),
    updatedAt: Type.String({ format: 'date-time' }),
    version: StrictSemverSchema,
    visualHints: SafeJsonObjectSchema,
  },
  { $id: 'PrimitiveVersionViewV1', additionalProperties: false },
);

export const PrimitiveListItemSchema = Type.Pick(PrimitiveVersionViewSchema, [
  'contentHash',
  'createdAt',
  'displayName',
  'id',
  'indexErrorCode',
  'indexState',
  'key',
  'kind',
  'lifecycle',
  'publishedAt',
  'rowVersion',
  'tags',
  'updatedAt',
  'version',
]);

export const PrimitiveListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(
      Type.String({ maxLength: 1024, minLength: 16, pattern: '^[A-Za-z0-9_-]+$' }),
    ),
    kinds: Type.Optional(Type.Array(PrimitiveKindSchema, { maxItems: 16, uniqueItems: true })),
    lifecycle: Type.Optional(PrimitiveLifecycleSchema),
    limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
    query: Type.Optional(Type.String({ maxLength: 500, minLength: 1 })),
    tags: Type.Optional(Type.Array(PrimitiveTagSchema, { maxItems: 16, uniqueItems: true })),
  },
  { $id: 'PrimitiveListQueryV1', additionalProperties: false },
);

export const PrimitiveListResponseSchema = Type.Object(
  {
    items: Type.Array(PrimitiveListItemSchema, { maxItems: 100 }),
    nextCursor: Type.Union([
      Type.String({ maxLength: 1024, minLength: 16, pattern: '^[A-Za-z0-9_-]+$' }),
      Type.Null(),
    ]),
  },
  { $id: 'PrimitiveListResponseV1', additionalProperties: false },
);

export const PrimitiveRetrievalRequestSchema = Type.Object(
  {
    compatibility: Type.Optional(SafeJsonObjectSchema),
    kinds: Type.Optional(Type.Array(PrimitiveKindSchema, { maxItems: 16, uniqueItems: true })),
    limit: Type.Optional(Type.Integer({ maximum: 30, minimum: 1 })),
    query: Type.String({ maxLength: 500, minLength: 1 }),
    tags: Type.Optional(
      Type.Array(PrimitiveTagSchema, {
        maxItems: 16,
        uniqueItems: true,
      }),
    ),
  },
  { $id: 'PrimitiveRetrievalRequestV1', additionalProperties: false },
);

export const RankContributionSchema = Type.Object(
  {
    lexicalRank: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    lexicalScore: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    matchedTags: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 }),
    matchedTerms: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 64 }),
    score: Type.Number({ minimum: 0 }),
    tagRank: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    tagScore: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    vectorRank: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    vectorSimilarity: Type.Union([Type.Number({ maximum: 1, minimum: -1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const PrimitiveIndexProvenanceSchema = Type.Object(
  {
    contentHash: ContentHashSchema,
    indexSchemaVersion: Type.Literal(PRIMITIVE_INDEX_SCHEMA_VERSION),
    lastErrorCode: Type.Union([
      Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
      Type.Null(),
    ]),
    model: Type.Union([Type.String({ maxLength: 160, minLength: 1 }), Type.Null()]),
    provider: Type.Union([Type.String({ maxLength: 120, minLength: 1 }), Type.Null()]),
    providerConfigurationId: Type.Union([
      Type.String({ maxLength: 120, minLength: 1 }),
      Type.Null(),
    ]),
    status: PrimitiveIndexStateSchema,
  },
  { additionalProperties: false },
);

export const PrimitiveDependencyClosureItemSchema = Type.Object(
  {
    contentHash: ContentHashSchema,
    familyId: Type.String({ format: 'uuid' }),
    key: StablePrimitiveKeySchema,
    primitiveVersionId: Type.String({ format: 'uuid' }),
    version: StrictSemverSchema,
  },
  { additionalProperties: false },
);

export const PrimitiveRetrievalResultSchema = Type.Object(
  {
    dependencyClosure: Type.Array(PrimitiveDependencyClosureItemSchema, { maxItems: 128 }),
    index: PrimitiveIndexProvenanceSchema,
    primitive: PrimitiveListItemSchema,
    rank: Type.Integer({ minimum: 1 }),
    reason: RankContributionSchema,
  },
  { additionalProperties: false },
);

export const PrimitiveRetrievalResponseSchema = Type.Object(
  {
    normalizedQueryHash: Type.String({ maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$' }),
    provider: Type.Object(
      {
        configurationId: Type.Union([Type.String({ maxLength: 120, minLength: 1 }), Type.Null()]),
        degradedReason: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
        model: Type.Union([Type.String({ maxLength: 160 }), Type.Null()]),
        name: Type.Union([Type.String({ maxLength: 120, minLength: 1 }), Type.Null()]),
        semanticAvailable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    ranking: Type.Object(
      {
        k: Type.Literal(60),
        strategy: Type.Literal('weighted_rrf_v1'),
        weights: Type.Object(
          { lexical: Type.Literal(1), tag: Type.Literal(0.6), vector: Type.Literal(0.35) },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    results: Type.Array(PrimitiveRetrievalResultSchema, { maxItems: 30 }),
    retrievalRunId: Type.String({ format: 'uuid' }),
    warnings: Type.Array(
      Type.Object(
        {
          code: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
          message: Type.String({ maxLength: 300, minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 16 },
    ),
  },
  { $id: 'PrimitiveRetrievalResponseV1', additionalProperties: false },
);

export const PrimitiveIndexRequestedSchema = Type.Object(
  {
    contentHash: Type.String({ maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$' }),
    indexSchemaVersion: Type.Literal(PRIMITIVE_INDEX_SCHEMA_VERSION),
    primitiveVersionId: Type.String({ format: 'uuid' }),
    providerConfigurationId: Type.String({
      maxLength: 120,
      minLength: 1,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$',
    }),
    schemaVersion: Type.Literal(PRIMITIVE_QUEUE_SCHEMA_VERSION),
    type: Type.Literal('PrimitiveIndexRequested'),
  },
  { $id: 'PrimitiveIndexRequestedV1', additionalProperties: false },
);

export const PrimitiveValidationReportSchema = Type.Object(
  {
    contentHash: NullableContentHashSchema,
    issues: Type.Array(ValidationIssueSchema, { maxItems: 128 }),
    valid: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CreatePrimitiveDraftRequestSchema = PrimitiveDraftInputSchema;
export const UpdatePrimitiveDraftRequestSchema = Type.Object(
  { draft: PrimitiveDraftInputSchema, expectedRowVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export const PublishPrimitiveVersionRequestSchema = Type.Object(
  { expectedRowVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export const DeprecatePrimitiveVersionRequestSchema = Type.Object(
  {
    expectedRowVersion: Type.Integer({ minimum: 1 }),
    reason: Type.String({ maxLength: 500, minLength: 10, pattern: '^[^\\u0000-\\u001F\\u007F]+$' }),
  },
  { additionalProperties: false },
);
export const ReindexPrimitiveVersionRequestSchema = Type.Object(
  { expectedRowVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const PrimitiveCommandResponseSchema = Type.Object(
  { primitive: PrimitiveListItemSchema },
  { additionalProperties: false },
);
export const PrimitiveDraftCommandResponseSchema = Type.Object(
  { primitive: PrimitiveListItemSchema, validation: PrimitiveValidationReportSchema },
  { additionalProperties: false },
);
export const PrimitiveReindexResponseSchema = Type.Object(
  { index: PrimitiveIndexProvenanceSchema, primitiveVersionId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

export type PrimitiveDependencyInput = Static<typeof PrimitiveDependencyInputSchema>;
export type PrimitiveDependencyView = Static<typeof PrimitiveDependencyViewSchema>;
export type PrimitiveDependencyClosureItem = Static<typeof PrimitiveDependencyClosureItemSchema>;
export type PrimitiveDraftInput = Static<typeof PrimitiveDraftInputSchema>;
export type PrimitiveIndexRequested = Static<typeof PrimitiveIndexRequestedSchema>;
export type PrimitiveIndexState = Static<typeof PrimitiveIndexStateSchema>;
export type PrimitiveIndexProvenance = Static<typeof PrimitiveIndexProvenanceSchema>;
export type PrimitiveKind = Static<typeof PrimitiveKindSchema>;
export type PrimitiveLifecycle = Static<typeof PrimitiveLifecycleSchema>;
export type PrimitiveListItem = Static<typeof PrimitiveListItemSchema>;
export type PrimitiveListQuery = Static<typeof PrimitiveListQuerySchema>;
export type PrimitiveListResponse = Static<typeof PrimitiveListResponseSchema>;
export type PrimitiveRetrievalRequest = Static<typeof PrimitiveRetrievalRequestSchema>;
export type PrimitiveRetrievalResponse = Static<typeof PrimitiveRetrievalResponseSchema>;
export type PrimitiveVersionView = Static<typeof PrimitiveVersionViewSchema>;
export type PrimitiveValidationIssue = Static<typeof ValidationIssueSchema>;
export type CreatePrimitiveDraftRequest = Static<typeof CreatePrimitiveDraftRequestSchema>;
export type UpdatePrimitiveDraftRequest = Static<typeof UpdatePrimitiveDraftRequestSchema>;
export type PublishPrimitiveVersionRequest = Static<typeof PublishPrimitiveVersionRequestSchema>;
export type DeprecatePrimitiveVersionRequest = Static<
  typeof DeprecatePrimitiveVersionRequestSchema
>;
export type ReindexPrimitiveVersionRequest = Static<typeof ReindexPrimitiveVersionRequestSchema>;
export type PrimitiveCommandResponse = Static<typeof PrimitiveCommandResponseSchema>;
export type PrimitiveDraftCommandResponse = Static<typeof PrimitiveDraftCommandResponseSchema>;
export type PrimitiveReindexResponse = Static<typeof PrimitiveReindexResponseSchema>;

export const PRIMITIVE_INDEX_QUEUE = 'primitive-index' as const;
