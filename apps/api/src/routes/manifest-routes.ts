import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest, FastifySerializerCompiler } from 'fastify';

import {
  ApproveManifestRevisionRequestSchema,
  ApproveManifestRevisionResponseSchema,
  CancelManifestGenerationRequestSchema,
  CancelManifestGenerationResponseSchema,
  CreateManifestRevisionRequestSchema,
  CreateManifestRevisionResponseSchema,
  ErrorEnvelopeSchema,
  GetManifestRevisionResponseSchema,
  IdempotencyKeySchema,
  ManifestGenerationRunViewSchema,
  ManifestRevisionDiffQuerySchema,
  ManifestRevisionDiffViewSchema,
  ManifestRevisionListQuerySchema,
  ManifestRevisionListResponseSchema,
  StartManifestGenerationRequestSchema,
  StartManifestGenerationResponseSchema,
  ValidateManifestRevisionRequestSchema,
  ValidateManifestRevisionResponseSchema,
  createValidator,
  type ApproveManifestRevisionRequest,
  type CancelManifestGenerationRequest,
  type CreateManifestRevisionRequest,
  type ManifestRevisionDiffQuery,
  type ManifestRevisionListQuery,
  type StartManifestGenerationRequest,
} from '@worldgraph/contracts';

import type { AuthenticatedActor } from '../identity/service.js';
import type { ManifestCommandContext, ManifestService } from '../manifests/service.js';

const WorldParams = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const RunParams = Type.Object(
  { runId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const RevisionParams = Type.Object(
  { id: Type.String({ format: 'uuid' }), revisionId: Type.String({ format: 'uuid' }) },
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
  413: ErrorEnvelopeSchema,
  422: ErrorEnvelopeSchema,
  429: ErrorEnvelopeSchema,
  503: ErrorEnvelopeSchema,
};

// fast-json-stringify 7 cannot resolve its generated local references when a
// bounded recursive JSON value appears below patternProperties. Manifest
// contracts remain registered for validation/documentation. Ajv validates the
// exact response contract before native JSON serialization avoids that
// upstream serializer defect without changing the wire representation.
const manifestSerializerCompiler: FastifySerializerCompiler<unknown> = ({ schema }) => {
  const validator = createValidator<unknown>(schema as Record<string, unknown>);
  return (payload: unknown): string => {
    const issues = validator.issues(payload);
    if (issues.length > 0) throw new TypeError(JSON.stringify(issues));
    return JSON.stringify(payload);
  };
};

export interface ManifestRouteAuthentication {
  authenticate(request: FastifyRequest): Promise<AuthenticatedActor>;
  command(request: FastifyRequest): ManifestCommandContext;
  mutation(request: FastifyRequest): Promise<AuthenticatedActor>;
}

export async function registerManifestRoutes(
  app: FastifyInstance,
  service: ManifestService,
  authentication: ManifestRouteAuthentication,
): Promise<void> {
  app.post<{
    Body: StartManifestGenerationRequest;
    Params: { id: string };
  }>(
    '/api/v1/worlds/:id/manifest-generations',
    {
      bodyLimit: 16 * 1024,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      serializerCompiler: manifestSerializerCompiler,
      schema: {
        body: StartManifestGenerationRequestSchema,
        headers: MutationHeaders,
        params: WorldParams,
        response: { 202: StartManifestGenerationResponseSchema, ...commonErrors },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await service.startGeneration(
            await authentication.mutation(request),
            request.params.id,
            request.body,
            authentication.command(request),
          ),
        ),
  );

  app.get<{ Params: { runId: string } }>(
    '/api/v1/manifest-generations/:runId',
    {
      serializerCompiler: manifestSerializerCompiler,
      schema: {
        params: RunParams,
        response: { 200: ManifestGenerationRunViewSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.generation(await authentication.authenticate(request), request.params.runId),
  );

  app.post<{
    Body: CancelManifestGenerationRequest;
    Params: { runId: string };
  }>(
    '/api/v1/manifest-generations/:runId/cancel',
    {
      serializerCompiler: manifestSerializerCompiler,
      schema: {
        body: CancelManifestGenerationRequestSchema,
        headers: MutationHeaders,
        params: RunParams,
        response: { 200: CancelManifestGenerationResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.cancelGeneration(
        await authentication.mutation(request),
        request.params.runId,
        request.body.expectedRowVersion,
        authentication.command(request),
      ),
  );

  app.get<{ Params: { id: string }; Querystring: ManifestRevisionListQuery }>(
    '/api/v1/worlds/:id/manifest-revisions',
    {
      serializerCompiler: manifestSerializerCompiler,
      schema: {
        params: WorldParams,
        querystring: ManifestRevisionListQuerySchema,
        response: { 200: ManifestRevisionListResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.listRevisions(
        await authentication.authenticate(request),
        request.params.id,
        request.query,
      ),
  );

  app.post<{
    Body: CreateManifestRevisionRequest;
    Params: { id: string };
  }>(
    '/api/v1/worlds/:id/manifest-revisions',
    {
      bodyLimit: 160 * 1024,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      serializerCompiler: manifestSerializerCompiler,
      schema: {
        body: CreateManifestRevisionRequestSchema,
        headers: MutationHeaders,
        params: WorldParams,
        response: { 201: CreateManifestRevisionResponseSchema, ...commonErrors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createRevision(
            await authentication.mutation(request),
            request.params.id,
            request.body,
            authentication.command(request),
          ),
        ),
  );

  app.get<{
    Params: { id: string };
    Querystring: ManifestRevisionDiffQuery;
  }>(
    '/api/v1/worlds/:id/manifest-revisions/diff',
    {
      serializerCompiler: manifestSerializerCompiler,
      schema: {
        params: WorldParams,
        querystring: ManifestRevisionDiffQuerySchema,
        response: { 200: ManifestRevisionDiffViewSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.diff(await authentication.authenticate(request), request.params.id, request.query),
  );

  app.get<{ Params: { id: string; revisionId: string } }>(
    '/api/v1/worlds/:id/manifest-revisions/:revisionId',
    {
      serializerCompiler: manifestSerializerCompiler,
      schema: {
        params: RevisionParams,
        response: { 200: GetManifestRevisionResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.revision(
        await authentication.authenticate(request),
        request.params.id,
        request.params.revisionId,
      ),
  );

  app.post<{
    Body: { expectedContentHash: string };
    Params: { id: string; revisionId: string };
  }>(
    '/api/v1/worlds/:id/manifest-revisions/:revisionId/validate',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      serializerCompiler: manifestSerializerCompiler,
      schema: {
        body: ValidateManifestRevisionRequestSchema,
        headers: MutationHeaders,
        params: RevisionParams,
        response: { 200: ValidateManifestRevisionResponseSchema, ...commonErrors },
      },
    },
    async (request) => ({
      report: await service.validateRevision(
        await authentication.mutation(request),
        request.params.id,
        request.params.revisionId,
        request.body.expectedContentHash,
        authentication.command(request),
      ),
    }),
  );

  app.post<{
    Body: ApproveManifestRevisionRequest;
    Params: { id: string; revisionId: string };
  }>(
    '/api/v1/worlds/:id/manifest-revisions/:revisionId/approve',
    {
      serializerCompiler: manifestSerializerCompiler,
      schema: {
        body: ApproveManifestRevisionRequestSchema,
        headers: MutationHeaders,
        params: RevisionParams,
        response: { 200: ApproveManifestRevisionResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.approve(
        await authentication.mutation(request),
        request.params.id,
        request.params.revisionId,
        request.body,
        authentication.command(request),
      ),
  );
}
