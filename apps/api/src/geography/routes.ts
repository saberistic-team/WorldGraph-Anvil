import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';

import {
  COMPILER_VERSION,
  ErrorEnvelopeSchema,
  GeographyBboxQueryV1Schema,
  GeographySnapshotResponseV1Schema,
  ResolveSpawnResponseV1Schema,
  SpatialEntityResponseV1Schema,
  SpawnPointsResponseV1Schema,
  VisualScenePlanResponseV1Schema,
  createValidator,
  type GeographyBboxQueryV1,
  type GeographySeedPlanV1,
} from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';
import type { AuthenticatedActor } from '../identity/service.js';
import { initializeWorldGeography, publishVisualScenePlan } from './initializer.js';
import { GeographyReadService } from './service.js';

const GeographyInitResponseSchema = Type.Object(
  {
    geographyVersion: Type.String({ minLength: 1, maxLength: 19 }),
    seedPlanHash: Type.String({ minLength: 64, maxLength: 64 }),
  },
  { additionalProperties: false },
);

const commonErrors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  429: ErrorEnvelopeSchema,
  500: ErrorEnvelopeSchema,
  503: ErrorEnvelopeSchema,
};

const bboxValidator = createValidator<GeographyBboxQueryV1>(GeographyBboxQueryV1Schema);

export interface GeographyAuthentication {
  authenticate(request: FastifyRequest): Promise<AuthenticatedActor>;
  mutation(request: FastifyRequest): Promise<AuthenticatedActor>;
}

export async function registerGeographyRoutes(
  app: FastifyInstance,
  pool: Pool,
  authentication: GeographyAuthentication,
): Promise<void> {
  const service = new GeographyReadService(pool);
  const read = { rateLimit: { max: 120, timeWindow: '1 minute' } };
  const write = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/v1/worlds/:id/geography',
    {
      config: read,
      schema: {
        response: { 200: GeographySnapshotResponseV1Schema, ...commonErrors },
      },
    },
    async (request) => {
      const actor = await authentication.authenticate(request);
      const raw = {
        maxXMilli: Number(request.query.maxXMilli ?? 50_000),
        maxYMilli: Number(request.query.maxYMilli ?? 50_000),
        minXMilli: Number(request.query.minXMilli ?? -50_000),
        minYMilli: Number(request.query.minYMilli ?? -50_000),
        ...(request.query.version ? { version: request.query.version } : {}),
        ...(request.query.layers
          ? { layers: request.query.layers.split(',').filter(Boolean) }
          : {}),
      };
      if (!bboxValidator.is(raw)) {
        throw new ApplicationError('VALIDATION_FAILED', 'Invalid geography query.', 400);
      }
      return service.snapshot(actor, request.params.id, raw);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/visual-scene-plan',
    {
      config: read,
      schema: { response: { 200: VisualScenePlanResponseV1Schema, ...commonErrors } },
    },
    async (request) =>
      service.scenePlan(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string; entityId: string } }>(
    '/api/v1/worlds/:id/spatial/entities/:entityId',
    {
      config: read,
      schema: { response: { 200: SpatialEntityResponseV1Schema, ...commonErrors } },
    },
    async (request) =>
      service.spatialEntity(
        await authentication.authenticate(request),
        request.params.id,
        decodeURIComponent(request.params.entityId),
      ),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/spawn-points',
    {
      config: read,
      schema: { response: { 200: SpawnPointsResponseV1Schema, ...commonErrors } },
    },
    async (request) =>
      service.spawnPoints(await authentication.authenticate(request), request.params.id),
  );

  app.post<{
    Params: { id: string };
    Body: { lastXMilli?: number; lastYMilli?: number };
  }>(
    '/api/v1/worlds/:id/spawn-points/resolve',
    {
      config: write,
      schema: { response: { 200: ResolveSpawnResponseV1Schema, ...commonErrors } },
    },
    async (request) => {
      const actor = await authentication.mutation(request);
      return service.resolveSpawn(
        actor,
        request.params.id,
        request.body?.lastXMilli,
        request.body?.lastYMilli,
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/geography/initialize',
    {
      config: write,
      schema: { response: { 200: GeographyInitResponseSchema, ...commonErrors } },
    },
    async (request) => {
      const actor = await authentication.mutation(request);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const membership = await client.query(
          `select membership.role::text
             from world_memberships membership
             join worlds world on world.id = membership.world_id
            where membership.world_id = $1::uuid
              and membership.user_id = $2::uuid
              and membership.status = 'active'
              and world.lifecycle = 'active'
              and membership.role = 'creator'`,
          [request.params.id, actor.user.id],
        );
        if (membership.rowCount !== 1) {
          throw new ApplicationError('AUTHORIZATION_DENIED', 'Creator authority required.', 403);
        }
        const artifact = await client.query<{
          content: GeographySeedPlanV1;
          artifact_hash: Buffer;
          world_version_id: string;
          state_revision: string;
        }>(
          `select (artifact.canonical_content -> 'geographySeedPlan') as content,
                  artifact.content_hash as artifact_hash,
                  version.id::text as world_version_id,
                  head.state_revision::text as state_revision
             from world_runtime_heads head
             join world_versions version on version.id = head.active_world_version_id
             join compiled_world_artifacts artifact
               on artifact.id = version.compiled_artifact_id
            where head.world_id = $1::uuid
              and artifact.artifact_schema_version = 5
              and artifact.canonical_content ->> 'compilerVersion' = $2`,
          [request.params.id, COMPILER_VERSION],
        );
        if (artifact.rowCount !== 1 || !artifact.rows[0]!.content) {
          throw new ApplicationError(
            'SEED_PLAN_INCOMPATIBLE',
            'Native geography seed plan is unavailable.',
            409,
          );
        }
        const commandId = randomUUID();
        const eventId = randomUUID();
        const result = await initializeWorldGeography(client, {
          commandId,
          compiledWorldVersionId: artifact.rows[0]!.world_version_id,
          eventId,
          seedPlan: artifact.rows[0]!.content,
          sourceArtifactHash: artifact.rows[0]!.artifact_hash.toString('hex'),
          stateRevision: artifact.rows[0]!.state_revision,
          worldId: request.params.id,
        });
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { seed?: string } }>(
    '/api/v1/worlds/:id/geography/visual-scene-plan',
    {
      config: write,
      schema: { response: { 200: VisualScenePlanResponseV1Schema, ...commonErrors } },
    },
    async (request) => {
      const actor = await authentication.mutation(request);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const membership = await client.query(
          `select membership.role::text
             from world_memberships membership
            where membership.world_id = $1::uuid
              and membership.user_id = $2::uuid
              and membership.status = 'active'
              and membership.role = 'creator'`,
          [request.params.id, actor.user.id],
        );
        if (membership.rowCount !== 1) {
          throw new ApplicationError('AUTHORIZATION_DENIED', 'Creator authority required.', 403);
        }
        const artifact = await client.query<{
          content: GeographySeedPlanV1;
          seed: string;
          state_revision: string;
          tick: string;
        }>(
          `select (artifact.canonical_content -> 'geographySeedPlan') as content,
                  artifact.canonical_content ->> 'seed' as seed,
                  head.state_revision::text as state_revision,
                  coalesce(clock.current_tick::text, '0') as tick
             from world_runtime_heads head
             join world_versions version on version.id = head.active_world_version_id
             join compiled_world_artifacts artifact
               on artifact.id = version.compiled_artifact_id
             left join world_simulation_clocks clock on clock.world_id = head.world_id
            where head.world_id = $1::uuid
              and artifact.artifact_schema_version = 5`,
          [request.params.id],
        );
        if (artifact.rowCount !== 1 || !artifact.rows[0]!.content) {
          throw new ApplicationError(
            'SEED_PLAN_INCOMPATIBLE',
            'Native geography seed plan is unavailable.',
            409,
          );
        }
        const commandId = randomUUID();
        const eventId = randomUUID();
        await publishVisualScenePlan(client, {
          commandId,
          compilerVersion: COMPILER_VERSION,
          eventId,
          seed: request.body?.seed ?? artifact.rows[0]!.seed,
          seedPlan: artifact.rows[0]!.content,
          stateRevision: artifact.rows[0]!.state_revision,
          styleKitVersion: 1,
          tick: artifact.rows[0]!.tick,
          worldId: request.params.id,
        });
        await client.query('commit');
        return new GeographyReadService(pool).scenePlan(actor, request.params.id);
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );
}
