import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  OUTBOX_SCHEMA_VERSION,
  type GeographyNotificationV1,
  type GeographySeedPlanV1,
} from '@worldgraph/contracts';
import {
  assertGeographySeedPlanV1,
  buildVisualScenePlanV1,
  geographySeedPlanHashV1,
} from '@worldgraph/geography';

import { ApplicationError } from '../application/errors.js';
import { ensureGeographyHead } from './service.js';

async function enqueueGeographyInvalidation(
  client: PoolClient,
  input: {
    notification: GeographyNotificationV1;
    outboxId: string;
  },
): Promise<void> {
  await client.query(
    `insert into outbox_messages(
       id, world_id, event_id, message_type, message_schema_version,
       payload, status, attempts, available_at, created_at
     ) values (
       $1::uuid, $2::uuid, null, 'GeographyInvalidationV1', $3,
       $4::jsonb, 'pending', 0, now(), now()
     )`,
    [
      input.outboxId,
      input.notification.worldId,
      OUTBOX_SCHEMA_VERSION,
      JSON.stringify({
        messageType: 'GeographyInvalidationV1',
        notification: input.notification,
      }),
    ],
  );
}

function ringWkt(ring: GeographySeedPlanV1['territory']['ring']): string {
  const body = ring
    .map((point) => `${(point.xMilli / 1000).toFixed(6)} ${(point.yMilli / 1000).toFixed(6)}`)
    .join(',');
  return `POLYGON((${body}))`;
}

function pathWkt(path: GeographySeedPlanV1['roads'][number]['path']): string {
  const body = path
    .map((point) => `${(point.xMilli / 1000).toFixed(6)} ${(point.yMilli / 1000).toFixed(6)}`)
    .join(',');
  return `LINESTRING(${body})`;
}

function pointWkt(xMilli: number, yMilli: number): string {
  return `POINT(${(xMilli / 1000).toFixed(6)} ${(yMilli / 1000).toFixed(6)})`;
}

function buildingFootprintWkt(building: GeographySeedPlanV1['buildings'][number]): string {
  const halfW = building.footprintHalfWidthMilli / 1000;
  const halfD = building.footprintHalfDepthMilli / 1000;
  const x = building.centroidXMilli / 1000;
  const y = building.centroidYMilli / 1000;
  return `POLYGON((${(x - halfW).toFixed(6)} ${(y - halfD).toFixed(6)},${(x + halfW).toFixed(6)} ${(y - halfD).toFixed(6)},${(x + halfW).toFixed(6)} ${(y + halfD).toFixed(6)},${(x - halfW).toFixed(6)} ${(y + halfD).toFixed(6)},${(x - halfW).toFixed(6)} ${(y - halfD).toFixed(6)}))`;
}

export async function initializeWorldGeography(
  client: PoolClient,
  input: {
    commandId: string;
    compiledWorldVersionId: string;
    eventId: string;
    seedPlan: GeographySeedPlanV1;
    sourceArtifactHash: string;
    stateRevision: string;
    worldId: string;
  },
): Promise<{ geographyVersion: string; seedPlanHash: string }> {
  const plan = assertGeographySeedPlanV1(input.seedPlan);
  const seedPlanHash = geographySeedPlanHashV1(plan);
  await ensureGeographyHead(client, input.worldId);
  const head = await client.query<{ geography_version: string; seed_plan_hash: Buffer | null }>(
    `select geography_version::text, seed_plan_hash
       from world_geography_heads
      where world_id = $1::uuid
      for update`,
    [input.worldId],
  );
  if (head.rowCount !== 1) {
    throw new ApplicationError('INTERNAL', 'Geography head missing.', 500);
  }
  if (head.rows[0]!.seed_plan_hash) {
    if (head.rows[0]!.seed_plan_hash.toString('hex') === seedPlanHash) {
      return { geographyVersion: head.rows[0]!.geography_version, seedPlanHash };
    }
    throw new ApplicationError(
      'GEOGRAPHY_ALREADY_INITIALIZED',
      'Geography is already initialized.',
      409,
    );
  }

  const geographyVersion = '1';
  const territoryId = randomUUID();
  const districtIds = new Map<string, string>();
  const parcelIds = new Map<string, string>();

  await client.query(
    `insert into spatial_reference_systems (
       world_id, units, origin_x_milli, origin_y_milli, bounds_min_x_milli, bounds_min_y_milli,
       bounds_max_x_milli, bounds_max_y_milli, srid, geography_version, seed_plan_hash,
       source_artifact_hash, compiled_world_version_id, created_command_id, created_event_id,
       created_state_revision
     ) values (
       $1::uuid, 'meters', $2, $3, $4, $5, $6, $7, 3857, 1, decode($8,'hex'), decode($9,'hex'),
       $10::uuid, $11::uuid, $12::uuid, $13::bigint
     )`,
    [
      input.worldId,
      plan.spatialReference.originXMilli,
      plan.spatialReference.originYMilli,
      plan.spatialReference.boundsMinXMilli,
      plan.spatialReference.boundsMinYMilli,
      plan.spatialReference.boundsMaxXMilli,
      plan.spatialReference.boundsMaxYMilli,
      seedPlanHash,
      input.sourceArtifactHash,
      input.compiledWorldVersionId,
      input.commandId,
      input.eventId,
      input.stateRevision,
    ],
  );

  await client.query(
    `insert into territories (
       id, world_id, stable_key, geom, geography_version, created_command_id
     ) values (
       $1::uuid, $2::uuid, $3,
       extensions.ST_Multi(extensions.ST_SetSRID(extensions.ST_GeomFromText($4), 3857)),
       1, $5::uuid
     )`,
    [
      territoryId,
      input.worldId,
      plan.territory.stableKey,
      ringWkt(plan.territory.ring),
      input.commandId,
    ],
  );

  for (const district of plan.districts) {
    const id = randomUUID();
    districtIds.set(district.stableKey, id);
    await client.query(
      `insert into districts (
         id, world_id, territory_id, stable_key, entity_logical_key, zoning, geom,
         geography_version, created_command_id
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4, $4, $5,
         extensions.ST_SetSRID(extensions.ST_GeomFromText($6), 3857),
         1, $7::uuid
       )`,
      [
        id,
        input.worldId,
        territoryId,
        district.stableKey,
        district.zoning,
        ringWkt(district.ring),
        input.commandId,
      ],
    );
  }

  for (const parcel of plan.parcels) {
    const id = randomUUID();
    parcelIds.set(parcel.stableKey, id);
    await client.query(
      `insert into parcels (
         id, world_id, district_id, stable_key, parcel_type, geom, geography_version,
         created_command_id
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         extensions.ST_SetSRID(extensions.ST_GeomFromText($6), 3857),
         1, $7::uuid
       )`,
      [
        id,
        input.worldId,
        districtIds.get(parcel.districtKey),
        parcel.stableKey,
        parcel.parcelType,
        ringWkt(parcel.ring),
        input.commandId,
      ],
    );
  }

  for (const road of plan.roads) {
    await client.query(
      `insert into roads (
         id, world_id, stable_key, road_class, width_milli, from_district_id, to_district_id,
         geom, geography_version, created_command_id
       ) values (
         $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid,
         extensions.ST_SetSRID(extensions.ST_GeomFromText($8), 3857),
         1, $9::uuid
       )`,
      [
        randomUUID(),
        input.worldId,
        road.stableKey,
        road.class,
        road.widthMilli,
        districtIds.get(road.fromDistrictKey),
        districtIds.get(road.toDistrictKey),
        pathWkt(road.path),
        input.commandId,
      ],
    );
  }

  for (const building of plan.buildings) {
    await client.query(
      `insert into building_placements (
         id, world_id, parcel_id, stable_key, entity_logical_key, archetype, centroid, footprint,
         elevation_milli, yaw_milli_degrees, geography_version, created_command_id
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
         extensions.ST_SetSRID(extensions.ST_GeomFromText($7), 3857),
         extensions.ST_SetSRID(extensions.ST_GeomFromText($8), 3857),
         $9, $10, 1, $11::uuid
       )`,
      [
        randomUUID(),
        input.worldId,
        parcelIds.get(building.parcelKey),
        building.stableKey,
        building.entityLogicalKey,
        building.archetype,
        pointWkt(building.centroidXMilli, building.centroidYMilli),
        buildingFootprintWkt(building),
        building.elevationMilli,
        building.yawMilliDegrees,
        input.commandId,
      ],
    );
  }

  for (const poi of plan.pointsOfInterest) {
    await client.query(
      `insert into points_of_interest (
         id, world_id, stable_key, entity_logical_key, kind, location, radius_milli,
         geography_version, created_command_id
       ) values (
         $1::uuid, $2::uuid, $3, $4, $5,
         extensions.ST_SetSRID(extensions.ST_GeomFromText($6), 3857),
         $7, 1, $8::uuid
       )`,
      [
        randomUUID(),
        input.worldId,
        poi.stableKey,
        poi.entityLogicalKey,
        poi.kind,
        pointWkt(poi.xMilli, poi.yMilli),
        poi.radiusMilli,
        input.commandId,
      ],
    );
  }

  for (const spawn of plan.spawnPoints) {
    await client.query(
      `insert into spawn_points (
         id, world_id, stable_key, location, radius_milli, priority, access_policy, active,
         geography_version, created_command_id
       ) values (
         $1::uuid, $2::uuid, $3,
         extensions.ST_SetSRID(extensions.ST_GeomFromText($4), 3857),
         $5, $6, $7, true, 1, $8::uuid
       )`,
      [
        randomUUID(),
        input.worldId,
        spawn.stableKey,
        pointWkt(spawn.xMilli, spawn.yMilli),
        spawn.radiusMilli,
        spawn.priority,
        spawn.accessPolicy,
        input.commandId,
      ],
    );
  }

  await client.query(
    `update world_geography_heads
        set geography_version = 1,
            geography_state_revision = $2::bigint,
            seed_plan_hash = decode($3,'hex'),
            initialized_at = now(),
            updated_at = now()
      where world_id = $1::uuid`,
    [input.worldId, input.stateRevision, seedPlanHash],
  );

  await enqueueGeographyInvalidation(client, {
    notification: {
      checksum: seedPlanHash,
      cursor: geographyVersion,
      geographyVersion,
      schemaVersion: 1,
      stateRevision: input.stateRevision,
      type: 'geography.version.published',
      worldId: input.worldId,
    },
    outboxId: randomUUID(),
  });

  return { geographyVersion, seedPlanHash };
}

export async function publishVisualScenePlan(
  client: PoolClient,
  input: {
    commandId: string;
    compilerVersion: string;
    eventId: string;
    seed: string;
    seedPlan: GeographySeedPlanV1;
    stateRevision: string;
    styleKitVersion: 1;
    tick: string;
    worldId: string;
  },
): Promise<{ checksum: string; planId: string }> {
  const head = await client.query<{
    geography_version: string;
    seed_plan_hash: Buffer | null;
    active_scene_plan_id: string | null;
  }>(
    `select geography_version::text, seed_plan_hash, active_scene_plan_id::text
       from world_geography_heads
      where world_id = $1::uuid
      for update`,
    [input.worldId],
  );
  if (head.rowCount !== 1 || !head.rows[0]!.seed_plan_hash) {
    throw new ApplicationError('GEOGRAPHY_NOT_INITIALIZED', 'Geography is not initialized.', 409);
  }
  const built = buildVisualScenePlanV1(input.seedPlan, {
    seed: input.seed,
    styleKitVersion: input.styleKitVersion,
  });
  if (head.rows[0]!.active_scene_plan_id) {
    const existing = await client.query<{ checksum: Buffer }>(
      `select checksum from visual_scene_plans where id = $1::uuid`,
      [head.rows[0]!.active_scene_plan_id],
    );
    if (existing.rowCount === 1 && existing.rows[0]!.checksum.toString('hex') === built.hash) {
      return { checksum: built.hash, planId: head.rows[0]!.active_scene_plan_id };
    }
  }
  const planId = randomUUID();
  await client.query(
    `insert into visual_scene_plans (
       id, world_id, geography_version, style_kit_version, compiler_version, seed,
       canonical_json, checksum, status, warnings, provenance, published_tick,
       created_command_id, created_event_id, created_state_revision
     ) values (
       $1::uuid, $2::uuid, $3::bigint, $4, $5, $6, $7::jsonb, decode($8,'hex'), 'published',
       $9::jsonb, $10::jsonb, $11::bigint, $12::uuid, $13::uuid, $14::bigint
     )
     on conflict (world_id, geography_version, style_kit_version, compiler_version, seed)
     do nothing`,
    [
      planId,
      input.worldId,
      head.rows[0]!.geography_version,
      input.styleKitVersion,
      input.compilerVersion,
      input.seed,
      JSON.stringify(built.plan),
      built.hash,
      JSON.stringify(built.plan.warnings),
      JSON.stringify({
        seedPlanHash: head.rows[0]!.seed_plan_hash.toString('hex'),
        styleKitVersion: input.styleKitVersion,
      }),
      input.tick,
      input.commandId,
      input.eventId,
      input.stateRevision,
    ],
  );
  const stored = await client.query<{ id: string; checksum: Buffer }>(
    `select id::text, checksum
       from visual_scene_plans
      where world_id = $1::uuid
        and geography_version = $2::bigint
        and style_kit_version = $3
        and compiler_version = $4
        and seed = $5`,
    [
      input.worldId,
      head.rows[0]!.geography_version,
      input.styleKitVersion,
      input.compilerVersion,
      input.seed,
    ],
  );
  if (stored.rowCount !== 1) {
    throw new ApplicationError('INTERNAL', 'Failed to publish visual scene plan.', 500);
  }
  await client.query(
    `update world_geography_heads
        set active_scene_plan_id = $2::uuid,
            active_scene_plan_checksum = $3,
            geography_state_revision = $4::bigint,
            updated_at = now()
      where world_id = $1::uuid`,
    [input.worldId, stored.rows[0]!.id, stored.rows[0]!.checksum, input.stateRevision],
  );
  const checksum = stored.rows[0]!.checksum.toString('hex');
  await enqueueGeographyInvalidation(client, {
    notification: {
      checksum,
      cursor: head.rows[0]!.geography_version,
      geographyVersion: head.rows[0]!.geography_version,
      schemaVersion: 1,
      stateRevision: input.stateRevision,
      type: 'visual-plan.published',
      worldId: input.worldId,
    },
    outboxId: randomUUID(),
  });
  return { checksum, planId: stored.rows[0]!.id };
}
