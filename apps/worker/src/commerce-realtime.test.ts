import { metrics, type Meter } from '@opentelemetry/api';
import type { QueryResultRow } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommerceNotificationV1 } from '@worldgraph/contracts';

import {
  commerceNotificationsForEvent,
  commerceRealtimeChannelV1,
  createProductionCommerceRealtimeMetrics,
  RedisCommerceRealtimePublisher,
  type CommerceRealtimeEvent,
  type CommerceRealtimeMetrics,
  type CommerceRealtimeQuery,
} from './commerce-realtime.js';

const WORLD_ID = '018f0000-0000-7000-8000-000000000001';
const EVENT_ID = '018f0000-0000-7000-8000-000000000002';
const RUN_ID = '018f0000-0000-7000-8000-000000000003';
const INVENTORY_A = '018f0000-0000-7000-8000-000000000004';
const INVENTORY_B = '018f0000-0000-7000-8000-000000000005';
const TREASURY_ID = '018f0000-0000-7000-8000-000000000006';

afterEach(() => vi.restoreAllMocks());

function domainEvent(
  eventType: string,
  overrides: Partial<CommerceRealtimeEvent> = {},
): CommerceRealtimeEvent {
  return {
    aggregateId: RUN_ID,
    eventId: EVENT_ID,
    eventType,
    payload: {},
    resultingStateRevision: '21',
    worldEventSequence: '34',
    worldId: WORLD_ID,
    ...overrides,
  };
}

class FakeQuery implements CommerceRealtimeQuery {
  public readonly calls: { queryText: string; values: unknown[] | undefined }[] = [];

  public constructor(private readonly entityIds: string[] = []) {}

  public async query<T extends QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push({ queryText, values });
    return { rows: this.entityIds.map((entity_id) => ({ entity_id }) as unknown as T) };
  }
}

function notification(): CommerceNotificationV1 {
  return {
    cursor: '34',
    entityId: RUN_ID,
    schemaVersion: 1,
    stateRevision: '21',
    type: 'economy.production.changed',
    worldId: WORLD_ID,
  };
}

describe('commerce realtime invalidations', () => {
  it('emits one counter with allowlisted type and outcome labels only', () => {
    const add = vi.fn();
    const createCounter = vi.fn(() => ({ add }));
    vi.spyOn(metrics, 'getMeter').mockReturnValue({ createCounter } as unknown as Meter);

    const production = createProductionCommerceRealtimeMetrics();
    production.recordPublication('economy.trade.completed', 'published');

    expect(createCounter).toHaveBeenCalledWith('worldgraph_commerce_realtime_publications_total');
    expect(add).toHaveBeenCalledWith(1, {
      message_type: 'economy.trade.completed',
      outcome: 'published',
    });
    expect(JSON.stringify(add.mock.calls)).not.toMatch(/018f|world_id|entity_id|event_id/u);
  });

  it('uses a deterministic world-scoped channel and publishes only the validated schema', async () => {
    const publish = vi.fn(async () => 2);
    const recordPublication = vi.fn();
    const warn = vi.fn();
    const publisher = new RedisCommerceRealtimePublisher(
      { publish },
      { warn },
      { recordPublication },
    );

    await publisher.publish(notification());

    expect(commerceRealtimeChannelV1(WORLD_ID)).toBe(`worldgraph:commerce:v1:world:${WORLD_ID}`);
    expect(publish).toHaveBeenCalledWith(
      commerceRealtimeChannelV1(WORLD_ID),
      JSON.stringify(notification()),
    );
    expect(recordPublication).toHaveBeenCalledWith('economy.production.changed', 'published');
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats no subscribers as a successful disposable invalidation publish', async () => {
    const recordPublication = vi.fn();
    const publisher = new RedisCommerceRealtimePublisher(
      { publish: vi.fn(async () => 0) },
      { warn: vi.fn() },
      { recordPublication },
    );

    await expect(publisher.publish(notification())).resolves.toBeUndefined();
    expect(recordPublication).toHaveBeenCalledWith(
      'economy.production.changed',
      'published_no_subscribers',
    );
  });

  it('fails closed before Redis for an unsafe payload and bounds its metric label', async () => {
    const publish = vi.fn(async () => 1);
    const recordPublication = vi.fn();
    const publisher = new RedisCommerceRealtimePublisher(
      { publish },
      { warn: vi.fn() },
      { recordPublication },
    );
    const unsafe = {
      ...notification(),
      buyerWalletId: INVENTORY_A,
    } as unknown as CommerceNotificationV1;

    await expect(publisher.publish(unsafe)).rejects.toThrow(
      'COMMERCE_REALTIME_NOTIFICATION_INVALID',
    );
    expect(publish).not.toHaveBeenCalled();
    expect(recordPublication).toHaveBeenCalledWith('invalid', 'failed');
  });

  it('surfaces Redis failure to the durable outbox without logging private error text', async () => {
    const recordPublication = vi.fn();
    const warn = vi.fn();
    const publisher = new RedisCommerceRealtimePublisher(
      {
        publish: vi.fn(async () => {
          throw Object.assign(new Error('private redis endpoint secret'), { code: 'ECONNRESET' });
        }),
      },
      { warn },
      { recordPublication },
    );

    await expect(publisher.publish(notification())).rejects.toThrow(
      'COMMERCE_REALTIME_PUBLISH_FAILED',
    );
    expect(recordPublication).toHaveBeenCalledWith('economy.production.changed', 'failed');
    expect(warn).toHaveBeenCalledWith(
      {
        code: 'COMMERCE_REALTIME_PUBLISH_FAILED',
        failureClass: 'dependency',
        messageType: 'economy.production.changed',
      },
      'commerce.realtime_publish_failed',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private redis endpoint secret');
  });

  it('projects production and inventory invalidations from private reservation rows', async () => {
    const query = new FakeQuery([INVENTORY_B, INVENTORY_A]);

    await expect(
      commerceNotificationsForEvent(query, domainEvent('ProductionRunStartedV1')),
    ).resolves.toEqual([
      {
        cursor: '34',
        entityId: INVENTORY_A,
        schemaVersion: 1,
        stateRevision: '21',
        type: 'economy.inventory.changed',
        worldId: WORLD_ID,
      },
      {
        cursor: '34',
        entityId: INVENTORY_B,
        schemaVersion: 1,
        stateRevision: '21',
        type: 'economy.inventory.changed',
        worldId: WORLD_ID,
      },
      notification(),
    ]);
    expect(query.calls).toHaveLength(1);
    expect(query.calls[0]?.values).toEqual([WORLD_ID, RUN_ID]);
  });

  it('projects both sides of an inventory transfer without a database lookup', async () => {
    const query = new FakeQuery();
    const notifications = await commerceNotificationsForEvent(
      query,
      domainEvent('InventoryTransferredV1', {
        aggregateId: EVENT_ID,
        payload: { fromInventoryId: INVENTORY_B, toInventoryId: INVENTORY_A },
      }),
    );

    expect(notifications.map((item) => item.entityId)).toEqual([INVENTORY_A, INVENTORY_B]);
    expect(notifications.every((item) => item.type === 'economy.inventory.changed')).toBe(true);
    expect(query.calls).toEqual([]);
  });

  it('invalidates a taxed payroll treasury without exposing wage or participant data', async () => {
    const query = new FakeQuery([TREASURY_ID]);
    const notifications = await commerceNotificationsForEvent(
      query,
      domainEvent('PayrollSettledV1'),
    );

    expect(notifications).toEqual([
      {
        cursor: '34',
        entityId: TREASURY_ID,
        schemaVersion: 1,
        stateRevision: '21',
        type: 'economy.treasury.changed',
        worldId: WORLD_ID,
      },
    ]);
    expect(JSON.stringify(notifications)).not.toMatch(/amount|contract|payroll|walletId/u);
    expect(query.calls[0]?.values).toEqual([WORLD_ID, EVENT_ID]);
  });

  it('maps listing, trade, and direct treasury facts to their exact public IDs', async () => {
    const query = new FakeQuery();
    const cases: [CommerceRealtimeEvent, CommerceNotificationV1['type'], string][] = [
      [domainEvent('MarketListingPartiallyFilledV1'), 'economy.listing.changed', RUN_ID],
      [domainEvent('MarketTradeCompletedV1'), 'economy.trade.completed', RUN_ID],
      [
        domainEvent('TreasuryRevenueRecordedV1', {
          payload: { treasuryWalletId: TREASURY_ID },
        }),
        'economy.treasury.changed',
        TREASURY_ID,
      ],
    ];

    for (const [event, type, entityId] of cases) {
      await expect(commerceNotificationsForEvent(query, event)).resolves.toEqual([
        {
          cursor: '34',
          entityId,
          schemaVersion: 1,
          stateRevision: '21',
          type,
          worldId: WORLD_ID,
        },
      ]);
    }
    expect(query.calls).toEqual([]);
  });

  it('does not invent realtime messages for unrelated ledger facts', async () => {
    const query = new FakeQuery();
    await expect(
      commerceNotificationsForEvent(query, domainEvent('WorldNoticeEmittedV1')),
    ).resolves.toEqual([]);
    expect(query.calls).toEqual([]);
  });
});

// Compile-time assertion that the test adapter exercises the full metric surface.
const _metrics: CommerceRealtimeMetrics = { recordPublication: () => undefined };
void _metrics;
