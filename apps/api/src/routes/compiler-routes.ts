import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  CancelWorldCompilationRequestSchema,
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  CompiledArtifactV1Schema,
  CompiledArtifactV2Schema,
  CompiledArtifactV3Schema,
  CompilerDiagnosticV1Schema,
  ErrorEnvelopeSchema,
  IdempotencyKeySchema,
  RetryWorldCompilationRequestSchema,
  RuntimeSummaryViewSchema,
  StartWorldCompilationRequestSchema,
  StartWorldCompilationResponseSchema,
  WorldCompilationRunViewSchema,
  WorldEntityDetailResponseSchema,
  WorldEntityListQuerySchema,
  WorldEntityListResponseSchema,
  WorldLogicalKeySchema,
  WorldNeighborQuerySchema,
  WorldNeighborResponseSchema,
  WorldRelationshipListQuerySchema,
  WorldRelationshipListResponseSchema,
  type CancelWorldCompilationRequest,
  type RetryWorldCompilationRequest,
  type StartWorldCompilationRequest,
  type WorldEntityListQuery,
  type WorldNeighborQuery,
  type WorldRelationshipListQuery,
} from '@worldgraph/contracts';

import type { CompilationService } from '../compilation/service.js';
import type { AuthenticatedActor } from '../identity/service.js';
import type { ManifestCommandContext } from '../manifests/service.js';

const WorldParams = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

function inlineSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => inlineSchema(item));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value) as Array<[string, unknown]>;
    return Object.fromEntries(
      entries.filter(([key]) => key !== '$id').map(([key, item]) => [key, inlineSchema(item)]),
    );
  }
  return value;
}

// The exact artifact variants share named nested schemas. Inline copies
// avoid duplicate JSON Schema identifiers in Fastify's response serializer.
const CompiledArtifactOpaqueResponseSchema = (
  artifactSchemaVersion: typeof COMPILED_ARTIFACT_SCHEMA_VERSION | 4,
) =>
  Type.Object(
    {
      artifactKind: Type.Literal('compiled_world'),
      artifactSchemaVersion: Type.Literal(artifactSchemaVersion),
      canonicalBytes: Type.String({ maxLength: 4_194_304, minLength: 2 }),
      contentHash: Type.String({ maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$' }),
      inputHash: Type.String({ maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$' }),
      // The service verifies the exact contract before returning it. Keeping the
      // already-verified world opaque here avoids Fastify losing the local $defs
      // scope used by the bounded recursive governance-policy schema.
      world: Type.Any(),
    },
    { additionalProperties: false },
  );
const CompiledArtifactResponseSchema = Type.Union([
  CompiledArtifactOpaqueResponseSchema(COMPILED_ARTIFACT_SCHEMA_VERSION),
  CompiledArtifactOpaqueResponseSchema(4),
  inlineSchema(CompiledArtifactV3Schema) as typeof CompiledArtifactV3Schema,
  inlineSchema(CompiledArtifactV2Schema) as typeof CompiledArtifactV2Schema,
  inlineSchema(CompiledArtifactV1Schema) as typeof CompiledArtifactV1Schema,
]);
const RunParams = Type.Object(
  { id: Type.String({ format: 'uuid' }), runId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const EntityParams = Type.Object(
  { id: Type.String({ format: 'uuid' }), logicalKey: WorldLogicalKeySchema },
  { additionalProperties: false },
);
const MutationHeaders = Type.Object(
  {
    'idempotency-key': IdempotencyKeySchema,
    'x-csrf-token': Type.Optional(Type.String({ maxLength: 128, minLength: 32 })),
  },
  { additionalProperties: true },
);
const commonErrors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  422: ErrorEnvelopeSchema,
  429: ErrorEnvelopeSchema,
  500: ErrorEnvelopeSchema,
  503: ErrorEnvelopeSchema,
};
const CompilationDiagnosticsResponseSchema = Type.Object(
  {
    diagnostics: Type.Array(CompilerDiagnosticV1Schema, { maxItems: 128 }),
    inputHash: Type.String({ maxLength: 64, minLength: 64, pattern: '^[a-f0-9]{64}$' }),
    runId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

export interface CompilerRouteAuthentication {
  authenticate(request: FastifyRequest): Promise<AuthenticatedActor>;
  command(request: FastifyRequest): ManifestCommandContext;
  mutation(request: FastifyRequest): Promise<AuthenticatedActor>;
}

export async function registerCompilerRoutes(
  app: FastifyInstance,
  service: CompilationService,
  authentication: CompilerRouteAuthentication,
): Promise<void> {
  app.post<{ Body: StartWorldCompilationRequest; Params: { id: string } }>(
    '/api/v1/worlds/:id/compilations',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: StartWorldCompilationRequestSchema,
        headers: MutationHeaders,
        params: WorldParams,
        response: { 202: StartWorldCompilationResponseSchema, ...commonErrors },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await service.start(
            await authentication.mutation(request),
            request.params.id,
            request.body,
            authentication.command(request),
          ),
        ),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/compilations/current',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorldParams,
        response: { 200: WorldCompilationRunViewSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.current(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string; runId: string } }>(
    '/api/v1/worlds/:id/compilations/:runId',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: RunParams,
        response: { 200: WorldCompilationRunViewSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.get(
        await authentication.authenticate(request),
        request.params.id,
        request.params.runId,
      ),
  );

  app.get<{ Params: { id: string; runId: string } }>(
    '/api/v1/worlds/:id/compilations/:runId/diagnostics',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: RunParams,
        response: { 200: CompilationDiagnosticsResponseSchema, ...commonErrors },
      },
    },
    async (request) => {
      const run = await service.get(
        await authentication.authenticate(request),
        request.params.id,
        request.params.runId,
      );
      return { diagnostics: run.diagnostics, inputHash: run.inputHash, runId: run.id };
    },
  );

  app.get<{ Params: { id: string; runId: string } }>(
    '/api/v1/worlds/:id/compilations/:runId/artifact',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        params: RunParams,
        response: { 200: CompiledArtifactResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.artifact(
        await authentication.authenticate(request),
        request.params.id,
        request.params.runId,
      ),
  );

  app.post<{
    Body: CancelWorldCompilationRequest;
    Params: { id: string; runId: string };
  }>(
    '/api/v1/worlds/:id/compilations/:runId/cancel',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: CancelWorldCompilationRequestSchema,
        headers: MutationHeaders,
        params: RunParams,
        response: { 200: WorldCompilationRunViewSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.cancel(
        await authentication.mutation(request),
        request.params.id,
        request.params.runId,
        request.body.expectedRowVersion,
        authentication.command(request),
      ),
  );

  app.post<{
    Body: RetryWorldCompilationRequest;
    Params: { id: string; runId: string };
  }>(
    '/api/v1/worlds/:id/compilations/:runId/retry',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: RetryWorldCompilationRequestSchema,
        headers: MutationHeaders,
        params: RunParams,
        response: { 202: StartWorldCompilationResponseSchema, ...commonErrors },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await service.retry(
            await authentication.mutation(request),
            request.params.id,
            request.params.runId,
            request.body.expectedRowVersion,
            authentication.command(request),
          ),
        ),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/worlds/:id/runtime-summary',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorldParams,
        response: { 200: RuntimeSummaryViewSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.runtimeSummary(await authentication.authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: WorldEntityListQuery }>(
    '/api/v1/worlds/:id/entities',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorldParams,
        querystring: WorldEntityListQuerySchema,
        response: { 200: WorldEntityListResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.listEntities(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.get<{ Params: { id: string; logicalKey: string } }>(
    '/api/v1/worlds/:id/entities/:logicalKey',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: EntityParams,
        response: { 200: WorldEntityDetailResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.getEntity(
        await authentication.authenticate(request),
        request.params.id,
        request.params.logicalKey,
      ),
  );

  app.get<{
    Params: { id: string; logicalKey: string };
    Querystring: WorldNeighborQuery;
  }>(
    '/api/v1/worlds/:id/entities/:logicalKey/neighbors',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: EntityParams,
        querystring: WorldNeighborQuerySchema,
        response: { 200: WorldNeighborResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.neighbors(
        await authentication.authenticate(request),
        request.params.id,
        request.params.logicalKey,
        request.query,
      ),
  );

  app.get<{ Params: { id: string }; Querystring: WorldRelationshipListQuery }>(
    '/api/v1/worlds/:id/relationships',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: WorldParams,
        querystring: WorldRelationshipListQuerySchema,
        response: { 200: WorldRelationshipListResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.listRelationships(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );
}
