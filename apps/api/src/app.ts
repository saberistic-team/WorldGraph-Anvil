import { Type } from '@sinclair/typebox';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import Fastify, { LogController } from 'fastify';
import type { Logger } from 'pino';

import type { RuntimeConfig } from '@worldgraph/config';
import {
  ErrorCodes,
  ErrorEnvelopeSchema,
  LiveResponseSchema,
  PRODUCT_CODENAME,
  PRODUCT_NAME,
  ReadyResponseSchema,
  SmokeJobAcceptedSchema,
  SystemInfoSchema,
  publicCompatibilityVersions,
  type Clock,
  type IdGenerator,
} from '@worldgraph/contracts';
import { telemetry } from '@worldgraph/observability';

import { HealthService } from './health.js';
import type { DomainServices } from './routes/domain-routes.js';
import { registerDomainRoutes } from './routes/domain-routes.js';
import { ApplicationError } from './application/errors.js';
import { IdentityInputError } from './identity/security.js';
import { isOperationsTokenValid, SmokeService } from './smoke.js';
import type { RedisProbe, SmokeQueue, SqlProbe } from './types.js';

export interface AppDependencies {
  clock: Clock;
  config: RuntimeConfig;
  domain?: DomainServices;
  idGenerator: IdGenerator;
  logger: Logger;
  pool: SqlProbe;
  redis: RedisProbe;
  smokeQueue: SmokeQueue;
}

function errorEnvelope(requestId: string, code: string, message: string, details?: object) {
  return { error: { code, ...(details ? { details } : {}), message, requestId } };
}

function internalFailureContext(error: unknown): {
  databaseConstraint?: string;
  failureCode?: string;
  failureRoutine?: string;
} {
  if (typeof error !== 'object' || error === null) return {};
  const record = error as Record<string, unknown>;
  const safe = (value: unknown, pattern: RegExp): string | undefined =>
    typeof value === 'string' && pattern.test(value) ? value : undefined;
  return {
    ...(safe(record.constraint, /^[a-z][a-z0-9_]{0,127}$/u)
      ? { databaseConstraint: String(record.constraint) }
      : {}),
    ...(safe(record.code, /^[A-Z0-9_]{3,64}$/u) ? { failureCode: String(record.code) } : {}),
    ...(safe(record.routine, /^[A-Za-z][A-Za-z0-9_]{0,127}$/u)
      ? { failureRoutine: String(record.routine) }
      : {}),
  };
}

export async function buildApp(dependencies: AppDependencies) {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    genReqId: () => dependencies.idGenerator.next(),
    logController: new LogController({ disableRequestLogging: true }),
    loggerInstance: dependencies.logger,
    requestTimeout: dependencies.config.requestTimeoutMs,
    trustProxy: false,
  });

  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
  });
  addFormats(ajv);
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema));

  await app.register(cors, {
    credentials: true,
    methods: ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'],
    origin: dependencies.config.allowedOrigins,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { global: false, max: 30, timeWindow: '1 minute' });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    request.log.info({ requestId: request.id, route: request.routeOptions.url }, 'request.started');
  });
  app.addHook('onResponse', async (request, reply) => {
    telemetry.httpDuration.record(reply.elapsedTime, {
      method: request.method,
      route: request.routeOptions.url,
      status: String(reply.statusCode),
    });
    request.log.info(
      {
        duration: reply.elapsedTime,
        outcome: reply.statusCode < 500 ? 'handled' : 'failed',
        requestId: request.id,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
      },
      'request.completed',
    );
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(
        errorEnvelope(request.id, ErrorCodes.notFound, 'The requested resource was not found.'),
      );
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IdentityInputError) {
      request.log.warn(
        {
          errorCode: ErrorCodes.validationFailed,
          requestId: request.id,
          statusCode: 400,
        },
        'request.rejected',
      );
      return reply
        .code(400)
        .send(
          errorEnvelope(request.id, ErrorCodes.validationFailed, 'The identity input is invalid.'),
        );
    }
    if (error instanceof ApplicationError) {
      request.log.warn(
        { errorCode: error.code, requestId: request.id, statusCode: error.statusCode },
        'request.rejected',
      );
      return reply
        .code(error.statusCode)
        .send(errorEnvelope(request.id, error.code, error.message, error.details));
    }
    const handledError = error as { statusCode?: number };
    const status =
      handledError.statusCode && handledError.statusCode >= 400 ? handledError.statusCode : 500;
    const validationError = typeof error === 'object' && error !== null && 'validation' in error;
    const code = validationError
      ? ErrorCodes.validationFailed
      : status === 400
        ? ErrorCodes.invalidRequest
        : status === 415
          ? ErrorCodes.invalidContentType
          : status === 413
            ? ErrorCodes.payloadTooLarge
            : status === 429
              ? ErrorCodes.rateLimited
              : ErrorCodes.internal;
    const logContext = {
      errorCode: code,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      ...internalFailureContext(error),
      requestId: request.id,
      statusCode: status,
    };
    if (status >= 500) request.log.error(logContext, 'request.failed');
    else request.log.warn(logContext, 'request.rejected');
    const publicMessage =
      status >= 500
        ? 'The request could not be completed.'
        : code === ErrorCodes.validationFailed
          ? 'The request does not match the required schema.'
          : code === ErrorCodes.invalidContentType
            ? 'The request content type is invalid.'
            : code === ErrorCodes.payloadTooLarge
              ? 'The request payload is too large.'
              : code === ErrorCodes.rateLimited
                ? 'Too many requests were submitted.'
                : 'The request is invalid.';
    void reply.code(status).send(errorEnvelope(request.id, code, publicMessage));
  });

  if (dependencies.domain) {
    await registerDomainRoutes(
      app as unknown as Parameters<typeof registerDomainRoutes>[0],
      dependencies.domain,
      dependencies.config,
    );
  }

  const health = new HealthService({
    clock: dependencies.clock,
    dependencyTimeoutMs: dependencies.config.dependencyTimeoutMs,
    pool: dependencies.pool,
    redis: dependencies.redis,
    workerHeartbeatTtlMs: dependencies.config.workerHeartbeatTtlMs,
  });

  app.get(
    '/health/live',
    {
      schema: { response: { 200: LiveResponseSchema } },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: { response: { 200: ReadyResponseSchema, 503: ErrorEnvelopeSchema } },
    },
    async (request, reply) => {
      const components = await health.readiness();
      const ready = components.every((component) => component.status === 'healthy');
      telemetry.setReadiness('api', ready);
      if (!ready) {
        return reply
          .code(503)
          .send(
            errorEnvelope(
              request.id,
              ErrorCodes.dependencyNotReady,
              'One or more required components are unavailable.',
              { components },
            ),
          );
      }
      return {
        checkedAt: dependencies.clock.now().toISOString(),
        components,
        status: 'ready' as const,
      };
    },
  );

  app.get(
    '/api/v1/system/info',
    {
      schema: { response: { 200: SystemInfoSchema } },
    },
    async () => ({
      build: { api: dependencies.config.buildRevision },
      codename: PRODUCT_CODENAME,
      features: { operationalSmoke: dependencies.config.enableOperationalSmoke },
      name: PRODUCT_NAME,
      versions: publicCompatibilityVersions,
    }),
  );

  if (dependencies.config.enableOperationalSmoke && dependencies.config.operationsToken) {
    const smoke = new SmokeService(dependencies.smokeQueue);
    app.post(
      '/api/v1/system/smoke-jobs',
      {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
        schema: {
          body: Type.Object({}, { additionalProperties: false }),
          headers: Type.Object(
            {
              authorization: Type.String({ maxLength: 300 }),
              'idempotency-key': Type.String({
                maxLength: 128,
                minLength: 8,
                pattern: '^[A-Za-z0-9._-]+$',
              }),
            },
            { additionalProperties: true },
          ),
          response: {
            202: SmokeJobAcceptedSchema,
            401: ErrorEnvelopeSchema,
            503: ErrorEnvelopeSchema,
          },
        },
      },
      async (request, reply) => {
        if (
          !isOperationsTokenValid(
            request.headers.authorization,
            dependencies.config.operationsToken!,
          )
        ) {
          return reply
            .code(401)
            .send(
              errorEnvelope(
                request.id,
                ErrorCodes.unauthorized,
                'Valid operations authorization is required.',
              ),
            );
        }
        try {
          const result = await smoke.enqueue(
            request.headers['idempotency-key'] as string,
            request.id,
          );
          telemetry.smokeJobs.add(1, { outcome: 'accepted' });
          return reply.code(202).send(result);
        } catch (error) {
          request.log.warn({ error, requestId: request.id }, 'system_smoke.queue_unavailable');
          telemetry.smokeJobs.add(1, { outcome: 'unavailable' });
          return reply.code(503).send(
            errorEnvelope(
              request.id,
              ErrorCodes.dependencyNotReady,
              'The operational queue is unavailable.',
              {
                components: [{ code: 'REDIS_UNAVAILABLE', name: 'redis', status: 'unavailable' }],
              },
            ),
          );
        }
      },
    );
  }

  return app;
}
