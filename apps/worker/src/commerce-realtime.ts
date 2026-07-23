import { metrics } from '@opentelemetry/api';
import type Redis from 'ioredis';
import type { QueryResultRow } from 'pg';
import type { Logger } from 'pino';

import {
  CommerceNotificationV1Schema,
  createValidator,
  type CommerceNotificationV1,
  type Validator,
} from '@worldgraph/contracts';

export const COMMERCE_REALTIME_CHANNEL_PREFIX = 'worldgraph:commerce:v1:world' as const;

const notificationValidator: Validator<CommerceNotificationV1> =
  createValidator<CommerceNotificationV1>(CommerceNotificationV1Schema);

export interface CommerceRealtimeEvent {
  aggregateId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  resultingStateRevision: string;
  worldEventSequence: string;
  worldId: string;
}

export interface CommerceRealtimeQuery {
  query<T extends QueryResultRow>(queryText: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface CommerceRealtimePublisher {
  publish(notification: CommerceNotificationV1): Promise<void>;
}

export type CommerceRealtimePublishOutcome = 'failed' | 'published' | 'published_no_subscribers';

export interface CommerceRealtimeMetrics {
  recordPublication(
    messageType: CommerceNotificationV1['type'] | 'invalid',
    outcome: CommerceRealtimePublishOutcome,
  ): void;
}

const discardMetrics: CommerceRealtimeMetrics = { recordPublication: () => undefined };

export function createProductionCommerceRealtimeMetrics(): CommerceRealtimeMetrics {
  const publications = metrics
    .getMeter('worldgraph-worker')
    .createCounter('worldgraph_commerce_realtime_publications_total');
  return {
    recordPublication(messageType, outcome) {
      publications.add(1, { message_type: messageType, outcome });
    },
  };
}

export function commerceRealtimeChannelV1(worldId: string): string {
  return `${COMMERCE_REALTIME_CHANNEL_PREFIX}:${worldId}`;
}

/**
 * Redis is a disposable invalidation transport. The durable outbox retries a
 * failed publish, while clients always refresh an authorized PostgreSQL-backed
 * read and use cursor/stateRevision to ignore duplicates or older hints.
 */
export class RedisCommerceRealtimePublisher implements CommerceRealtimePublisher {
  private readonly metrics: CommerceRealtimeMetrics;

  public constructor(
    private readonly redis: Pick<Redis, 'publish'>,
    private readonly logger: Pick<Logger, 'warn'>,
    metricsAdapter: CommerceRealtimeMetrics = discardMetrics,
  ) {
    this.metrics = metricsAdapter;
  }

  public async publish(notification: CommerceNotificationV1): Promise<void> {
    try {
      notificationValidator.assert(notification);
    } catch {
      this.metrics.recordPublication('invalid', 'failed');
      this.logger.warn(
        { code: 'COMMERCE_REALTIME_NOTIFICATION_INVALID', failureClass: 'validation' },
        'commerce.realtime_publish_failed',
      );
      throw new Error('COMMERCE_REALTIME_NOTIFICATION_INVALID');
    }

    try {
      const subscribers = await this.redis.publish(
        commerceRealtimeChannelV1(notification.worldId),
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
          code: 'COMMERCE_REALTIME_PUBLISH_FAILED',
          failureClass: realtimeFailureClass(error),
          messageType: notification.type,
        },
        'commerce.realtime_publish_failed',
      );
      throw new Error('COMMERCE_REALTIME_PUBLISH_FAILED', { cause: error });
    }
  }
}

/**
 * Derive one or more ID-only refresh hints from an already committed domain
 * fact. Queries recover affected inventory IDs that are deliberately omitted
 * from public event payloads; no amounts, parties, or private terms are copied.
 */
export async function commerceNotificationsForEvent(
  query: CommerceRealtimeQuery,
  event: CommerceRealtimeEvent,
): Promise<CommerceNotificationV1[]> {
  const notifications: CommerceNotificationV1[] = [];
  const add = (type: CommerceNotificationV1['type'], entityId: string): void => {
    notifications.push({
      cursor: event.worldEventSequence,
      entityId,
      schemaVersion: 1,
      stateRevision: event.resultingStateRevision,
      type,
      worldId: event.worldId,
    });
  };

  switch (event.eventType) {
    case 'ProductionRunStartedV1':
    case 'ResourcesConsumedV1':
    case 'ResourcesProducedV1':
    case 'ProductionFailedV1':
      add('economy.production.changed', event.aggregateId);
      break;
    case 'MarketListingCreatedV1':
    case 'MarketListingCancelledV1':
    case 'MarketListingExpiredV1':
    case 'MarketListingPartiallyFilledV1':
    case 'MarketListingFilledV1':
      add('economy.listing.changed', event.aggregateId);
      break;
    case 'MarketTradeCompletedV1':
      add('economy.trade.completed', event.aggregateId);
      break;
    case 'TreasuryRevenueRecordedV1':
      add('economy.treasury.changed', requiredUuidField(event.payload, 'treasuryWalletId'));
      break;
    default:
      break;
  }

  let inventoryIds: string[] = [];
  switch (event.eventType) {
    case 'ProductionRunStartedV1':
    case 'ProductionFailedV1':
      inventoryIds = await affectedProductionReservationInventories(
        query,
        event.worldId,
        event.aggregateId,
      );
      break;
    case 'ResourcesConsumedV1':
    case 'ResourcesProducedV1':
      inventoryIds = await affectedMovementInventories(query, event.worldId, event.eventId);
      break;
    case 'MarketListingCreatedV1':
    case 'MarketListingCancelledV1':
    case 'MarketListingExpiredV1':
      inventoryIds = await affectedListingInventories(query, event.worldId, event.aggregateId);
      break;
    case 'InventoryTransferredV1':
      inventoryIds = [
        requiredUuidField(event.payload, 'fromInventoryId'),
        requiredUuidField(event.payload, 'toInventoryId'),
      ];
      break;
    default:
      break;
  }
  for (const inventoryId of inventoryIds) add('economy.inventory.changed', inventoryId);

  if (event.eventType === 'PayrollSettledV1') {
    for (const treasuryWalletId of await payrollTreasuryWallets(
      query,
      event.worldId,
      event.eventId,
    )) {
      add('economy.treasury.changed', treasuryWalletId);
    }
  }

  const exact = new Map<string, CommerceNotificationV1>();
  for (const notification of notifications) {
    notificationValidator.assert(notification);
    exact.set(`${notification.type}:${notification.entityId}`, notification);
  }
  return [...exact.values()].sort(
    (left, right) =>
      left.type.localeCompare(right.type) || left.entityId.localeCompare(right.entityId),
  );
}

async function affectedProductionReservationInventories(
  query: CommerceRealtimeQuery,
  worldId: string,
  productionRunId: string,
): Promise<string[]> {
  const result = await query.query<{ entity_id: string }>(
    `select distinct inventory_id::text as entity_id
       from inventory_reservations
      where world_id=$1 and purpose_type='production_input' and purpose_id=$2
      order by entity_id`,
    [worldId, productionRunId],
  );
  return result.rows.map((row) => row.entity_id);
}

async function affectedMovementInventories(
  query: CommerceRealtimeQuery,
  worldId: string,
  eventId: string,
): Promise<string[]> {
  const result = await query.query<{ entity_id: string }>(
    `select distinct entity_id
       from (
         select from_inventory_id::text as entity_id
           from inventory_movements where world_id=$1 and event_id=$2
         union all
         select to_inventory_id::text as entity_id
           from inventory_movements where world_id=$1 and event_id=$2
       ) affected
      where entity_id is not null
      order by entity_id`,
    [worldId, eventId],
  );
  return result.rows.map((row) => row.entity_id);
}

async function affectedListingInventories(
  query: CommerceRealtimeQuery,
  worldId: string,
  listingId: string,
): Promise<string[]> {
  const result = await query.query<{ entity_id: string }>(
    `select seller_inventory_id::text as entity_id
       from market_listings where world_id=$1 and id=$2`,
    [worldId, listingId],
  );
  return result.rows.map((row) => row.entity_id);
}

async function payrollTreasuryWallets(
  query: CommerceRealtimeQuery,
  worldId: string,
  eventId: string,
): Promise<string[]> {
  const result = await query.query<{ entity_id: string }>(
    `select distinct treasury_wallet_id::text as entity_id
       from tax_assessments
      where world_id=$1 and event_id=$2 and amount_minor > 0
      order by entity_id`,
    [worldId, eventId],
  );
  return result.rows.map((row) => row.entity_id);
}

function requiredUuidField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error('COMMERCE_REALTIME_EVENT_INVALID');
  return value;
}

function realtimeFailureClass(error: unknown): 'dependency' | 'unexpected' {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    if (/^(?:E|NR_|READONLY|CLUSTERDOWN)/u.test(error.code)) return 'dependency';
  }
  return 'unexpected';
}
