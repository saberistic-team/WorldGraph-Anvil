import { createHash } from 'node:crypto';

import type { Queue } from 'bullmq';

import {
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  WORLD_COMPILATION_QUEUE_SCHEMA_VERSION,
  canonicalJson,
  type ApplicationNotification,
  type WorldCompilationRequestedQueue,
} from '@worldgraph/contracts';
import { withSpan } from '@worldgraph/observability';

import type { NotificationSink } from '../application/notifications.js';

/**
 * Emits only a validated wake message. PostgreSQL retains the authoritative
 * compilation request and exact input identity, so reconciliation recovers a
 * lost Redis message without putting manifest or member data on the queue.
 */
export class CompilationNotificationSink implements NotificationSink {
  public constructor(
    private readonly queue: Queue<WorldCompilationRequestedQueue>,
    private readonly downstream: NotificationSink,
  ) {}

  public async publish(notification: ApplicationNotification): Promise<void> {
    await this.downstream.publish(notification);
    if (notification.type !== 'WorldCompilationRequested') return;
    const message: WorldCompilationRequestedQueue = {
      compilerConfigVersion: COMPILER_CONFIG_SCHEMA_VERSION,
      compilerVersion: notification.payload.compilerVersion ?? COMPILER_VERSION,
      inputHash: notification.payload.inputHash,
      manifestRevisionId: notification.payload.manifestRevisionId,
      runId: notification.payload.runId,
      schemaVersion: WORLD_COMPILATION_QUEUE_SCHEMA_VERSION,
      type: 'WorldCompilationRequested',
    };
    const jobId = createHash('sha256').update(canonicalJson(message)).digest('hex');
    await withSpan('world.compilation.enqueue', async (span) => {
      span.setAttributes({
        'world.compilation.compiler_config_version': COMPILER_CONFIG_SCHEMA_VERSION,
        'world.compilation.compiler_version': message.compilerVersion,
        'world.compilation.input_hash': message.inputHash,
        'world.compilation.manifest_revision_id': message.manifestRevisionId,
        'world.compilation.outcome': 'failed',
        'world.compilation.run_id': message.runId,
        'world.compilation.stage': 'enqueue',
      });
      await this.queue.add('world-compilation-requested', message, {
        attempts: 3,
        backoff: { delay: 500, type: 'exponential' },
        jobId,
        removeOnComplete: 500,
        removeOnFail: 1_000,
      });
      span.setAttribute('world.compilation.outcome', 'enqueued');
    });
  }
}
