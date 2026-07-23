import { createLogger } from '@worldgraph/observability';
import { describe, expect, it, vi } from 'vitest';

import type { ClaimedOutboxMessage, OutboxBacklog, OutboxRepository } from './outbox-repository.js';
import { OutboxCoordinator, OutboxRunner } from './outbox-worker.js';

const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'outbox-test',
});
const message: ClaimedOutboxMessage = {
  attempts: 1,
  createdAt: new Date('2026-07-22T00:00:00.000Z'),
  eventId: '078f0000-0000-7000-8000-000000000002',
  id: '078f0000-0000-7000-8000-000000000001',
  messageSchemaVersion: 1,
  messageType: 'DomainEventReferenceV1',
  payload: { eventId: '078f0000-0000-7000-8000-000000000002' },
  worldId: '078f0000-0000-7000-8000-000000000003',
};

class FakeRepository implements OutboxRepository {
  public backlog: OutboxBacklog = { dead: 0, oldestReadyAgeMs: 10, ready: 1 };
  public claimed: ClaimedOutboxMessage[] = [message];
  public failure: 'dead' | 'lost_claim' | 'pending' = 'pending';
  public published = true;
  public readonly calls: string[] = [];

  public async claim(): Promise<ClaimedOutboxMessage[]> {
    this.calls.push('claim');
    return this.claimed;
  }
  public async inspectBacklog(): Promise<OutboxBacklog> {
    this.calls.push('backlog');
    return this.backlog;
  }
  public async markFailed(): Promise<'dead' | 'lost_claim' | 'pending'> {
    this.calls.push('failed');
    return this.failure;
  }
  public async publish(): Promise<boolean> {
    this.calls.push('publish');
    if (!this.published) throw new Error('temporary');
    return true;
  }
}

describe('transactional outbox runner', () => {
  it('claims only after observing lag and publishes a durable message', async () => {
    const repository = new FakeRepository();
    const result = await new OutboxRunner(repository, 'worker-a', logger).reconcile();
    expect(result).toEqual([{ message, outcome: 'published' }]);
    expect(repository.calls).toEqual(['backlog', 'claim', 'publish']);
  });

  it('schedules retry or dead-letter without losing the durable record', async () => {
    const repository = new FakeRepository();
    repository.published = false;
    expect(await new OutboxRunner(repository, 'worker-a', logger).reconcile()).toEqual([
      { message, outcome: 'retry' },
    ]);
    repository.calls.length = 0;
    repository.failure = 'dead';
    expect(await new OutboxRunner(repository, 'worker-a', logger).reconcile()).toEqual([
      { message, outcome: 'dead' },
    ]);
  });

  it('coalesces overlapping wakes and paces sequential polling', async () => {
    let release!: () => void;
    const reconcile = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    let now = 0;
    const coordinator = new OutboxCoordinator({ reconcile }, logger, {
      monotonicNow: () => now,
      reconciliationIntervalMs: 500,
    });
    const first = coordinator.wake();
    expect(coordinator.wake()).toBe(first);
    release();
    await first;
    expect(await coordinator.wake()).toEqual([]);
    now = 500;
    const second = coordinator.wake();
    release();
    await second;
    expect(reconcile).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });
});
