import type { Pool, PoolClient } from 'pg';

import {
  GeographySnapshotResponseV1Schema,
  SpatialEntityResponseV1Schema,
  SpawnPointsResponseV1Schema,
  VisualScenePlanResponseV1Schema,
  createValidator,
  type GeographyBboxQueryV1,
  type GeographyFeatureViewV1,
  type GeographySnapshotResponseV1,
  type ResolveSpawnResponseV1,
  type SpatialEntityResponseV1,
  type SpawnPointsResponseV1,
  type VisualScenePlanResponseV1,
  type VisualScenePlanV1,
} from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';
import type { AuthenticatedActor } from '../identity/service.js';

const snapshotValidator = createValidator<GeographySnapshotResponseV1>(
  GeographySnapshotResponseV1Schema,
);
const sceneValidator = createValidator<VisualScenePlanResponseV1>(VisualScenePlanResponseV1Schema);
const spawnValidator = createValidator<SpawnPointsResponseV1>(SpawnPointsResponseV1Schema);
const spatialValidator = createValidator<SpatialEntityResponseV1>(SpatialEntityResponseV1Schema);

async function requireMember(
  pool: Pool,
  actor: AuthenticatedActor,
  worldId: string,
): Promise<void> {
  const result = await pool.query(
    `select 1
       from world_memberships membership
       join worlds world on world.id = membership.world_id
      where membership.world_id = $1::uuid
        and membership.user_id = $2::uuid
        and membership.status = 'active'
        and world.archived_at is null
      limit 1`,
    [worldId, actor.user.id],
  );
  if (result.rowCount !== 1) {
    throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
  }
}

function milliToMeters(value: number): number {
  return value / 1000;
}

export class GeographyReadService {
  constructor(private readonly pool: Pool) {}

  async snapshot(
    actor: AuthenticatedActor,
    worldId: string,
    query: GeographyBboxQueryV1,
  ): Promise<GeographySnapshotResponseV1> {
    await requireMember(this.pool, actor, worldId);
    const head = await this.pool.query<{
      geography_version: string;
      geography_state_revision: string;
      seed_plan_hash: Buffer | null;
    }>(
      `select geography_version::text, geography_state_revision::text, seed_plan_hash
         from world_geography_heads where world_id = $1::uuid`,
      [worldId],
    );
    if (head.rowCount !== 1 || !head.rows[0]!.seed_plan_hash) {
      throw new ApplicationError('PLAN_NOT_READY', 'Geography is not initialized.', 404);
    }
    if (query.version && query.version !== head.rows[0]!.geography_version) {
      throw new ApplicationError('VERSION_UNAVAILABLE', 'Geography version unavailable.', 409);
    }
    const reference = await this.pool.query<{
      bounds_max_x_milli: string;
      bounds_max_y_milli: string;
      bounds_min_x_milli: string;
      bounds_min_y_milli: string;
      origin_x_milli: string;
      origin_y_milli: string;
    }>(
      `select bounds_max_x_milli::text, bounds_max_y_milli::text, bounds_min_x_milli::text,
              bounds_min_y_milli::text, origin_x_milli::text, origin_y_milli::text
         from spatial_reference_systems where world_id = $1::uuid`,
      [worldId],
    );
    if (reference.rowCount !== 1) {
      throw new ApplicationError('PLAN_NOT_READY', 'Geography is not initialized.', 404);
    }
    const layers = new Set(
      query.layers ?? ['territory', 'district', 'parcel', 'road', 'building', 'poi', 'spawn'],
    );
    const features: GeographySnapshotResponseV1['features'] = [];
    const bounds = [
      milliToMeters(query.minXMilli),
      milliToMeters(query.minYMilli),
      milliToMeters(query.maxXMilli),
      milliToMeters(query.maxYMilli),
    ];

    if (layers.has('district')) {
      const districtRows = await this.pool.query<{
        stable_key: string;
        entity_logical_key: string | null;
        zoning: string;
        coords: number[][];
      }>(
        `select stable_key, entity_logical_key, zoning,
                (
                  select coalesce(jsonb_agg(jsonb_build_array(
                    round(extensions.ST_X((dp).geom)::numeric * 1000),
                    round(extensions.ST_Y((dp).geom)::numeric * 1000)
                  ) order by (dp).path), '[]'::jsonb)
                  from extensions.ST_DumpPoints(extensions.ST_ExteriorRing(geom)) as dp
                ) as coords
           from districts
          where world_id = $1::uuid
            and geom OPERATOR(extensions.&&) extensions.ST_MakeEnvelope($2::float8,$3::float8,$4::float8,$5::float8,3857)
          order by stable_key
          limit 200`,
        [worldId, ...bounds],
      );
      for (const row of districtRows.rows) {
        features.push({
          entityLogicalKey: row.entity_logical_key,
          geometryKind: 'polygon',
          layer: 'district',
          properties: { zoning: row.zoning },
          ringOrPath: row.coords.map(([xMilli, yMilli]) => ({
            xMilli: Number(xMilli),
            yMilli: Number(yMilli),
          })),
          stableKey: row.stable_key,
        });
      }
    }

    if (layers.has('building')) {
      const buildingRows = await this.pool.query<{
        stable_key: string;
        entity_logical_key: string;
        archetype: string;
        x_milli: string;
        y_milli: string;
      }>(
        `select stable_key, entity_logical_key, archetype,
                round(extensions.ST_X(centroid)::numeric * 1000)::text as x_milli,
                round(extensions.ST_Y(centroid)::numeric * 1000)::text as y_milli
           from building_placements
          where world_id = $1::uuid
            and centroid OPERATOR(extensions.&&) extensions.ST_MakeEnvelope($2::float8,$3::float8,$4::float8,$5::float8,3857)
          order by stable_key
          limit 200`,
        [worldId, ...bounds],
      );
      for (const row of buildingRows.rows) {
        features.push({
          entityLogicalKey: row.entity_logical_key,
          geometryKind: 'point',
          layer: 'building',
          properties: { archetype: row.archetype },
          ringOrPath: [{ xMilli: Number(row.x_milli), yMilli: Number(row.y_milli) }],
          stableKey: row.stable_key,
        });
      }
    }

    if (layers.has('spawn')) {
      const spawnRows = await this.pool.query<{
        stable_key: string;
        x_milli: string;
        y_milli: string;
      }>(
        `select stable_key,
                round(extensions.ST_X(location)::numeric * 1000)::text as x_milli,
                round(extensions.ST_Y(location)::numeric * 1000)::text as y_milli
           from spawn_points
          where world_id = $1::uuid
            and active
            and location OPERATOR(extensions.&&) extensions.ST_MakeEnvelope($2::float8,$3::float8,$4::float8,$5::float8,3857)
          order by priority desc, stable_key
          limit 32`,
        [worldId, ...bounds],
      );
      for (const row of spawnRows.rows) {
        features.push({
          entityLogicalKey: null,
          geometryKind: 'point',
          layer: 'spawn',
          properties: {},
          ringOrPath: [{ xMilli: Number(row.x_milli), yMilli: Number(row.y_milli) }],
          stableKey: row.stable_key,
        });
      }
    }

    if (layers.has('road')) {
      const roadRows = await this.pool.query<{
        stable_key: string;
        road_class: 'path' | 'primary' | 'secondary';
        coords: number[][];
      }>(
        `select stable_key, road_class,
                (
                  select coalesce(jsonb_agg(jsonb_build_array(
                    round(extensions.ST_X((dp).geom)::numeric * 1000),
                    round(extensions.ST_Y((dp).geom)::numeric * 1000)
                  ) order by (dp).path), '[]'::jsonb)
                  from extensions.ST_DumpPoints(geom) as dp
                ) as coords
           from roads
          where world_id = $1::uuid
            and geom OPERATOR(extensions.&&) extensions.ST_MakeEnvelope($2::float8,$3::float8,$4::float8,$5::float8,3857)
          order by stable_key
          limit 100`,
        [worldId, ...bounds],
      );
      for (const row of roadRows.rows) {
        features.push({
          entityLogicalKey: null,
          geometryKind: 'linestring',
          layer: 'road',
          properties: { class: row.road_class },
          ringOrPath: row.coords.map(([xMilli, yMilli]) => ({
            xMilli: Number(xMilli),
            yMilli: Number(yMilli),
          })),
          stableKey: row.stable_key,
        });
      }
    }

    if (layers.has('poi')) {
      const poiRows = await this.pool.query<{
        stable_key: string;
        entity_logical_key: string | null;
        kind: string;
        x_milli: string;
        y_milli: string;
      }>(
        `select stable_key, entity_logical_key, kind,
                round(extensions.ST_X(location)::numeric * 1000)::text as x_milli,
                round(extensions.ST_Y(location)::numeric * 1000)::text as y_milli
           from points_of_interest
          where world_id = $1::uuid
            and location OPERATOR(extensions.&&) extensions.ST_MakeEnvelope($2::float8,$3::float8,$4::float8,$5::float8,3857)
          order by stable_key
          limit 100`,
        [worldId, ...bounds],
      );
      for (const row of poiRows.rows) {
        features.push({
          entityLogicalKey: row.entity_logical_key,
          geometryKind: 'point',
          layer: 'poi',
          properties: { archetype: row.kind },
          ringOrPath: [{ xMilli: Number(row.x_milli), yMilli: Number(row.y_milli) }],
          stableKey: row.stable_key,
        });
      }
    }

    const ref = reference.rows[0]!;
    const response: GeographySnapshotResponseV1 = {
      etag: head.rows[0]!.seed_plan_hash.toString('hex'),
      features: features.slice(0, 500),
      geographyVersion: head.rows[0]!.geography_version,
      spatialReference: {
        boundsMaxXMilli: Number(ref.bounds_max_x_milli),
        boundsMaxYMilli: Number(ref.bounds_max_y_milli),
        boundsMinXMilli: Number(ref.bounds_min_x_milli),
        boundsMinYMilli: Number(ref.bounds_min_y_milli),
        originXMilli: Number(ref.origin_x_milli),
        originYMilli: Number(ref.origin_y_milli),
        srid: 3857,
        units: 'meters',
      },
      stateRevision: head.rows[0]!.geography_state_revision,
    };
    if (!snapshotValidator.is(response)) {
      throw new ApplicationError('INTERNAL', 'Geography snapshot failed validation.', 500);
    }
    return response;
  }

  async scenePlan(actor: AuthenticatedActor, worldId: string): Promise<VisualScenePlanResponseV1> {
    await requireMember(this.pool, actor, worldId);
    const row = await this.pool.query<{
      checksum: Buffer;
      canonical_json: VisualScenePlanV1;
      geography_version: string;
      published_tick: string;
      geography_state_revision: string;
    }>(
      `select plan.checksum, plan.canonical_json, plan.geography_version::text,
              plan.published_tick::text, head.geography_state_revision::text
         from world_geography_heads head
         join visual_scene_plans plan
           on plan.world_id = head.world_id
          and plan.id = head.active_scene_plan_id
        where head.world_id = $1::uuid`,
      [worldId],
    );
    if (row.rowCount !== 1) {
      throw new ApplicationError('PLAN_NOT_READY', 'Visual scene plan is not published.', 404);
    }
    const current = row.rows[0]!;
    const response: VisualScenePlanResponseV1 = {
      checksum: current.checksum.toString('hex'),
      etag: current.checksum.toString('hex'),
      geographyVersion: current.geography_version,
      plan: current.canonical_json,
      publishedAtTick: current.published_tick,
      stateRevision: current.geography_state_revision,
      status: 'published',
    };
    if (!sceneValidator.is(response)) {
      throw new ApplicationError('INTERNAL', 'Scene plan response failed validation.', 500);
    }
    return response;
  }

  async spawnPoints(actor: AuthenticatedActor, worldId: string): Promise<SpawnPointsResponseV1> {
    await requireMember(this.pool, actor, worldId);
    const head = await this.pool.query<{
      geography_version: string;
      geography_state_revision: string;
      seed_plan_hash: Buffer | null;
    }>(
      `select geography_version::text, geography_state_revision::text, seed_plan_hash
         from world_geography_heads where world_id = $1::uuid`,
      [worldId],
    );
    if (head.rowCount !== 1 || !head.rows[0]!.seed_plan_hash) {
      throw new ApplicationError('PLAN_NOT_READY', 'Geography is not initialized.', 404);
    }
    const rows = await this.pool.query<{
      access_policy: 'public' | 'member';
      priority: number;
      radius_milli: string;
      stable_key: string;
      x_milli: string;
      y_milli: string;
    }>(
      `select access_policy, priority, radius_milli::text, stable_key,
              round(extensions.ST_X(location)::numeric * 1000)::text as x_milli,
              round(extensions.ST_Y(location)::numeric * 1000)::text as y_milli
         from spawn_points
        where world_id = $1::uuid and active
        order by priority desc, stable_key
        limit 32`,
      [worldId],
    );
    const response: SpawnPointsResponseV1 = {
      geographyVersion: head.rows[0]!.geography_version,
      spawnPoints: rows.rows.map((row) => ({
        accessPolicy: row.access_policy,
        priority: row.priority,
        radiusMilli: Number(row.radius_milli),
        stableKey: row.stable_key,
        xMilli: Number(row.x_milli),
        yMilli: Number(row.y_milli),
      })),
      stateRevision: head.rows[0]!.geography_state_revision,
    };
    if (!spawnValidator.is(response)) {
      throw new ApplicationError('INTERNAL', 'Spawn points response failed validation.', 500);
    }
    return response;
  }

  async spatialEntity(
    actor: AuthenticatedActor,
    worldId: string,
    entityId: string,
  ): Promise<SpatialEntityResponseV1> {
    await requireMember(this.pool, actor, worldId);
    const head = await this.pool.query<{
      geography_version: string;
      geography_state_revision: string;
      seed_plan_hash: Buffer | null;
    }>(
      `select geography_version::text, geography_state_revision::text, seed_plan_hash
         from world_geography_heads where world_id = $1::uuid`,
      [worldId],
    );
    if (head.rowCount !== 1 || !head.rows[0]!.seed_plan_hash) {
      throw new ApplicationError('PLAN_NOT_READY', 'Geography is not initialized.', 404);
    }
    const building = await this.pool.query<{
      stable_key: string;
      entity_logical_key: string;
      archetype: string;
      x_milli: string;
      y_milli: string;
    }>(
      `select stable_key, entity_logical_key, archetype,
              round(extensions.ST_X(centroid)::numeric * 1000)::text as x_milli,
              round(extensions.ST_Y(centroid)::numeric * 1000)::text as y_milli
         from building_placements
        where world_id = $1::uuid
          and (entity_logical_key = $2 or stable_key = $2)
        order by stable_key
        limit 1`,
      [worldId, entityId],
    );
    let feature: GeographyFeatureViewV1 | null = null;
    if (building.rowCount === 1) {
      const row = building.rows[0]!;
      feature = {
        entityLogicalKey: row.entity_logical_key,
        geometryKind: 'point',
        layer: 'building',
        properties: { archetype: row.archetype },
        ringOrPath: [{ xMilli: Number(row.x_milli), yMilli: Number(row.y_milli) }],
        stableKey: row.stable_key,
      };
    } else {
      const district = await this.pool.query<{
        stable_key: string;
        entity_logical_key: string | null;
        zoning: string;
        coords: number[][];
      }>(
        `select stable_key, entity_logical_key, zoning,
                (
                  select coalesce(jsonb_agg(jsonb_build_array(
                    round(extensions.ST_X((dp).geom)::numeric * 1000),
                    round(extensions.ST_Y((dp).geom)::numeric * 1000)
                  ) order by (dp).path), '[]'::jsonb)
                  from extensions.ST_DumpPoints(extensions.ST_ExteriorRing(geom)) as dp
                ) as coords
           from districts
          where world_id = $1::uuid
            and (entity_logical_key = $2 or stable_key = $2)
          order by stable_key
          limit 1`,
        [worldId, entityId],
      );
      if (district.rowCount === 1) {
        const row = district.rows[0]!;
        feature = {
          entityLogicalKey: row.entity_logical_key,
          geometryKind: 'polygon',
          layer: 'district',
          properties: { zoning: row.zoning },
          ringOrPath: row.coords.map(([xMilli, yMilli]) => ({
            xMilli: Number(xMilli),
            yMilli: Number(yMilli),
          })),
          stableKey: row.stable_key,
        };
      }
    }
    if (!feature) {
      throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
    }
    const response: SpatialEntityResponseV1 = {
      entityLogicalKey: feature.entityLogicalKey,
      etag: head.rows[0]!.seed_plan_hash.toString('hex'),
      feature,
      geographyVersion: head.rows[0]!.geography_version,
      stateRevision: head.rows[0]!.geography_state_revision,
    };
    if (!spatialValidator.is(response)) {
      throw new ApplicationError('INTERNAL', 'Spatial entity response failed validation.', 500);
    }
    return response;
  }

  async resolveSpawn(
    actor: AuthenticatedActor,
    worldId: string,
    lastXMilli?: number,
    lastYMilli?: number,
  ): Promise<ResolveSpawnResponseV1> {
    const points = await this.spawnPoints(actor, worldId);
    const publicPoints = points.spawnPoints.filter((point) => point.accessPolicy === 'public');
    if (publicPoints.length < 1) {
      throw new ApplicationError('SPAWN_UNAVAILABLE', 'No public spawn is available.', 409);
    }
    let selected = publicPoints[0]!;
    if (lastXMilli !== undefined && lastYMilli !== undefined) {
      selected = [...publicPoints].sort((left, right) => {
        const leftDistance = (left.xMilli - lastXMilli) ** 2 + (left.yMilli - lastYMilli) ** 2;
        const rightDistance = (right.xMilli - lastXMilli) ** 2 + (right.yMilli - lastYMilli) ** 2;
        return leftDistance - rightDistance || left.stableKey.localeCompare(right.stableKey);
      })[0]!;
    }
    return {
      accessPolicy: selected.accessPolicy,
      geographyVersion: points.geographyVersion,
      radiusMilli: selected.radiusMilli,
      spawnStableKey: selected.stableKey,
      xMilli: selected.xMilli,
      yMilli: selected.yMilli,
    };
  }
}

export async function ensureGeographyHead(client: PoolClient, worldId: string): Promise<void> {
  await client.query(
    `insert into world_geography_heads (world_id)
     values ($1::uuid)
     on conflict (world_id) do nothing`,
    [worldId],
  );
}
