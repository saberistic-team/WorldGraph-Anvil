import { describe, expect, it, vi } from 'vitest';

import { PostgresCommerceScheduleRepository } from './commerce-schedule-repository.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const actionId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const completedEventId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const targetId = '018f8652-3cb6-7d52-904b-cce7901d7e28';

describe('Postgres commerce schedule repository', () => {
  it('discovers completed target-ID schedules without an accepted linked effect', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [
        {
          action_schema_version: 1,
          action_type: 'CompleteProductionRunV1',
          completed_event_id: completedEventId,
          current_tick: '14',
          due_tick: '12',
          payload: { productionRunId: targetId },
          process_version: '1.0.0',
          schedule_sequence: '7',
          scheduled_action_id: actionId,
          world_id: worldId,
        },
      ],
    }));
    const repository = new PostgresCommerceScheduleRepository({ query } as never, [targetId]);
    await expect(repository.findPendingEffects(25)).resolves.toEqual([
      {
        actionType: 'CompleteProductionRunV1',
        completedEventId,
        currentTick: '14',
        dueTick: '12',
        payload: { productionRunId: targetId },
        scheduleSequence: '7',
        scheduledActionId: actionId,
        worldId,
      },
    ]);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("action.status = 'completed'");
    expect(sql).toContain('command.causation_id = action.completed_event_id');
    expect(sql).toContain("command.status = 'accepted'");
    expect(sql).toContain('order by action.due_tick, action.priority');
    const payrollClause = sql.slice(
      sql.indexOf("when 'SettlePayrollV1'"),
      sql.indexOf("when 'ExpireMarketListingV1'"),
    );
    expect(payrollClause).not.toContain('tax_policies');
    expect(payrollClause).not.toContain('tax_policy_id');
    expect(payrollClause).not.toContain('clock.current_tick');
    const periodicClause = sql.slice(
      sql.indexOf("when 'AssessPeriodicTaxV1'"),
      sql.indexOf('else false'),
    );
    expect(periodicClause).toContain('worldgraph_tax_policy_effective_at_v2(');
    expect(periodicClause).not.toContain('policy.effective_until_tick > clock.current_tick');
    expect(periodicClause).toContain('not (policy.id = any($2::uuid[]))');
    expect(sql).toContain('($3::uuid is null or action.world_id = $3::uuid)');
    expect(values).toEqual([
      [
        'CompleteProductionRunV1',
        'SettlePayrollV1',
        'ExpireMarketListingV1',
        'AssessPeriodicTaxV1',
      ],
      [targetId],
      null,
      25,
    ]);
  });

  it('can scope deterministic reconciliation to one world before applying the batch limit', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    const repository = new PostgresCommerceScheduleRepository({ query } as never, [], worldId);

    await expect(repository.findPendingEffects(25)).resolves.toEqual([]);
    expect(query.mock.calls[0]![1]).toEqual([
      [
        'CompleteProductionRunV1',
        'SettlePayrollV1',
        'ExpireMarketListingV1',
        'AssessPeriodicTaxV1',
      ],
      [],
      worldId,
      25,
    ]);
  });

  it('rejects an unsafe world scope before querying', async () => {
    const query = vi.fn();
    expect(
      () => new PostgresCommerceScheduleRepository({ query } as never, [], 'not-a-world-id'),
    ).toThrow('COMMERCE_SCHEDULE_WORLD_SCOPE_INVALID');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects payloads with computed fields or mismatched target identity', async () => {
    const repository = new PostgresCommerceScheduleRepository({
      query: vi.fn(async () => ({
        rows: [
          {
            action_schema_version: 1,
            action_type: 'SettlePayrollV1',
            completed_event_id: completedEventId,
            current_tick: '12',
            due_tick: '12',
            payload: { grossMinor: '100', payrollRecordId: targetId },
            process_version: '1.0.0',
            schedule_sequence: '8',
            scheduled_action_id: actionId,
            world_id: worldId,
          },
        ],
      })),
    } as never);
    await expect(repository.findPendingEffects(25)).rejects.toThrow(
      'COMMERCE_SCHEDULE_PAYLOAD_INVALID',
    );
  });

  it('fails closed before querying for an unsafe batch size', async () => {
    const query = vi.fn();
    const repository = new PostgresCommerceScheduleRepository({ query } as never);
    await expect(repository.findPendingEffects(0)).rejects.toThrow(
      'COMMERCE_SCHEDULE_DISCOVERY_LIMIT_INVALID',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
