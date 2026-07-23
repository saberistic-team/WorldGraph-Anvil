import { describe, expect, it } from 'vitest';

import {
  ScheduledActionCreatedPayloadV1Schema,
  ScheduledActionV1Schema,
  SimulationOutcomeV1Schema,
} from './simulation.js';
import { createValidator } from './validation.js';

const uuid = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const targetId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const hash = 'a'.repeat(64);

describe('M09 commerce scheduler contracts', () => {
  it('accepts a target-ID-only production schedule and rejects cross-variant payloads', () => {
    const validator = createValidator(ScheduledActionV1Schema);
    const action = {
      actionSchemaVersion: 1,
      actionType: 'CompleteProductionRunV1',
      cancelledCommandId: null,
      completedEventId: null,
      completedStateRevision: null,
      createdAt: '2026-07-22T00:00:00.000Z',
      createdBy: { actorId: uuid, actorType: 'user' },
      createdCommandId: uuid,
      createdStateRevision: '1',
      dueTick: '12',
      id: uuid,
      payload: { productionRunId: targetId },
      payloadHash: hash,
      priority: 50,
      processVersion: '1.0.0',
      scheduleSchemaVersion: 1,
      scheduleSequence: '1',
      status: 'scheduled',
      updatedAt: '2026-07-22T00:00:00.000Z',
      worldId: uuid,
    };
    expect(validator.is(action)).toBe(true);
    expect(validator.is({ ...action, payload: { listingId: targetId } })).toBe(false);
    expect(
      validator.is({ ...action, payload: { grossMinor: '10', productionRunId: targetId } }),
    ).toBe(false);
  });

  it.each([
    ['CompleteProductionRunV1', { productionRunId: targetId }],
    ['SettlePayrollV1', { payrollRecordId: targetId }],
    ['ExpireMarketListingV1', { listingId: targetId }],
    ['AssessPeriodicTaxV1', { taxPolicyId: targetId }],
  ] as const)('registers %s creation evidence', (actionType, payload) => {
    expect(
      createValidator(ScheduledActionCreatedPayloadV1Schema).is({
        actionSchemaVersion: 1,
        actionType,
        dueTick: '12',
        payload,
        payloadHash: hash,
        priority: 50,
        processVersion: '1.0.0',
        scheduleId: uuid,
        scheduleSequence: '1',
      }),
    ).toBe(true);
  });

  it('retains registry-1 outcome readability while admitting registry 2', () => {
    const validator = createValidator(SimulationOutcomeV1Schema);
    const outcome = {
      fromTick: '1',
      inputChecksum: hash,
      outcomeHash: hash,
      outcomeSchemaVersion: 1,
      prngAlgorithmVersion: 'xorshift32-sha256-v1',
      processRegistryVersion: 1,
      toTick: '2',
      worldSeedHash: hash,
    };
    expect(validator.is(outcome)).toBe(true);
    expect(validator.is({ ...outcome, processRegistryVersion: 2 })).toBe(true);
    expect(validator.is({ ...outcome, processRegistryVersion: 3 })).toBe(false);
  });
});
