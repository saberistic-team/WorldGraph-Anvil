import { metrics } from '@opentelemetry/api';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

import {
  GeographyInvalidationV1Schema,
  GeographyNotificationV1Schema,
  createValidator,
  type GeographyInvalidationV1,
  type GeographyNotificationV1,
  type Validator,
} from '@worldgraph/contracts';

export const GEOGRAPHY_REALTIME_CHANNEL_PREFIX = 'worldgraph:geography:v1:world' as const;

const notificationValidator: Validator<GeographyNotificationV1> =
  createValidator<GeographyNotificationV1>(GeographyNotificationV1Schema);
const invalidationValidator: Validator<GeographyInvalidationV1> =
  createValidator<GeographyInvalidationV1>(GeographyInvalidationV1Schema);

export interface GeographyRealtimePublisher {
  publish(notification: GeographyNotificationV1): Promise<void>;
}

export type GeographyRealtimePublishOutcome = 'failed' | 'published' | 'published_no_subscribers';

export interface GeographyRealtimeMetrics {
  recordPublication(
    messageType: GeographyNotificationV1['type'] | 'invalid',
    outcome: GeographyRealtimePublishOutcome,
  ): void;
}

const discardMetrics: GeographyRealtimeMetrics = { recordPublication: () => undefined };

export function createProductionGeographyRealtimeMetrics(): GeographyRealtimeMetrics {
  const publications = metrics
    .getMeter('worldgraph-worker')
    .createCounter('worldgraph_geography_realtime_publications_total');
  return {
    recordPublication(messageType, outcome) {
      publications.add(1, { message_type: messageType, outcome });
    },
  };
}

export function geographyRealtimeChannelV1(worldId: string): string {
  return `${GEOGRAPHY_REALTIME_CHANNEL_PREFIX}:${worldId}`;
}

/**
 * Redis is a disposable invalidation transport. Clients refresh authorized
 * geography/scene-plan reads and ignore stale cursor/stateRevision hints.
 */
export class RedisGeographyRealtimePublisher implements GeographyRealtimePublisher {
  private readonly metrics: GeographyRealtimeMetrics;

  public constructor(
    private readonly redis: Pick<Redis, 'publish'>,
    private readonly logger: Pick<Logger, 'warn'>,
    metricsAdapter: GeographyRealtimeMetrics = discardMetrics,
  ) {
    this.metrics = metricsAdapter;
  }

  public async publish(notification: GeographyNotificationV1): Promise<void> {
    try {
      notificationValidator.assert(notification);
    } catch {
      this.metrics.recordPublication('invalid', 'failed');
      this.logger.warn(
        { code: 'GEOGRAPHY_REALTIME_NOTIFICATION_INVALID', failureClass: 'validation' },
        'geography.realtime_publish_failed',
      );
      throw new Error('GEOGRAPHY_REALTIME_NOTIFICATION_INVALID');
    }

    try {
      const subscribers = await this.redis.publish(
        geographyRealtimeChannelV1(notification.worldId),
        JSON.stringify(notification),
      );
      this.metrics.recordPublication(
        notification.type,
        subscribers > 0 ? 'published' : 'published_no_subscribers',
      );
    } catch (error) {
      this.metrics.recordPublication(notification.type, 'failed');
      this.logger.warn(
        {
          code: 'GEOGRAPHY_REALTIME_PUBLISH_FAILED',
          failureClass: 'transport',
          messageType: notification.type,
        },
        'geography.realtime_publish_failed',
      );
      throw new Error('GEOGRAPHY_REALTIME_PUBLISH_FAILED', { cause: error });
    }
  }
}

export function geographyNotificationFromInvalidationPayload(
  payload: unknown,
): GeographyNotificationV1 | null {
  if (!invalidationValidator.is(payload)) return null;
  return payload.notification;
}
