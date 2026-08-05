import { createHash } from 'node:crypto';

import {
  EMIT_WORLD_NOTICE_PROCESS_VERSION,
  MAX_SIMULATION_EVENTS_PER_ADVANCE,
  MAX_SCHEDULED_ACTIONS_PER_ACTOR,
  MAX_SCHEDULED_ACTIONS_PER_TICK,
  MAX_SCHEDULED_ACTIONS_PER_WORLD,
  SIMULATION_PRNG_ALGORITHM_VERSION,
  SIMULATION_PROCESS_REGISTRY_VERSION,
  SIMULATION_SCHEDULE_SCHEMA_VERSION,
  SimulationErrorCodes,
  WorldEntityStatePairV1Validator,
  canonicalJson,
  type AdvanceSimulationPayloadV1,
  type CancelScheduledActionPayloadV1,
  type ConfigureWorldClockPayloadV1,
  type IdGenerator,
  type IssueCurrencyPayloadV1,
  type GovernanceActorMode,
  type PublicGovernanceCommandRequestV1,
  type ResolveSimulationFailurePayloadV1,
  type ScheduleWorldNoticePayloadV1,
  type ScheduledActionV1,
  type SimulationBatchRunV1,
  type SimulationErrorCode,
  type WorldSimulationClockV1,
  type WorldCommandEnvelopeV1,
  type WorldCommandRejectionCode,
} from '@worldgraph/contracts';
import { validateCompilerPrivateContent } from '@worldgraph/compiler';
import { decideRenameWorldEntityV1 } from '@worldgraph/ledger';
import {
  economyCommandTraceAttributes,
  governanceCommandTraceAttributes,
  telemetry,
  withSpan,
} from '@worldgraph/observability';
import {
  isPublicGovernanceCommandType,
  type GovernanceRecentCredentialProof,
} from '@worldgraph/governance-command';
import {
  SimulationDomainError,
  advanceSimulationClockV1,
  assertExpectedTickV1,
  assertFutureScheduleV1,
  configureSimulationClockV1,
  computeSimulationWorldSeedHashV1,
  createSimulationOutcomeV1,
  deriveWorldTimeV1,
  pauseSimulationClockV1,
  runSimulationProcessV1,
  resolveSimulationFailureClockV1,
  simulationScheduleProcessKeyV1,
  startSimulationClockV1,
} from '@worldgraph/simulation';

import { ApplicationError } from '../application/errors.js';
import { evaluateAuthority } from '../authority/evaluator.js';
import { economyCommandRejectionCode } from '../economy/command-executor.js';
import {
  governanceExecutionInput,
  type GovernanceAuthorityPreparationInput,
  type GovernanceCommandGateway,
} from '../governance/command-gateway.js';
import type { AuthenticatedActor } from '../identity/service.js';
import {
  ACCEPT_ASSET_TRANSFER_OFFER_COMMAND,
  ADVANCE_SIMULATION_COMMAND,
  ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND,
  CANCEL_ASSET_TRANSFER_OFFER_COMMAND,
  CANCEL_SCHEDULED_ACTION_COMMAND,
  CONFIGURE_WORLD_CLOCK_COMMAND,
  CREATE_ASSET_TRANSFER_OFFER_COMMAND,
  CREATE_MARKET_LISTING_COMMAND,
  COMMERCE_PUBLIC_COMMAND_TYPES,
  ECONOMY_PUBLIC_COMMAND_TYPES,
  GOVERNANCE_PUBLIC_COMMAND_TYPES,
  ADOPT_GOVERNANCE_SEED_PLAN_COMMAND,
  APPOINT_OFFICEHOLDER_COMMAND,
  CAST_ELECTION_BALLOT_COMMAND,
  CAST_PROPOSAL_BALLOT_COMMAND,
  CREATE_PROPOSAL_COMMAND,
  EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND,
  INITIALIZE_WORLD_GOVERNANCE_COMMAND,
  NOMINATE_CANDIDATE_COMMAND,
  ACCEPT_NOMINATION_COMMAND,
  REMOVE_OFFICEHOLDER_COMMAND,
  REPAIR_GOVERNANCE_RESULT_COMMAND,
  SPONSOR_PROPOSAL_COMMAND,
  WITHDRAW_PROPOSAL_COMMAND,
  FREEZE_CURRENCY_COMMAND,
  FREEZE_WALLET_COMMAND,
  INITIALIZE_WORLD_ECONOMY_COMMAND,
  ISSUE_CURRENCY_COMMAND,
  PAUSE_WORLD_CLOCK_COMMAND,
  RENAME_WORLD_ENTITY_COMMAND,
  RESOLVE_SIMULATION_FAILURE_COMMAND,
  SCHEDULE_WORLD_NOTICE_COMMAND,
  START_WORLD_CLOCK_COMMAND,
  RECONCILE_WORLD_ECONOMY_COMMAND,
  PERFORM_JOB_COMMAND,
  PURCHASE_MARKET_LISTING_COMMAND,
  START_PRODUCTION_RUN_COMMAND,
  TRANSFER_ASSET_COMMAND,
  TRANSFER_CURRENCY_COMMAND,
  UNFREEZE_CURRENCY_COMMAND,
  UNFREEZE_WALLET_COMMAND,
  WorldCommandRegistry,
} from './registry.js';
import type {
  CommandRepository,
  CommandSubmissionResult,
  CommandTransaction,
  CommandWorldContext,
  EconomyCommandPolicy,
  CommerceCommandPolicy,
  ReceivedCommandWrite,
  SimulationClockRecord,
  SimulationEventWrite,
  StoredCommandIdentity,
} from './types.js';
import type {
  RenameWorldEntityPayloadTransport,
  SubmitWorldCommand,
  WorldCommandResultTransport,
} from './api-contracts.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const defaultEconomyPolicy: EconomyCommandPolicy = {
  debitsFrozen: false,
  issuanceEnabled: true,
  issuanceRateLimitPerHour: 3,
  offerRateLimitPerMinute: 10,
  offersEnabled: true,
  transferRateLimitPerMinute: 20,
  transfersEnabled: true,
};
const defaultCommercePolicy: CommerceCommandPolicy = {
  disabledTaxPolicyIds: [],
  jobsEnabled: true,
  listingRateLimitPerMinute: 10,
  listingsEnabled: true,
  productionEnabled: true,
  productionRateLimitPerMinute: 10,
  purchaseRateLimitPerMinute: 20,
  purchasesEnabled: true,
  workRateLimitPerMinute: 10,
};

export class WorldCommandBus {
  public constructor(
    private readonly repository: CommandRepository,
    private readonly ids: IdGenerator,
    private readonly registry = new WorldCommandRegistry(),
    private readonly economyPolicy: EconomyCommandPolicy = defaultEconomyPolicy,
    private readonly commercePolicy: CommerceCommandPolicy = defaultCommercePolicy,
    private readonly governanceGateway?: GovernanceCommandGateway,
  ) {}

  public async submit(
    actor: AuthenticatedActor,
    worldId: string,
    request: SubmitWorldCommand,
    requestId: string,
    submittedAt: Date,
    recentCredential?: GovernanceRecentCredentialProof,
  ): Promise<CommandSubmissionResult> {
    const governanceHandler = this.registry.resolve(request.type, request.schemaVersion);
    if (
      isPublicGovernanceCommandType(request.type) &&
      governanceHandler?.payloadValidator.is(request.payload) === true &&
      request.expectedTick !== undefined
    ) {
      return this.submitGovernance(
        actor,
        worldId,
        { ...request, expectedTick: request.expectedTick },
        requestId,
        governanceHandler.action,
        recentCredential,
      );
    }
    const requestHash = hash({
      expectedAggregateVersion: request.expectedAggregateVersion,
      expectedStateRevision: request.expectedStateRevision,
      expectedTick: request.expectedTick ?? null,
      expectedWorldVersion: request.expectedWorldVersion,
      payload: request.payload,
      schemaVersion: request.schemaVersion,
      type: request.type,
      worldId,
    });
    const payloadHash = hash(request.payload);
    const eventId = this.ids.next();
    const command: ReceivedCommandWrite = {
      actorId: actor.user.id,
      actorType: actor.user.platformRole === 'platform_admin' ? 'platform_admin' : 'user',
      causationId: null,
      commandId: request.commandId,
      commandType: request.type,
      correlationId: UUID_PATTERN.test(requestId) ? requestId : request.commandId,
      expectedAggregateVersion: request.expectedAggregateVersion,
      expectedStateRevision: request.expectedStateRevision,
      ...(request.expectedTick ? { expectedTick: request.expectedTick } : {}),
      expectedWorldVersion: request.expectedWorldVersion,
      idempotencyKey: request.idempotencyKey,
      payloadClassification: 'member',
      payloadHash,
      rateLimitScopeHash: commerceRateLimitScopeHash(request),
      requestHash,
      requestedAt: submittedAt,
      schemaVersion: request.schemaVersion,
      worldId,
    };

    const execute = (): Promise<CommandSubmissionResult> =>
      this.repository.serializable(async (transaction) => {
        const replay = await this.replayOrConflict(transaction, command);
        if (replay) return { httpStatus: resultStatus(replay), result: replay };
        await transaction.insertReceived(command);

        const world = await transaction.lockWorld(worldId, actor.user.id, command.commandId);
        if (!world) {
          throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
        }
        if (!world.ledgerAnchoredAt || !world.anchorArtifactHash) {
          throw new ApplicationError(
            'LEDGER_NOT_ANCHORED',
            'Authoritative world writes are unavailable until the ledger anchor is verified.',
            503,
          );
        }
        if (world.lifecycle !== 'active') {
          return this.rejected(transaction, command, world, submittedAt, {
            code: 'WORLD_NOT_ACTIVE',
          });
        }

        const handler = this.registry.resolve(request.type, request.schemaVersion);
        if (!handler) {
          return this.rejected(transaction, command, world, submittedAt, {
            code: 'COMMAND_TYPE_DISABLED',
          });
        }
        if (!handler.payloadValidator.is(request.payload)) {
          return this.rejected(transaction, command, world, submittedAt, {
            code: 'VALIDATION_FAILED',
          });
        }
        if (GOVERNANCE_PUBLIC_COMMAND_TYPES.has(request.type)) {
          return this.rejected(transaction, command, world, submittedAt, {
            code: 'VALIDATION_FAILED',
          });
        }
        const historyTargetId = commandHistoryTarget(request);

        const authority = evaluateAuthority(
          {
            ...(world.membershipRole ? { membershipRole: world.membershipRole } : {}),
            ...(world.membershipStatus ? { membershipStatus: world.membershipStatus } : {}),
            platformRole: actor.user.platformRole,
            userId: actor.user.id,
          },
          handler.action,
          { worldId },
          {
            overrideRequested:
              request.type === ISSUE_CURRENCY_COMMAND &&
              (request.payload as Partial<IssueCurrencyPayloadV1>).confirmation ===
                'ISSUE VIRTUAL CURRENCY',
          },
        );
        if (!authority.allowed) {
          return this.rejected(transaction, command, world, submittedAt, {
            authorizationRuleId: authority.ruleId,
            code: 'AUTHORIZATION_DENIED',
            ...(historyTargetId ? { historyTargetId } : {}),
            ...(authority.reasonCode === 'WORLD_NOT_VISIBLE' ? { httpStatus: 404 } : {}),
          });
        }

        const worldConflict = expectedWorldConflict(request, world);
        if (worldConflict) {
          return this.rejected(transaction, command, world, submittedAt, {
            authorizationRuleId: authority.ruleId,
            ...(historyTargetId ? { historyTargetId } : {}),
            ...worldConflict,
          });
        }

        if (COMMERCE_PUBLIC_COMMAND_TYPES.has(request.type)) {
          try {
            const result = await transaction.executeCommerce({
              authorizationRuleId: authority.ruleId,
              command,
              decidedAt: submittedAt,
              policy: this.commercePolicy,
              request,
              world,
            });
            telemetry.economyCommands.add(1, {
              operation: economyOperation(request.type),
              outcome: 'accepted',
            });
            return { httpStatus: 200, result };
          } catch (error) {
            const economyCode = economyCommandRejectionCode(error);
            if (economyCode) {
              return this.rejected(transaction, command, world, submittedAt, {
                authorizationRuleId: authority.ruleId,
                code: economyCode,
              });
            }
            if (error instanceof RangeError || error instanceof TypeError) {
              return this.rejected(transaction, command, world, submittedAt, {
                authorizationRuleId: authority.ruleId,
                code: 'VALIDATION_FAILED',
              });
            }
            throw error;
          }
        }

        if (ECONOMY_PUBLIC_COMMAND_TYPES.has(request.type)) {
          try {
            const result = await transaction.executeEconomy({
              authorizationRuleId: authority.ruleId,
              command,
              decidedAt: submittedAt,
              policy: this.economyPolicy,
              request,
              world,
            });
            telemetry.economyCommands.add(1, {
              operation: economyOperation(request.type),
              outcome: 'accepted',
            });
            if (request.type === INITIALIZE_WORLD_ECONOMY_COMMAND) {
              telemetry.economyInitialization.add(1, { outcome: 'accepted' });
            }
            if (request.type === ISSUE_CURRENCY_COMMAND) {
              telemetry.economyIssuanceOverrides.add(1, { outcome: 'accepted' });
            }
            return { httpStatus: 200, result };
          } catch (error) {
            const economyCode = economyCommandRejectionCode(error);
            if (economyCode) {
              return this.rejected(transaction, command, world, submittedAt, {
                authorizationRuleId: authority.ruleId,
                code: economyCode,
              });
            }
            if (error instanceof RangeError || error instanceof TypeError) {
              return this.rejected(transaction, command, world, submittedAt, {
                authorizationRuleId: authority.ruleId,
                code: 'VALIDATION_FAILED',
              });
            }
            throw error;
          }
        }

        if (request.type !== RENAME_WORLD_ENTITY_COMMAND) {
          return this.executeSimulation(
            transaction,
            command,
            world,
            request,
            authority.ruleId,
            submittedAt,
          );
        }
        const payload = request.payload as RenameWorldEntityPayloadTransport;
        const entity = await transaction.lockEntity(worldId, payload.entityKey);
        if (!entity) {
          return this.rejected(transaction, command, world, submittedAt, {
            authorizationRuleId: authority.ruleId,
            code: 'ENTITY_NOT_FOUND',
            historyTargetId: payload.entityKey,
            redactedTargetHash: hashHex(payload.entityKey),
          });
        }
        const pair = { entityType: entity.entityType, state: entity.state };
        if (!WorldEntityStatePairV1Validator.is(pair)) {
          return this.rejected(transaction, command, world, submittedAt, {
            authorizationRuleId: authority.ruleId,
            code: 'VALIDATION_FAILED',
            historyTargetId: payload.entityKey,
            redactedTargetHash: hashHex(payload.entityKey),
          });
        }
        if (
          validateCompilerPrivateContent(payload.newDisplayName, '/newDisplayName', 'validate')
            .length > 0
        ) {
          return this.rejected(transaction, command, world, submittedAt, {
            authorizationRuleId: authority.ruleId,
            code: 'VALIDATION_FAILED',
            historyTargetId: payload.entityKey,
            redactedTargetHash: hashHex(payload.entityKey),
          });
        }
        const envelope: WorldCommandEnvelopeV1 = {
          actor: { actorId: command.actorId, actorType: command.actorType },
          causationId: command.causationId,
          commandId: command.commandId,
          correlationId: command.correlationId,
          expectedAggregateVersion: request.expectedAggregateVersion,
          expectedStateRevision: request.expectedStateRevision,
          expectedWorldVersion: request.expectedWorldVersion,
          idempotencyKey: request.idempotencyKey,
          overrideId: null,
          payload,
          schemaVersion: 1,
          type: RENAME_WORLD_ENTITY_COMMAND,
          worldId,
        };
        const decision = decideRenameWorldEntityV1(envelope, {
          entity: {
            ...pair,
            entitySchemaVersion: entity.entitySchemaVersion as 1,
            entityVersion: entity.entityVersion,
            logicalKey: entity.logicalKey,
          },
          stateRevision: world.stateRevision,
          worldVersionNumber: world.designVersion,
        });
        if (!decision.accepted) {
          return this.rejected(transaction, command, world, submittedAt, {
            authorizationRuleId: authority.ruleId,
            code: decision.rejectionCode,
            currentStateRevision: decision.currentStateRevision,
            historyTargetId: payload.entityKey,
            redactedTargetHash: hashHex(payload.entityKey),
          });
        }

        const resultingEntityVersion = decision.payload.entityVersion;
        const resultingStateRevision = incrementDecimal(world.stateRevision);
        const nextState = { ...entity.state, name: decision.payload.newDisplayName };
        if (
          !WorldEntityStatePairV1Validator.is({ entityType: entity.entityType, state: nextState })
        ) {
          return this.rejected(transaction, command, world, submittedAt, {
            authorizationRuleId: authority.ruleId,
            code: 'VALIDATION_FAILED',
            historyTargetId: payload.entityKey,
            redactedTargetHash: hashHex(payload.entityKey),
          });
        }
        const result = await transaction.acceptRename({
          authorizationRuleId: authority.ruleId,
          command,
          decidedAt: submittedAt,
          entity,
          eventId,
          eventPayload: decision.payload,
          eventType: 'WorldEntityRenamedV1',
          nextState,
          resultingEntityVersion,
          resultingStateRevision,
        });
        return { httpStatus: 200, result };
      }, worldId);

    if (
      !COMMERCE_PUBLIC_COMMAND_TYPES.has(request.type) &&
      !ECONOMY_PUBLIC_COMMAND_TYPES.has(request.type)
    ) {
      return execute();
    }
    return withSpan('world.economy.command', async (span) => {
      span.setAttributes(
        economyCommandTraceAttributes({
          actorId: command.actorId,
          commandId: command.commandId,
          commandType: command.commandType,
          correlationId: command.correlationId,
          idempotencyKey: command.idempotencyKey,
          ...(command.expectedTick ? { tick: command.expectedTick } : {}),
          worldId: command.worldId,
        }),
      );
      span.setAttribute('world.economy.outcome', 'executing');
      try {
        const outcome = await execute();
        span.setAttributes({
          'world.economy.event_count': outcome.result.eventIds.length,
          'world.economy.outcome': outcome.result.status,
        });
        if (outcome.result.status === 'rejected' || outcome.result.status === 'failed') {
          span.setAttribute('world.economy.rejection_code', outcome.result.rejectionCode);
        }
        return outcome;
      } catch (error) {
        span.setAttribute('world.economy.outcome', 'failed_before_result');
        throw error;
      }
    });
  }

  private async submitGovernance(
    actor: AuthenticatedActor,
    worldId: string,
    request: SubmitWorldCommand & { expectedTick: string },
    requestId: string,
    actionCode: GovernanceAuthorityPreparationInput['actionCode'],
    recentCredential?: GovernanceRecentCredentialProof,
  ): Promise<CommandSubmissionResult> {
    if (!this.governanceGateway) {
      throw new ApplicationError(
        'GOVERNANCE_COMMAND_UNAVAILABLE',
        'Governance command execution is unavailable.',
        503,
      );
    }
    const actorMode = governanceActorMode(request.type, actor.user.platformRole);
    const resource = governanceCommandResource(request, worldId);
    const overrideRequested = governanceOverrideIsExplicit(request);
    const policyResourceType = governancePolicyResourceType(request.type);
    const preparation = await this.governanceGateway.prepareAuthority({
      actionCode,
      actorId: actor.user.id,
      actorMode,
      allowActiveLaw: governanceUsesActiveCivicLaw(request.type),
      overrideRequested,
      platformRole: actor.user.platformRole,
      policyActionCode: governancePolicyAction(request.type),
      ...(policyResourceType ? { policyResourceType } : {}),
      resourceId: resource.resourceId,
      resourceKey: resource.resourceKey,
      resourceType: resource.resourceType,
      worldId,
    });
    if (!preparation) {
      throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
    }
    const correlationId = UUID_PATTERN.test(requestId) ? requestId : request.commandId;
    const governanceCommand = {
      ...request,
      actorMode,
    } as unknown as PublicGovernanceCommandRequestV1;
    const executionInput = governanceExecutionInput(governanceCommand, preparation, {
      correlationId,
      ...(recentCredential ? { recentCredential } : {}),
      worldId,
    });
    return withSpan('world.governance.command', async (span) => {
      span.setAttributes(
        governanceCommandTraceAttributes({
          actorId: actor.user.id,
          commandId: request.commandId,
          commandType: request.type,
          correlationId,
          ...(request.expectedTick ? { tick: request.expectedTick } : {}),
          worldId,
        }),
      );
      span.setAttribute('world.governance.outcome', 'executing');
      try {
        const execution = await this.governanceGateway!.executePublic(executionInput);
        const { result } = execution;
        const rejectionCode =
          result.status === 'rejected' || result.status === 'failed'
            ? result.rejectionCode
            : 'none';
        telemetry.governanceCommands.add(1, {
          command_type: request.type,
          outcome: result.status,
          rejection_code: rejectionCode,
        });
        if (rejectionCode === 'AUTHORIZATION_DENIED') {
          telemetry.governanceAuthorityDenies.add(1, { action: actionCode });
        }
        if (
          (request.type === CAST_PROPOSAL_BALLOT_COMMAND ||
            request.type === CAST_ELECTION_BALLOT_COMMAND) &&
          rejectionCode !== 'none'
        ) {
          telemetry.governanceBallotRejections.add(1, { rejection_code: rejectionCode });
        }
        if (request.type === EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND) {
          telemetry.governanceOverrides.add(1, { outcome: result.status });
        }
        if (request.type === REPAIR_GOVERNANCE_RESULT_COMMAND) {
          telemetry.governanceRepairs.add(1, { outcome: result.status });
        }
        span.setAttributes({
          'world.governance.event_count': result.eventIds.length,
          'world.governance.outcome': result.status,
          'world.governance.replayed': execution.replayed,
        });
        if (rejectionCode !== 'none') {
          span.setAttribute('world.governance.rejection_code', rejectionCode);
        }
        return {
          httpStatus:
            preparation.hiddenByAuthority && rejectionCode === 'AUTHORIZATION_DENIED'
              ? 404
              : resultStatus(result),
          result,
        };
      } catch (error) {
        span.setAttribute('world.governance.outcome', 'failed_before_result');
        throw error;
      }
    });
  }

  private async executeSimulation(
    transaction: CommandTransaction,
    command: ReceivedCommandWrite,
    world: CommandWorldContext,
    request: SubmitWorldCommand,
    authorizationRuleId: string,
    submittedAt: Date,
  ): Promise<CommandSubmissionResult> {
    const clockRecord = await transaction.lockSimulationClock(world.worldId);
    if (!clockRecord) {
      throw new ApplicationError(
        'NOT_FOUND',
        'The world simulation has not been initialized.',
        404,
      );
    }
    if (request.expectedTick === undefined) {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: 'VALIDATION_FAILED',
      });
    }
    try {
      assertExpectedTickV1(clockState(clockRecord), request.expectedTick);
      switch (request.type) {
        case CONFIGURE_WORLD_CLOCK_COMMAND:
          return await this.configureClock(
            transaction,
            command,
            world,
            request,
            clockRecord,
            authorizationRuleId,
            submittedAt,
          );
        case START_WORLD_CLOCK_COMMAND:
          return await this.startClock(
            transaction,
            command,
            world,
            request,
            clockRecord,
            authorizationRuleId,
            submittedAt,
          );
        case PAUSE_WORLD_CLOCK_COMMAND:
          return await this.pauseClock(
            transaction,
            command,
            world,
            request,
            clockRecord,
            authorizationRuleId,
            submittedAt,
          );
        case ADVANCE_SIMULATION_COMMAND:
          return await this.advanceSimulation(
            transaction,
            command,
            world,
            request,
            clockRecord,
            authorizationRuleId,
            submittedAt,
          );
        case SCHEDULE_WORLD_NOTICE_COMMAND:
          return await this.scheduleWorldNotice(
            transaction,
            command,
            world,
            request,
            clockRecord,
            authorizationRuleId,
            submittedAt,
          );
        case CANCEL_SCHEDULED_ACTION_COMMAND:
          return await this.cancelScheduledAction(
            transaction,
            command,
            world,
            request,
            clockRecord,
            authorizationRuleId,
            submittedAt,
          );
        case RESOLVE_SIMULATION_FAILURE_COMMAND:
          return await this.resolveSimulationFailure(
            transaction,
            command,
            world,
            request,
            clockRecord,
            authorizationRuleId,
            submittedAt,
          );
        default:
          return this.rejected(transaction, command, world, submittedAt, {
            authorizationRuleId,
            code: 'COMMAND_TYPE_DISABLED',
          });
      }
    } catch (error) {
      const simulationCode = simulationDomainErrorCode(error);
      if (simulationCode) {
        return this.rejected(transaction, command, world, submittedAt, {
          authorizationRuleId,
          code: simulationCode,
        });
      }
      if (error instanceof RangeError || error instanceof TypeError) {
        return this.rejected(transaction, command, world, submittedAt, {
          authorizationRuleId,
          code: 'VALIDATION_FAILED',
        });
      }
      throw error;
    }
  }

  private async configureClock(
    transaction: CommandTransaction,
    command: ReceivedCommandWrite,
    world: CommandWorldContext,
    request: SubmitWorldCommand,
    clockRecord: SimulationClockRecord,
    authorizationRuleId: string,
    submittedAt: Date,
  ): Promise<CommandSubmissionResult> {
    const conflict = expectedAggregateConflict(request.expectedAggregateVersion, clockRecord);
    if (conflict) {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: conflict,
      });
    }
    const payload = request.payload as ConfigureWorldClockPayloadV1;
    const previousConfiguration = clockRecord.clock.configuration;
    const state = configureSimulationClockV1(clockState(clockRecord), {
      epochAt: payload.epoch,
      maxBatchTicks: payload.maxBatch,
      maxCatchUpTicks: payload.maxCatchUp,
      prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
      wallCadenceMilliseconds: payload.wallCadenceMs,
      worldMillisecondsPerTick: payload.worldMillisecondsPerTick,
    });
    const resultingStateRevision = incrementDecimal(world.stateRevision);
    const eventId = this.ids.next();
    const result = await transaction.acceptSimulation({
      authorizationRuleId,
      clock: projectedClock(clockRecord.clock, state, resultingStateRevision, submittedAt, null),
      command,
      decidedAt: submittedAt,
      events: [
        {
          aggregateId: world.worldId,
          aggregateType: 'simulation_clock',
          eventId,
          eventType: 'WorldClockConfiguredV1',
          payload: {
            configuration: state.configuration,
            previousConfiguration,
            tick: '0',
          },
        },
      ],
      resultingStateRevision,
    });
    return { httpStatus: 200, result };
  }

  private async startClock(
    transaction: CommandTransaction,
    command: ReceivedCommandWrite,
    world: CommandWorldContext,
    request: SubmitWorldCommand,
    clockRecord: SimulationClockRecord,
    authorizationRuleId: string,
    submittedAt: Date,
  ): Promise<CommandSubmissionResult> {
    const conflict = expectedAggregateConflict(request.expectedAggregateVersion, clockRecord);
    if (conflict) {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: conflict,
      });
    }
    const state = startSimulationClockV1(clockState(clockRecord));
    const resultingStateRevision = incrementDecimal(world.stateRevision);
    const eventId = this.ids.next();
    const result = await transaction.acceptSimulation({
      authorizationRuleId,
      clock: projectedClock(
        clockRecord.clock,
        state,
        resultingStateRevision,
        submittedAt,
        submittedAt,
      ),
      command,
      decidedAt: submittedAt,
      events: [
        {
          aggregateId: world.worldId,
          aggregateType: 'simulation_clock',
          eventId,
          eventType: 'WorldClockStartedV1',
          payload: { tick: state.currentTick },
        },
      ],
      resultingStateRevision,
    });
    return { httpStatus: 200, result };
  }

  private async pauseClock(
    transaction: CommandTransaction,
    command: ReceivedCommandWrite,
    world: CommandWorldContext,
    request: SubmitWorldCommand,
    clockRecord: SimulationClockRecord,
    authorizationRuleId: string,
    submittedAt: Date,
  ): Promise<CommandSubmissionResult> {
    const conflict = expectedAggregateConflict(request.expectedAggregateVersion, clockRecord);
    if (conflict) {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: conflict,
      });
    }
    const state = pauseSimulationClockV1(clockState(clockRecord));
    const resultingStateRevision = incrementDecimal(world.stateRevision);
    const eventId = this.ids.next();
    const result = await transaction.acceptSimulation({
      authorizationRuleId,
      clock: projectedClock(clockRecord.clock, state, resultingStateRevision, submittedAt, null),
      command,
      decidedAt: submittedAt,
      events: [
        {
          aggregateId: world.worldId,
          aggregateType: 'simulation_clock',
          eventId,
          eventType: 'WorldClockPausedV1',
          payload: { reason: 'creator', tick: state.currentTick },
        },
      ],
      resultingStateRevision,
    });
    return { httpStatus: 200, result };
  }

  private async scheduleWorldNotice(
    transaction: CommandTransaction,
    command: ReceivedCommandWrite,
    world: CommandWorldContext,
    request: SubmitWorldCommand,
    clockRecord: SimulationClockRecord,
    authorizationRuleId: string,
    submittedAt: Date,
  ): Promise<CommandSubmissionResult> {
    if (request.expectedAggregateVersion !== '0') {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: 'AGGREGATE_VERSION_CONFLICT',
      });
    }
    const payload = request.payload as ScheduleWorldNoticePayloadV1;
    assertFutureScheduleV1(clockRecord.clock.currentTick, payload.dueTick);
    const capacity = await transaction.countScheduledActionsForWorldAndActor(
      world.worldId,
      command.actorId,
    );
    if (
      capacity.worldCount >= MAX_SCHEDULED_ACTIONS_PER_WORLD ||
      capacity.actorCount >= MAX_SCHEDULED_ACTIONS_PER_ACTOR
    ) {
      throw new SimulationDomainError(
        'SIMULATION_BUDGET_EXCEEDED',
        'The active scheduled action limit has been reached.',
      );
    }
    if (
      (await transaction.countScheduledActionsAtTick(world.worldId, payload.dueTick)) >=
      MAX_SCHEDULED_ACTIONS_PER_TICK
    ) {
      throw new SimulationDomainError(
        'SIMULATION_BUDGET_EXCEEDED',
        'The scheduled action limit for this tick has been reached.',
      );
    }
    const scheduleSequence = await transaction.allocateScheduleSequence(world.worldId);
    const scheduleId = this.ids.next();
    const eventId = this.ids.next();
    const resultingStateRevision = incrementDecimal(world.stateRevision);
    const actionPayload = { text: payload.text, visibility: payload.visibility } as const;
    const action: ScheduledActionV1 = {
      actionSchemaVersion: SIMULATION_SCHEDULE_SCHEMA_VERSION,
      actionType: 'EmitWorldNoticeV1',
      cancelledCommandId: null,
      completedEventId: null,
      completedStateRevision: null,
      createdAt: submittedAt.toISOString(),
      createdBy: { actorId: command.actorId, actorType: command.actorType },
      createdCommandId: command.commandId,
      createdStateRevision: resultingStateRevision,
      dueTick: payload.dueTick,
      id: scheduleId,
      payload: actionPayload,
      payloadHash: hash(actionPayload).toString('hex'),
      priority: payload.priority,
      processVersion: EMIT_WORLD_NOTICE_PROCESS_VERSION,
      scheduleSchemaVersion: SIMULATION_SCHEDULE_SCHEMA_VERSION,
      scheduleSequence,
      status: 'scheduled',
      updatedAt: submittedAt.toISOString(),
      worldId: world.worldId,
    };
    const result = await transaction.acceptSimulation({
      authorizationRuleId,
      command,
      decidedAt: submittedAt,
      events: [
        {
          aggregateId: scheduleId,
          aggregateType: 'scheduled_action',
          eventId,
          eventType: 'ScheduledActionCreatedV1',
          payload: {
            actionSchemaVersion: SIMULATION_SCHEDULE_SCHEMA_VERSION,
            actionType: action.actionType,
            dueTick: action.dueTick,
            payload: action.payload,
            payloadHash: action.payloadHash,
            priority: action.priority,
            processVersion: action.processVersion,
            scheduleId,
            scheduleSequence,
          },
        },
      ],
      resultingStateRevision,
      scheduleCreates: [action],
    });
    return { httpStatus: 200, result };
  }

  private async cancelScheduledAction(
    transaction: CommandTransaction,
    command: ReceivedCommandWrite,
    world: CommandWorldContext,
    request: SubmitWorldCommand,
    _clockRecord: SimulationClockRecord,
    authorizationRuleId: string,
    submittedAt: Date,
  ): Promise<CommandSubmissionResult> {
    const payload = request.payload as CancelScheduledActionPayloadV1;
    const record = await transaction.lockScheduledAction(world.worldId, payload.scheduleId);
    if (!record) {
      throw new ApplicationError('NOT_FOUND', 'The scheduled action was not found.', 404);
    }
    if (record.action.actionType !== 'EmitWorldNoticeV1') {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: 'VALIDATION_FAILED',
        historyTargetId: record.action.id,
        redactedTargetHash: hashHex(record.action.id),
      });
    }
    if (record.action.status !== 'scheduled') {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: 'SCHEDULE_ALREADY_TERMINAL',
      });
    }
    if (request.expectedAggregateVersion !== record.aggregateVersion) {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: 'AGGREGATE_VERSION_CONFLICT',
      });
    }
    const eventId = this.ids.next();
    const resultingStateRevision = incrementDecimal(world.stateRevision);
    const result = await transaction.acceptSimulation({
      authorizationRuleId,
      command,
      decidedAt: submittedAt,
      events: [
        {
          aggregateId: record.action.id,
          aggregateType: 'scheduled_action',
          eventId,
          eventType: 'ScheduledActionCancelledV1',
          payload: {
            actionType: record.action.actionType,
            dueTick: record.action.dueTick,
            scheduleId: record.action.id,
            scheduleSequence: record.action.scheduleSequence,
          },
        },
      ],
      resultingStateRevision,
      scheduleTerminals: [
        {
          cancelledCommandId: command.commandId,
          completedEventId: null,
          completedStateRevision: resultingStateRevision,
          id: record.action.id,
          status: 'cancelled',
        },
      ],
    });
    return { httpStatus: 200, result };
  }

  private async resolveSimulationFailure(
    transaction: CommandTransaction,
    command: ReceivedCommandWrite,
    world: CommandWorldContext,
    request: SubmitWorldCommand,
    clockRecord: SimulationClockRecord,
    authorizationRuleId: string,
    submittedAt: Date,
  ): Promise<CommandSubmissionResult> {
    const payload = request.payload as ResolveSimulationFailurePayloadV1;
    const record = await transaction.lockSimulationFailure(world.worldId, payload.failureId);
    if (!record) {
      throw new ApplicationError('NOT_FOUND', 'The simulation failure was not found.', 404);
    }
    if (
      record.failure.status !== 'open' ||
      request.expectedAggregateVersion !== record.aggregateVersion
    ) {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: 'AGGREGATE_VERSION_CONFLICT',
        historyTargetId: payload.failureId,
        redactedTargetHash: hashHex(payload.failureId),
      });
    }

    const nextClock = resolveSimulationFailureClockV1(clockState(clockRecord));
    const resultingStateRevision = incrementDecimal(world.stateRevision);
    const events: SimulationEventWrite[] = [
      {
        aggregateId: record.failure.id,
        aggregateType: 'simulation_failure',
        eventId: this.ids.next(),
        eventType: 'SimulationFailureResolvedV1',
        payload: {
          failureId: record.failure.id,
          resolution: payload.resolution,
          scheduleId: record.failure.scheduleId,
          tick: record.failure.tick,
        },
      },
    ];
    const scheduleTerminals = [];
    if (payload.resolution === 'cancel_action') {
      if (!record.failure.scheduleId) {
        return this.rejected(transaction, command, world, submittedAt, {
          authorizationRuleId,
          code: 'VALIDATION_FAILED',
          historyTargetId: payload.failureId,
          redactedTargetHash: hashHex(payload.failureId),
        });
      }
      const schedule = await transaction.lockScheduledAction(
        world.worldId,
        record.failure.scheduleId,
      );
      if (!schedule) {
        throw new ApplicationError('NOT_FOUND', 'The failed scheduled action was not found.', 404);
      }
      if (schedule.action.actionType !== 'EmitWorldNoticeV1') {
        return this.rejected(transaction, command, world, submittedAt, {
          authorizationRuleId,
          code: 'VALIDATION_FAILED',
          historyTargetId: schedule.action.id,
          redactedTargetHash: hashHex(schedule.action.id),
        });
      }
      if (schedule.action.status !== 'scheduled') {
        return this.rejected(transaction, command, world, submittedAt, {
          authorizationRuleId,
          code: 'SCHEDULE_ALREADY_TERMINAL',
          historyTargetId: schedule.action.id,
          redactedTargetHash: hashHex(schedule.action.id),
        });
      }
      events.push({
        aggregateId: schedule.action.id,
        aggregateType: 'scheduled_action',
        eventId: this.ids.next(),
        eventType: 'ScheduledActionCancelledV1',
        payload: {
          actionType: schedule.action.actionType,
          dueTick: schedule.action.dueTick,
          scheduleId: schedule.action.id,
          scheduleSequence: schedule.action.scheduleSequence,
        },
      });
      scheduleTerminals.push({
        cancelledCommandId: command.commandId,
        completedEventId: null,
        completedStateRevision: resultingStateRevision,
        id: schedule.action.id,
        status: 'cancelled' as const,
      });
    }

    const result = await transaction.acceptSimulation({
      authorizationRuleId,
      clock: projectedClock(
        clockRecord.clock,
        nextClock,
        resultingStateRevision,
        submittedAt,
        null,
      ),
      command,
      decidedAt: submittedAt,
      events,
      failureResolution: {
        failureId: record.failure.id,
        resolvedAt: submittedAt,
        resolvedByActorId: command.actorId,
        resolutionCommandId: command.commandId,
      },
      resultingStateRevision,
      ...(scheduleTerminals.length > 0 ? { scheduleTerminals } : {}),
    });
    return { httpStatus: 200, result };
  }

  private async advanceSimulation(
    transaction: CommandTransaction,
    command: ReceivedCommandWrite,
    world: CommandWorldContext,
    request: SubmitWorldCommand,
    clockRecord: SimulationClockRecord,
    authorizationRuleId: string,
    submittedAt: Date,
  ): Promise<CommandSubmissionResult> {
    const conflict = expectedAggregateConflict(request.expectedAggregateVersion, clockRecord);
    if (conflict) {
      return this.rejected(transaction, command, world, submittedAt, {
        authorizationRuleId,
        code: conflict,
      });
    }
    const payload = request.payload as AdvanceSimulationPayloadV1;
    const nextState = advanceSimulationClockV1(clockState(clockRecord), payload.ticks);
    const due = await transaction.lockDueScheduledActions(world.worldId, nextState.currentTick);
    const eventCount =
      1 +
      due.reduce((count, action) => count + (action.actionType === 'EmitWorldNoticeV1' ? 2 : 1), 0);
    if (eventCount > MAX_SIMULATION_EVENTS_PER_ADVANCE) {
      throw new SimulationDomainError(
        'SIMULATION_BUDGET_EXCEEDED',
        'The due schedule set exceeds the atomic command event budget.',
      );
    }
    const fromTick = clockRecord.clock.currentTick;
    const semanticTicks = [];
    const processResults = new Map<string, ReturnType<typeof runSimulationProcessV1>>();
    for (let tick = BigInt(fromTick) + 1n; tick <= BigInt(nextState.currentTick); tick += 1n) {
      const tickText = tick.toString(10);
      const tickActions = due.filter((action) => action.dueTick === tickText);
      const returnedEvents = [];
      for (const action of tickActions) {
        const worldTime = deriveWorldTimeV1(
          clockRecord.clock.configuration.epochAt,
          tickText,
          clockRecord.clock.configuration.worldMillisecondsPerTick,
        );
        const processResult = runSimulationProcessV1({
          actionSchemaVersion: action.actionSchemaVersion,
          actionType: action.actionType,
          context: {
            currentProjectionChecksum: clockRecord.projectionChecksum,
            processSchemaVersion: 1,
            scheduleSequence: action.scheduleSequence,
            stableProcessKey: simulationScheduleProcessKeyV1(action.scheduleSequence),
            state: {},
            tick: tickText,
            worldSeed: clockRecord.worldSeed,
            worldTimeUnixMilliseconds: worldTime.worldTimeUnixMilliseconds,
          },
          payload: action.payload,
          processVersion: action.processVersion,
        });
        processResults.set(action.id, processResult);
        returnedEvents.push(...processResult.events);
      }
      semanticTicks.push({
        createdSchedules: [],
        dueActions: tickActions.map((action) => ({
          actionSchemaVersion: action.actionSchemaVersion,
          actionType: action.actionType,
          dueTick: action.dueTick,
          payloadHash: action.payloadHash,
          priority: action.priority,
          processVersion: action.processVersion,
          scheduleSequence: action.scheduleSequence,
        })),
        returnedEvents,
        tick: tickText,
      });
    }
    const outcome = createSimulationOutcomeV1({
      prngAlgorithmVersion: SIMULATION_PRNG_ALGORITHM_VERSION,
      processRegistryVersion: SIMULATION_PROCESS_REGISTRY_VERSION,
      startingOutcomeHash: clockRecord.clock.outcomeHash,
      startingProjectionChecksum: clockRecord.projectionChecksum,
      ticks: semanticTicks,
      worldSeedHash: computeSimulationWorldSeedHashV1(clockRecord.worldSeed),
    });
    const events: SimulationEventWrite[] = [
      {
        aggregateId: world.worldId,
        aggregateType: 'simulation_clock',
        eventId: this.ids.next(),
        eventType: 'SimulationAdvancedV1',
        payload: {
          executedScheduleCount: due.length,
          fromTick,
          outcomeHash: outcome.outcomeHash,
          processRegistryVersion: SIMULATION_PROCESS_REGISTRY_VERSION,
          tickCount: payload.ticks,
          toTick: nextState.currentTick,
        },
      },
    ];
    const terminals = [];
    for (const action of due) {
      const processResult = processResults.get(action.id);
      const notice = processResult?.events[0];
      const validNotice =
        action.actionType === 'EmitWorldNoticeV1' &&
        processResult?.events.length === 1 &&
        notice?.eventType === 'WorldNoticeEmittedV1';
      const validSystemDispatch =
        action.actionType !== 'EmitWorldNoticeV1' && processResult?.events.length === 0;
      if (!validNotice && !validSystemDispatch) {
        throw new SimulationDomainError(
          'SIMULATION_HANDLER_FAILED',
          'The registered scheduled process returned an invalid event set.',
        );
      }
      const executedEventId = this.ids.next();
      events.push({
        aggregateId: action.id,
        aggregateType: 'scheduled_action',
        eventId: executedEventId,
        eventType: 'ScheduledActionExecutedV1',
        payload: {
          actionType: action.actionType,
          dueTick: action.dueTick,
          outcomeHash: outcome.outcomeHash,
          processVersion: action.processVersion,
          scheduleId: action.id,
          scheduleSequence: action.scheduleSequence,
        },
      });
      if (validNotice) {
        events.push({
          aggregateId: action.id,
          aggregateType: 'world_notice',
          eventId: this.ids.next(),
          eventType: 'WorldNoticeEmittedV1',
          payload: { ...notice.payload, scheduleId: action.id },
        });
      }
      terminals.push({
        cancelledCommandId: null,
        completedEventId: executedEventId,
        completedStateRevision: incrementDecimal(world.stateRevision),
        id: action.id,
        status: 'completed' as const,
      });
    }
    const resultingStateRevision = incrementDecimal(world.stateRevision);
    const batch: SimulationBatchRunV1 = {
      attempts: 1,
      batchKey: hash({
        fromTick,
        inputChecksum: clockRecord.projectionChecksum,
        processRegistryVersion: SIMULATION_PROCESS_REGISTRY_VERSION,
        toTick: nextState.currentTick,
        worldId: world.worldId,
      }).toString('hex'),
      batchSchemaVersion: 1,
      commandId: command.commandId,
      completedAt: submittedAt.toISOString(),
      errorCode: null,
      fromTick,
      id: this.ids.next(),
      inputChecksum: clockRecord.projectionChecksum,
      outcomeHash: outcome.outcomeHash,
      processRegistryVersion: SIMULATION_PROCESS_REGISTRY_VERSION,
      startedAt: submittedAt.toISOString(),
      status: 'completed',
      toTick: nextState.currentTick,
      worldId: world.worldId,
    };
    const result = await transaction.acceptSimulation({
      authorizationRuleId,
      batch,
      clock: projectedClock(
        clockRecord.clock,
        nextState,
        resultingStateRevision,
        submittedAt,
        nextState.mode === 'running' ? advancedWallAnchor(clockRecord.clock, payload.ticks) : null,
        outcome.outcomeHash,
      ),
      command,
      decidedAt: submittedAt,
      events,
      resultingStateRevision,
      scheduleTerminals: terminals,
    });
    return { httpStatus: 200, result };
  }

  private async replayOrConflict(
    transaction: Parameters<CommandRepository['serializable']>[0] extends (
      transaction: infer T,
    ) => unknown
      ? T
      : never,
    command: ReceivedCommandWrite,
  ): Promise<WorldCommandResultTransport | null> {
    const byId = await transaction.findCommandById(command.commandId);
    if (byId) return this.replayStoredWithTelemetry(byId, command);
    const byIdempotency = await transaction.findCommandByIdempotency({
      actorId: command.actorId,
      actorType: command.actorType,
      commandType: command.commandType,
      idempotencyKey: command.idempotencyKey,
      worldId: command.worldId,
    });
    if (byIdempotency) return this.replayStoredWithTelemetry(byIdempotency, command);
    return null;
  }

  private replayStoredWithTelemetry(
    stored: StoredCommandIdentity,
    command: ReceivedCommandWrite,
  ): WorldCommandResultTransport {
    try {
      const result = replayStored(stored, command);
      telemetry.idempotency.add(1, { outcome: 'replay', scope: 'world_command' });
      if (
        ECONOMY_PUBLIC_COMMAND_TYPES.has(command.commandType) ||
        COMMERCE_PUBLIC_COMMAND_TYPES.has(command.commandType)
      ) {
        telemetry.economyCommands.add(1, {
          operation: economyOperation(command.commandType),
          outcome: 'replayed',
        });
      }
      return result;
    } catch (error) {
      const outcome =
        error instanceof ApplicationError && error.code === 'IDEMPOTENCY_KEY_REUSED'
          ? 'conflict'
          : error instanceof ApplicationError && error.code === 'COMMAND_IN_PROGRESS'
            ? 'in_progress'
            : 'failed';
      telemetry.idempotency.add(1, { outcome, scope: 'world_command' });
      if (
        outcome === 'conflict' &&
        (ECONOMY_PUBLIC_COMMAND_TYPES.has(command.commandType) ||
          COMMERCE_PUBLIC_COMMAND_TYPES.has(command.commandType))
      ) {
        telemetry.economyCommands.add(1, {
          operation: economyOperation(command.commandType),
          outcome: 'idempotency_conflict',
        });
      }
      throw error;
    }
  }

  private async rejected(
    transaction: Parameters<CommandRepository['serializable']>[0] extends (
      transaction: infer T,
    ) => unknown
      ? T
      : never,
    command: ReceivedCommandWrite,
    world: CommandWorldContext,
    decidedAt: Date,
    rejection: {
      authorizationRuleId?: string;
      code: WorldCommandRejectionCode;
      currentEntityVersion?: string;
      currentStateRevision?: string;
      currentWorldVersion?: string;
      historyTargetId?: string;
      httpStatus?: 403 | 404 | 409 | 422;
      redactedTargetHash?: string;
    },
  ): Promise<CommandSubmissionResult> {
    if (
      ECONOMY_PUBLIC_COMMAND_TYPES.has(command.commandType) ||
      COMMERCE_PUBLIC_COMMAND_TYPES.has(command.commandType)
    ) {
      telemetry.economyCommands.add(1, {
        operation: economyOperation(command.commandType),
        outcome: 'rejected',
      });
      if (command.commandType === INITIALIZE_WORLD_ECONOMY_COMMAND) {
        telemetry.economyInitialization.add(1, {
          outcome: rejection.code === 'SEED_PLAN_HASH_MISMATCH' ? 'hash_mismatch' : 'failed',
        });
      }
      if (command.commandType === RECONCILE_WORLD_ECONOMY_COMMAND) {
        telemetry.economyReconciliationRuns.add(1, {
          outcome: 'failed',
          trigger: 'command',
        });
      }
    }
    const result = await transaction.reject({
      authorizationRuleId: rejection.authorizationRuleId ?? null,
      code: rejection.code,
      command,
      ...(rejection.currentEntityVersion
        ? { currentEntityVersion: rejection.currentEntityVersion }
        : {}),
      ...(rejection.currentStateRevision
        ? { currentStateRevision: rejection.currentStateRevision }
        : {}),
      ...(rejection.currentWorldVersion
        ? { currentWorldVersion: rejection.currentWorldVersion }
        : {}),
      decidedAt,
      ...(rejection.historyTargetId ? { historyTargetId: rejection.historyTargetId } : {}),
      ...(rejection.redactedTargetHash ? { redactedTargetHash: rejection.redactedTargetHash } : {}),
    });
    return { httpStatus: rejection.httpStatus ?? resultStatus(result), result };
  }
}

function economyOperation(commandType: string): string {
  const operations: Readonly<Record<string, string>> = {
    [ACCEPT_ASSET_TRANSFER_OFFER_COMMAND]: 'accept_offer',
    [ADOPT_LEGACY_ECONOMY_SEED_PLAN_COMMAND]: 'adopt_legacy_seed',
    [CANCEL_ASSET_TRANSFER_OFFER_COMMAND]: 'cancel_offer',
    [CREATE_ASSET_TRANSFER_OFFER_COMMAND]: 'create_offer',
    [FREEZE_CURRENCY_COMMAND]: 'freeze_currency',
    [FREEZE_WALLET_COMMAND]: 'freeze_wallet',
    [INITIALIZE_WORLD_ECONOMY_COMMAND]: 'initialize',
    [ISSUE_CURRENCY_COMMAND]: 'issue_currency',
    [RECONCILE_WORLD_ECONOMY_COMMAND]: 'reconcile',
    [TRANSFER_ASSET_COMMAND]: 'transfer_asset',
    [TRANSFER_CURRENCY_COMMAND]: 'transfer_currency',
    [UNFREEZE_CURRENCY_COMMAND]: 'unfreeze_currency',
    [UNFREEZE_WALLET_COMMAND]: 'unfreeze_wallet',
    InitializeWorldCommerceV1: 'initialize_commerce',
    CreateBusinessV1: 'create_business',
    ConfigureBusinessFacilityV1: 'configure_facility',
    CreateEmploymentContractV1: 'create_contract',
    AcceptEmploymentContractV1: 'accept_contract',
    EndEmploymentContractV1: 'end_contract',
    PerformJobV1: 'perform_job',
    StartProductionRunV1: 'start_production',
    CreateMarketListingV1: 'create_listing',
    CancelMarketListingV1: 'cancel_listing',
    PurchaseMarketListingV1: 'purchase_listing',
    ReconcileWorldCommerceV1: 'reconcile_commerce',
  };
  return operations[commandType] ?? 'unknown';
}

function commerceRateLimitScopeHash(request: SubmitWorldCommand): Buffer | null {
  const payload = request.payload as Record<string, unknown>;
  let targetId: unknown;
  switch (request.type) {
    case PERFORM_JOB_COMMAND:
      targetId = payload.contractId;
      break;
    case START_PRODUCTION_RUN_COMMAND:
      targetId = payload.facilityId;
      break;
    case CREATE_MARKET_LISTING_COMMAND:
      targetId = payload.sellerInventoryId;
      break;
    case PURCHASE_MARKET_LISTING_COMMAND:
      targetId = payload.listingId;
      break;
    default:
      return null;
  }
  // Command identity is recorded before payload validation. The null sentinel
  // preserves that durable ledger path for malformed limited commands; policy
  // enforcement is reached only after the validator accepts a string target.
  return hash({
    commandType: request.type,
    targetId:
      typeof targetId === 'string' && UUID_PATTERN.test(targetId) ? targetId.toLowerCase() : null,
  });
}

const knownSimulationErrorCodes = new Set<string>(Object.values(SimulationErrorCodes));

/** Cross-module test/dev loaders can materialize the same error class twice. */
function simulationDomainErrorCode(error: unknown): SimulationErrorCode | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if (
    !(error instanceof SimulationDomainError) &&
    (!('name' in error) || error.name !== 'SimulationDomainError')
  ) {
    return undefined;
  }
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' && knownSimulationErrorCodes.has(code)
    ? (code as SimulationErrorCode)
    : undefined;
}

function clockState(record: SimulationClockRecord) {
  return {
    configuration: record.clock.configuration,
    currentTick: record.clock.currentTick,
    mode: record.clock.mode,
  };
}

function projectedClock(
  previous: WorldSimulationClockV1,
  state: Pick<WorldSimulationClockV1, 'configuration' | 'currentTick' | 'mode'>,
  resultingStateRevision: string,
  updatedAt: Date,
  lastWallAnchorAt: Date | null,
  outcomeHash: string = previous.outcomeHash,
): WorldSimulationClockV1 {
  return {
    ...previous,
    configuration: state.configuration,
    currentTick: state.currentTick,
    lastWallAnchorAt: lastWallAnchorAt?.toISOString() ?? null,
    mode: state.mode,
    outcomeHash,
    rowVersion: incrementDecimal(previous.rowVersion),
    updatedAt: updatedAt.toISOString(),
    updatedStateRevision: resultingStateRevision,
  };
}

function advancedWallAnchor(clock: WorldSimulationClockV1, ticks: number): Date {
  if (!clock.lastWallAnchorAt) {
    throw new SimulationDomainError(
      'CLOCK_NOT_RUNNING',
      'A running clock must have an authoritative wall anchor.',
    );
  }
  const milliseconds =
    Date.parse(clock.lastWallAnchorAt) + ticks * clock.configuration.wallCadenceMilliseconds;
  const anchor = new Date(milliseconds);
  if (Number.isNaN(anchor.valueOf())) {
    throw new SimulationDomainError(
      'SIMULATION_INTEGER_OVERFLOW',
      'The wall anchor is outside the supported operational range.',
    );
  }
  return anchor;
}

function commandHistoryTarget(request: SubmitWorldCommand): string | undefined {
  if (request.type === RENAME_WORLD_ENTITY_COMMAND) {
    const value = request.payload.entityKey;
    return typeof value === 'string' ? value : undefined;
  }
  if (request.type === CANCEL_SCHEDULED_ACTION_COMMAND) {
    const value = request.payload.scheduleId;
    return typeof value === 'string' ? value : undefined;
  }
  if (request.type === RESOLVE_SIMULATION_FAILURE_COMMAND) {
    const value = request.payload.failureId;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function expectedAggregateConflict(
  expectedAggregateVersion: string,
  clock: SimulationClockRecord,
): 'AGGREGATE_VERSION_CONFLICT' | undefined {
  return expectedAggregateVersion === clock.aggregateVersion
    ? undefined
    : 'AGGREGATE_VERSION_CONFLICT';
}

function expectedWorldConflict(
  request: SubmitWorldCommand,
  world: CommandWorldContext,
):
  | {
      code: 'REVISION_CONFLICT' | 'WORLD_VERSION_CONFLICT';
      currentStateRevision: string;
      currentWorldVersion: string;
    }
  | undefined {
  if (request.expectedWorldVersion !== world.designVersion) {
    return {
      code: 'WORLD_VERSION_CONFLICT',
      currentStateRevision: world.stateRevision,
      currentWorldVersion: world.designVersion,
    };
  }
  if (request.expectedStateRevision === world.stateRevision) return undefined;
  return {
    code: 'REVISION_CONFLICT',
    currentStateRevision: world.stateRevision,
    currentWorldVersion: world.designVersion,
  };
}

function replayStored(
  stored: StoredCommandIdentity,
  command: ReceivedCommandWrite,
): WorldCommandResultTransport {
  if (
    stored.worldId !== command.worldId ||
    stored.actorId !== command.actorId ||
    stored.actorType !== command.actorType ||
    stored.commandType !== command.commandType ||
    stored.idempotencyKey !== command.idempotencyKey ||
    !stored.requestHash.equals(command.requestHash)
  ) {
    throw new ApplicationError(
      'IDEMPOTENCY_KEY_REUSED',
      'The command identity was already used for a different request.',
      409,
    );
  }
  if (stored.status === 'received' || !stored.result) {
    throw new ApplicationError(
      'COMMAND_IN_PROGRESS',
      'The original command is still being processed.',
      409,
      { commandId: stored.commandId },
    );
  }
  return stored.result;
}

function hash(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value)).digest();
}

function hashHex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function incrementDecimal(value: string): string {
  return (BigInt(value) + 1n).toString(10);
}

function governanceActorMode(
  commandType: string,
  platformRole: AuthenticatedActor['user']['platformRole'],
): GovernanceActorMode {
  if (
    commandType === INITIALIZE_WORLD_GOVERNANCE_COMMAND ||
    commandType === ADOPT_GOVERNANCE_SEED_PLAN_COMMAND ||
    commandType === EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND ||
    commandType === REPAIR_GOVERNANCE_RESULT_COMMAND
  ) {
    return platformRole === 'platform_admin' ? 'administrator' : 'creator';
  }
  return 'in_world';
}

function governanceUsesActiveCivicLaw(commandType: string): boolean {
  return new Set<string>([
    SPONSOR_PROPOSAL_COMMAND,
    WITHDRAW_PROPOSAL_COMMAND,
    CAST_PROPOSAL_BALLOT_COMMAND,
    NOMINATE_CANDIDATE_COMMAND,
    ACCEPT_NOMINATION_COMMAND,
    CAST_ELECTION_BALLOT_COMMAND,
  ]).has(commandType);
}

function governancePolicyAction(commandType: string): string | null {
  if (commandType === CREATE_PROPOSAL_COMMAND) return 'governance.propose';
  if (commandType === APPOINT_OFFICEHOLDER_COMMAND || commandType === REMOVE_OFFICEHOLDER_COMMAND) {
    return 'governance.appoint';
  }
  return null;
}

function governancePolicyResourceType(commandType: string): string | undefined {
  if (commandType === CREATE_PROPOSAL_COMMAND) return 'proposal';
  if (commandType === APPOINT_OFFICEHOLDER_COMMAND || commandType === REMOVE_OFFICEHOLDER_COMMAND) {
    return 'office';
  }
  return undefined;
}

function governanceOverrideIsExplicit(request: SubmitWorldCommand): boolean {
  if (request.type === EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND) {
    return request.payload.confirmation === 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE';
  }
  if (request.type === REPAIR_GOVERNANCE_RESULT_COMMAND) {
    return request.payload.confirmation === 'APPEND LINKED GOVERNANCE REPAIR';
  }
  return false;
}

function governanceCommandResource(
  request: SubmitWorldCommand,
  worldId: string,
): { resourceId: string; resourceKey: string | null; resourceType: string } {
  const payload = request.payload;
  switch (request.type) {
    case CREATE_PROPOSAL_COMMAND:
      return {
        resourceId: recordString(payload, 'institutionId') ?? worldId,
        resourceKey: recordString(payload, 'proposalKey'),
        resourceType: 'institution',
      };
    case SPONSOR_PROPOSAL_COMMAND:
    case WITHDRAW_PROPOSAL_COMMAND:
    case CAST_PROPOSAL_BALLOT_COMMAND:
      return {
        resourceId: recordString(payload, 'proposalId') ?? worldId,
        resourceKey: null,
        resourceType: 'proposal',
      };
    case NOMINATE_CANDIDATE_COMMAND:
    case ACCEPT_NOMINATION_COMMAND:
    case CAST_ELECTION_BALLOT_COMMAND:
      return {
        resourceId: recordString(payload, 'electionId') ?? worldId,
        resourceKey: null,
        resourceType: 'election',
      };
    case APPOINT_OFFICEHOLDER_COMMAND:
      return {
        resourceId: recordString(payload, 'officeId') ?? worldId,
        resourceKey: null,
        resourceType: 'office',
      };
    case REMOVE_OFFICEHOLDER_COMMAND:
      return {
        resourceId: recordString(payload, 'termId') ?? worldId,
        resourceKey: null,
        resourceType: 'office_term',
      };
    case EXECUTE_CREATOR_GOVERNANCE_OVERRIDE_COMMAND:
      return { resourceId: worldId, resourceKey: null, resourceType: 'governance_override' };
    case REPAIR_GOVERNANCE_RESULT_COMMAND:
      return {
        resourceId: recordString(payload, 'sourceResultId') ?? worldId,
        resourceKey: null,
        resourceType: 'governance_result',
      };
    case ADOPT_GOVERNANCE_SEED_PLAN_COMMAND:
      return {
        resourceId: recordString(payload, 'compiledWorldVersionId') ?? worldId,
        resourceKey: null,
        resourceType: 'governance_seed_plan',
      };
    default:
      return { resourceId: worldId, resourceKey: null, resourceType: 'world_governance' };
  }
}

function recordString(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === 'string' ? value[key] : null;
}

function resultStatus(result: WorldCommandResultTransport): 200 | 403 | 404 | 409 | 422 {
  if (result.status === 'accepted') return 200;
  if (result.status === 'received') return 409;
  switch (result.rejectionCode) {
    case 'AUTHORIZATION_DENIED':
      return 403;
    case 'VALIDATION_FAILED':
    case 'COMMAND_TYPE_DISABLED':
      return 422;
    default:
      return 409;
  }
}
