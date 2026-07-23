import type Redis from 'ioredis';
import type { Logger } from 'pino';

import { WORKER_HEARTBEAT_KEY, type Clock } from '@worldgraph/contracts';

export class Heartbeat {
  private timer?: NodeJS.Timeout;

  public constructor(
    private readonly redis: Redis,
    private readonly clock: Clock,
    private readonly buildRevision: string,
    private readonly intervalMs: number,
    private readonly ttlMs: number,
    private readonly logger: Logger,
  ) {}

  public async beat(): Promise<void> {
    await this.redis.set(
      WORKER_HEARTBEAT_KEY,
      JSON.stringify({
        at: this.clock.now().toISOString(),
        buildRevision: this.buildRevision,
        schemaVersion: 1,
      }),
      'PX',
      this.ttlMs,
    );
  }

  public async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      void this.beat().catch((error: unknown) => {
        this.logger.warn({ error }, 'worker.heartbeat_failed');
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
