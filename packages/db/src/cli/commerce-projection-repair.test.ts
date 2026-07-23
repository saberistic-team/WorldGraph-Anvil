import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson, type CommerceProjectionRepairPlanV1 } from '@worldgraph/contracts';

import {
  assertOperatorCommerceProjectionRepairPlan,
  validateCommerceProjectionRepairReason,
} from './commerce-projection-repair.js';

const id = (value: number): string => `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;

function repairPlan(): CommerceProjectionRepairPlanV1 {
  const body = {
    domain: 'worldgraph.commerce-projection-repair-plan.v1',
    expiresAt: '2026-07-22T12:15:00.000Z',
    items: [
      {
        actualQuantity: '8.000000000000',
        actualReservedQuantity: '3',
        expectedRowVersion: '7',
        inventoryId: id(10),
        itemOrdinal: 0,
        mismatchKinds: ['quantity', 'reservation'],
        repairFactId: id(20),
        repairedQuantity: '10',
        repairedReservedQuantity: '2',
      },
      {
        actualQuantity: '12',
        actualReservedQuantity: '1',
        expectedRowVersion: '4',
        inventoryId: id(11),
        itemOrdinal: 1,
        mismatchKinds: ['reservation'],
        repairFactId: id(21),
        repairedQuantity: '12.000000000000',
        repairedReservedQuantity: '0',
      },
    ],
    preparedAt: '2026-07-22T12:00:00.000Z',
    preparedByUserId: id(1),
    reason: 'INCIDENT-COMMERCE-001 exact inventory repair is required',
    repairPlanId: id(2),
    repairPlanSchemaVersion: 1,
    reservedCommandId: id(3),
    reservedEventId: id(4),
    reservedLedgerEntryId: id(5),
    sourceEconomyChecksum: 'a'.repeat(64),
    sourceEconomyHeadVersion: '4',
    sourceEventSequence: '18',
    sourceExpansionChecksum: 'b'.repeat(64),
    sourceExpansionHeadVersion: '5',
    sourceLedgerSequence: '21',
    sourceReconciliationLiveChecksum: 'd'.repeat(64),
    sourceReconciliationRebuiltChecksum: 'c'.repeat(64),
    sourceReconciliationRunId: id(6),
    sourceStateRevision: '18',
    sourceWorldVersion: '2',
    worldId: id(7),
  } as const satisfies Omit<CommerceProjectionRepairPlanV1, 'planHash'>;
  return {
    ...body,
    planHash: createHash('sha256')
      .update(
        canonicalJson({
          domain: 'worldgraph.commerce-projection-repair-plan-hash.v1',
          plan: body,
        }),
      )
      .digest('hex'),
  };
}

function reseal(
  plan: CommerceProjectionRepairPlanV1,
  changes: Partial<Omit<CommerceProjectionRepairPlanV1, 'planHash'>>,
): CommerceProjectionRepairPlanV1 {
  const changed = { ...plan, ...changes };
  const body = Object.fromEntries(
    Object.entries(changed).filter(([key]) => key !== 'planHash'),
  ) as Omit<CommerceProjectionRepairPlanV1, 'planHash'>;
  return {
    ...body,
    planHash: createHash('sha256')
      .update(
        canonicalJson({
          domain: 'worldgraph.commerce-projection-repair-plan-hash.v1',
          plan: body,
        }),
      )
      .digest('hex'),
  };
}

describe('commerce projection repair operator validation', () => {
  it('accepts only the exact canonical, ordered, mismatched plan', () => {
    const plan = repairPlan();
    expect(assertOperatorCommerceProjectionRepairPlan(plan)).toEqual(plan);
    expect(() =>
      assertOperatorCommerceProjectionRepairPlan({ ...plan, planHash: 'd'.repeat(64) }),
    ).toThrow('invalid canonical plan hash');
    expect(() =>
      assertOperatorCommerceProjectionRepairPlan(
        reseal(plan, { items: [...plan.items].reverse() }),
      ),
    ).toThrow('ordinal-contiguous');
    expect(() =>
      assertOperatorCommerceProjectionRepairPlan(
        reseal(plan, {
          items: [
            {
              ...plan.items[0]!,
              repairedQuantity: plan.items[0]!.actualQuantity,
            },
            plan.items[1]!,
          ],
        }),
      ),
    ).toThrow('mismatch kinds');
  });

  it('rejects stale, non-mismatched, duplicate-id, and over-reserved plans', () => {
    const plan = repairPlan();
    expect(() =>
      assertOperatorCommerceProjectionRepairPlan(
        reseal(plan, { expiresAt: '2026-07-22T12:16:00.000Z' }),
      ),
    ).toThrow('exact 15-minute review window');
    expect(() =>
      assertOperatorCommerceProjectionRepairPlan(
        reseal(plan, {
          sourceReconciliationRebuiltChecksum: plan.sourceReconciliationLiveChecksum,
        }),
      ),
    ).toThrow('actual reconciliation mismatch');
    expect(() =>
      assertOperatorCommerceProjectionRepairPlan(
        reseal(plan, {
          items: [{ ...plan.items[0]!, repairFactId: plan.reservedEventId }, plan.items[1]!],
        }),
      ),
    ).toThrow('reuses a reserved effect identity');
    expect(() =>
      assertOperatorCommerceProjectionRepairPlan(
        reseal(plan, {
          items: [{ ...plan.items[0]!, repairedReservedQuantity: '11' }, plan.items[1]!],
        }),
      ),
    ).toThrow('inventory reservation bound');
  });

  it('preserves valid Unicode reasons and rejects boundary/control normalization', () => {
    expect(validateCommerceProjectionRepairReason('事件-商務-001 😀 exact repair evidence')).toBe(
      '事件-商務-001 😀 exact repair evidence',
    );
    for (const reason of [
      'too short',
      ' incident reason has a leading space',
      'incident reason has a trailing space ',
      `incident reason has a control\u0085character`,
      '😀'.repeat(1_001),
    ]) {
      expect(() => validateCommerceProjectionRepairReason(reason)).toThrow(
        '20-1000 Unicode code points',
      );
    }
  });
});
