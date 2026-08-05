import { describe, expect, it } from 'vitest';

import { AuthorityActionSchema } from './authority.js';
import { DomainEventEnvelopeV1Schema } from './ledger.js';
import {
  AdvanceSimulationCommandV1Schema,
  EmitWorldNoticePayloadV1Schema,
  InitializeWorldSimulationCommandV1Schema,
  ResolveSimulationFailureCommandV1Schema,
  ScheduledActionV1Schema,
  SimulationCommandRequestV1Schema,
  SimulationEventV1Schema,
  SimulationOutcomeV1Schema,
  SimulationSystemCommandEnvelopeV1Schema,
  SimulationWakeMessageV1Schema,
  WorldClockConfigurationV1Schema,
  WorldSimulationClockV1Schema,
} from './simulation.js';
import { createValidator } from './validation.js';
import {
  COMPILER_VERSION,
  CONTRACT_SCHEMA_VERSION,
  RUNTIME_SCHEMA_VERSION,
  SIMULATION_BATCH_SCHEMA_VERSION,
  SIMULATION_CLOCK_SCHEMA_VERSION,
  SIMULATION_FAILURE_SCHEMA_VERSION,
  SIMULATION_OUTCOME_SCHEMA_VERSION,
  SIMULATION_PRNG_ALGORITHM_VERSION,
  SIMULATION_PRNG_SCHEMA_VERSION,
  SIMULATION_PROCESS_SCHEMA_VERSION,
  SIMULATION_PROCESS_REGISTRY_VERSION,
  SIMULATION_PROJECTION_SCHEMA_VERSION,
  SIMULATION_QUEUE_SCHEMA_VERSION,
  SIMULATION_SCHEDULE_SCHEMA_VERSION,
  publicCompatibilityVersions,
} from './versions.js';

const uuid = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const hash = 'a'.repeat(64);

describe('simulation contracts', () => {
  it('publishes M10 aggregate, compiler, and process-registry compatibility', () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe(10);
    expect(RUNTIME_SCHEMA_VERSION).toBe(10);
    expect(COMPILER_VERSION).toBe('1.3.0');
    expect({
      batch: SIMULATION_BATCH_SCHEMA_VERSION,
      clock: SIMULATION_CLOCK_SCHEMA_VERSION,
      failure: SIMULATION_FAILURE_SCHEMA_VERSION,
      outcome: SIMULATION_OUTCOME_SCHEMA_VERSION,
      prng: SIMULATION_PRNG_SCHEMA_VERSION,
      process: SIMULATION_PROCESS_SCHEMA_VERSION,
      processRegistry: SIMULATION_PROCESS_REGISTRY_VERSION,
      projection: SIMULATION_PROJECTION_SCHEMA_VERSION,
      queue: SIMULATION_QUEUE_SCHEMA_VERSION,
      schedule: SIMULATION_SCHEDULE_SCHEMA_VERSION,
    }).toEqual({
      batch: 1,
      clock: 1,
      failure: 1,
      outcome: 1,
      prng: 1,
      process: 1,
      processRegistry: 3,
      projection: 1,
      queue: 1,
      schedule: 1,
    });
    expect(publicCompatibilityVersions).toMatchObject({
      simulationPrngAlgorithm: SIMULATION_PRNG_ALGORITHM_VERSION,
      simulationPrngSchema: 1,
      simulationProcessSchema: 1,
      simulationProcessRegistry: 3,
    });
  });

  it('strictly validates clock configuration and command concurrency fields', () => {
    const authorityValidator = createValidator(AuthorityActionSchema);
    expect(authorityValidator.is('simulation.manage')).toBe(true);
    expect(authorityValidator.is('simulation.schedule')).toBe(true);
    const config = {
      epochAt: '2000-01-01T00:00:00.000Z',
      maxBatchTicks: 64,
      maxCatchUpTicks: 256,
      prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
      wallCadenceMilliseconds: 10_000,
      worldMillisecondsPerTick: 86_400_000,
    };
    const configValidator = createValidator(WorldClockConfigurationV1Schema);
    expect(configValidator.is(config)).toBe(true);
    expect(configValidator.is({ ...config, wallCadenceMilliseconds: 99 })).toBe(false);
    expect(configValidator.is({ ...config, timezone: 'UTC' })).toBe(false);

    const clock = {
      clockSchemaVersion: 1,
      configuration: config,
      currentTick: '0',
      lastWallAnchorAt: null,
      mode: 'paused',
      outcomeHash: hash,
      projectionSchemaVersion: 1,
      rowVersion: '1',
      updatedAt: '2026-07-22T00:00:00.000Z',
      updatedStateRevision: '1',
      worldId: uuid,
    };
    const clockValidator = createValidator(WorldSimulationClockV1Schema);
    expect(clockValidator.is(clock)).toBe(true);
    const clockWithoutOutcomeHash: Record<string, unknown> = { ...clock };
    delete clockWithoutOutcomeHash.outcomeHash;
    expect(clockValidator.is(clockWithoutOutcomeHash)).toBe(false);

    const outcomeValidator = createValidator(SimulationOutcomeV1Schema);
    expect(
      outcomeValidator.is({
        fromTick: '1',
        inputChecksum: hash,
        outcomeHash: 'b'.repeat(64),
        outcomeSchemaVersion: 1,
        prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
        processRegistryVersion: 1,
        toTick: '2',
        worldSeedHash: 'c'.repeat(64),
      }),
    ).toBe(true);

    const command = {
      commandId: uuid,
      expectedAggregateVersion: '0',
      expectedStateRevision: '1',
      expectedTick: '2',
      expectedWorldVersion: '1',
      idempotencyKey: 'advance-tick-0001',
      payload: { ticks: 1 },
      schemaVersion: 1,
      type: 'AdvanceSimulationV1',
    };
    const commandValidator = createValidator(AdvanceSimulationCommandV1Schema);
    expect(commandValidator.is(command)).toBe(true);
    expect(commandValidator.is({ ...command, expectedAggregateVersion: 0 })).toBe(false);
    expect(commandValidator.is({ ...command, workerId: uuid })).toBe(false);
    expect(createValidator(SimulationCommandRequestV1Schema).is(command)).toBe(true);

    const resolution = {
      ...command,
      payload: { failureId: uuid, resolution: 'cancel_action' },
      type: 'ResolveSimulationFailureV1',
    };
    expect(createValidator(ResolveSimulationFailureCommandV1Schema).is(resolution)).toBe(true);
    expect(createValidator(SimulationCommandRequestV1Schema).is(resolution)).toBe(true);

    const initialize = {
      ...command,
      actor: { actorId: 'simulation.initializer.v1', actorType: 'system' },
      causationId: null,
      correlationId: uuid,
      expectedTick: '0',
      overrideId: null,
      payload: {
        configuration: config,
        currentTick: '0',
        mode: 'paused',
        processRegistryVersion: 1,
        provenance: 'm07_default',
      },
      type: 'InitializeWorldSimulationV1',
      worldId: uuid,
    };
    const initializeValidator = createValidator(InitializeWorldSimulationCommandV1Schema);
    expect(initializeValidator.is(initialize)).toBe(true);
    expect(createValidator(SimulationSystemCommandEnvelopeV1Schema).is(initialize)).toBe(true);
    expect(
      initializeValidator.is({ ...initialize, actor: { actorId: uuid, actorType: 'user' } }),
    ).toBe(false);
  });

  it('rejects control characters, unknown process payload fields, and authority in queue wakes', () => {
    const noticeValidator = createValidator(EmitWorldNoticePayloadV1Schema);
    expect(noticeValidator.is({ text: 'Guild Founding Day', visibility: 'public' })).toBe(true);
    expect(noticeValidator.is({ text: '<script>alert(1)</script>', visibility: 'member' })).toBe(
      true,
    );
    expect(noticeValidator.is({ text: 'bad\u0000text', visibility: 'public' })).toBe(false);
    expect(noticeValidator.is({ html: true, text: 'Notice', visibility: 'public' })).toBe(false);

    const wake = {
      expectedLeaseFencingToken: '3',
      messageSchemaVersion: 1,
      messageType: 'SimulationWakeV1',
      worldId: uuid,
    };
    const wakeValidator = createValidator(SimulationWakeMessageV1Schema);
    expect(wakeValidator.is(wake)).toBe(true);
    expect(wakeValidator.is({ ...wake, actorId: uuid })).toBe(false);
  });

  it('strictly validates target-only governance scheduler payloads', () => {
    const scheduled = {
      actionSchemaVersion: 1,
      actionType: 'OpenProposalVotingV1',
      cancelledCommandId: null,
      completedEventId: null,
      completedStateRevision: null,
      createdAt: '2026-07-22T00:00:00.000Z',
      createdBy: { actorId: 'governance.scheduler.v1', actorType: 'system' },
      createdCommandId: uuid,
      createdStateRevision: '1',
      dueTick: '42',
      id: uuid,
      payload: { proposalId: uuid },
      payloadHash: hash,
      priority: 0,
      processVersion: '1.0.0',
      scheduleSchemaVersion: 1,
      scheduleSequence: '1',
      status: 'scheduled',
      updatedAt: '2026-07-22T00:00:00.000Z',
      worldId: uuid,
    };
    const validator = createValidator(ScheduledActionV1Schema);
    expect(validator.is(scheduled)).toBe(true);
    expect(validator.is({ ...scheduled, payload: { choice: 'yes', proposalId: uuid } })).toBe(
      false,
    );
  });

  it('registers initialization and notice variants in both simulation and authoritative unions', () => {
    const simulationEventValidator = createValidator(SimulationEventV1Schema);
    const initialized = {
      eventSchemaVersion: 1,
      eventType: 'WorldSimulationInitializedV1',
      payload: {
        configuration: {
          epochAt: '2000-01-01T00:00:00.000Z',
          maxBatchTicks: 64,
          maxCatchUpTicks: 256,
          prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
          wallCadenceMilliseconds: 10_000,
          worldMillisecondsPerTick: 86_400_000,
        },
        currentTick: '0',
        mode: 'paused',
        processRegistryVersion: 1,
        provenance: 'm07_default',
      },
    };
    expect(simulationEventValidator.is(initialized)).toBe(true);

    const authoritative = {
      aggregateId: uuid,
      aggregateType: 'world_simulation',
      aggregateVersion: '1',
      commandId: uuid,
      eventHash: hash,
      eventId: uuid,
      eventOrdinal: 0,
      eventSchemaVersion: 1,
      eventType: initialized.eventType,
      metadata: {
        actor: { actorId: 'simulation.initializer.v1', actorType: 'system' },
        authorizationRuleId: 'simulation.system.initialize',
        causationId: null,
        commandSchemaVersion: 1,
        commandType: 'InitializeWorldSimulationV1',
        correlationId: uuid,
        overrideId: null,
        payloadClassification: 'member',
      },
      occurredAt: '2026-07-22T00:00:00.000Z',
      payload: initialized.payload,
      recordedAt: '2026-07-22T00:00:00.000Z',
      resultingStateRevision: '1',
      worldEventSequence: '2',
      worldId: uuid,
    };
    expect(createValidator(DomainEventEnvelopeV1Schema).is(authoritative)).toBe(true);
    expect(
      createValidator(DomainEventEnvelopeV1Schema).is({
        ...authoritative,
        eventType: 'WorldNoticeEmittedV1',
      }),
    ).toBe(false);
  });
});
