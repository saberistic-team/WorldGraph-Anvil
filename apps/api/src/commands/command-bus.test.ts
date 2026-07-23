import { describe, expect, it, vi } from 'vitest';

import type { ScheduledActionV1 } from '@worldgraph/contracts';
import { telemetry } from '@worldgraph/observability';

import type { AuthenticatedActor } from '../identity/service.js';
import type { SubmitWorldCommand, WorldCommandResultTransport } from './api-contracts.js';
import { WorldCommandBus } from './command-bus.js';
import type {
  CommandRepository,
  CommandTransaction,
  ReceivedCommandWrite,
  SimulationClockRecord,
  StoredCommandIdentity,
} from './types.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e21';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const eventId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
const now = new Date('2026-07-22T12:00:00.000Z');

const creator = actor('creator');

function actor(role: 'creator' | 'observer'): AuthenticatedActor {
  return {
    csrfHash: Buffer.alloc(32),
    session: {
      absoluteExpiresAt: '2026-07-23T12:00:00.000Z',
      id: '018f8652-3cb6-7d52-904b-cce7901d7e20',
      idleExpiresAt: '2026-07-22T13:00:00.000Z',
    },
    user: {
      displayName: role,
      email: `${role}@example.test`,
      id: actorId,
      platformRole: 'user',
      rowVersion: 1,
      status: 'active',
    },
  };
}

function request(overrides: Partial<SubmitWorldCommand> = {}): SubmitWorldCommand {
  return {
    commandId,
    expectedAggregateVersion: '1',
    expectedStateRevision: '0',
    expectedWorldVersion: '1',
    idempotencyKey: 'rename-command-key',
    payload: { entityKey: 'district:civic-platform', newDisplayName: 'Civic Commons' },
    schemaVersion: 1,
    type: 'RenameWorldEntityV1',
    ...overrides,
  };
}

function transaction(role: 'administrator' | 'creator' | 'observer' | 'player' = 'creator') {
  const acceptRename = vi.fn<CommandTransaction['acceptRename']>(async (input) => ({
    commandId: input.command.commandId,
    eventIds: [input.eventId],
    eventSequenceRange: { from: '2', to: '2' },
    ledgerSequenceRange: { from: '2', to: '3' },
    resultingStateRevision: input.resultingStateRevision,
    schemaVersion: 1,
    status: 'accepted',
  }));
  const acceptSimulation = vi.fn<CommandTransaction['acceptSimulation']>(async () => {
    throw new Error('Simulation acceptance was not expected in this fixture.');
  });
  const allocateScheduleSequence = vi.fn<CommandTransaction['allocateScheduleSequence']>(
    async () => '1',
  );
  const countScheduledActionsAtTick = vi.fn<CommandTransaction['countScheduledActionsAtTick']>(
    async () => 0,
  );
  const countScheduledActionsForWorldAndActor = vi.fn<
    CommandTransaction['countScheduledActionsForWorldAndActor']
  >(async () => ({ actorCount: 0, worldCount: 0 }));
  const executeEconomy = vi.fn<CommandTransaction['executeEconomy']>(async () => {
    throw new Error('Economy execution was not expected in this fixture.');
  });
  const executeCommerce = vi.fn<CommandTransaction['executeCommerce']>(async () => {
    throw new Error('Commerce execution was not expected in this fixture.');
  });
  const findCommandById = vi.fn<CommandTransaction['findCommandById']>(async () => null);
  const findCommandByIdempotency = vi.fn<CommandTransaction['findCommandByIdempotency']>(
    async () => null,
  );
  const insertReceived = vi.fn<CommandTransaction['insertReceived']>(async () => undefined);
  const lockEntity = vi.fn<CommandTransaction['lockEntity']>(async () => ({
    entitySchemaVersion: 1,
    entityType: 'district',
    entityVersion: '1',
    logicalKey: 'district:civic-platform',
    state: { name: 'Civic Platform', parameters: {}, primitiveRef: 'civic-district' },
    storageRowVersion: '0',
    worldId,
  }));
  const lockDueScheduledActions = vi.fn<CommandTransaction['lockDueScheduledActions']>(
    async () => [],
  );
  const lockScheduledAction = vi.fn<CommandTransaction['lockScheduledAction']>(async () => null);
  const lockSimulationClock = vi.fn<CommandTransaction['lockSimulationClock']>(async () => null);
  const lockSimulationFailure = vi.fn<CommandTransaction['lockSimulationFailure']>(
    async () => null,
  );
  const lockWorld = vi.fn<CommandTransaction['lockWorld']>(async () => ({
    activeWorldVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
    anchorArtifactHash: 'a'.repeat(64),
    designVersion: '1',
    ledgerAnchoredAt: now,
    lifecycle: 'active',
    membershipRole: role,
    membershipStatus: 'active',
    stateRevision: '0',
    worldId,
  }));
  const reject = vi.fn<CommandTransaction['reject']>(async (input) => ({
    commandId: input.command.commandId,
    currentStateRevision: input.currentStateRevision ?? '0',
    eventIds: [],
    rejectionCode: input.code,
    schemaVersion: 1,
    status: 'rejected',
  }));
  const tx: CommandTransaction = {
    acceptRename,
    acceptSimulation,
    allocateScheduleSequence,
    countScheduledActionsAtTick,
    countScheduledActionsForWorldAndActor,
    executeCommerce,
    executeEconomy,
    findCommandById,
    findCommandByIdempotency,
    insertReceived,
    lockEntity,
    lockDueScheduledActions,
    lockScheduledAction,
    lockSimulationClock,
    lockSimulationFailure,
    lockWorld,
    reject,
  };
  return {
    acceptRename,
    acceptSimulation,
    allocateScheduleSequence,
    countScheduledActionsAtTick,
    countScheduledActionsForWorldAndActor,
    executeCommerce,
    executeEconomy,
    findCommandById,
    insertReceived,
    lockDueScheduledActions,
    lockEntity,
    lockScheduledAction,
    lockSimulationClock,
    lockSimulationFailure,
    reject,
    tx,
  };
}

function repository(tx: CommandTransaction): CommandRepository {
  return {
    getCommand: vi.fn(),
    getHistoryEntry: vi.fn(),
    getRuntimeHead: vi.fn(),
    getScheduledAction: vi.fn(),
    getSimulationClock: vi.fn(),
    listScheduledActions: vi.fn(),
    listSimulationBatches: vi.fn(),
    listHistory: vi.fn(),
    serializable: async (operation) => operation(tx),
  };
}

function bus(tx: CommandTransaction): WorldCommandBus {
  return new WorldCommandBus(repository(tx), { next: () => eventId });
}

function simulationBus(tx: CommandTransaction): WorldCommandBus {
  let sequence = 0x30;
  return new WorldCommandBus(repository(tx), {
    next: () => {
      sequence += 1;
      return `018f8652-3cb6-7d52-904b-${sequence.toString(16).padStart(12, '0')}`;
    },
  });
}

function simulationClock(currentTick = '0'): SimulationClockRecord {
  return {
    aggregateVersion: '1',
    clock: {
      clockSchemaVersion: 1,
      configuration: {
        epochAt: '2000-01-01T00:00:00.000Z',
        maxBatchTicks: 64,
        maxCatchUpTicks: 256,
        prngAlgorithmVersion: 'xorshift32-sha256-v1' as const,
        wallCadenceMilliseconds: 10_000,
        worldMillisecondsPerTick: 86_400_000,
      },
      currentTick,
      lastWallAnchorAt: null,
      mode: 'paused' as const,
      outcomeHash: 'c'.repeat(64),
      projectionSchemaVersion: 1,
      rowVersion: '1',
      updatedAt: now.toISOString(),
      updatedStateRevision: '1',
      worldId,
    },
    projectionChecksum: 'a'.repeat(64),
    worldSeed: 'simulation-command-bus-seed',
  };
}

function acceptSimulationResult(harness: ReturnType<typeof transaction>): void {
  harness.acceptSimulation.mockImplementation(async (input) => ({
    commandId: input.command.commandId,
    eventIds: input.events.map((event) => event.eventId),
    eventSequenceRange: { from: '3', to: String(input.events.length + 2) },
    ledgerSequenceRange: { from: '3', to: String(input.events.length + 3) },
    resultingStateRevision: input.resultingStateRevision,
    schemaVersion: 1,
    status: 'accepted',
  }));
}

function payrollSchedule(): ScheduledActionV1 {
  return {
    actionSchemaVersion: 1,
    actionType: 'SettlePayrollV1',
    cancelledCommandId: null,
    completedEventId: null,
    completedStateRevision: null,
    createdAt: now.toISOString(),
    createdBy: { actorId, actorType: 'user' },
    createdCommandId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
    createdStateRevision: '1',
    dueTick: '1',
    id: '018f8652-3cb6-7d52-904b-cce7901d7e27',
    payload: { payrollRecordId: '018f8652-3cb6-7d52-904b-cce7901d7e28' },
    payloadHash: 'b'.repeat(64),
    priority: 50,
    processVersion: '1.0.0',
    scheduleSchemaVersion: 1,
    scheduleSequence: '1',
    status: 'scheduled',
    updatedAt: now.toISOString(),
    worldId,
  };
}

describe('world command bus', () => {
  it('runs an authorized rename through one accepted transaction plan', async () => {
    const { acceptRename, insertReceived, reject, tx } = transaction();

    const outcome = await bus(tx).submit(creator, worldId, request(), commandId, now);

    expect(outcome).toMatchObject({
      httpStatus: 200,
      result: {
        commandId,
        eventIds: [eventId],
        resultingStateRevision: '1',
        status: 'accepted',
      },
    });
    expect(insertReceived).toHaveBeenCalledOnce();
    expect(acceptRename).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationRuleId: 'ledger.world_role.authoritative_write',
        eventPayload: {
          entityKey: 'district:civic-platform',
          entityType: 'district',
          entityVersion: '2',
          newDisplayName: 'Civic Commons',
          previousDisplayName: 'Civic Platform',
        },
        nextState: {
          name: 'Civic Commons',
          parameters: {},
          primitiveRef: 'civic-district',
        },
      }),
    );
    expect(reject).not.toHaveBeenCalled();
  });

  it('durably rejects stale state before loading or mutating the entity', async () => {
    const { acceptRename, lockEntity, reject, tx } = transaction();

    const outcome = await bus(tx).submit(
      creator,
      worldId,
      request({ expectedStateRevision: '9' }),
      commandId,
      now,
    );

    expect(outcome).toMatchObject({
      httpStatus: 409,
      result: { currentStateRevision: '0', rejectionCode: 'REVISION_CONFLICT' },
    });
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'REVISION_CONFLICT', currentStateRevision: '0' }),
    );
    expect(lockEntity).not.toHaveBeenCalled();
    expect(acceptRename).not.toHaveBeenCalled();
  });

  it('durably rejects unknown types, unauthorized actors and private-looking names', async () => {
    const unknown = transaction();
    const unknownOutcome = await bus(unknown.tx).submit(
      creator,
      worldId,
      request({ schemaVersion: 2, type: 'UnregisteredCommandV2' }),
      commandId,
      now,
    );
    expect(unknownOutcome).toMatchObject({
      httpStatus: 422,
      result: { rejectionCode: 'COMMAND_TYPE_DISABLED' },
    });
    expect(unknown.reject).toHaveBeenCalledOnce();

    const observerTx = transaction('observer');
    const forbidden = await bus(observerTx.tx).submit(
      actor('observer'),
      worldId,
      request(),
      commandId,
      now,
    );
    expect(forbidden).toMatchObject({
      httpStatus: 403,
      result: { rejectionCode: 'AUTHORIZATION_DENIED' },
    });
    expect(observerTx.lockEntity).not.toHaveBeenCalled();

    const privateNameTx = transaction();
    const privateName = await bus(privateNameTx.tx).submit(
      creator,
      worldId,
      request({
        payload: {
          entityKey: 'district:civic-platform',
          newDisplayName: 'contact private.person@example.test',
        },
      }),
      commandId,
      now,
    );
    expect(privateName).toMatchObject({
      httpStatus: 422,
      result: { rejectionCode: 'VALIDATION_FAILED' },
    });
    expect(JSON.stringify(privateNameTx.reject.mock.calls)).not.toContain(
      'private.person@example.test',
    );
  });

  it('returns the exact prior terminal result for duplicate identity and rejects collisions', async () => {
    const { findCommandById, insertReceived: firstWrite, tx } = transaction();
    const idempotencyMetric = vi
      .spyOn(telemetry.idempotency, 'add')
      .mockImplementation(() => undefined);
    const accepted: WorldCommandResultTransport = {
      commandId,
      eventIds: [eventId],
      eventSequenceRange: { from: '2', to: '2' },
      ledgerSequenceRange: { from: '2', to: '3' },
      resultingStateRevision: '1',
      schemaVersion: 1,
      status: 'accepted',
    };
    try {
      await bus(tx).submit(creator, worldId, request(), commandId, now);
      const received = firstWrite.mock.calls[0]?.[0] as ReceivedCommandWrite;
      const stored: StoredCommandIdentity = {
        actorId,
        actorType: 'user',
        commandId,
        commandType: 'RenameWorldEntityV1',
        idempotencyKey: 'rename-command-key',
        requestHash: received.requestHash,
        result: accepted,
        status: 'accepted',
        worldId,
      };
      findCommandById.mockResolvedValue(stored);
      firstWrite.mockClear();

      await expect(bus(tx).submit(creator, worldId, request(), commandId, now)).resolves.toEqual({
        httpStatus: 200,
        result: accepted,
      });
      expect(firstWrite).not.toHaveBeenCalled();

      await expect(
        bus(tx).submit(
          creator,
          worldId,
          request({ payload: { entityKey: 'district:civic-platform', newDisplayName: 'Other' } }),
          commandId,
          now,
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
      expect(idempotencyMetric).toHaveBeenNthCalledWith(1, 1, {
        outcome: 'replay',
        scope: 'world_command',
      });
      expect(idempotencyMetric).toHaveBeenNthCalledWith(2, 1, {
        outcome: 'conflict',
        scope: 'world_command',
      });
    } finally {
      idempotencyMetric.mockRestore();
    }
  });

  it('creates a future notice through a versioned schedule aggregate', async () => {
    const harness = transaction();
    harness.lockSimulationClock.mockResolvedValue(simulationClock());
    acceptSimulationResult(harness);

    const outcome = await simulationBus(harness.tx).submit(
      creator,
      worldId,
      request({
        expectedAggregateVersion: '0',
        expectedTick: '0',
        idempotencyKey: 'schedule-notice-key',
        payload: { dueTick: '3', priority: -2, text: 'Guild Founding Day', visibility: 'public' },
        type: 'ScheduleWorldNoticeV1',
      }),
      commandId,
      now,
    );

    expect(outcome).toMatchObject({ httpStatus: 200, result: { status: 'accepted' } });
    expect(harness.allocateScheduleSequence).toHaveBeenCalledWith(worldId);
    const accepted = harness.acceptSimulation.mock.calls[0]?.[0];
    expect(accepted?.events[0]).toMatchObject({
      aggregateType: 'scheduled_action',
      eventType: 'ScheduledActionCreatedV1',
    });
    expect(accepted?.events[0]?.payload).toMatchObject({
      dueTick: '3',
      payload: { text: 'Guild Founding Day', visibility: 'public' },
      priority: -2,
      scheduleSequence: '1',
    });
    expect(accepted?.scheduleCreates?.[0]).toMatchObject({
      dueTick: '3',
      scheduleSequence: '1',
      status: 'scheduled',
    });
  });

  it('rejects active per-actor schedule abuse before allocating an identity', async () => {
    const harness = transaction();
    harness.lockSimulationClock.mockResolvedValue(simulationClock());
    harness.countScheduledActionsForWorldAndActor.mockResolvedValue({
      actorCount: 1_000,
      worldCount: 1_000,
    });

    const outcome = await simulationBus(harness.tx).submit(
      creator,
      worldId,
      request({
        expectedAggregateVersion: '0',
        expectedTick: '0',
        idempotencyKey: 'schedule-cap-key',
        payload: { dueTick: '3', priority: 0, text: 'Bounded', visibility: 'member' },
        type: 'ScheduleWorldNoticeV1',
      }),
      commandId,
      now,
    );
    expect(outcome).toMatchObject({
      httpStatus: 409,
      result: { rejectionCode: 'SIMULATION_BUDGET_EXCEEDED', status: 'rejected' },
    });
    expect(harness.reject).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SIMULATION_BUDGET_EXCEEDED' }),
    );
    expect(harness.allocateScheduleSequence).not.toHaveBeenCalled();
    expect(harness.acceptSimulation).not.toHaveBeenCalled();
  });

  it('advances through a due notice once with one shared resulting revision', async () => {
    const harness = transaction();
    harness.lockSimulationClock.mockResolvedValue(simulationClock());
    harness.lockDueScheduledActions.mockResolvedValue([
      {
        actionSchemaVersion: 1,
        actionType: 'EmitWorldNoticeV1',
        cancelledCommandId: null,
        completedEventId: null,
        completedStateRevision: null,
        createdAt: now.toISOString(),
        createdBy: { actorId, actorType: 'user' },
        createdCommandId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        createdStateRevision: '1',
        dueTick: '3',
        id: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        payload: { text: 'Guild Founding Day', visibility: 'public' },
        payloadHash: 'b'.repeat(64),
        priority: 0,
        processVersion: '1.0.0',
        scheduleSchemaVersion: 1,
        scheduleSequence: '1',
        status: 'scheduled',
        updatedAt: now.toISOString(),
        worldId,
      },
    ]);
    acceptSimulationResult(harness);

    const outcome = await simulationBus(harness.tx).submit(
      creator,
      worldId,
      request({
        expectedAggregateVersion: '1',
        expectedTick: '0',
        idempotencyKey: 'advance-three-ticks',
        payload: { ticks: 3 },
        type: 'AdvanceSimulationV1',
      }),
      commandId,
      now,
    );

    expect(outcome.result.status).toBe('accepted');
    expect(Array.isArray(outcome.result.eventIds)).toBe(true);
    const accepted = harness.acceptSimulation.mock.calls[0]?.[0];
    expect(accepted?.events.map((event) => event.eventType)).toEqual([
      'SimulationAdvancedV1',
      'ScheduledActionExecutedV1',
      'WorldNoticeEmittedV1',
    ]);
    expect(accepted?.events.map(() => accepted.resultingStateRevision)).toEqual(['1', '1', '1']);
    expect(accepted?.clock).toMatchObject({ currentTick: '3', updatedStateRevision: '1' });
    expect(accepted?.scheduleTerminals).toEqual([
      expect.objectContaining({ status: 'completed', completedStateRevision: '1' }),
    ]);
    expect(accepted?.batch).toMatchObject({ fromTick: '0', status: 'completed', toTick: '3' });
  });

  it('completes a due commerce dispatch without inventing a notice event', async () => {
    const harness = transaction();
    harness.lockSimulationClock.mockResolvedValue(simulationClock());
    harness.lockDueScheduledActions.mockResolvedValue([payrollSchedule()]);
    acceptSimulationResult(harness);

    const outcome = await simulationBus(harness.tx).submit(
      creator,
      worldId,
      request({
        expectedAggregateVersion: '1',
        expectedTick: '0',
        idempotencyKey: 'advance-payroll-dispatch',
        payload: { ticks: 1 },
        type: 'AdvanceSimulationV1',
      }),
      commandId,
      now,
    );

    expect(outcome.result.status).toBe('accepted');
    const accepted = harness.acceptSimulation.mock.calls[0]?.[0];
    expect(accepted?.events.map((event) => event.eventType)).toEqual([
      'SimulationAdvancedV1',
      'ScheduledActionExecutedV1',
    ]);
    expect(accepted?.scheduleTerminals).toEqual([
      expect.objectContaining({
        completedEventId: accepted?.events[1]?.eventId,
        id: payrollSchedule().id,
        status: 'completed',
      }),
    ]);
  });

  it('rejects public cancellation of an internal commerce schedule', async () => {
    const harness = transaction();
    harness.lockSimulationClock.mockResolvedValue(simulationClock());
    harness.lockScheduledAction.mockResolvedValue({
      action: payrollSchedule(),
      aggregateVersion: '1',
    });

    const outcome = await simulationBus(harness.tx).submit(
      creator,
      worldId,
      request({
        expectedAggregateVersion: '1',
        expectedTick: '0',
        idempotencyKey: 'cancel-internal-payroll',
        payload: { scheduleId: payrollSchedule().id },
        type: 'CancelScheduledActionV1',
      }),
      commandId,
      now,
    );

    expect(outcome).toMatchObject({
      httpStatus: 422,
      result: { rejectionCode: 'VALIDATION_FAILED', status: 'rejected' },
    });
    expect(harness.acceptSimulation).not.toHaveBeenCalled();
  });

  it('durably rejects a stale expected tick before loading due work', async () => {
    const harness = transaction();
    harness.lockSimulationClock.mockResolvedValue(simulationClock('4'));

    const outcome = await simulationBus(harness.tx).submit(
      creator,
      worldId,
      request({
        expectedAggregateVersion: '1',
        expectedTick: '3',
        idempotencyKey: 'stale-simulation-tick',
        payload: { ticks: 1 },
        type: 'AdvanceSimulationV1',
      }),
      commandId,
      now,
    );

    expect(outcome).toMatchObject({
      httpStatus: 409,
      result: { rejectionCode: 'EXPECTED_TICK_MISMATCH', status: 'rejected' },
    });
    expect(harness.lockDueScheduledActions).not.toHaveBeenCalled();
    expect(harness.acceptSimulation).not.toHaveBeenCalled();
  });

  it('resolves an auto-pause through the failure aggregate and cancels its broken action', async () => {
    const harness = transaction();
    const clock = simulationClock();
    clock.clock.mode = 'error';
    harness.lockSimulationClock.mockResolvedValue(clock);
    const failureId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
    const scheduleId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
    harness.lockSimulationFailure.mockResolvedValue({
      aggregateVersion: '1',
      failure: {
        aggregateVersion: '1',
        attempts: 3,
        batchRunId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        errorCode: 'SIMULATION_HANDLER_FAILED',
        failureSchemaVersion: 1,
        id: failureId,
        openedAt: now.toISOString(),
        processType: 'EmitWorldNoticeV1',
        processVersion: '1.0.0',
        redactedContext: { failedCommandType: 'AdvanceSimulationV1' },
        resolutionCommandId: null,
        resolvedAt: null,
        resolvedByActorId: null,
        scheduleId,
        status: 'open',
        tick: '1',
        worldId,
      },
    });
    harness.lockScheduledAction.mockResolvedValue({
      action: {
        actionSchemaVersion: 1,
        actionType: 'EmitWorldNoticeV1',
        cancelledCommandId: null,
        completedEventId: null,
        completedStateRevision: null,
        createdAt: now.toISOString(),
        createdBy: { actorId, actorType: 'user' },
        createdCommandId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        createdStateRevision: '1',
        dueTick: '1',
        id: scheduleId,
        payload: { text: 'Broken notice', visibility: 'member' },
        payloadHash: 'b'.repeat(64),
        priority: 0,
        processVersion: '1.0.0',
        scheduleSchemaVersion: 1,
        scheduleSequence: '1',
        status: 'scheduled',
        updatedAt: now.toISOString(),
        worldId,
      },
      aggregateVersion: '1',
    });
    acceptSimulationResult(harness);

    const outcome = await simulationBus(harness.tx).submit(
      creator,
      worldId,
      request({
        expectedAggregateVersion: '1',
        expectedTick: '0',
        idempotencyKey: 'resolve-simulation-failure',
        payload: { failureId, resolution: 'cancel_action' },
        type: 'ResolveSimulationFailureV1',
      }),
      commandId,
      now,
    );

    expect(outcome).toMatchObject({ httpStatus: 200, result: { status: 'accepted' } });
    const accepted = harness.acceptSimulation.mock.calls[0]?.[0];
    expect(accepted?.clock).toMatchObject({ mode: 'paused' });
    expect(accepted?.events).toEqual([
      expect.objectContaining({
        aggregateId: failureId,
        aggregateType: 'simulation_failure',
        eventType: 'SimulationFailureResolvedV1',
      }),
      expect.objectContaining({
        aggregateId: scheduleId,
        aggregateType: 'scheduled_action',
        eventType: 'ScheduledActionCancelledV1',
      }),
    ]);
    expect(accepted?.failureResolution).toEqual({
      failureId,
      resolutionCommandId: commandId,
      resolvedAt: now,
      resolvedByActorId: actorId,
    });
    expect(accepted?.scheduleTerminals).toEqual([
      expect.objectContaining({
        cancelledCommandId: commandId,
        id: scheduleId,
        status: 'cancelled',
      }),
    ]);
  });

  it('routes a validated economy initialization and emits only bounded accepted metrics', async () => {
    const harness = transaction();
    harness.executeEconomy.mockResolvedValue({
      commandId,
      eventIds: [eventId],
      eventSequenceRange: { from: '2', to: '2' },
      ledgerSequenceRange: { from: '2', to: '3' },
      resultingStateRevision: '1',
      schemaVersion: 1,
      status: 'accepted',
    });
    const economyMetric = vi
      .spyOn(telemetry.economyCommands, 'add')
      .mockImplementation(() => undefined);
    const initializationMetric = vi
      .spyOn(telemetry.economyInitialization, 'add')
      .mockImplementation(() => undefined);
    try {
      const outcome = await bus(harness.tx).submit(
        creator,
        worldId,
        request({
          expectedAggregateVersion: '0',
          idempotencyKey: 'initialize-economy-command',
          payload: {
            compiledWorldVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
            seedPlanHash: 'a'.repeat(64),
          },
          type: 'InitializeWorldEconomyV1',
        }),
        commandId,
        now,
      );

      expect(outcome).toMatchObject({ httpStatus: 200, result: { status: 'accepted' } });
      expect(harness.executeEconomy).toHaveBeenCalledWith(
        expect.objectContaining({ authorizationRuleId: 'economy.creator_command' }),
      );
      expect(economyMetric).toHaveBeenCalledWith(1, {
        operation: 'initialize',
        outcome: 'accepted',
      });
      expect(initializationMetric).toHaveBeenCalledWith(1, { outcome: 'accepted' });
    } finally {
      economyMetric.mockRestore();
      initializationMetric.mockRestore();
    }
  });

  it('routes validated commerce through the transactional executor and denies observer play', async () => {
    const harness = transaction('player');
    harness.executeCommerce.mockResolvedValue({
      commandId,
      eventIds: [eventId],
      eventSequenceRange: { from: '2', to: '4' },
      ledgerSequenceRange: { from: '2', to: '5' },
      resultingStateRevision: '1',
      schemaVersion: 1,
      status: 'accepted',
    });
    const purchase = request({
      expectedTick: '0',
      idempotencyKey: 'purchase-listing-command',
      payload: {
        buyerInventoryId: null,
        buyerWalletId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        expectedBuyerInventoryVersion: null,
        expectedBuyerWalletVersion: '1',
        expectedListingVersion: '1',
        listingId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        quantity: '1',
      },
      type: 'PurchaseMarketListingV1',
    });

    const outcome = await bus(harness.tx).submit(creator, worldId, purchase, commandId, now);

    expect(outcome).toMatchObject({ httpStatus: 200, result: { status: 'accepted' } });
    expect(harness.executeCommerce).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationRuleId: 'commerce.controller_recheck_required',
        request: purchase,
      }),
    );
    expect(harness.executeEconomy).not.toHaveBeenCalled();

    const observerHarness = transaction('observer');
    const denied = await bus(observerHarness.tx).submit(
      actor('observer'),
      worldId,
      purchase,
      commandId,
      now,
    );
    expect(denied).toMatchObject({
      httpStatus: 403,
      result: { rejectionCode: 'AUTHORIZATION_DENIED', status: 'rejected' },
    });
    expect(observerHarness.executeCommerce).not.toHaveBeenCalled();
  });

  it('derives bounded target scope hashes only for rate-limited commerce commands', async () => {
    const targetA = '018f8652-3cb6-7d52-904b-cce7901d7e27';
    const targetB = '018f8652-3cb6-7d52-904b-cce7901d7e28';
    const commands: Array<{
      payload: Record<string, unknown>;
      targetField: string;
      type: string;
    }> = [
      {
        payload: { contractId: targetA, expectedContractVersion: '1' },
        targetField: 'contractId',
        type: 'PerformJobV1',
      },
      {
        payload: {
          businessId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
          expectedBusinessVersion: '1',
          expectedFacilityVersion: '1',
          expectedInventories: [
            { inventoryId: '018f8652-3cb6-7d52-904b-cce7901d7e29', rowVersion: '1' },
          ],
          facilityId: targetA,
          recipeVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
          runQuantity: '1',
        },
        targetField: 'facilityId',
        type: 'StartProductionRunV1',
      },
      {
        payload: {
          expiresAtTick: '1',
          expectedInventoryVersion: '1',
          quantity: '1',
          sellerInventoryId: targetA,
          sellerWalletId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
          unitPriceMinor: '1',
        },
        targetField: 'sellerInventoryId',
        type: 'CreateMarketListingV1',
      },
      {
        payload: {
          buyerInventoryId: null,
          buyerWalletId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
          expectedBuyerInventoryVersion: null,
          expectedBuyerWalletVersion: '1',
          expectedListingVersion: '1',
          listingId: targetA,
          quantity: '1',
        },
        targetField: 'listingId',
        type: 'PurchaseMarketListingV1',
      },
    ];

    for (const command of commands) {
      const submitAndReadScope = async (targetId: string) => {
        const harness = transaction('player');
        harness.executeCommerce.mockResolvedValue({
          commandId,
          eventIds: [eventId],
          eventSequenceRange: { from: '2', to: '2' },
          ledgerSequenceRange: { from: '2', to: '3' },
          resultingStateRevision: '1',
          schemaVersion: 1,
          status: 'accepted',
        });
        await bus(harness.tx).submit(
          creator,
          worldId,
          request({
            expectedTick: '0',
            idempotencyKey: `scope-${command.type}-${targetId}`,
            payload: { ...command.payload, [command.targetField]: targetId },
            type: command.type,
          }),
          commandId,
          now,
        );
        return (harness.insertReceived.mock.calls[0]?.[0] as ReceivedCommandWrite)
          .rateLimitScopeHash;
      };

      const first = await submitAndReadScope(targetA);
      const same = await submitAndReadScope(targetA);
      const alternateUuidSpelling = await submitAndReadScope(targetA.toUpperCase());
      const different = await submitAndReadScope(targetB);
      expect(first).toBeInstanceOf(Buffer);
      expect(first).toHaveLength(32);
      expect(same).toEqual(first);
      expect(alternateUuidSpelling).toEqual(first);
      expect(different).not.toEqual(first);
    }

    const nonLimited = transaction('player');
    nonLimited.executeCommerce.mockResolvedValue({
      commandId,
      eventIds: [eventId],
      eventSequenceRange: { from: '2', to: '2' },
      ledgerSequenceRange: { from: '2', to: '3' },
      resultingStateRevision: '1',
      schemaVersion: 1,
      status: 'accepted',
    });
    await bus(nonLimited.tx).submit(
      creator,
      worldId,
      request({
        expectedTick: '0',
        idempotencyKey: 'scope-cancel-market-listing',
        payload: { expectedListingVersion: '1', listingId: targetA },
        type: 'CancelMarketListingV1',
      }),
      commandId,
      now,
    );
    expect(
      (nonLimited.insertReceived.mock.calls[0]?.[0] as ReceivedCommandWrite).rateLimitScopeHash,
    ).toBeNull();
  });

  it('durably rejects a malformed limited command before commerce rate enforcement', async () => {
    const harness = transaction('player');
    const malformed = request({
      expectedTick: '0',
      idempotencyKey: 'malformed-rate-scoped-purchase',
      payload: {},
      type: 'PurchaseMarketListingV1',
    });

    await expect(
      bus(harness.tx).submit(creator, worldId, malformed, commandId, now),
    ).resolves.toMatchObject({
      httpStatus: 422,
      result: { rejectionCode: 'VALIDATION_FAILED', status: 'rejected' },
    });
    const received = harness.insertReceived.mock.calls[0]?.[0] as ReceivedCommandWrite;
    expect(received.rateLimitScopeHash).toBeInstanceOf(Buffer);
    expect(received.rateLimitScopeHash).toHaveLength(32);
    expect(harness.executeCommerce).not.toHaveBeenCalled();
  });

  it('distinguishes exact commerce replay from conflicting idempotency reuse in telemetry', async () => {
    const harness = transaction('player');
    const result: WorldCommandResultTransport = {
      commandId,
      eventIds: [eventId],
      eventSequenceRange: { from: '2', to: '4' },
      ledgerSequenceRange: { from: '2', to: '5' },
      resultingStateRevision: '1',
      schemaVersion: 1,
      status: 'accepted',
    };
    harness.executeCommerce.mockResolvedValue(result);
    const purchase = request({
      expectedTick: '0',
      idempotencyKey: 'purchase-replay-telemetry',
      payload: {
        buyerInventoryId: null,
        buyerWalletId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        expectedBuyerInventoryVersion: null,
        expectedBuyerWalletVersion: '1',
        expectedListingVersion: '1',
        listingId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        quantity: '1',
      },
      type: 'PurchaseMarketListingV1',
    });
    await bus(harness.tx).submit(creator, worldId, purchase, commandId, now);
    const received = harness.insertReceived.mock.calls[0]?.[0] as ReceivedCommandWrite;
    harness.findCommandById.mockResolvedValue({
      actorId,
      actorType: 'user',
      commandId,
      commandType: purchase.type,
      idempotencyKey: purchase.idempotencyKey,
      requestHash: received.requestHash,
      result,
      status: 'accepted',
      worldId,
    });
    harness.executeCommerce.mockClear();
    const economyMetric = vi
      .spyOn(telemetry.economyCommands, 'add')
      .mockImplementation(() => undefined);
    try {
      await expect(
        bus(harness.tx).submit(creator, worldId, purchase, commandId, now),
      ).resolves.toEqual({ httpStatus: 200, result });
      await expect(
        bus(harness.tx).submit(
          creator,
          worldId,
          {
            ...purchase,
            payload: { ...purchase.payload, quantity: '2' },
          },
          commandId,
          now,
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });

      expect(harness.executeCommerce).not.toHaveBeenCalled();
      expect(economyMetric).toHaveBeenNthCalledWith(1, 1, {
        operation: 'purchase_listing',
        outcome: 'replayed',
      });
      expect(economyMetric).toHaveBeenNthCalledWith(2, 1, {
        operation: 'purchase_listing',
        outcome: 'idempotency_conflict',
      });
    } finally {
      economyMetric.mockRestore();
    }
  });

  it('records bounded rejection and explicit issuance-override metrics without value labels', async () => {
    const rejectedHarness = transaction();
    const economyMetric = vi
      .spyOn(telemetry.economyCommands, 'add')
      .mockImplementation(() => undefined);
    const initializationMetric = vi
      .spyOn(telemetry.economyInitialization, 'add')
      .mockImplementation(() => undefined);
    const issuanceMetric = vi
      .spyOn(telemetry.economyIssuanceOverrides, 'add')
      .mockImplementation(() => undefined);
    try {
      const rejected = await bus(rejectedHarness.tx).submit(
        creator,
        worldId,
        request({
          expectedAggregateVersion: '0',
          idempotencyKey: 'invalid-economy-initialization',
          payload: { compiledWorldVersionId: 'not-a-uuid', seedPlanHash: 'secret-value' },
          type: 'InitializeWorldEconomyV1',
        }),
        commandId,
        now,
      );
      expect(rejected).toMatchObject({
        httpStatus: 422,
        result: { rejectionCode: 'VALIDATION_FAILED', status: 'rejected' },
      });
      expect(economyMetric).toHaveBeenCalledWith(1, {
        operation: 'initialize',
        outcome: 'rejected',
      });
      expect(initializationMetric).toHaveBeenCalledWith(1, { outcome: 'failed' });

      const issuanceHarness = transaction();
      issuanceHarness.executeEconomy.mockResolvedValue({
        commandId,
        eventIds: [eventId],
        eventSequenceRange: { from: '2', to: '2' },
        ledgerSequenceRange: { from: '2', to: '3' },
        resultingStateRevision: '1',
        schemaVersion: 1,
        status: 'accepted',
      });
      const issued = await bus(issuanceHarness.tx).submit(
        creator,
        worldId,
        request({
          idempotencyKey: 'explicit-economy-issuance',
          payload: {
            amount: '10.00',
            confirmation: 'ISSUE VIRTUAL CURRENCY',
            expectedSupplyVersion: '1',
            reason: 'Creator approved test issuance.',
            treasuryWalletId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
          },
          type: 'IssueCurrencyV1',
        }),
        commandId,
        now,
      );
      expect(issued).toMatchObject({ httpStatus: 200, result: { status: 'accepted' } });
      expect(issuanceMetric).toHaveBeenCalledWith(1, { outcome: 'accepted' });
      const metricAttributes = issuanceMetric.mock.calls[0]?.[1] ?? {};
      expect(Object.keys(metricAttributes)).toEqual(['outcome']);
    } finally {
      economyMetric.mockRestore();
      initializationMetric.mockRestore();
      issuanceMetric.mockRestore();
    }
  });
});
