import type {
  ScheduledActionV1,
  SimulationBatchRunV1,
  SimulationEventV1,
  SimulationFailureV1,
  WorldSimulationClockV1,
  WorldCommandRejectionCode,
  WorldEntityStatePairV1,
  WorldRole,
} from '@worldgraph/contracts';

import type {
  SubmitWorldCommand,
  WorldCommandResultTransport,
  WorldHistoryEntryTransport,
  WorldHistoryDetailTransport,
  WorldHistoryQueryTransport,
  WorldRuntimeHeadTransport,
  SimulationClockViewTransport,
  SimulationListQueryTransport,
  ScheduledActionPageTransport,
  SimulationBatchPageTransport,
} from './api-contracts.js';

export interface CommandWorldContext {
  activeWorldVersionId: string;
  anchorArtifactHash: string | null;
  designVersion: string;
  ledgerAnchoredAt: Date | null;
  lifecycle: string;
  membershipRole: WorldRole | null;
  membershipStatus: 'active' | 'removed' | null;
  stateRevision: string;
  worldId: string;
}

export interface CommandEntityRecord {
  entityVersion: string;
  entitySchemaVersion: number;
  entityType: WorldEntityStatePairV1['entityType'];
  logicalKey: string;
  storageRowVersion: string;
  state: Record<string, unknown>;
  worldId: string;
}

export interface StoredCommandIdentity {
  actorId: string | null;
  actorType: 'ai' | 'platform_admin' | 'system' | 'user';
  commandId: string;
  commandType: string;
  idempotencyKey: string;
  requestHash: Buffer;
  result: WorldCommandResultTransport | null;
  status: 'accepted' | 'failed' | 'received' | 'rejected';
  worldId: string;
}

export interface ReceivedCommandWrite {
  actorId: string;
  actorType: 'platform_admin' | 'user';
  causationId: string | null;
  commandId: string;
  commandType: string;
  correlationId: string;
  expectedAggregateVersion: string;
  expectedStateRevision: string;
  expectedTick?: string;
  expectedWorldVersion: string;
  idempotencyKey: string;
  payloadClassification: 'member';
  payloadHash: Buffer;
  rateLimitScopeHash: Buffer | null;
  requestHash: Buffer;
  requestedAt: Date;
  schemaVersion: number;
  worldId: string;
}

export interface SimulationClockRecord {
  aggregateVersion: string;
  clock: WorldSimulationClockV1;
  projectionChecksum: string;
  worldSeed: string;
}

export interface ScheduledActionRecord {
  action: ScheduledActionV1;
  aggregateVersion: string;
}

export interface SimulationFailureRecord {
  aggregateVersion: string;
  failure: SimulationFailureV1;
}

export interface SimulationEventWrite {
  aggregateId: string;
  aggregateType: 'scheduled_action' | 'simulation_clock' | 'simulation_failure' | 'world_notice';
  eventId: string;
  eventType: SimulationEventV1['eventType'];
  payload: SimulationEventV1['payload'];
}

export interface SimulationAcceptanceWrite {
  authorizationRuleId: string;
  batch?: SimulationBatchRunV1;
  clock?: WorldSimulationClockV1;
  command: ReceivedCommandWrite;
  decidedAt: Date;
  events: SimulationEventWrite[];
  failureResolution?: {
    failureId: string;
    resolvedAt: Date;
    resolvedByActorId: string;
    resolutionCommandId: string;
  };
  resultingStateRevision: string;
  scheduleCreates?: ScheduledActionV1[];
  scheduleTerminals?: Array<{
    cancelledCommandId: string | null;
    completedEventId: string | null;
    completedStateRevision: string;
    id: string;
    status: 'cancelled' | 'completed' | 'failed';
  }>;
}

export interface EconomyCommandPolicy {
  debitsFrozen: boolean;
  issuanceEnabled: boolean;
  issuanceRateLimitPerHour: number;
  offerRateLimitPerMinute: number;
  offersEnabled: boolean;
  transferRateLimitPerMinute: number;
  transfersEnabled: boolean;
}

export interface EconomyCommandExecutionInput {
  authorizationRuleId: string;
  command: ReceivedCommandWrite;
  decidedAt: Date;
  policy: EconomyCommandPolicy;
  request: SubmitWorldCommand;
  world: CommandWorldContext;
}

export interface CommerceCommandPolicy {
  disabledTaxPolicyIds: readonly string[];
  jobsEnabled: boolean;
  listingRateLimitPerMinute: number;
  listingsEnabled: boolean;
  productionEnabled: boolean;
  productionRateLimitPerMinute: number;
  purchaseRateLimitPerMinute: number;
  purchasesEnabled: boolean;
  workRateLimitPerMinute: number;
}

export interface CommerceCommandExecutionInput {
  authorizationRuleId: string;
  command: ReceivedCommandWrite;
  decidedAt: Date;
  policy: CommerceCommandPolicy;
  request: SubmitWorldCommand;
  world: CommandWorldContext;
}

export interface CommandRejectionWrite {
  authorizationRuleId: string | null;
  code: WorldCommandRejectionCode;
  command: ReceivedCommandWrite;
  currentEntityVersion?: string;
  currentStateRevision?: string;
  currentWorldVersion?: string;
  decidedAt: Date;
  historyTargetId?: string;
  redactedTargetHash?: string;
}

export interface RenameAcceptanceWrite {
  authorizationRuleId: string;
  command: ReceivedCommandWrite;
  decidedAt: Date;
  entity: CommandEntityRecord;
  eventId: string;
  eventPayload: Record<string, unknown>;
  eventType: 'WorldEntityRenamedV1';
  nextState: Record<string, unknown>;
  resultingEntityVersion: string;
  resultingStateRevision: string;
}

export interface HistoryReadInput {
  actorId: string;
  beforeLedgerSequence?: string;
  limit: number;
  platformAdmin: boolean;
  query: Omit<WorldHistoryQueryTransport, 'cursor' | 'limit'>;
  worldId: string;
}

export interface CommandTransaction {
  acceptRename(input: RenameAcceptanceWrite): Promise<WorldCommandResultTransport>;
  acceptSimulation(input: SimulationAcceptanceWrite): Promise<WorldCommandResultTransport>;
  allocateScheduleSequence(worldId: string): Promise<string>;
  countScheduledActionsAtTick(worldId: string, dueTick: string): Promise<number>;
  countScheduledActionsForWorldAndActor(
    worldId: string,
    actorId: string,
  ): Promise<{ actorCount: number; worldCount: number }>;
  executeEconomy(input: EconomyCommandExecutionInput): Promise<WorldCommandResultTransport>;
  executeCommerce(input: CommerceCommandExecutionInput): Promise<WorldCommandResultTransport>;
  findCommandById(commandId: string): Promise<StoredCommandIdentity | null>;
  findCommandByIdempotency(input: {
    actorId: string;
    actorType: ReceivedCommandWrite['actorType'];
    commandType: string;
    idempotencyKey: string;
    worldId: string;
  }): Promise<StoredCommandIdentity | null>;
  insertReceived(input: ReceivedCommandWrite): Promise<void>;
  lockEntity(worldId: string, entityKey: string): Promise<CommandEntityRecord | null>;
  lockDueScheduledActions(worldId: string, toTick: string): Promise<ScheduledActionV1[]>;
  lockScheduledAction(worldId: string, scheduleId: string): Promise<ScheduledActionRecord | null>;
  lockSimulationFailure(
    worldId: string,
    failureId: string,
  ): Promise<SimulationFailureRecord | null>;
  lockSimulationClock(worldId: string): Promise<SimulationClockRecord | null>;
  lockWorld(
    worldId: string,
    actorId: string,
    commandId: string,
  ): Promise<CommandWorldContext | null>;
  reject(input: CommandRejectionWrite): Promise<WorldCommandResultTransport>;
}

export interface CommandRepository {
  getCommand(actorId: string, commandId: string): Promise<WorldCommandResultTransport | null>;
  getHistoryEntry(
    actorId: string,
    platformAdmin: boolean,
    worldId: string,
    ledgerSequence: string,
  ): Promise<WorldHistoryDetailTransport | null>;
  getRuntimeHead(actorId: string, worldId: string): Promise<WorldRuntimeHeadTransport | null>;
  getSimulationClock(
    actorId: string,
    worldId: string,
  ): Promise<SimulationClockViewTransport | null>;
  getScheduledAction(
    actorId: string,
    worldId: string,
    scheduleId: string,
  ): Promise<ScheduledActionV1 | null>;
  listScheduledActions(input: {
    actorId: string;
    query: SimulationListQueryTransport;
    worldId: string;
  }): Promise<ScheduledActionPageTransport | null>;
  listSimulationBatches(input: {
    actorId: string;
    query: SimulationListQueryTransport;
    worldId: string;
  }): Promise<SimulationBatchPageTransport | null>;
  listHistory(input: HistoryReadInput): Promise<WorldHistoryEntryTransport[]>;
  serializable<T>(
    operation: (transaction: CommandTransaction) => Promise<T>,
    worldId?: string,
  ): Promise<T>;
}

export interface CommandSubmissionResult {
  httpStatus: 200 | 403 | 404 | 409 | 422;
  result: WorldCommandResultTransport;
}

export interface CommandSubmissionContext {
  actorId: string;
  platformRole: 'platform_admin' | 'user';
  requestId: string;
  submittedAt: Date;
  worldId: string;
}

export interface CommandSubmission {
  context: CommandSubmissionContext;
  request: SubmitWorldCommand;
}
