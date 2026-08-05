import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type { Pool } from '@worldgraph/db';
import {
  MAX_SCHEDULED_ACTIONS_PER_TICK,
  MAX_SCHEDULED_ACTIONS_PER_WORLD,
  canonicalJson,
} from '@worldgraph/contracts';

import {
  PostgresCommerceScheduledCommand,
  commerceScheduleCapacityAvailableV1,
  commerceScheduledRequestHashV1,
  parsePostgresQuantityV1,
} from './commerce-scheduled-postgres.js';
import type { CommerceScheduledCommandRequest } from './types.js';

const request: CommerceScheduledCommandRequest = {
  actionType: 'CompleteProductionRunV1',
  commandId: '019c1111-1111-7111-8111-111111111111',
  completedEventId: '019c2222-2222-7222-8222-222222222222',
  dueTick: '42',
  idempotencyKey:
    'commerce-schedule-v1:CompleteProductionRunV1:019c3333-3333-7333-8333-333333333333',
  payload: { productionRunId: '019c4444-4444-7444-8444-444444444444' },
  scheduleSequence: '7',
  scheduledActionId: '019c3333-3333-7333-8333-333333333333',
  worldId: '019c5555-5555-7555-8555-555555555555',
};

function acceptedStoredCommand(
  storedRequest: CommerceScheduledCommandRequest,
  resultingStateRevision = '91',
) {
  return {
    actor_id: 'worldgraph:commerce-scheduler',
    actor_type: 'system',
    causation_id: storedRequest.completedEventId,
    command_type: storedRequest.actionType,
    id: storedRequest.commandId,
    idempotency_key: storedRequest.idempotencyKey,
    request_hash: commerceScheduledRequestHashV1(storedRequest),
    response_summary: { resultingStateRevision },
    status: 'accepted',
    world_id: storedRequest.worldId,
  };
}

describe('commerce scheduled Postgres command', () => {
  it('normalizes only zero-padded PostgreSQL numeric digits beyond the declared scale', () => {
    expect(parsePostgresQuantityV1('100.000000000000', 0)).toBe(100n);
    expect(parsePostgresQuantityV1('1.230000000000', 2)).toBe(123n);
    expect(() => parsePostgresQuantityV1('1.230100000000', 2)).toThrow(
      'COMMERCE_DATABASE_QUANTITY_INVALID',
    );
  });

  it('hashes schedule provenance and the exact ID-only internal payload', () => {
    const first = commerceScheduledRequestHashV1(request);
    expect(commerceScheduledRequestHashV1({ ...request })).toEqual(first);
    expect(
      commerceScheduledRequestHashV1({
        ...request,
        completedEventId: '019c6666-6666-7666-8666-666666666666',
      }),
    ).not.toEqual(first);
    expect(
      commerceScheduledRequestHashV1({
        ...request,
        dueTick: '43',
      }),
    ).not.toEqual(first);
  });

  it('reserves conservative scheduler capacity before periodic recurrence', async () => {
    expect(
      commerceScheduleCapacityAvailableV1({
        tick_count: String(MAX_SCHEDULED_ACTIONS_PER_TICK - 1),
        world_count: String(MAX_SCHEDULED_ACTIONS_PER_WORLD - 1),
      }),
    ).toBe(true);
    expect(
      commerceScheduleCapacityAvailableV1({
        tick_count: String(MAX_SCHEDULED_ACTIONS_PER_TICK),
        world_count: '0',
      }),
    ).toBe(false);
    expect(
      commerceScheduleCapacityAvailableV1({
        tick_count: '0',
        world_count: String(MAX_SCHEDULED_ACTIONS_PER_WORLD),
      }),
    ).toBe(false);
    expect(() =>
      commerceScheduleCapacityAvailableV1({ tick_count: '-1', world_count: '0' }),
    ).toThrow('COMMERCE_SCHEDULE_CAPACITY_INVALID');

    const source = await readFile(
      new URL('commerce-scheduled-postgres.ts', import.meta.url),
      'utf8',
    );
    const periodicStart = source.indexOf('async function assessPeriodicTax(');
    const periodicEnd = source.indexOf('function parseResourceSnapshot(', periodicStart);
    const periodic = source.slice(periodicStart, periodicEnd);
    expect(periodic).toContain("where world_id=$1 and status='scheduled'");
    expect(periodic).toContain("return { status: 'not_ready' }");
    expect(periodic.indexOf('hasScheduledActionCapacity(')).toBeLessThan(
      periodic.indexOf('applyFinancialTransaction('),
    );
  });

  it('replays an accepted deterministic key without opening another write gate', async () => {
    const queries: string[] = [];
    const client = {
      async query(text: string) {
        queries.push(text);
        if (text.includes('where id=$1 for update')) return { rowCount: 0, rows: [] };
        if (text.includes("actor_type='system'")) {
          return {
            rowCount: 1,
            rows: [
              {
                actor_id: 'worldgraph:commerce-scheduler',
                actor_type: 'system',
                causation_id: request.completedEventId,
                command_type: request.actionType,
                id: '019c7777-7777-7777-8777-777777777777',
                idempotency_key: request.idempotencyKey,
                request_hash: commerceScheduledRequestHashV1(request),
                response_summary: { resultingStateRevision: '91' },
                status: 'accepted',
                world_id: request.worldId,
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
      release() {},
    };
    const pool = {
      async connect() {
        return client;
      },
    } as unknown as Pool;
    const command = new PostgresCommerceScheduledCommand(pool, {
      ids: { next: () => '019c8888-8888-7888-8888-888888888888' },
    });

    await expect(command.execute(request)).resolves.toEqual({
      resultingStateRevision: '91',
      status: 'applied',
    });
    expect(queries.some((query) => query.includes('worldgraph_open_command_write'))).toBe(false);
    expect(queries.at(-1)).toBe('rollback');
  });

  it('re-reads an exact replay after a concurrent command receipt wins', async () => {
    const attempts: string[][] = [];
    const retryDelay = vi.fn(async () => undefined);
    const connect = vi.fn(async () => {
      const attempt = attempts.length;
      const queries: string[] = [];
      attempts.push(queries);
      return {
        async query(sql: string) {
          queries.push(sql);
          if (attempt === 0 && sql.includes('insert into command_records')) {
            throw Object.assign(new Error('duplicate command receipt'), {
              code: '23505',
              constraint: 'command_records_pkey',
            });
          }
          if (attempt === 1 && sql.includes('where id=$1 for update')) {
            return { rowCount: 1, rows: [acceptedStoredCommand(request)] };
          }
          return { rowCount: 0, rows: [] };
        },
        release: vi.fn(),
      };
    });
    const command = new PostgresCommerceScheduledCommand({ connect } as unknown as Pool, {
      ids: { next: () => '019c8888-8888-7888-8888-888888888888' },
      retryDelay,
    });

    await expect(command.execute(request)).resolves.toEqual({
      resultingStateRevision: '91',
      status: 'applied',
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledOnce();
    expect(retryDelay).toHaveBeenCalledWith(0);
    expect(attempts.flat().filter((sql) => sql === 'rollback')).toHaveLength(2);
    expect(attempts.flat().some((sql) => sql.includes('worldgraph_open_command_write'))).toBe(
      false,
    );
  });

  it('returns conflict after a raced idempotency key resolves to a changed payload', async () => {
    const changedRequest: CommerceScheduledCommandRequest = {
      ...request,
      commandId: '019c6666-6666-7666-8666-666666666666',
      payload: { productionRunId: '019c7777-7777-7777-8777-777777777777' },
    };
    const attempts: string[][] = [];
    const retryDelay = vi.fn(async () => undefined);
    const connect = vi.fn(async () => {
      const attempt = attempts.length;
      const queries: string[] = [];
      attempts.push(queries);
      return {
        async query(sql: string) {
          queries.push(sql);
          if (attempt === 0 && sql.includes('insert into command_records')) {
            throw Object.assign(new Error('duplicate idempotency key'), {
              code: '23505',
              constraint: 'command_records_idempotency_unique',
            });
          }
          if (attempt === 1 && sql.includes("actor_type='system'")) {
            return { rowCount: 1, rows: [acceptedStoredCommand(request)] };
          }
          return { rowCount: 0, rows: [] };
        },
        release: vi.fn(),
      };
    });
    const command = new PostgresCommerceScheduledCommand({ connect } as unknown as Pool, {
      ids: { next: () => '019c8888-8888-7888-8888-888888888888' },
      retryDelay,
    });

    await expect(command.execute(changedRequest)).resolves.toEqual({ status: 'conflict' });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledOnce();
    expect(attempts.flat().filter((sql) => sql === 'rollback')).toHaveLength(2);
    expect(attempts.flat().some((sql) => sql.includes('worldgraph_open_command_write'))).toBe(
      false,
    );
  });

  it('does not retry unrelated unique violations', async () => {
    const retryDelay = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({
      async query(sql: string) {
        if (sql.includes('insert into command_records')) {
          throw Object.assign(new Error('unrelated uniqueness failure'), {
            code: '23505',
            constraint: 'some_other_unique_constraint',
          });
        }
        return { rowCount: 0, rows: [] };
      },
      release: vi.fn(),
    }));
    const command = new PostgresCommerceScheduledCommand({ connect } as unknown as Pool, {
      ids: { next: () => '019c8888-8888-7888-8888-888888888888' },
      retryDelay,
    });

    await expect(command.execute(request)).rejects.toMatchObject({
      code: '23505',
      constraint: 'some_other_unique_constraint',
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(retryDelay).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied fields beyond the one target identifier', async () => {
    const pool = {
      async connect() {
        throw new Error('should not connect');
      },
    } as unknown as Pool;
    const command = new PostgresCommerceScheduledCommand(pool, {
      ids: { next: () => '019c8888-8888-7888-8888-888888888888' },
    });
    const injected = {
      ...request,
      payload: { ...request.payload, grossMinor: '999999999' },
    } as unknown as CommerceScheduledCommandRequest;

    await expect(command.execute(injected)).rejects.toThrow('COMMERCE_SCHEDULED_REQUEST_INVALID');
  });

  it('rejects a disabled periodic policy before opening a transaction', async () => {
    const taxPolicyId = '019c9999-9999-7999-8999-999999999999';
    const connect = vi.fn(async () => {
      throw new Error('should not connect');
    });
    const command = new PostgresCommerceScheduledCommand({ connect } as unknown as Pool, {
      disabledTaxPolicyIds: [taxPolicyId],
      ids: { next: () => '019c8888-8888-7888-8888-888888888888' },
    });
    const periodicRequest: CommerceScheduledCommandRequest = {
      ...request,
      actionType: 'AssessPeriodicTaxV1',
      idempotencyKey:
        'commerce-schedule-v1:AssessPeriodicTaxV1:019c3333-3333-7333-8333-333333333333',
      payload: { taxPolicyId },
    };

    await expect(command.execute(periodicRequest)).rejects.toThrow('COMMERCE_TAX_POLICY_DISABLED');
    expect(connect).not.toHaveBeenCalled();
  });

  it('keeps the adapter system-only and derives recurrence from authoritative state', async () => {
    const source = await readFile(
      new URL('commerce-scheduled-postgres.ts', import.meta.url),
      'utf8',
    );
    for (const forbidden of [
      /from ['"](?:bullmq|ioredis|fastify|next|openai)/u,
      /\bfetch\s*\(/u,
      /\bMath\.random\s*\(/u,
      /\bDate\.now\s*\(/u,
      /\bprocess\.env/u,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
    expect(source).toContain('worldgraph_open_command_write');
    expect(source).toContain('worldgraph_assert_commerce_command_terminal');
    expect(source).toContain("sourceType: 'periodic_tax'");
    expect(source).toContain('BigInt(context.current_tick) + BigInt(applicability.intervalTicks)');
    expect(source).toContain("eventType: 'ScheduledActionCreatedV1'");
    expect(source).toContain('COMMERCE_SCHEDULER_ACTOR_ID');
  });

  it('settles the immutable payroll tax snapshot at the work tick after policy expiry', async () => {
    const source = await readFile(
      new URL('commerce-scheduled-postgres.ts', import.meta.url),
      'utf8',
    );
    const payrollStart = source.indexOf('async function settlePayroll(');
    const payrollEnd = source.indexOf('async function failPayroll(', payrollStart);
    const payroll = source.slice(payrollStart, payrollEnd);
    const policyLookupStart = source.indexOf('async function taxPolicyByIdAt(');
    const policyLookupEnd = source.indexOf('function taxPolicyState(', policyLookupStart);
    const policyLookup = source.slice(policyLookupStart, policyLookupEnd);

    expect(payroll).toContain('payroll.tax_policy_id');
    expect(payroll).toContain('payroll.performed_tick');
    expect(payroll).toContain('assessTax(snapshottedTaxPolicyState(policy), gross)');
    expect(payroll).toContain('occurredTick: payroll.performed_tick');
    expect(policyLookup).toContain(
      'worldgraph_tax_policy_effective_at_v2($1,$3::tax_policy_type,$4::bigint)',
    );
    expect(policyLookup).not.toContain('effective_until_tick >');
    expect(policyLookup).not.toContain("status='active'");
    expect(policyLookup).not.toContain('current_tick');
  });

  it('projects scheduled payroll history to both active participant controllers', async () => {
    const source = await readFile(
      new URL('commerce-scheduled-postgres.ts', import.meta.url),
      'utf8',
    );
    const payrollStart = source.indexOf('async function settlePayroll(');
    const payrollEnd = source.indexOf('async function assessPeriodicTax(', payrollStart);
    const payroll = source.slice(payrollStart, payrollEnd);
    const participantStart = source.indexOf('async function insertParticipantHistory(');
    const participantEnd = source.indexOf('async function upsertCheckpoint(', participantStart);
    const participantInsert = source.slice(participantStart, participantEnd);
    const finalizationStart = source.indexOf('async function finalizeScheduledCommand(');
    const finalizationEnd = source.indexOf('function createLedgerEntry(', finalizationStart);
    const finalization = source.slice(finalizationStart, finalizationEnd);

    expect(payroll).toContain('firstEntityId: payroll.employer_entity_id');
    expect(payroll).toContain('secondEntityId: payroll.worker_entity_id');
    expect(payroll).toContain("summaryCode: 'PAYROLL_SETTLED'");
    expect(payroll).toContain("summaryCode: 'PAYROLL_FAILED'");
    expect(payroll).toContain('contractId: payroll.contract_id');
    expect(payroll).toContain('payrollRecordId: payroll.id');
    expect(participantInsert).toContain('select distinct on (controller.user_id)');
    expect(participantInsert).toContain('party.counterparty_entity_id');
    expect(participantInsert).toContain('controller.revoked_at is null');
    expect(participantInsert).toContain("membership.status='active'");
    expect(participantInsert).toContain('worldgraph_user_controls_economy_entity_v1(');
    expect(participantInsert).not.toContain('controller.entity_id=party.participant_entity_id');
    expect(participantInsert).not.toMatch(/grossMinor|netMinor|taxMinor|availableMinor/u);
    expect(finalization).toContain('event.ledgerSequence');
    expect(finalization).toContain('input.context.recorded_at');
  });

  it('loads production outputs from the run facility and emits valid reservation SQL', async () => {
    const inputResourceId = '019c9999-9999-7999-8999-999999999991';
    const outputResourceId = '019c9999-9999-7999-8999-999999999992';
    const organizationId = '019c9999-9999-7999-8999-999999999993';
    const facilityAssetId = '019c9999-9999-7999-8999-999999999994';
    const inputInventoryId = '019c9999-9999-7999-8999-999999999995';
    const input = [{ quantity: '1', resourceTypeId: inputResourceId }];
    const output = [{ quantity: '1', resourceTypeId: outputResourceId }];
    const snapshotChecksum = createHash('sha256')
      .update(canonicalJson({ inputs: input, outputs: output }), 'utf8')
      .digest();
    let outputLookup: { sql: string; values: readonly unknown[] } | undefined;
    const now = new Date('2026-07-22T00:00:00.000Z');
    const client = {
      async query(sql: string, values: readonly unknown[] = []) {
        if (sql.includes('from command_records where id=$1 for update')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("actor_type='system'")) return { rowCount: 0, rows: [] };
        if (sql.includes('from worlds world')) {
          return {
            rowCount: 1,
            rows: [
              {
                active_world_version_id: '019c9999-9999-7999-8999-999999999996',
                anchor_artifact_hash: Buffer.alloc(32, 1),
                design_version: '1',
                last_event_sequence: '2',
                last_ledger_sequence: '3',
                ledger_anchored_at: now,
                lifecycle: 'active',
                recorded_at: now,
                state_revision: '4',
                world_id: request.worldId,
              },
            ],
          };
        }
        if (sql.includes('from world_economy_heads')) {
          return {
            rowCount: 1,
            rows: [
              { checksum: Buffer.alloc(32, 2), reconciliation_status: 'current', row_version: '1' },
            ],
          };
        }
        if (sql.includes('from world_economy_expansion_heads')) {
          return {
            rowCount: 1,
            rows: [
              { checksum: Buffer.alloc(32, 3), reconciliation_status: 'current', row_version: '1' },
            ],
          };
        }
        if (sql.includes('from world_simulation_clocks')) {
          return { rowCount: 1, rows: [{ current_tick: request.dueTick }] };
        }
        if (sql.includes('from scheduled_actions')) {
          return {
            rowCount: 1,
            rows: [
              {
                action_schema_version: 1,
                action_type: request.actionType,
                completed_event_id: request.completedEventId,
                due_tick: request.dueTick,
                payload: request.payload,
                process_version: '1.0.0',
                schedule_sequence: request.scheduleSequence,
                status: 'completed',
              },
            ],
          };
        }
        if (sql.includes('from production_runs run')) {
          return {
            rowCount: 1,
            rows: [
              {
                backing_organization_entity_id: organizationId,
                due_tick: request.dueTick,
                facility_asset_id: facilityAssetId,
                id: request.payload.productionRunId,
                input_snapshot: input,
                output_snapshot: output,
                row_version: '1',
                scheduled_action_id: request.scheduledActionId,
                snapshot_checksum: snapshotChecksum,
                status: 'ready',
              },
            ],
          };
        }
        if (sql.includes('from inventory_reservations reservation')) {
          return {
            rowCount: 1,
            rows: [
              {
                inventory_id: inputInventoryId,
                inventory_quantity: '4',
                inventory_reserved_quantity: '1',
                inventory_row_version: '1',
                quantity: '1',
                reservation_id: '019c9999-9999-7999-8999-999999999997',
                reservation_row_version: '1',
                resource_type_id: inputResourceId,
                scale: 0,
                status: 'active',
              },
            ],
          };
        }
        if (sql.includes('inventory.owner_entity_id=$2')) {
          outputLookup = { sql, values };
          throw new Error('STOP_AFTER_OUTPUT_LOOKUP');
        }
        return { rowCount: 1, rows: [] };
      },
      release() {},
    };
    const command = new PostgresCommerceScheduledCommand(
      { connect: async () => client } as unknown as Pool,
      { ids: { next: () => '019c9999-9999-7999-8999-999999999998' } },
    );

    await expect(command.execute(request)).rejects.toThrow('STOP_AFTER_OUTPUT_LOOKUP');
    expect(outputLookup?.sql).toContain('inventory.container_asset_id=$3');
    expect(outputLookup?.values).toEqual([
      request.worldId,
      organizationId,
      facilityAssetId,
      [outputResourceId],
    ]);

    const source = await readFile(
      new URL('commerce-scheduled-postgres.ts', import.meta.url),
      'utf8',
    );
    const reservationStart = source.indexOf('const reservationResult = await client.query(');
    const reservationEnd = source.indexOf('const reservations =', reservationStart);
    const reservationSql = source.slice(reservationStart, reservationEnd);
    expect(
      reservationSql.match(/inventory\.row_version::text as inventory_row_version/gu),
    ).toHaveLength(1);
    expect(reservationSql).toMatch(
      /inventory\.row_version::text as inventory_row_version,resource\.quantity_scale as scale\s+from/u,
    );
  });
});
