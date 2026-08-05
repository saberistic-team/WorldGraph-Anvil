import { Type, type Static, type TSchema } from '@sinclair/typebox';

import { IdempotencyKeySchema } from './commands.js';
import {
  GEOGRAPHY_SCHEMA_VERSION,
  GEOGRAPHY_SEED_PLAN_SCHEMA_VERSION,
  VISUAL_ASSET_CATALOG_SCHEMA_VERSION,
  VISUAL_SCENE_PLAN_SCHEMA_VERSION,
  VISUAL_STYLE_KIT_VERSION,
} from './versions.js';

export const GeographyHashSchema = Type.String({
  maxLength: 64,
  minLength: 64,
  pattern: '^[a-f0-9]{64}$',
});
export const GeographyUuidSchema = Type.String({ format: 'uuid' });
export const GeographyTickSchema = Type.String({
  maxLength: 19,
  minLength: 1,
  pattern: '^(?:0|[1-9][0-9]{0,18})$',
});
export const GeographyVersionSchema = GeographyTickSchema;
export const GeographyPositiveVersionSchema = Type.String({
  maxLength: 19,
  minLength: 1,
  pattern: '^[1-9][0-9]{0,18}$',
});
export const GeographyStableKeySchema = Type.String({
  maxLength: 240,
  minLength: 3,
  pattern: '^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$',
});
export const GeographyCodeSchema = Type.String({
  maxLength: 100,
  minLength: 1,
  pattern: '^[a-z][a-z0-9._-]*$',
});
export const GeographyMilliCoordinateSchema = Type.Integer({
  maximum: 10_000_000,
  minimum: -10_000_000,
});
export const GeographyPositiveMilliSchema = Type.Integer({
  maximum: 10_000_000,
  minimum: 1,
});
export const GeographyYawMilliDegreesSchema = Type.Integer({
  maximum: 359_999,
  minimum: 0,
});

export const GeographyPointMilliV1Schema = Type.Object(
  {
    xMilli: GeographyMilliCoordinateSchema,
    yMilli: GeographyMilliCoordinateSchema,
  },
  { additionalProperties: false },
);

export const GeographyRingMilliV1Schema = Type.Array(GeographyPointMilliV1Schema, {
  maxItems: 64,
  minItems: 4,
});

export const GeographySpatialReferenceV1Schema = Type.Object(
  {
    boundsMaxXMilli: GeographyMilliCoordinateSchema,
    boundsMaxYMilli: GeographyMilliCoordinateSchema,
    boundsMinXMilli: GeographyMilliCoordinateSchema,
    boundsMinYMilli: GeographyMilliCoordinateSchema,
    originXMilli: GeographyMilliCoordinateSchema,
    originYMilli: GeographyMilliCoordinateSchema,
    srid: Type.Literal(3857),
    units: Type.Literal('meters'),
  },
  { additionalProperties: false },
);

export const GeographySeedTerritoryV1Schema = Type.Object(
  {
    ring: GeographyRingMilliV1Schema,
    stableKey: GeographyStableKeySchema,
  },
  { additionalProperties: false },
);

export const GeographySeedDistrictV1Schema = Type.Object(
  {
    parentTerritoryKey: GeographyStableKeySchema,
    ring: GeographyRingMilliV1Schema,
    stableKey: GeographyStableKeySchema,
    zoning: GeographyCodeSchema,
  },
  { additionalProperties: false },
);

export const GeographySeedParcelV1Schema = Type.Object(
  {
    districtKey: GeographyStableKeySchema,
    parcelType: GeographyCodeSchema,
    ring: GeographyRingMilliV1Schema,
    stableKey: GeographyStableKeySchema,
  },
  { additionalProperties: false },
);

export const GeographyRoadClassSchema = Type.Union([
  Type.Literal('primary'),
  Type.Literal('secondary'),
  Type.Literal('path'),
]);

export const GeographySeedRoadV1Schema = Type.Object(
  {
    class: GeographyRoadClassSchema,
    fromDistrictKey: GeographyStableKeySchema,
    path: Type.Array(GeographyPointMilliV1Schema, { maxItems: 64, minItems: 2 }),
    stableKey: GeographyStableKeySchema,
    toDistrictKey: GeographyStableKeySchema,
    widthMilli: GeographyPositiveMilliSchema,
  },
  { additionalProperties: false },
);

export const GeographySeedBuildingV1Schema = Type.Object(
  {
    archetype: GeographyCodeSchema,
    centroidXMilli: GeographyMilliCoordinateSchema,
    centroidYMilli: GeographyMilliCoordinateSchema,
    elevationMilli: Type.Integer({ maximum: 1_000_000, minimum: 0 }),
    entityLogicalKey: GeographyStableKeySchema,
    footprintHalfDepthMilli: GeographyPositiveMilliSchema,
    footprintHalfWidthMilli: GeographyPositiveMilliSchema,
    parcelKey: GeographyStableKeySchema,
    stableKey: GeographyStableKeySchema,
    yawMilliDegrees: GeographyYawMilliDegreesSchema,
  },
  { additionalProperties: false },
);

export const GeographySeedPointOfInterestV1Schema = Type.Object(
  {
    entityLogicalKey: GeographyStableKeySchema,
    kind: GeographyCodeSchema,
    radiusMilli: GeographyPositiveMilliSchema,
    stableKey: GeographyStableKeySchema,
    xMilli: GeographyMilliCoordinateSchema,
    yMilli: GeographyMilliCoordinateSchema,
  },
  { additionalProperties: false },
);

export const GeographySpawnAccessPolicySchema = Type.Union([
  Type.Literal('public'),
  Type.Literal('member'),
]);

export const GeographySeedSpawnPointV1Schema = Type.Object(
  {
    accessPolicy: GeographySpawnAccessPolicySchema,
    priority: Type.Integer({ maximum: 1_000, minimum: 0 }),
    radiusMilli: GeographyPositiveMilliSchema,
    stableKey: GeographyStableKeySchema,
    xMilli: GeographyMilliCoordinateSchema,
    yMilli: GeographyMilliCoordinateSchema,
  },
  { additionalProperties: false },
);

export const GeographySeedPlanV1Schema = Type.Object(
  {
    buildings: Type.Array(GeographySeedBuildingV1Schema, { maxItems: 256 }),
    districts: Type.Array(GeographySeedDistrictV1Schema, { maxItems: 32, minItems: 1 }),
    geographySeedPlanSchemaVersion: Type.Literal(GEOGRAPHY_SEED_PLAN_SCHEMA_VERSION),
    parcels: Type.Array(GeographySeedParcelV1Schema, { maxItems: 256, minItems: 1 }),
    pointsOfInterest: Type.Array(GeographySeedPointOfInterestV1Schema, { maxItems: 128 }),
    roads: Type.Array(GeographySeedRoadV1Schema, { maxItems: 128, minItems: 1 }),
    spatialReference: GeographySpatialReferenceV1Schema,
    spawnPoints: Type.Array(GeographySeedSpawnPointV1Schema, { maxItems: 32, minItems: 1 }),
    territory: GeographySeedTerritoryV1Schema,
  },
  { $id: 'GeographySeedPlanV1', additionalProperties: false },
);

export const VisualSceneLayerSchema = Type.Union([
  Type.Literal('district'),
  Type.Literal('parcel'),
  Type.Literal('road'),
  Type.Literal('building'),
  Type.Literal('poi'),
  Type.Literal('spawn'),
]);

export const VisualSceneLodHintSchema = Type.Union([
  Type.Literal('high'),
  Type.Literal('medium'),
  Type.Literal('low'),
]);

export const VisualSceneNodeV1Schema = Type.Object(
  {
    archetype: GeographyCodeSchema,
    entityLogicalKey: GeographyStableKeySchema,
    layer: VisualSceneLayerSchema,
    lodHint: VisualSceneLodHintSchema,
    materialToken: GeographyCodeSchema,
    provenance: Type.Object(
      { sourceStableKey: GeographyStableKeySchema },
      { additionalProperties: false },
    ),
    transform: Type.Object(
      {
        scaleMilli: GeographyPositiveMilliSchema,
        xMilli: GeographyMilliCoordinateSchema,
        yMilli: GeographyMilliCoordinateSchema,
        yawMilliDegrees: GeographyYawMilliDegreesSchema,
        zMilli: Type.Integer({ maximum: 1_000_000, minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const VisualScenePlanWarningV1Schema = Type.Object(
  {
    code: Type.String({ maxLength: 100, minLength: 1, pattern: '^[A-Z][A-Z0-9_]*$' }),
    message: Type.String({ maxLength: 500, minLength: 1 }),
  },
  { additionalProperties: false },
);

export const VisualScenePlanV1Schema = Type.Object(
  {
    bounds: Type.Object(
      {
        maxXMilli: GeographyMilliCoordinateSchema,
        maxYMilli: GeographyMilliCoordinateSchema,
        minXMilli: GeographyMilliCoordinateSchema,
        minYMilli: GeographyMilliCoordinateSchema,
      },
      { additionalProperties: false },
    ),
    nodes: Type.Array(VisualSceneNodeV1Schema, { maxItems: 1_024 }),
    styleKitVersion: Type.Literal(VISUAL_STYLE_KIT_VERSION),
    visualScenePlanSchemaVersion: Type.Literal(VISUAL_SCENE_PLAN_SCHEMA_VERSION),
    warnings: Type.Array(VisualScenePlanWarningV1Schema, { maxItems: 64 }),
  },
  { $id: 'VisualScenePlanV1', additionalProperties: false },
);

export const VisualAssetCatalogEntryV1Schema = Type.Object(
  {
    assetId: GeographyCodeSchema,
    contentHash: GeographyHashSchema,
    license: Type.String({ maxLength: 200, minLength: 1 }),
    maxBytes: Type.Integer({ maximum: 4_194_304, minimum: 1 }),
    provenance: Type.String({ maxLength: 500, minLength: 1 }),
    schemaVersion: Type.Literal(VISUAL_ASSET_CATALOG_SCHEMA_VERSION),
    uriReference: Type.String({
      maxLength: 500,
      minLength: 1,
      pattern: '^asset://worldgraph/[a-z0-9][a-z0-9._/-]*$',
    }),
  },
  { additionalProperties: false },
);

const GeographyCommandCommonFields = {
  commandId: GeographyUuidSchema,
  expectedAggregateVersion: GeographyVersionSchema,
  expectedStateRevision: GeographyVersionSchema,
  expectedTick: GeographyTickSchema,
  expectedWorldVersion: GeographyPositiveVersionSchema,
  idempotencyKey: IdempotencyKeySchema,
  schemaVersion: Type.Literal(GEOGRAPHY_SCHEMA_VERSION),
} as const;

function geographyCommand<TType extends string, TPayload extends TSchema, TMode extends TSchema>(
  type: TType,
  payload: TPayload,
  actorMode: TMode,
) {
  return Type.Object(
    {
      ...GeographyCommandCommonFields,
      actorMode,
      payload,
      type: Type.Literal(type),
    },
    { additionalProperties: false },
  );
}

export const GeographyCreatorModeSchema = Type.Literal('creator');
export const GeographySystemModeSchema = Type.Literal('system');
export const GeographyInWorldModeSchema = Type.Literal('in_world');

export const InitializeWorldGeographyPayloadV1Schema = Type.Object(
  {
    compiledWorldVersionId: GeographyUuidSchema,
    seedPlanHash: GeographyHashSchema,
    sourceArtifactHash: GeographyHashSchema,
  },
  { $id: 'InitializeWorldGeographyPayloadV1', additionalProperties: false },
);
export const InitializeWorldGeographyV1Schema = geographyCommand(
  'InitializeWorldGeographyV1',
  InitializeWorldGeographyPayloadV1Schema,
  GeographyCreatorModeSchema,
);

export const PublishVisualScenePlanPayloadV1Schema = Type.Object(
  {
    expectedGeographyVersion: GeographyPositiveVersionSchema,
    seed: Type.String({ maxLength: 128, minLength: 1, pattern: '^[A-Za-z0-9._:-]+$' }),
    styleKitVersion: Type.Literal(VISUAL_STYLE_KIT_VERSION),
  },
  { $id: 'PublishVisualScenePlanPayloadV1', additionalProperties: false },
);
export const PublishVisualScenePlanV1Schema = geographyCommand(
  'PublishVisualScenePlanV1',
  PublishVisualScenePlanPayloadV1Schema,
  GeographyCreatorModeSchema,
);

export const ResolveSpawnPayloadV1Schema = Type.Object(
  {
    characterEntityKey: GeographyStableKeySchema,
    lastXMilli: Type.Optional(GeographyMilliCoordinateSchema),
    lastYMilli: Type.Optional(GeographyMilliCoordinateSchema),
  },
  { $id: 'ResolveSpawnPayloadV1', additionalProperties: false },
);
export const ResolveSpawnV1Schema = geographyCommand(
  'ResolveSpawnV1',
  ResolveSpawnPayloadV1Schema,
  GeographyInWorldModeSchema,
);

export const PublicGeographyCommandRequestV1Schema = Type.Union(
  [InitializeWorldGeographyV1Schema, PublishVisualScenePlanV1Schema, ResolveSpawnV1Schema],
  { $id: 'PublicGeographyCommandRequestV1' },
);

export const GeographyLayerSchema = Type.Union([
  Type.Literal('territory'),
  Type.Literal('district'),
  Type.Literal('parcel'),
  Type.Literal('road'),
  Type.Literal('building'),
  Type.Literal('poi'),
  Type.Literal('spawn'),
]);

export const GeographyBboxQueryV1Schema = Type.Object(
  {
    layers: Type.Optional(Type.Array(GeographyLayerSchema, { maxItems: 8, minItems: 1 })),
    maxXMilli: GeographyMilliCoordinateSchema,
    maxYMilli: GeographyMilliCoordinateSchema,
    minXMilli: GeographyMilliCoordinateSchema,
    minYMilli: GeographyMilliCoordinateSchema,
    version: Type.Optional(GeographyPositiveVersionSchema),
  },
  { additionalProperties: false },
);

export const GeographyFeatureViewV1Schema = Type.Object(
  {
    entityLogicalKey: Type.Union([GeographyStableKeySchema, Type.Null()]),
    geometryKind: Type.Union([
      Type.Literal('polygon'),
      Type.Literal('linestring'),
      Type.Literal('point'),
    ]),
    layer: GeographyLayerSchema,
    properties: Type.Object(
      {
        archetype: Type.Optional(GeographyCodeSchema),
        class: Type.Optional(GeographyRoadClassSchema),
        parcelType: Type.Optional(GeographyCodeSchema),
        zoning: Type.Optional(GeographyCodeSchema),
      },
      { additionalProperties: false },
    ),
    ringOrPath: Type.Array(GeographyPointMilliV1Schema, { maxItems: 64, minItems: 1 }),
    stableKey: GeographyStableKeySchema,
  },
  { additionalProperties: false },
);

export const GeographySnapshotResponseV1Schema = Type.Object(
  {
    etag: GeographyHashSchema,
    features: Type.Array(GeographyFeatureViewV1Schema, { maxItems: 500 }),
    geographyVersion: GeographyPositiveVersionSchema,
    spatialReference: GeographySpatialReferenceV1Schema,
    stateRevision: GeographyVersionSchema,
  },
  { $id: 'GeographySnapshotResponseV1', additionalProperties: false },
);

export const VisualScenePlanResponseV1Schema = Type.Object(
  {
    checksum: GeographyHashSchema,
    etag: GeographyHashSchema,
    geographyVersion: GeographyPositiveVersionSchema,
    plan: VisualScenePlanV1Schema,
    publishedAtTick: GeographyTickSchema,
    stateRevision: GeographyVersionSchema,
    status: Type.Literal('published'),
  },
  { $id: 'VisualScenePlanResponseV1', additionalProperties: false },
);

export const SpawnPointViewV1Schema = Type.Object(
  {
    accessPolicy: GeographySpawnAccessPolicySchema,
    priority: Type.Integer({ maximum: 1_000, minimum: 0 }),
    radiusMilli: GeographyPositiveMilliSchema,
    stableKey: GeographyStableKeySchema,
    xMilli: GeographyMilliCoordinateSchema,
    yMilli: GeographyMilliCoordinateSchema,
  },
  { additionalProperties: false },
);

export const SpawnPointsResponseV1Schema = Type.Object(
  {
    geographyVersion: GeographyPositiveVersionSchema,
    spawnPoints: Type.Array(SpawnPointViewV1Schema, { maxItems: 32 }),
    stateRevision: GeographyVersionSchema,
  },
  { $id: 'SpawnPointsResponseV1', additionalProperties: false },
);

export const ResolveSpawnResponseV1Schema = Type.Object(
  {
    accessPolicy: GeographySpawnAccessPolicySchema,
    geographyVersion: GeographyPositiveVersionSchema,
    radiusMilli: GeographyPositiveMilliSchema,
    spawnStableKey: GeographyStableKeySchema,
    xMilli: GeographyMilliCoordinateSchema,
    yMilli: GeographyMilliCoordinateSchema,
  },
  { $id: 'ResolveSpawnResponseV1', additionalProperties: false },
);

export const GeographyErrorCodeSchema = Type.Union([
  Type.Literal('GEOMETRY_INVALID'),
  Type.Literal('PLAN_NOT_READY'),
  Type.Literal('VERSION_UNAVAILABLE'),
  Type.Literal('GEOGRAPHY_NOT_INITIALIZED'),
  Type.Literal('GEOGRAPHY_ALREADY_INITIALIZED'),
  Type.Literal('SEED_PLAN_HASH_MISMATCH'),
  Type.Literal('SEED_PLAN_INCOMPATIBLE'),
  Type.Literal('SPAWN_UNAVAILABLE'),
  Type.Literal('SPATIAL_QUERY_BOUNDED'),
  Type.Literal('TOPOLOGY_INVALID'),
]);

export const SpatialEntityResponseV1Schema = Type.Object(
  {
    entityLogicalKey: Type.Union([GeographyStableKeySchema, Type.Null()]),
    etag: GeographyHashSchema,
    feature: GeographyFeatureViewV1Schema,
    geographyVersion: GeographyPositiveVersionSchema,
    stateRevision: GeographyVersionSchema,
  },
  { $id: 'SpatialEntityResponseV1', additionalProperties: false },
);

const GeographyNotificationFields = {
  checksum: GeographyHashSchema,
  cursor: GeographyPositiveVersionSchema,
  geographyVersion: GeographyPositiveVersionSchema,
  schemaVersion: Type.Literal(1),
  stateRevision: GeographyVersionSchema,
  worldId: GeographyUuidSchema,
} as const;

export const GeographyNotificationV1Schema = Type.Union(
  [
    Type.Object(
      {
        ...GeographyNotificationFields,
        type: Type.Literal('geography.version.published'),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...GeographyNotificationFields,
        type: Type.Literal('visual-plan.published'),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: 'GeographyNotificationV1' },
);

/** Durable outbox envelope for geography invalidations (no domain-event FK required). */
export const GeographyInvalidationV1Schema = Type.Object(
  {
    messageType: Type.Literal('GeographyInvalidationV1'),
    notification: GeographyNotificationV1Schema,
  },
  { $id: 'GeographyInvalidationV1', additionalProperties: false },
);

export type GeographySeedPlanV1 = Static<typeof GeographySeedPlanV1Schema>;
export type VisualScenePlanV1 = Static<typeof VisualScenePlanV1Schema>;
export type VisualAssetCatalogEntryV1 = Static<typeof VisualAssetCatalogEntryV1Schema>;
export type InitializeWorldGeographyPayloadV1 = Static<
  typeof InitializeWorldGeographyPayloadV1Schema
>;
export type PublishVisualScenePlanPayloadV1 = Static<typeof PublishVisualScenePlanPayloadV1Schema>;
export type ResolveSpawnPayloadV1 = Static<typeof ResolveSpawnPayloadV1Schema>;
export type PublicGeographyCommandRequestV1 = Static<typeof PublicGeographyCommandRequestV1Schema>;
export type GeographySnapshotResponseV1 = Static<typeof GeographySnapshotResponseV1Schema>;
export type VisualScenePlanResponseV1 = Static<typeof VisualScenePlanResponseV1Schema>;
export type SpawnPointsResponseV1 = Static<typeof SpawnPointsResponseV1Schema>;
export type ResolveSpawnResponseV1 = Static<typeof ResolveSpawnResponseV1Schema>;
export type GeographyBboxQueryV1 = Static<typeof GeographyBboxQueryV1Schema>;
export type GeographyErrorCode = Static<typeof GeographyErrorCodeSchema>;
export type GeographyFeatureViewV1 = Static<typeof GeographyFeatureViewV1Schema>;
export type GeographyPointMilliV1 = Static<typeof GeographyPointMilliV1Schema>;
export type SpatialEntityResponseV1 = Static<typeof SpatialEntityResponseV1Schema>;
export type GeographyNotificationV1 = Static<typeof GeographyNotificationV1Schema>;
export type GeographyInvalidationV1 = Static<typeof GeographyInvalidationV1Schema>;
