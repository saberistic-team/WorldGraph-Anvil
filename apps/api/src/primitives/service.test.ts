import { describe, expect, it } from 'vitest';

import type { AuthenticatedActor } from '../identity/service.js';
import { PrimitiveService } from './service.js';
import type { PrimitiveCursorTuple, PrimitiveRepository } from './repository.js';

const actor = {
  csrfHash: Buffer.alloc(32),
  session: {
    absoluteExpiresAt: '2026-07-22T12:00:00.000Z',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e24',
    idleExpiresAt: '2026-07-21T13:00:00.000Z',
  },
  user: {
    displayName: 'Reader',
    email: 'reader@example.test',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
    platformRole: 'user',
    rowVersion: 1,
    status: 'active',
  },
} as AuthenticatedActor;

describe('PrimitiveService cursors', () => {
  it('bounds and round-trips a worst-case signed cursor with complete filter binding', async () => {
    const tail: PrimitiveCursorTuple = {
      id: '018f8652-3cb6-7d52-904b-cce7901d7e26',
      key: `a.b.${'c'.repeat(156)}`,
      sortKey: '9'.repeat(96),
      version: `1.${'9'.repeat(58)}.1`,
    };
    let received: PrimitiveCursorTuple | null = null;
    const repository = {
      list: async (filter: { cursor: PrimitiveCursorTuple | null }) => {
        received = filter.cursor;
        return { items: [], tail: filter.cursor ? null : tail };
      },
    } as unknown as PrimitiveRepository;
    const service = new PrimitiveService(
      repository,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      { next: () => '018f8652-3cb6-7d52-904b-cce7901d7e27' },
      { publish: async () => undefined },
      'test-only-cursor-secret-32-characters',
    );
    const first = await service.list(actor, {
      kinds: ['government'],
      limit: 100,
      tags: ['city-state'],
    });
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor!.length).toBeLessThanOrEqual(1024);
    await service.list(actor, {
      cursor: first.nextCursor!,
      kinds: ['government'],
      limit: 100,
      tags: ['city-state'],
    });
    expect(received).toEqual(tail);
  });

  it('fails closed when the exact filter-first catalog scope exceeds 500 rows', async () => {
    const repository = {
      retrievalSnapshot: async () => ({ rows: [], scopeSize: 501 }),
    } as unknown as PrimitiveRepository;
    const service = new PrimitiveService(
      repository,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      { next: () => '018f8652-3cb6-7d52-904b-cce7901d7e27' },
      { publish: async () => undefined },
      'test-only-cursor-secret-32-characters',
    );
    await expect(service.retrieve(actor, { query: 'guild council' })).rejects.toMatchObject({
      code: 'RETRIEVAL_UNAVAILABLE',
      details: { limit: 500, reasonCode: 'CATALOG_SCOPE_LIMIT' },
      statusCode: 503,
    });
  });

  it('rejects structurally unsafe compatibility filters before database retrieval', async () => {
    let retrieved = false;
    const repository = {
      retrievalSnapshot: async () => {
        retrieved = true;
        return { rows: [], scopeSize: 0 };
      },
    } as unknown as PrimitiveRepository;
    const service = new PrimitiveService(
      repository,
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
      { next: () => '018f8652-3cb6-7d52-904b-cce7901d7e27' },
      { publish: async () => undefined },
      'test-only-cursor-secret-32-characters',
    );
    const compatibility = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    await expect(
      service.retrieve(actor, { compatibility, query: 'guild council' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [expect.objectContaining({ code: 'PROTOTYPE_KEY_FORBIDDEN' })] },
      statusCode: 400,
    });
    expect(retrieved).toBe(false);
  });

  it('rejects an enabled local query source that does not match the immutable index profile', () => {
    expect(
      () =>
        new PrimitiveService(
          {} as PrimitiveRepository,
          { now: () => new Date('2026-07-21T12:00:00.000Z') },
          { next: () => '018f8652-3cb6-7d52-904b-cce7901d7e27' },
          { publish: async () => undefined },
          'test-only-cursor-secret-32-characters',
          {
            configurationId: 'query-v1',
            enabled: true,
            execution: 'local',
            model: 'fixed-v1',
            provider: 'local-test',
            vectorize: async () => Array<number>(1536).fill(1),
          },
          { configurationId: 'index-v2', model: 'fixed-v2', provider: 'local-test' },
        ),
    ).toThrow('must match exactly');
  });
});
