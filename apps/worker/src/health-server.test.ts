import type { AddressInfo } from 'node:net';

import { createLogger } from '@worldgraph/observability';
import { afterEach, describe, expect, it } from 'vitest';

import { createHealthServer } from './health-server.js';

const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'worker-health-test',
});

describe('worker health server', () => {
  const servers: ReturnType<typeof createHealthServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function request(
    redis: { ping(): Promise<string> },
    postgres: { query(queryText: string): Promise<unknown> },
    path: string,
  ): Promise<Response> {
    const server = createHealthServer(redis, postgres, logger, 25);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${address.port}${path}`);
  }

  it('reports ready only when both Redis and PostgreSQL respond', async () => {
    const response = await request(
      { ping: async () => 'PONG' },
      { query: async () => ({ rows: [{ ready: 1 }] }) },
      '/health/ready',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      components: { postgresql: 'healthy', redis: 'healthy' },
      status: 'ready',
    });
  });

  it('returns a sanitized 503 identifying only unavailable components', async () => {
    const response = await request(
      { ping: async () => 'PONG' },
      {
        query: async () => {
          throw new Error('postgres://user:secret@example.test/private');
        },
      },
      '/health/ready',
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      components: { postgresql: 'unavailable', redis: 'healthy' },
      error: {
        code: 'DEPENDENCY_NOT_READY',
        message: 'Worker dependencies are unavailable.',
      },
    });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('keeps liveness independent from dependencies', async () => {
    const response = await request(
      {
        ping: async () => {
          throw new Error('down');
        },
      },
      {
        query: async () => {
          throw new Error('down');
        },
      },
      '/health/live',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('includes the restricted tally connection in readiness when configured', async () => {
    const tally = {
      query: async () => {
        throw new Error('postgres://tally:secret@example.test/private');
      },
    };
    const server = createHealthServer(
      { ping: async () => 'PONG' },
      { query: async () => ({ rows: [{ ready: 1 }] }) },
      logger,
      25,
      { governanceTally: tally },
    );
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`);

    expect(response.status).toBe(503);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({
      components: {
        governanceTally: 'unavailable',
        postgresql: 'healthy',
        redis: 'healthy',
      },
      error: {
        code: 'DEPENDENCY_NOT_READY',
        message: 'Worker dependencies are unavailable.',
      },
    });
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
