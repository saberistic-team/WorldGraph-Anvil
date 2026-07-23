import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { ApplicationError } from '../application/errors.js';
import {
  appendAcceptedLegacyMutation,
  appendRejectedLegacyMutation,
  decodeDurableLegacyRejection,
  derivedLegacyLedgerUuid,
  encodeDurableLegacyRejection,
  type LegacyBuiltCommand,
  type LegacyLedgerExecutor,
} from './legacy-mutation-ledger.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e21';
const at = new Date('2026-07-22T12:00:00.000Z');

interface CapturedQuery {
  text: string;
  values: unknown[];
}

class CapturingExecutor implements LegacyLedgerExecutor {
  public readonly queries: CapturedQuery[] = [];

  public constructor(private readonly anchored = true) {}

  public async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    const normalized = text.replace(/\s+/gu, ' ').trim();
    if (normalized.includes('from world_runtime_heads runtime')) {
      return result(
        this.anchored
          ? [
              {
                last_entry_hash: Buffer.alloc(32, 1),
                ledger_anchored_at: at,
                ledger_head_anchored_at: at,
                next_event_sequence: '8',
                next_ledger_sequence: '13',
                state_revision: '5',
              },
            ]
          : [
              {
                last_entry_hash: null,
                ledger_anchored_at: null,
                ledger_head_anchored_at: null,
                next_event_sequence: '1',
                next_ledger_sequence: '1',
                state_revision: '0',
              },
            ],
      ) as unknown as QueryResult<Row>;
    }
    if (normalized.includes('as aggregate_version')) {
      return result([{ aggregate_version: '1' }]) as unknown as QueryResult<Row>;
    }
    if (normalized.includes('worldgraph_projection_checksum')) {
      return result([{ checksum: Buffer.alloc(32, 2) }]) as unknown as QueryResult<Row>;
    }
    return result([], 1);
  }
}

describe('legacy world mutation ledger adapter', () => {
  it('atomically appends an allowlisted event and only privacy-safe references', async () => {
    const executor = new CapturingExecutor();
    const input = {
      actorType: 'user' as const,
      authorizationRuleId: 'world.creator_or_admin',
      command: command('world.rename'),
      decidedAt: at,
      event: {
        aggregateId: worldId,
        aggregateType: 'world' as const,
        eventType: 'WorldRenamedV1' as const,
        payload: { newName: 'New Anvil Reach', previousName: 'Anvil Reach' },
      },
      worldId,
    };

    await expect(appendAcceptedLegacyMutation(executor, input)).resolves.toEqual({
      kind: 'appended',
      resultingStateRevision: '6',
    });
    const domainInsert = findQuery(executor, 'insert into domain_events');
    expect(domainInsert.values[7]).toBe('WorldRenamedV1');
    expect(JSON.parse(domainInsert.values[9] as string)).toEqual(input.event.payload);
    expect(domainInsert.values[0]).toBe(derivedLegacyLedgerUuid(commandId, 'event:0'));
    expect(findQueries(executor, 'insert into ledger_entries')).toHaveLength(2);
    expect(findQueries(executor, 'insert into world_history_entries')).toHaveLength(1);
    expect(findQueries(executor, 'insert into outbox_messages')).toHaveLength(1);
    expect(findQueries(executor, 'update world_runtime_heads')).toHaveLength(1);
    expect(findQueries(executor, 'update command_records')).toHaveLength(1);
    expect(JSON.stringify(executor.queries)).not.toMatch(/email|rawToken|tokenDigest/iu);

    const retried = new CapturingExecutor();
    await appendAcceptedLegacyMutation(retried, input);
    expect(findQuery(retried, 'insert into domain_events').values[0]).toBe(domainInsert.values[0]);
    expect(
      findQueries(retried, 'insert into ledger_entries').map((query) => query.values[0]),
    ).toEqual(findQueries(executor, 'insert into ledger_entries').map((query) => query.values[0]));
  });

  it('does not fabricate command history before the genesis anchor', async () => {
    const executor = new CapturingExecutor(false);
    await expect(
      appendAcceptedLegacyMutation(executor, {
        actorType: 'user',
        authorizationRuleId: 'manifest.creator_only',
        command: command('manifest.revision.create'),
        decidedAt: at,
        event: {
          aggregateId: commandId,
          aggregateType: 'manifest_revision',
          eventType: 'ManifestRevisionCreatedV1',
          payload: {
            contentHash: 'a'.repeat(64),
            manifestSchemaVersion: 1,
            revisionId: commandId,
            revisionNumber: '1',
            source: 'manual',
          },
        },
        worldId,
      }),
    ).resolves.toEqual({ kind: 'unanchored' });
    expect(executor.queries).toHaveLength(1);
  });

  it('records a durable rejection without a domain event or state-revision change', async () => {
    const executor = new CapturingExecutor();
    await expect(
      appendRejectedLegacyMutation(executor, {
        actorType: 'user',
        command: command('membership.remove'),
        decidedAt: at,
        rejectionCode: 'REVISION_CONFLICT',
        worldId,
      }),
    ).resolves.toEqual({ kind: 'appended', resultingStateRevision: '5' });
    expect(findQueries(executor, 'insert into domain_events')).toHaveLength(0);
    expect(findQueries(executor, 'insert into outbox_messages')).toHaveLength(0);
    expect(findQueries(executor, 'insert into ledger_entries')).toHaveLength(1);
    const runtimeUpdateSetClause = findQuery(executor, 'update world_runtime_heads').text.split(
      /\bwhere\b/iu,
      1,
    )[0];
    expect(runtimeUpdateSetClause).not.toContain('state_revision =');
    const terminal = findQuery(executor, 'update command_records');
    expect(terminal.values[1]).toBe('REVISION_CONFLICT');
  });

  it('rejects action/event mismatches before any write', async () => {
    const executor = new CapturingExecutor();
    await expect(
      appendAcceptedLegacyMutation(executor, {
        actorType: 'user',
        authorizationRuleId: 'world.creator_or_admin',
        command: command('world.rename'),
        decidedAt: at,
        event: {
          aggregateId: actorId,
          aggregateType: 'world_membership',
          eventType: 'WorldMembershipRemovedV1',
          payload: { previousRole: 'player', targetUserId: actorId },
        },
        worldId,
      }),
    ).rejects.toThrow('action/event registration mismatch');
    expect(executor.queries).toHaveLength(0);
  });

  it('persists replayable error semantics while removing secret-shaped detail keys', () => {
    const error = new ApplicationError('FORBIDDEN', 'Not permitted.', 403, {
      rawToken: 'must-not-survive',
      reasonCode: 'ROLE_REQUIRED',
      ruleId: 'membership.creator_only',
    });
    const body = encodeDurableLegacyRejection(error);
    expect(JSON.stringify(body)).not.toContain('must-not-survive');
    expect(decodeDurableLegacyRejection(body)).toMatchObject({
      code: 'FORBIDDEN',
      details: { reasonCode: 'ROLE_REQUIRED', ruleId: 'membership.creator_only' },
      message: 'Not permitted.',
      statusCode: 403,
    });
  });
});

function command(action: string): LegacyBuiltCommand {
  const built = {
    action,
    actorUserId: actorId,
    commandId,
    correlationId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
    expectedRowVersion: 1,
    idempotencyKey: 'legacy-ledger-test-001',
    requestHash: 'c'.repeat(64),
    requestId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
    requestHashBytes: Buffer.alloc(32, 3),
    resourceId: worldId,
    schemaVersion: 1 as const,
  };
  return built;
}

function findQueries(executor: CapturingExecutor, fragment: string): CapturedQuery[] {
  return executor.queries.filter((query) => query.text.includes(fragment));
}

function findQuery(executor: CapturingExecutor, fragment: string): CapturedQuery {
  const query = findQueries(executor, fragment)[0];
  if (!query) throw new Error(`Missing query: ${fragment}`);
  return query;
}

function result<Row extends QueryResultRow>(rows: Row[], rowCount = rows.length): QueryResult<Row> {
  return {
    command: '',
    fields: [],
    oid: 0,
    rowCount,
    rows,
  };
}
