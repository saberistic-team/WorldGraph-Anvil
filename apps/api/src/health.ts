import {
  RUNTIME_SCHEMA_VERSION,
  WORKER_HEARTBEAT_KEY,
  type Clock,
  type ComponentStatus,
} from '@worldgraph/contracts';
import { telemetry, withSpan } from '@worldgraph/observability';

import type { RedisProbe, SqlProbe } from './types.js';

export interface HealthDependencies {
  clock: Clock;
  dependencyTimeoutMs: number;
  pool: SqlProbe;
  redis: RedisProbe;
  workerHeartbeatTtlMs: number;
}

interface WorkerHeartbeat {
  at: string;
  buildRevision: string;
  schemaVersion: 1;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DEPENDENCY_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function measured<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await withSpan(`dependency.${name}`, () => operation());
  } finally {
    telemetry.dependencyLatency.record(performance.now() - started, { dependency: name });
  }
}

export class HealthService {
  public constructor(private readonly dependencies: HealthDependencies) {}

  public async readiness(): Promise<ComponentStatus[]> {
    const [postgresql, redis, worker] = await Promise.all([
      this.postgresql(),
      this.redis(),
      this.worker(),
    ]);
    return [{ name: 'api', status: 'healthy' }, postgresql, redis, worker];
  }

  private async postgresql(): Promise<ComponentStatus> {
    try {
      const result = await measured('postgresql', () =>
        withTimeout(
          this.dependencies.pool.query(
            "select (value->>'runtimeSchema')::integer as runtime_schema from platform_metadata where key = 'runtime_versions'",
          ),
          this.dependencies.dependencyTimeoutMs,
        ),
      );
      if (result.rows[0]?.runtime_schema !== RUNTIME_SCHEMA_VERSION) {
        return { code: 'MIGRATION_INCOMPATIBLE', name: 'postgresql', status: 'unavailable' };
      }
      return { name: 'postgresql', status: 'healthy' };
    } catch {
      return { code: 'POSTGRESQL_UNAVAILABLE', name: 'postgresql', status: 'unavailable' };
    }
  }

  private async redis(): Promise<ComponentStatus> {
    try {
      const response = await measured('redis', () =>
        withTimeout(this.dependencies.redis.ping(), this.dependencies.dependencyTimeoutMs),
      );
      return response === 'PONG'
        ? { name: 'redis', status: 'healthy' }
        : { code: 'REDIS_INVALID_RESPONSE', name: 'redis', status: 'unavailable' };
    } catch {
      return { code: 'REDIS_UNAVAILABLE', name: 'redis', status: 'unavailable' };
    }
  }

  private async worker(): Promise<ComponentStatus> {
    try {
      const raw = await measured('worker-heartbeat', () =>
        withTimeout(
          this.dependencies.redis.get(WORKER_HEARTBEAT_KEY),
          this.dependencies.dependencyTimeoutMs,
        ),
      );
      if (!raw) return { code: 'WORKER_HEARTBEAT_MISSING', name: 'worker', status: 'unavailable' };
      const heartbeat = JSON.parse(raw) as WorkerHeartbeat;
      const age = this.dependencies.clock.now().getTime() - new Date(heartbeat.at).getTime();
      if (!Number.isFinite(age) || heartbeat.schemaVersion !== 1 || age < 0) {
        return { code: 'WORKER_HEARTBEAT_INVALID', name: 'worker', status: 'unavailable' };
      }
      if (age > this.dependencies.workerHeartbeatTtlMs) {
        return { code: 'WORKER_HEARTBEAT_STALE', name: 'worker', status: 'unavailable' };
      }
      return { name: 'worker', status: 'healthy' };
    } catch {
      return { code: 'WORKER_UNAVAILABLE', name: 'worker', status: 'unavailable' };
    }
  }
}
