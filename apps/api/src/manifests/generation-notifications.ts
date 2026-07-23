import { createHash } from 'node:crypto';

import type { Queue } from 'bullmq';

import {
  MANIFEST_GENERATOR_SCHEMA_VERSION,
  MANIFEST_PROMPT_TEMPLATE_VERSION,
  MANIFEST_QUEUE_SCHEMA_VERSION,
  MANIFEST_VALIDATOR_VERSION,
  canonicalJson,
  type ApplicationNotification,
  type ManifestGenerationRequested,
} from '@worldgraph/contracts';
import { withSpan } from '@worldgraph/observability';

import type { NotificationSink } from '../application/notifications.js';

/**
 * Converts an in-process application notification into a wake-only BullMQ job.
 * The database run remains the source of truth, so queue loss is recovered by
 * worker reconciliation and the payload deliberately contains no prompt text.
 */
export class ManifestGenerationNotificationSink implements NotificationSink {
  public constructor(
    private readonly queue: Queue<ManifestGenerationRequested>,
    private readonly providerConfigurationId: string,
    private readonly downstream: NotificationSink,
  ) {}

  public async publish(notification: ApplicationNotification): Promise<void> {
    await this.downstream.publish(notification);
    if (notification.type !== 'ManifestGenerationRequested') return;
    const message: ManifestGenerationRequested = {
      generatorSchemaVersion: MANIFEST_GENERATOR_SCHEMA_VERSION,
      inputHash: notification.payload.inputHash,
      promptTemplateVersion: MANIFEST_PROMPT_TEMPLATE_VERSION,
      providerConfigurationId: this.providerConfigurationId,
      runId: notification.payload.runId,
      schemaVersion: MANIFEST_QUEUE_SCHEMA_VERSION,
      type: 'ManifestGenerationRequested',
      validatorVersion: MANIFEST_VALIDATOR_VERSION,
    };
    const jobId = createHash('sha256').update(canonicalJson(message)).digest('hex');
    await withSpan('manifest.generation.enqueue', async (span) => {
      span.setAttributes({
        'manifest.generation.outcome': 'failed',
        'manifest.generation.provider_configuration': this.providerConfigurationId,
        'manifest.generation.schema_version': MANIFEST_GENERATOR_SCHEMA_VERSION,
      });
      await this.queue.add('manifest-generation-requested', message, {
        attempts: 3,
        backoff: { delay: 500, type: 'exponential' },
        jobId,
        removeOnComplete: 500,
        removeOnFail: 1_000,
      });
      span.setAttribute('manifest.generation.outcome', 'enqueued');
    });
  }
}
