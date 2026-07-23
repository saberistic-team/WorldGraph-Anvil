import { createHmac } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { RuntimeConfig } from '@worldgraph/config';
import {
  CreatePrimitiveDraftRequestSchema,
  DeprecatePrimitiveVersionRequestSchema,
  ErrorEnvelopeSchema,
  IdempotencyKeySchema,
  PrimitiveCommandResponseSchema,
  PrimitiveDependencyViewSchema,
  PrimitiveDraftCommandResponseSchema,
  PrimitiveKindSchema,
  PrimitiveLifecycleSchema,
  PrimitiveListResponseSchema,
  PrimitiveReindexResponseSchema,
  PrimitiveRetrievalResponseSchema,
  PrimitiveTagSchema,
  PrimitiveVersionViewSchema,
  PublishPrimitiveVersionRequestSchema,
  ReindexPrimitiveVersionRequestSchema,
  StablePrimitiveKeySchema,
  StrictSemverSchema,
  UpdatePrimitiveDraftRequestSchema,
  type CreatePrimitiveDraftRequest,
  type DeprecatePrimitiveVersionRequest,
  type PrimitiveKind,
  type PrimitiveLifecycle,
  type PrimitiveListQuery,
  type PrimitiveRetrievalRequest,
  type PublishPrimitiveVersionRequest,
  type ReindexPrimitiveVersionRequest,
  type UpdatePrimitiveDraftRequest,
} from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';
import type { AuthenticatedActor, IdentityService } from '../identity/service.js';
import type { PrimitiveService } from '../primitives/service.js';

const SESSION_COOKIE = 'wg_session';
const CSRF_COOKIE = 'wg_csrf';
const MutationHeaders = Type.Object(
  {
    'idempotency-key': IdempotencyKeySchema,
    'x-csrf-token': Type.Optional(Type.String({ maxLength: 128, minLength: 32 })),
  },
  { additionalProperties: true },
);
const PrimitiveParams = Type.Object(
  { key: StablePrimitiveKeySchema, version: StrictSemverSchema },
  { additionalProperties: false },
);
const MultiKind = Type.Union([
  PrimitiveKindSchema,
  Type.Array(PrimitiveKindSchema, { maxItems: 16, minItems: 1, uniqueItems: true }),
]);
const MultiTag = Type.Union([
  PrimitiveTagSchema,
  Type.Array(PrimitiveTagSchema, { maxItems: 16, minItems: 1, uniqueItems: true }),
]);
const RetrievalTransportSchema = Type.Object(
  {
    compatibility: Type.Optional(
      Type.Record(Type.String({ maxLength: 160 }), Type.Unknown(), { maxProperties: 200 }),
    ),
    kinds: Type.Optional(Type.Array(PrimitiveKindSchema, { maxItems: 16, uniqueItems: true })),
    limit: Type.Optional(Type.Integer({ maximum: 30, minimum: 1 })),
    query: Type.String({ maxLength: 16_372, minLength: 1 }),
    tags: Type.Optional(Type.Array(PrimitiveTagSchema, { maxItems: 16, uniqueItems: true })),
  },
  { additionalProperties: false },
);
const ListTransportSchema = Type.Object(
  {
    cursor: Type.Optional(
      Type.String({ maxLength: 1024, minLength: 16, pattern: '^[A-Za-z0-9_-]+$' }),
    ),
    kinds: Type.Optional(MultiKind),
    lifecycle: Type.Optional(PrimitiveLifecycleSchema),
    limit: Type.Optional(Type.String({ maxLength: 3, pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
    query: Type.Optional(Type.String({ maxLength: 500, minLength: 1 })),
    tags: Type.Optional(MultiTag),
  },
  { additionalProperties: false },
);
const DependencyResponseSchema = Type.Object(
  { dependencies: Type.Array(PrimitiveDependencyViewSchema, { maxItems: 32 }) },
  { additionalProperties: false },
);
const commonErrors = {
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  403: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  413: ErrorEnvelopeSchema,
  429: ErrorEnvelopeSchema,
  503: ErrorEnvelopeSchema,
};

interface MutationHeaderValues {
  'idempotency-key': string;
  'x-csrf-token'?: string;
}

interface PrimitivePath {
  key: string;
  version: string;
}

interface ListTransport {
  cursor?: string;
  kinds?: PrimitiveKind | PrimitiveKind[];
  lifecycle?: PrimitiveLifecycle;
  limit?: string;
  query?: string;
  tags?: string | string[];
}

export async function registerPrimitiveRoutes(
  app: FastifyInstance,
  service: PrimitiveService,
  identity: IdentityService,
  config: RuntimeConfig,
): Promise<void> {
  const retrievalNetworkRateLimit = app.createRateLimit({
    keyGenerator: (request) =>
      createHmac('sha256', config.authPepper ?? 'unconfigured')
        .update(`primitive-retrieval-network:${coarseNetworkAddress(request.ip)}`)
        .digest('hex'),
    max: 300,
    timeWindow: '1 minute',
  });
  app.get<{ Querystring: ListTransport }>(
    '/api/v1/primitives',
    {
      schema: {
        querystring: ListTransportSchema,
        response: { 200: PrimitiveListResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.list(await authenticate(request, identity), listQuery(request.query)),
  );

  app.get<{ Params: PrimitivePath }>(
    '/api/v1/primitives/:key/versions/:version',
    {
      schema: {
        params: PrimitiveParams,
        response: { 200: PrimitiveVersionViewSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.get(
        await authenticate(request, identity),
        request.params.key,
        request.params.version,
      ),
  );

  app.get<{ Params: PrimitivePath }>(
    '/api/v1/primitives/:key/versions/:version/dependencies',
    {
      schema: {
        params: PrimitiveParams,
        response: { 200: DependencyResponseSchema, ...commonErrors },
      },
    },
    async (request) => ({
      dependencies: await service.dependencies(
        await authenticate(request, identity),
        request.params.key,
        request.params.version,
      ),
    }),
  );

  app.post<{ Body: PrimitiveRetrievalRequest }>(
    '/api/v1/primitive-retrievals',
    {
      config: {
        rateLimit: {
          keyGenerator: (request: FastifyRequest) => {
            const session = request.cookies[SESSION_COOKIE];
            const material =
              typeof session === 'string' && session.length > 0 ? session : request.ip;
            return createHmac('sha256', config.authPepper ?? 'unconfigured')
              .update(`primitive-retrieval:${material}`)
              .digest('hex');
          },
          max: 30,
          timeWindow: '1 minute',
        },
      },
      preHandler: async (request) => {
        const result = await retrievalNetworkRateLimit(request);
        if (!result.isAllowed && result.isExceeded) {
          throw new ApplicationError('RATE_LIMITED', 'Too many retrieval requests.', 429);
        }
      },
      schema: {
        body: RetrievalTransportSchema,
        response: { 200: PrimitiveRetrievalResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.retrieve(await authenticate(request, identity), request.body, request.id),
  );

  app.post<{ Body: CreatePrimitiveDraftRequest; Headers: MutationHeaderValues }>(
    '/api/v1/admin/primitives/drafts',
    {
      bodyLimit: 160 * 1024,
      schema: {
        body: CreatePrimitiveDraftRequestSchema,
        headers: MutationHeaders,
        response: { 201: PrimitiveDraftCommandResponseSchema, ...commonErrors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createDraft(
            await authenticatedMutation(request, identity, config),
            request.body,
            commandContext(request),
          ),
        ),
  );

  app.put<{
    Body: UpdatePrimitiveDraftRequest;
    Headers: MutationHeaderValues;
    Params: PrimitivePath;
  }>(
    '/api/v1/admin/primitives/:key/versions/:version/draft',
    {
      bodyLimit: 160 * 1024,
      schema: {
        body: UpdatePrimitiveDraftRequestSchema,
        headers: MutationHeaders,
        params: PrimitiveParams,
        response: { 200: PrimitiveDraftCommandResponseSchema, ...commonErrors },
      },
    },
    async (request) =>
      service.updateDraft(
        await authenticatedMutation(request, identity, config),
        request.params.key,
        request.params.version,
        request.body,
        commandContext(request),
      ),
  );

  app.post<{
    Body: PublishPrimitiveVersionRequest;
    Headers: MutationHeaderValues;
    Params: PrimitivePath;
  }>(
    '/api/v1/admin/primitives/:key/versions/:version/publish',
    commandRoute(PublishPrimitiveVersionRequestSchema, PrimitiveCommandResponseSchema),
    async (request) =>
      service.publishVersion(
        await authenticatedMutation(request, identity, config),
        request.params.key,
        request.params.version,
        request.body,
        commandContext(request),
      ),
  );

  app.post<{
    Body: DeprecatePrimitiveVersionRequest;
    Headers: MutationHeaderValues;
    Params: PrimitivePath;
  }>(
    '/api/v1/admin/primitives/:key/versions/:version/deprecate',
    commandRoute(DeprecatePrimitiveVersionRequestSchema, PrimitiveCommandResponseSchema),
    async (request) =>
      service.deprecateVersion(
        await authenticatedMutation(request, identity, config),
        request.params.key,
        request.params.version,
        request.body,
        commandContext(request),
      ),
  );

  app.post<{
    Body: ReindexPrimitiveVersionRequest;
    Headers: MutationHeaderValues;
    Params: PrimitivePath;
  }>(
    '/api/v1/admin/primitives/:key/versions/:version/reindex',
    commandRoute(ReindexPrimitiveVersionRequestSchema, PrimitiveReindexResponseSchema),
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await service.reindexVersion(
            await authenticatedMutation(request, identity, config),
            request.params.key,
            request.params.version,
            request.body,
            commandContext(request),
          ),
        ),
  );
}

function commandRoute(body: object, response: object) {
  return {
    schema: {
      body,
      headers: MutationHeaders,
      params: PrimitiveParams,
      response: { 200: response, 202: response, ...commonErrors },
    },
  };
}

function listQuery(query: ListTransport): PrimitiveListQuery {
  const kinds = asArray(query.kinds);
  const tags = asArray(query.tags);
  return {
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(query.lifecycle ? { lifecycle: query.lifecycle } : {}),
    ...(query.limit ? { limit: Number(query.limit) } : {}),
    ...(query.query ? { query: query.query } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function coarseNetworkAddress(address: string): string {
  const value = address.trim();
  return value.includes('.')
    ? value.split('.').slice(0, 3).join('.')
    : value.split(':').slice(0, 4).join(':');
}

function commandContext(request: FastifyRequest<{ Headers: MutationHeaderValues }>) {
  return { idempotencyKey: request.headers['idempotency-key'], requestId: request.id };
}

async function authenticate(
  request: FastifyRequest,
  identity: IdentityService,
): Promise<AuthenticatedActor> {
  return identity.authenticate(request.cookies[SESSION_COOKIE]);
}

async function authenticatedMutation(
  request: FastifyRequest,
  identity: IdentityService,
  config: RuntimeConfig,
): Promise<AuthenticatedActor> {
  const actor = await authenticate(request, identity);
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) {
    throw new ApplicationError('CSRF_INVALID', 'The request origin is not allowed.', 403);
  }
  identity.assertCsrf(
    actor,
    request.cookies[CSRF_COOKIE],
    typeof request.headers['x-csrf-token'] === 'string'
      ? request.headers['x-csrf-token']
      : undefined,
  );
  return actor;
}
