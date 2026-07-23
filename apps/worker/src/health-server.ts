import { createServer, type Server } from 'node:http';

import type { Logger } from 'pino';

import { telemetry } from '@worldgraph/observability';

export interface RedisReadinessProbe {
  ping(): Promise<string>;
}

export interface PostgresReadinessProbe {
  query(queryText: string): Promise<unknown>;
}

async function withinDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DEPENDENCY_TIMEOUT')), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createHealthServer(
  redis: RedisReadinessProbe,
  postgres: PostgresReadinessProbe,
  logger: Logger,
  timeoutMs: number,
): Server {
  return createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('x-content-type-options', 'nosniff');
    if (request.url === '/health/live') {
      response.writeHead(200).end('{"status":"ok"}');
      return;
    }
    if (request.url === '/health/ready') {
      void Promise.allSettled([
        withinDeadline(redis.ping(), timeoutMs),
        withinDeadline(postgres.query('select 1 as ready'), timeoutMs),
      ]).then(([redisResult, postgresResult]) => {
        const redisReady = redisResult?.status === 'fulfilled' && redisResult.value === 'PONG';
        const postgresReady = postgresResult?.status === 'fulfilled';
        const ready = redisReady && postgresReady;
        telemetry.setReadiness('worker', ready);
        if (!ready) {
          logger.warn(
            {
              components: {
                postgresql: postgresReady ? 'healthy' : 'unavailable',
                redis: redisReady ? 'healthy' : 'unavailable',
              },
            },
            'worker.readiness_failed',
          );
        }
        response.writeHead(ready ? 200 : 503).end(
          JSON.stringify(
            ready
              ? {
                  components: { postgresql: 'healthy', redis: 'healthy' },
                  status: 'ready',
                }
              : {
                  components: {
                    postgresql: postgresReady ? 'healthy' : 'unavailable',
                    redis: redisReady ? 'healthy' : 'unavailable',
                  },
                  error: {
                    code: 'DEPENDENCY_NOT_READY',
                    message: 'Worker dependencies are unavailable.',
                  },
                },
          ),
        );
      });
      return;
    }
    response.writeHead(404).end('{"error":{"code":"NOT_FOUND","message":"Not found."}}');
  });
}
