import { describe, expect, it } from 'vitest';

import {
  ASSESS_PERIODIC_TAX_DESCRIPTOR_V1,
  COMPLETE_PRODUCTION_RUN_DESCRIPTOR_V1,
  EXPIRE_MARKET_LISTING_DESCRIPTOR_V1,
  SETTLE_PAYROLL_DESCRIPTOR_V1,
  runSimulationProcessV1,
  simulationProcessDescriptorsV1,
} from './registry.js';

const context = {
  currentProjectionChecksum: 'a'.repeat(64),
  processSchemaVersion: 1 as const,
  scheduleSequence: '7',
  stableProcessKey: 'schedule:7',
  state: {},
  tick: '12',
  worldSeed: 'harbor-city-seed',
  worldTimeUnixMilliseconds: '947721600000',
};
const targetId = '018f8652-3cb6-7d52-904b-cce7901d7e26';

describe('commerce simulation process registry', () => {
  it('retains immutable commerce system-dispatch descriptors in registry 3', () => {
    const descriptors = [
      COMPLETE_PRODUCTION_RUN_DESCRIPTOR_V1,
      SETTLE_PAYROLL_DESCRIPTOR_V1,
      EXPIRE_MARKET_LISTING_DESCRIPTOR_V1,
      ASSESS_PERIODIC_TAX_DESCRIPTOR_V1,
    ];
    expect(simulationProcessDescriptorsV1()).toHaveLength(11);
    for (const descriptor of descriptors) {
      expect(descriptor).toMatchObject({
        authorityPolicy: 'system_scheduler',
        maxEvents: 0,
        maxSchedules: 0,
        processVersion: '1.0.0',
        registryVersion: 3,
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
  });

  it.each([
    ['CompleteProductionRunV1', { productionRunId: targetId }],
    ['SettlePayrollV1', { payrollRecordId: targetId }],
    ['ExpireMarketListingV1', { listingId: targetId }],
    ['AssessPeriodicTaxV1', { taxPolicyId: targetId }],
  ] as const)('commits a payload-free %s dispatch trigger', (actionType, payload) => {
    expect(
      runSimulationProcessV1({
        actionSchemaVersion: 1,
        actionType,
        context,
        payload,
        processVersion: '1.0.0',
      }),
    ).toEqual({ events: [], processSchemaVersion: 1, schedules: [] });
  });

  it('fails closed when a schedule injects mutable economics into its payload', () => {
    try {
      runSimulationProcessV1({
        actionSchemaVersion: 1,
        actionType: 'SettlePayrollV1',
        context,
        payload: { grossMinor: '500', payrollRecordId: targetId },
        processVersion: '1.0.0',
      });
      throw new Error('Expected invalid scheduler payload to fail.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'SIMULATION_HANDLER_FAILED' });
    }
  });
});
