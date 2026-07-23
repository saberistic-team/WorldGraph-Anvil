import { describe, expect, it, vi } from 'vitest';

import {
  ECONOMY_EXPIRY_LOCK_ORDER,
  PostgresEconomyOfferExpiryCommand,
  economyOfferExpiryRequestHashV1,
} from './postgres.js';

const request = {
  commandId: '018f8652-3cb6-7d52-904b-cce7901d7e30',
  eventId: '018f8652-3cb6-7d52-904b-cce7901d7e31',
  expectedOfferVersion: '1',
  expectedStateRevision: '8',
  expectedTick: '12',
  expectedWorldVersion: '2',
  idempotencyKey: 'economy-offer-expiry-v1:018f8652-3cb6-7d52-904b-cce7901d7e24:10',
  offerId: '018f8652-3cb6-7d52-904b-cce7901d7e24',
  worldId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
};

describe('Postgres economy expiry system command', () => {
  it('publishes the global application-owned lock order explicitly', () => {
    expect(ECONOMY_EXPIRY_LOCK_ORDER).toEqual([
      'world_runtime',
      'economy_head',
      'simulation_clock',
      'offer',
    ]);
  });

  it('fails closed before touching PostgreSQL for malformed identities or versions', async () => {
    const connect = vi.fn();
    const command = new PostgresEconomyOfferExpiryCommand({ connect } as never, {
      ids: { next: () => request.eventId },
      retryDelay: async () => undefined,
    });
    await expect(command.expire({ ...request, expectedTick: '-1' })).rejects.toThrow(
      'ECONOMY_EXPIRY_REQUEST_INVALID',
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('replays an accepted fixed-key command without reopening the write gate', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('where id = $1 for update')) {
          return {
            rowCount: 1,
            rows: [
              {
                actor_id: 'worldgraph:economy-offer-reconciler',
                actor_type: 'system',
                command_type: 'ExpireAssetTransferOfferV1',
                id: request.commandId,
                idempotency_key: request.idempotencyKey,
                request_hash: economyOfferExpiryRequestHashV1(request),
                response_summary: { resultingStateRevision: '9', status: 'accepted' },
                status: 'accepted',
                world_id: request.worldId,
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };
    const command = new PostgresEconomyOfferExpiryCommand(
      { connect: vi.fn(async () => client) } as never,
      { ids: { next: () => request.eventId }, retryDelay: async () => undefined },
    );
    await expect(command.expire(request)).resolves.toEqual({
      resultingStateRevision: '9',
      status: 'expired',
    });
    expect(queries.some((query) => query.includes('worldgraph_open_command_write'))).toBe(false);
    expect(queries.at(-1)).toBe('rollback');
  });
});
