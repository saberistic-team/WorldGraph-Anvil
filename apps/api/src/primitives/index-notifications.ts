import { createHash } from 'node:crypto';

import type { Queue } from 'bullmq';

import {
  canonicalJson,
  type ApplicationNotification,
  type PrimitiveIndexRequested,
} from '@worldgraph/contracts';
import { withSpan } from '@worldgraph/observability';

import type { NotificationSink } from '../application/notifications.js';

export class PrimitiveIndexNotificationSink implements NotificationSink {
  public constructor(
    private readonly queue: Queue<PrimitiveIndexRequested>,
    private readonly downstream: NotificationSink,
  ) {}

  public async publish(notification: ApplicationNotification): Promise<void> {
    await this.downstream.publish(notification);
    if (notification.type !== 'PrimitiveIndexRequested') return;
    const message: PrimitiveIndexRequested = {
      contentHash: notification.payload.contentHash,
      indexSchemaVersion: notification.payload.indexSchemaVersion,
      primitiveVersionId: notification.payload.primitiveVersionId,
      providerConfigurationId: notification.payload.providerConfigurationId,
      schemaVersion: 1,
      type: 'PrimitiveIndexRequested',
    };
    const jobId = createHash('sha256').update(canonicalJson(message)).digest('hex');
    await withSpan('primitive.index.enqueue', async (span) => {
      span.setAttributes({
        'primitive.index.outcome': 'failed',
        'primitive.index.provider_configuration': message.providerConfigurationId,
        'primitive.index.schema_version': message.indexSchemaVersion,
        'primitive.version.id': message.primitiveVersionId,
      });
      await this.queue.add('primitive-index-requested', message, {
        jobId,
        removeOnComplete: 500,
        removeOnFail: 1_000,
      });
      span.setAttribute('primitive.index.outcome', 'enqueued');
    });
  }
}
