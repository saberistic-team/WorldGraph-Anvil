import { createServer, type Server } from 'node:http';

import type { Logger } from 'pino';

import { telemetry } from '@worldgraph/observability';

export interface RedisReadinessProbe {
  ping(): Promise<string>;
}

export interface PostgresReadinessProbe {
  query(queryText: string): Promise<unknown>;
}

export interface WorkerHealthDependencies {
  governanceTally?: PostgresReadinessProbe;
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
  dependencies: WorkerHealthDependencies = {},
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
      const probes = [
        withinDeadline(redis.ping(), timeoutMs),
        withinDeadline(postgres.query('select 1 as ready'), timeoutMs),
        ...(dependencies.governanceTally
          ? [withinDeadline(dependencies.governanceTally.query('select 1 as ready'), timeoutMs)]
          : []),
      ];
      void Promise.allSettled(probes).then(([redisResult, postgresResult, tallyResult]) => {
        const redisReady = redisResult?.status === 'fulfilled' && redisResult.value === 'PONG';
        const postgresReady = postgresResult?.status === 'fulfilled';
        const tallyReady =
          dependencies.governanceTally === undefined || tallyResult?.status === 'fulfilled';
        const ready = redisReady && postgresReady && tallyReady;
        const components = {
          ...(dependencies.governanceTally
            ? { governanceTally: tallyReady ? 'healthy' : 'unavailable' }
            : {}),
          postgresql: postgresReady ? 'healthy' : 'unavailable',
          redis: redisReady ? 'healthy' : 'unavailable',
        };
        telemetry.setReadiness('worker', ready);
        if (!ready) {
          logger.warn({ components }, 'worker.readiness_failed');
        }
        response.writeHead(ready ? 200 : 503).end(
          JSON.stringify(
            ready
              ? {
                  components,
                  status: 'ready',
                }
              : {
                  components,
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
