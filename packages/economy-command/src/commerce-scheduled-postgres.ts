import { createHash, timingSafeEqual } from 'node:crypto';

import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  DOMAIN_EVENT_SCHEMA_VERSION,
  ECONOMY_SCHEMA_VERSION,
  HISTORY_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  MAX_SCHEDULED_ACTIONS_PER_TICK,
  MAX_SCHEDULED_ACTIONS_PER_WORLD,
  OUTBOX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  canonicalJson,
  type DomainEventEnvelopeV1,
  type DomainEventMetadataV1,
  type JsonValue,
  type LedgerActorV1,
  type LedgerEntryV1,
  type WorldCommandResultV1,
  type WorldHistoryEntryV1,
} from '@worldgraph/contracts';
import type { Pool } from '@worldgraph/db';
import {
  EconomyDomainError,
  assessTax,
  assertBalancedTransaction,
  consumeReservedInventory,
  creditInventory,
  decideProductionCompletion,
  formatQuantity,
  parseCanonicalQuantity,
  projectAccountingDecision,
  releaseInventoryReservation,
  type EconomyPosting,
  type InventoryState,
  type TaxPolicyState,
} from '@worldgraph/economy';
import {
  LEDGER_GENESIS_PREVIOUS_HASH,
  computeDomainEventHashV1,
  computeLedgerEntryHashV1,
  projectWorldHistoryEntryV1,
  type DomainEventHashInputV1,
  type LedgerEntryHashInputV1,
} from '@worldgraph/ledger';

import {
  COMMERCE_SCHEDULER_ACTOR_ID,
  COMMERCE_SCHEDULER_AUTHORIZATION_RULE_ID,
  type CommerceScheduledCommandPort,
  type CommerceScheduledCommandRequest,
  type CommerceScheduledCommandResult,
  type PostgresCommerceScheduledCommandOptions,
} from './types.js';

interface SqlClient {
  on?(event: 'error', listener: (error: Error) => void): void;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null; rows: unknown[] }>;
  removeListener?(event: 'error', listener: (error: Error) => void): void;
  release(error?: Error): void;
}

interface StoredCommandRow {
  actor_id: string | null;
  actor_type: string;
  causation_id: string | null;
  command_type: string;
  id: string;
  idempotency_key: string;
  request_hash: Buffer;
  response_summary: unknown;
  status: string;
  world_id: string;
}

interface RuntimeRow {
  active_world_version_id: string;
  anchor_artifact_hash: Buffer | null;
  design_version: string;
  last_event_sequence: string;
  last_ledger_sequence: string;
  ledger_anchored_at: Date | null;
  lifecycle: string;
  recorded_at: Date;
  state_revision: string;
  world_id: string;
}

interface EconomyHeadRow {
  checksum: Buffer;
  reconciliation_status: string;
  row_version: string;
}

interface ScheduleRow {
  action_schema_version: number;
  action_type: string;
  completed_event_id: string | null;
  due_tick: string;
  payload: unknown;
  process_version: string;
  schedule_sequence: string;
  status: string;
}

interface ScheduleCapacityRow {
  tick_count: string;
  world_count: string;
}

interface ScheduledContext extends RuntimeRow {
  core_checksum: Buffer;
  core_reconciliation_status: string;
  core_row_version: string;
  current_tick: string;
  expansion_checksum: Buffer;
  expansion_reconciliation_status: string;
  expansion_row_version: string;
}

interface ProductionRunRow {
  backing_organization_entity_id: string;
  due_tick: string;
  facility_asset_id: string;
  id: string;
  input_snapshot: unknown;
  output_snapshot: unknown;
  row_version: string;
  scheduled_action_id: string;
  snapshot_checksum: Buffer;
  status: string;
}

interface InventoryReservationRow {
  inventory_id: string;
  inventory_quantity: string;
  inventory_reserved_quantity: string;
  inventory_row_version: string;
  quantity: string;
  reservation_id: string;
  reservation_row_version: string;
  resource_type_id: string;
  scale: number;
  status: string;
}

interface InventoryRow {
  id: string;
  quantity: string;
  reserved_quantity: string;
  resource_type_id: string;
  row_version: string;
  scale: number;
}

interface PayrollRow {
  contract_id: string;
  currency_id: string;
  employer_entity_id: string;
  employer_wallet_id: string;
  gross_minor: string;
  id: string;
  net_minor: string;
  performed_tick: string;
  row_version: string;
  scheduled_action_id: string;
  status: string;
  tax_minor: string;
  tax_policy_id: string | null;
  worker_entity_id: string;
  worker_wallet_id: string;
}

interface TaxPolicyRow {
  applicability: unknown;
  collection_mode: 'added_to_payer' | 'withheld_from_recipient';
  currency_id: string;
  effective_from_tick: string;
  effective_until_tick: string | null;
  fixed_amount_minor: string | null;
  id: string;
  rate_basis_points: number | null;
  rounding_mode: 'floor' | 'half_up';
  status: string;
  tax_type: 'marketplace_fee' | 'payroll' | 'periodic_flat' | 'sales' | 'transaction';
  treasury_wallet_id: string;
}

interface WalletRow {
  available_minor: string;
  currency_id: string;
  id: string;
  owner_entity_id: string;
  row_version: string;
  status: string;
}

interface ListingRow {
  expires_at_tick: string;
  id: string;
  inventory_quantity: string;
  inventory_reserved_quantity: string;
  inventory_row_version: string;
  quantity_scale: number;
  remaining_quantity: string;
  reservation_id: string | null;
  reservation_quantity: string | null;
  reservation_row_version: string | null;
  reservation_status: string | null;
  row_version: string;
  scheduled_action_id: string;
  seller_entity_id: string;
  seller_inventory_id: string;
  status: string;
}

interface AllocationRow {
  last_entry_hash: Buffer | null;
  next_event_sequence: string;
  next_ledger_sequence: string;
}

interface PlannedEvent {
  aggregateId: string;
  aggregateType: string;
  commerceBase: boolean;
  eventId: string;
  eventType: string;
  payload: Record<string, JsonValue>;
}

interface ParticipantHistoryPlan {
  category: 'payroll';
  eventId: string;
  firstEntityId: string;
  secondEntityId: string;
  summaryArgs: Record<string, JsonValue>;
  summaryCode: 'PAYROLL_FAILED' | 'PAYROLL_SETTLED';
}

interface PreparedEffect {
  coreChanged: boolean;
  events: PlannedEvent[];
  participantHistory?: ParticipantHistoryPlan[];
}

interface PersistedEvent {
  envelope: DomainEventHashInputV1 & { eventHash: string };
  ledgerSequence: string;
}

interface TransactionResolution {
  commit: boolean;
  result: CommerceScheduledCommandResult;
}

interface ResourceSnapshotItem {
  quantity: string;
  resourceTypeId: string;
}

interface PeriodicApplicability {
  intervalTicks: string;
  payerEntityId: string;
  payerWalletId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const NONNEGATIVE_INT64 = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE_INT64 = /^[1-9][0-9]{0,18}$/u;
const INT64_MAX = 9_223_372_036_854_775_807n;

/**
 * Every worker uses the same world-scoped advisory lock. The subsequent row
 * order mirrors public economy commands and prevents a scheduler-only lock
 * inversion from being introduced later.
 */
export const COMMERCE_SCHEDULED_LOCK_ORDER = [
  'world_runtime',
  'economy_head',
  'economy_expansion_head',
  'simulation_clock',
  'scheduled_action',
  'target',
  'target_resources_by_id',
] as const;

export function commerceScheduledRequestHashV1(request: CommerceScheduledCommandRequest): Buffer {
  return digest({
    actionType: request.actionType,
    causationId: request.completedEventId,
    dueTick: request.dueTick,
    payload: commandPayload(request),
    scheduleSequence: request.scheduleSequence,
    schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    worldId: request.worldId,
  });
}

export function commerceScheduleCapacityAvailableV1(input: ScheduleCapacityRow): boolean {
  if (!nonnegativeInt64(input.tick_count) || !nonnegativeInt64(input.world_count)) {
    throw new Error('COMMERCE_SCHEDULE_CAPACITY_INVALID');
  }
  return (
    BigInt(input.tick_count) < BigInt(MAX_SCHEDULED_ACTIONS_PER_TICK) &&
    BigInt(input.world_count) < BigInt(MAX_SCHEDULED_ACTIONS_PER_WORLD)
  );
}

/**
 * Narrow system-only executor for effects whose durable trigger is an M7
 * ScheduledActionExecutedV1 fact. No user authority or caller-supplied money,
 * quantity, party, policy, or state version crosses this boundary.
 */
export class PostgresCommerceScheduledCommand implements CommerceScheduledCommandPort {
  private readonly disabledTaxPolicyIds: ReadonlySet<string>;
  private readonly maximumSerializationAttempts: number;
  private readonly retryDelay: (attempt: number) => Promise<void>;

  public constructor(
    private readonly pool: Pool,
    private readonly options: PostgresCommerceScheduledCommandOptions,
  ) {
    const disabledTaxPolicyIds = options.disabledTaxPolicyIds ?? [];
    const normalizedDisabledTaxPolicyIds = disabledTaxPolicyIds.map((policyId) =>
      policyId.toLowerCase(),
    );
    this.maximumSerializationAttempts = options.maximumSerializationAttempts ?? 3;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    if (
      disabledTaxPolicyIds.length > 64 ||
      disabledTaxPolicyIds.some((policyId) => !UUID.test(policyId)) ||
      new Set(normalizedDisabledTaxPolicyIds).size !== disabledTaxPolicyIds.length ||
      !Number.isSafeInteger(this.maximumSerializationAttempts) ||
      this.maximumSerializationAttempts < 1 ||
      this.maximumSerializationAttempts > 5
    ) {
      throw new Error('COMMERCE_SCHEDULED_COMMAND_CONFIGURATION_INVALID');
    }
    this.disabledTaxPolicyIds = new Set(normalizedDisabledTaxPolicyIds);
  }

  public async execute(
    request: CommerceScheduledCommandRequest,
  ): Promise<CommerceScheduledCommandResult> {
    assertRequest(request);
    if (
      request.actionType === 'AssessPeriodicTaxV1' &&
      this.disabledTaxPolicyIds.has(request.payload.taxPolicyId.toLowerCase())
    ) {
      throw new Error('COMMERCE_TAX_POLICY_DISABLED');
    }
    const payload = commandPayload(request);
    const payloadHash = digest(payload);
    const requestHash = commerceScheduledRequestHashV1(request);

    for (let attempt = 0; attempt < this.maximumSerializationAttempts; attempt += 1) {
      const client = (await this.pool.connect()) as unknown as SqlClient;
      let releaseError: Error | undefined;
      const connectionError = (error: Error): void => {
        releaseError ??= error;
      };
      client.on?.('error', connectionError);
      try {
        await client.query('begin isolation level serializable');
        const resolution = await this.executeTransaction(
          client,
          request,
          payload,
          payloadHash,
          requestHash,
        );
        await client.query(resolution.commit ? 'commit' : 'rollback');
        return resolution.result;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        releaseError ??= fatalConnectionError(error);
        if (serializationFailure(error) && attempt + 1 < this.maximumSerializationAttempts) {
          await this.retryDelay(attempt);
          continue;
        }
        throw error;
      } finally {
        client.removeListener?.('error', connectionError);
        client.release(releaseError);
      }
    }
    throw new Error('COMMERCE_SCHEDULED_SERIALIZATION_RETRY_EXHAUSTED');
  }

  private async executeTransaction(
    client: SqlClient,
    request: CommerceScheduledCommandRequest,
    payload: Record<string, string>,
    payloadHash: Buffer,
    requestHash: Buffer,
  ): Promise<TransactionResolution> {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `worldgraph-command-v1:${request.worldId}`,
    ]);
    const replay = await replayCommand(client, request, requestHash);
    if (replay) return { commit: false, result: replay };

    await insertReceivedCommand(client, request, payload, payloadHash, requestHash);
    await client.query('select worldgraph_open_command_write($1,$2)', [
      request.commandId,
      request.worldId,
    ]);
    const context = await loadScheduledContext(client, request);
    if (!context) return { commit: false, result: { status: 'conflict' } };
    if (BigInt(context.current_tick) < BigInt(request.dueTick)) {
      return { commit: false, result: { status: 'not_ready' } };
    }
    const resultingStateRevision = addDecimal(context.state_revision, 1);
    const effect = await this.applyEffect(client, request, context, resultingStateRevision);
    if ('status' in effect) return { commit: false, result: effect };

    const expansionChecksum = await advanceExpansionHead(
      client,
      request,
      context,
      resultingStateRevision,
    );
    const economyChecksum = effect.coreChanged
      ? await advanceCoreHead(client, request, context, resultingStateRevision)
      : context.core_checksum;
    const result = await finalizeScheduledCommand(client, this.options.ids, {
      context,
      economyChecksum,
      events: effect.events,
      expansionChecksum,
      participantHistory: effect.participantHistory ?? [],
      request,
      resultingStateRevision,
    });
    return { commit: true, result };
  }

  private applyEffect(
    client: SqlClient,
    request: CommerceScheduledCommandRequest,
    context: ScheduledContext,
    resultingStateRevision: string,
  ): Promise<PreparedEffect | CommerceScheduledCommandResult> {
    switch (request.actionType) {
      case 'CompleteProductionRunV1':
        return completeProductionRun(
          client,
          this.options.ids,
          request,
          context,
          resultingStateRevision,
        );
      case 'SettlePayrollV1':
        return settlePayroll(client, this.options.ids, request, context, resultingStateRevision);
      case 'ExpireMarketListingV1':
        return expireMarketListing(
          client,
          this.options.ids,
          request,
          context,
          resultingStateRevision,
        );
      case 'AssessPeriodicTaxV1':
        return assessPeriodicTax(
          client,
          this.options.ids,
          request,
          context,
          resultingStateRevision,
        );
    }
  }
}

async function loadScheduledContext(
  client: SqlClient,
  request: CommerceScheduledCommandRequest,
): Promise<ScheduledContext | null> {
  const runtimeResult = await client.query(
    `select world.id::text as world_id,world.lifecycle::text,
            runtime.active_world_version_id::text,runtime.state_revision::text,
            runtime.last_event_sequence::text,runtime.last_ledger_sequence::text,
            runtime.ledger_anchored_at,runtime.anchor_artifact_hash,
            version.version_number::text as design_version,
            date_trunc('milliseconds',transaction_timestamp()) as recorded_at
       from worlds world
       join world_runtime_heads runtime on runtime.world_id=world.id
       join world_versions version
         on version.world_id=runtime.world_id and version.id=runtime.active_world_version_id
      where world.id=$1 and world.archived_at is null
      for update of runtime`,
    [request.worldId],
  );
  const runtime = runtimeResult.rows[0] as RuntimeRow | undefined;
  if (!runtime || runtime.lifecycle !== 'active') return null;

  const coreResult = await client.query(
    `select checksum,reconciliation_status::text,row_version::text
       from world_economy_heads where world_id=$1 for update`,
    [request.worldId],
  );
  const core = coreResult.rows[0] as EconomyHeadRow | undefined;
  if (!core || ['failed', 'mismatch'].includes(core.reconciliation_status)) return null;

  const expansionResult = await client.query(
    `select checksum,reconciliation_status::text,row_version::text
       from world_economy_expansion_heads where world_id=$1 for update`,
    [request.worldId],
  );
  const expansion = expansionResult.rows[0] as EconomyHeadRow | undefined;
  if (!expansion || ['failed', 'mismatch'].includes(expansion.reconciliation_status)) return null;

  const clockResult = await client.query(
    `select current_tick::text from world_simulation_clocks
      where world_id=$1 for update`,
    [request.worldId],
  );
  const currentTick = (clockResult.rows[0] as { current_tick?: string } | undefined)?.current_tick;
  if (!currentTick || !nonnegativeInt64(currentTick)) return null;

  const scheduleResult = await client.query(
    `select schedule_sequence::text,due_tick::text,action_type,
            action_schema_version,payload,process_version,status::text,completed_event_id::text
       from scheduled_actions
      where world_id=$1 and id=$2`,
    [request.worldId, request.scheduledActionId],
  );
  const schedule = scheduleResult.rows[0] as ScheduleRow | undefined;
  if (!schedule || !scheduleMatchesRequest(schedule, request)) return null;
  if (!contextShapeIsValid(runtime, core, expansion)) {
    throw new Error('COMMERCE_SCHEDULED_CONTEXT_INVALID');
  }
  return {
    ...runtime,
    core_checksum: core.checksum,
    core_reconciliation_status: core.reconciliation_status,
    core_row_version: core.row_version,
    current_tick: currentTick,
    expansion_checksum: expansion.checksum,
    expansion_reconciliation_status: expansion.reconciliation_status,
    expansion_row_version: expansion.row_version,
  };
}

function scheduleMatchesRequest(
  row: ScheduleRow,
  request: CommerceScheduledCommandRequest,
): boolean {
  return (
    row.status === 'completed' &&
    row.completed_event_id === request.completedEventId &&
    row.action_type === request.actionType &&
    row.action_schema_version === 1 &&
    row.process_version === '1.0.0' &&
    row.due_tick === request.dueTick &&
    row.schedule_sequence === request.scheduleSequence &&
    canonicalJson(row.payload) === canonicalJson(request.payload)
  );
}

function contextShapeIsValid(
  runtime: RuntimeRow,
  core: EconomyHeadRow,
  expansion: EconomyHeadRow,
): boolean {
  return (
    UUID.test(runtime.world_id) &&
    UUID.test(runtime.active_world_version_id) &&
    positiveInt64(runtime.design_version) &&
    nonnegativeInt64(runtime.state_revision) &&
    nonnegativeInt64(runtime.last_event_sequence) &&
    nonnegativeInt64(runtime.last_ledger_sequence) &&
    runtime.recorded_at instanceof Date &&
    runtime.ledger_anchored_at instanceof Date &&
    runtime.anchor_artifact_hash instanceof Buffer &&
    runtime.anchor_artifact_hash.length === 32 &&
    positiveInt64(core.row_version) &&
    core.checksum instanceof Buffer &&
    core.checksum.length === 32 &&
    positiveInt64(expansion.row_version) &&
    expansion.checksum instanceof Buffer &&
    expansion.checksum.length === 32
  );
}

async function replayCommand(
  client: SqlClient,
  request: CommerceScheduledCommandRequest,
  requestHash: Buffer,
): Promise<CommerceScheduledCommandResult | null> {
  const byId = await client.query(
    `select id,world_id,command_type,actor_type,actor_id,idempotency_key,
            request_hash,status,response_summary,causation_id::text
       from command_records where id=$1 for update`,
    [request.commandId],
  );
  const storedById = byId.rows[0] as StoredCommandRow | undefined;
  if (storedById) return replayStored(storedById, request, requestHash);
  const byKey = await client.query(
    `select id,world_id,command_type,actor_type,actor_id,idempotency_key,
            request_hash,status,response_summary,causation_id::text
       from command_records
      where world_id=$1 and actor_type='system' and actor_id=$2
        and command_type=$3 and idempotency_key=$4
      for update`,
    [request.worldId, COMMERCE_SCHEDULER_ACTOR_ID, request.actionType, request.idempotencyKey],
  );
  const storedByKey = byKey.rows[0] as StoredCommandRow | undefined;
  return storedByKey ? replayStored(storedByKey, request, requestHash) : null;
}

function replayStored(
  stored: StoredCommandRow,
  request: CommerceScheduledCommandRequest,
  requestHash: Buffer,
): CommerceScheduledCommandResult {
  const identityMatches =
    stored.world_id === request.worldId &&
    stored.command_type === request.actionType &&
    stored.actor_type === 'system' &&
    stored.actor_id === COMMERCE_SCHEDULER_ACTOR_ID &&
    stored.idempotency_key === request.idempotencyKey &&
    stored.causation_id === request.completedEventId;
  if (!identityMatches || !buffersEqual(stored.request_hash, requestHash)) {
    return { status: 'conflict' };
  }
  if (stored.status !== 'accepted' || !isObject(stored.response_summary)) {
    return { status: 'conflict' };
  }
  const revision = stored.response_summary.resultingStateRevision;
  return typeof revision === 'string' && nonnegativeInt64(revision)
    ? { resultingStateRevision: revision, status: 'applied' }
    : { status: 'conflict' };
}

async function insertReceivedCommand(
  client: SqlClient,
  request: CommerceScheduledCommandRequest,
  payload: Record<string, string>,
  payloadHash: Buffer,
  requestHash: Buffer,
): Promise<void> {
  await client.query(
    `insert into command_records(
       id,world_id,command_type,command_schema_version,actor_type,actor_id,
       payload,payload_hash,payload_classification,idempotency_key,request_hash,
       correlation_id,causation_id,requested_at
     ) values (
       $1,$2,$3,$4,'system',$5,$6,$7,'member',$8,$9,$10,$10,
       date_trunc('milliseconds',transaction_timestamp())
     )`,
    [
      request.commandId,
      request.worldId,
      request.actionType,
      AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      COMMERCE_SCHEDULER_ACTOR_ID,
      JSON.stringify(payload),
      payloadHash,
      request.idempotencyKey,
      requestHash,
      request.completedEventId,
    ],
  );
}

function commandPayload(request: CommerceScheduledCommandRequest): Record<string, string> {
  const common = {
    expectedTick: request.dueTick,
    scheduledActionId: request.scheduledActionId,
  };
  switch (request.actionType) {
    case 'CompleteProductionRunV1':
      return { ...common, productionRunId: request.payload.productionRunId };
    case 'SettlePayrollV1':
      return { ...common, payrollRecordId: request.payload.payrollRecordId };
    case 'ExpireMarketListingV1':
      return { ...common, listingId: request.payload.listingId };
    case 'AssessPeriodicTaxV1':
      return { ...common, taxPolicyId: request.payload.taxPolicyId };
  }
}

function assertRequest(request: CommerceScheduledCommandRequest): void {
  if (
    !isObject(request) ||
    typeof request.commandId !== 'string' ||
    !UUID.test(request.commandId) ||
    typeof request.completedEventId !== 'string' ||
    !UUID.test(request.completedEventId) ||
    typeof request.scheduledActionId !== 'string' ||
    !UUID.test(request.scheduledActionId) ||
    typeof request.worldId !== 'string' ||
    !UUID.test(request.worldId) ||
    typeof request.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(request.idempotencyKey) ||
    typeof request.dueTick !== 'string' ||
    !nonnegativeInt64(request.dueTick) ||
    typeof request.scheduleSequence !== 'string' ||
    !positiveInt64(request.scheduleSequence) ||
    !scheduledPayloadIsExact(request)
  ) {
    throw new Error('COMMERCE_SCHEDULED_REQUEST_INVALID');
  }
}

function scheduledPayloadIsExact(request: CommerceScheduledCommandRequest): boolean {
  if (!isObject(request.payload)) return false;
  const keys = Object.keys(request.payload);
  switch (request.actionType) {
    case 'CompleteProductionRunV1':
      return (
        keys.length === 1 &&
        keys[0] === 'productionRunId' &&
        typeof request.payload.productionRunId === 'string' &&
        UUID.test(request.payload.productionRunId)
      );
    case 'SettlePayrollV1':
      return (
        keys.length === 1 &&
        keys[0] === 'payrollRecordId' &&
        typeof request.payload.payrollRecordId === 'string' &&
        UUID.test(request.payload.payrollRecordId)
      );
    case 'ExpireMarketListingV1':
      return (
        keys.length === 1 &&
        keys[0] === 'listingId' &&
        typeof request.payload.listingId === 'string' &&
        UUID.test(request.payload.listingId)
      );
    case 'AssessPeriodicTaxV1':
      return (
        keys.length === 1 &&
        keys[0] === 'taxPolicyId' &&
        typeof request.payload.taxPolicyId === 'string' &&
        UUID.test(request.payload.taxPolicyId)
      );
    default:
      return false;
  }
}

async function completeProductionRun(
  client: SqlClient,
  ids: PostgresCommerceScheduledCommandOptions['ids'],
  request: Extract<CommerceScheduledCommandRequest, { actionType: 'CompleteProductionRunV1' }>,
  context: ScheduledContext,
  resultingStateRevision: string,
): Promise<PreparedEffect | CommerceScheduledCommandResult> {
  const result = await client.query(
    `select run.id::text,run.scheduled_action_id::text,run.status::text,
            run.due_tick::text,run.input_snapshot,run.output_snapshot,
            run.snapshot_checksum,run.row_version::text,
            business.backing_organization_entity_id::text,
            facility.facility_asset_id::text
       from production_runs run
       join businesses business
         on business.world_id=run.world_id and business.id=run.business_id
       join business_facilities facility
         on facility.world_id=run.world_id and facility.id=run.facility_id
        and facility.business_id=run.business_id
      where run.world_id=$1 and run.id=$2
      for update of run`,
    [request.worldId, request.payload.productionRunId],
  );
  const run = result.rows[0] as ProductionRunRow | undefined;
  if (!run) return { status: 'conflict' };
  if (run.status !== 'ready') return { status: 'already_terminal' };
  if (run.scheduled_action_id !== request.scheduledActionId || run.due_tick !== request.dueTick) {
    return { status: 'conflict' };
  }
  if (BigInt(context.current_tick) < BigInt(run.due_tick)) return { status: 'not_ready' };
  try {
    decideProductionCompletion({
      currentTick: BigInt(context.current_tick),
      dueTick: BigInt(run.due_tick),
      status: 'ready',
    });
  } catch (error) {
    if (error instanceof EconomyDomainError && error.code === 'CONFLICT') {
      return { status: 'not_ready' };
    }
    throw error;
  }

  const inputs = parseResourceSnapshot(run.input_snapshot);
  const outputs = parseResourceSnapshot(run.output_snapshot);
  if (
    !buffersEqual(run.snapshot_checksum, digest({ inputs, outputs })) ||
    inputs.length < 1 ||
    outputs.length < 1
  ) {
    throw new Error('COMMERCE_PRODUCTION_SNAPSHOT_INVALID');
  }
  const reservationResult = await client.query(
    `select reservation.id::text as reservation_id,reservation.status::text,
            reservation.quantity::text,reservation.row_version::text as reservation_row_version,
            inventory.id::text as inventory_id,inventory.resource_type_id::text,
            inventory.quantity::text as inventory_quantity,
            inventory.reserved_quantity::text as inventory_reserved_quantity,
            inventory.row_version::text as inventory_row_version,resource.quantity_scale as scale
       from inventory_reservations reservation
       join inventories inventory
         on inventory.world_id=reservation.world_id and inventory.id=reservation.inventory_id
       join resource_types resource
         on resource.world_id=inventory.world_id and resource.id=inventory.resource_type_id
      where reservation.world_id=$1 and reservation.purpose_type='production_input'
        and reservation.purpose_id=$2
      order by inventory.id
      for update of inventory,reservation`,
    [request.worldId, run.id],
  );
  const reservations = reservationResult.rows as unknown as InventoryReservationRow[];
  assertProductionReservations(inputs, reservations);

  const outputIds = [...new Set(outputs.map((item) => item.resourceTypeId))].sort();
  const outputResult = await client.query(
    `select inventory.id::text,inventory.resource_type_id::text,
            inventory.quantity::text,inventory.reserved_quantity::text,
            inventory.row_version::text,resource.quantity_scale as scale
       from inventories inventory
       join resource_types resource
         on resource.world_id=inventory.world_id and resource.id=inventory.resource_type_id
      where inventory.world_id=$1 and inventory.owner_entity_id=$2
        and inventory.container_asset_id=$3
        and inventory.resource_type_id=any($4::uuid[])
      order by inventory.id
      for update of inventory`,
    [request.worldId, run.backing_organization_entity_id, run.facility_asset_id, outputIds],
  );
  const outputInventories = outputResult.rows as unknown as InventoryRow[];
  if (outputInventories.length !== outputIds.length) {
    return failProductionRun(
      client,
      ids,
      request,
      context,
      resultingStateRevision,
      run,
      reservations,
      'OUTPUT_INVENTORY_UNAVAILABLE',
    );
  }

  const consumedEventId = ids.next();
  const producedEventId = ids.next();
  let movementOrdinal = 0;
  for (const item of inputs) {
    const reservation = reservations.find(
      (candidate) => candidate.resource_type_id === item.resourceTypeId,
    );
    if (!reservation) throw new Error('COMMERCE_PRODUCTION_RESERVATION_INVALID');
    const quantityAtoms = parseCanonicalQuantity(item.quantity, reservation.scale, {
      positive: true,
    });
    const mutation = consumeReservedInventory(
      inventoryStateFromReservation(reservation),
      quantityAtoms,
      BigInt(reservation.inventory_row_version),
    );
    await updateInventory(client, request, context, resultingStateRevision, {
      inventoryId: reservation.inventory_id,
      previousVersion: reservation.inventory_row_version,
      quantity: formatQuantity(mutation.quantityAtoms, reservation.scale),
      reservedQuantity: formatQuantity(mutation.reservedAtoms, reservation.scale),
    });
    const sameOutputInventory = outputInventories.find(
      (inventory) => inventory.id === reservation.inventory_id,
    );
    if (sameOutputInventory) {
      sameOutputInventory.quantity = formatQuantity(mutation.quantityAtoms, reservation.scale);
      sameOutputInventory.reserved_quantity = formatQuantity(
        mutation.reservedAtoms,
        reservation.scale,
      );
      sameOutputInventory.row_version = addDecimal(reservation.inventory_row_version, 1);
    }
    await terminalizeReservation(
      client,
      request,
      context,
      resultingStateRevision,
      reservation,
      'consumed',
      consumedEventId,
    );
    await insertInventoryMovement(client, ids.next(), {
      commandId: request.commandId,
      eventId: consumedEventId,
      fromInventoryId: reservation.inventory_id,
      movementKind: 'production_consume',
      occurredTick: context.current_tick,
      quantity: item.quantity,
      resourceTypeId: item.resourceTypeId,
      sourceId: run.id,
      sourceOrdinal: movementOrdinal,
      stateRevision: resultingStateRevision,
      toInventoryId: null,
      worldId: request.worldId,
      recordedAt: context.recorded_at,
    });
    movementOrdinal += 1;
  }

  const outputByResource = new Map(
    outputInventories.map((inventory) => [inventory.resource_type_id, inventory]),
  );
  for (const item of outputs) {
    const inventory = outputByResource.get(item.resourceTypeId);
    if (!inventory) throw new Error('COMMERCE_PRODUCTION_OUTPUT_INVENTORY_INVALID');
    const quantityAtoms = parseCanonicalQuantity(item.quantity, inventory.scale, {
      positive: true,
    });
    const mutation = creditInventory(
      inventoryState(inventory),
      quantityAtoms,
      BigInt(inventory.row_version),
    );
    await updateInventory(client, request, context, resultingStateRevision, {
      inventoryId: inventory.id,
      previousVersion: inventory.row_version,
      quantity: formatQuantity(mutation.quantityAtoms, inventory.scale),
      reservedQuantity: formatQuantity(mutation.reservedAtoms, inventory.scale),
    });
    await insertInventoryMovement(client, ids.next(), {
      commandId: request.commandId,
      eventId: producedEventId,
      fromInventoryId: null,
      movementKind: 'production_output',
      occurredTick: context.current_tick,
      quantity: item.quantity,
      resourceTypeId: item.resourceTypeId,
      sourceId: run.id,
      sourceOrdinal: movementOrdinal,
      stateRevision: resultingStateRevision,
      toInventoryId: inventory.id,
      worldId: request.worldId,
      recordedAt: context.recorded_at,
    });
    movementOrdinal += 1;
  }

  const updated = await client.query(
    `update production_runs
        set status='completed',row_version=row_version+1,terminal_command_id=$3,
            terminal_event_id=$4,terminal_state_revision=$5::bigint,
            updated_at=greatest(updated_at,$6),completed_at=$6
      where world_id=$1 and id=$2 and status='ready' and row_version=$7::bigint`,
    [
      request.worldId,
      run.id,
      request.commandId,
      producedEventId,
      resultingStateRevision,
      context.recorded_at,
      run.row_version,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) return { status: 'conflict' };
  await insertProductionTransition(
    client,
    request,
    context,
    resultingStateRevision,
    run,
    'completed',
    producedEventId,
  );
  return {
    coreChanged: false,
    events: [
      commerceEvent(consumedEventId, run.id, 'production_run', 'ResourcesConsumedV1', {
        productionRunId: run.id,
        resources: resourcePayload(inputs),
      }),
      commerceEvent(producedEventId, run.id, 'production_run', 'ResourcesProducedV1', {
        productionRunId: run.id,
        resources: resourcePayload(outputs),
      }),
    ],
  };
}

async function failProductionRun(
  client: SqlClient,
  ids: PostgresCommerceScheduledCommandOptions['ids'],
  request: Extract<CommerceScheduledCommandRequest, { actionType: 'CompleteProductionRunV1' }>,
  context: ScheduledContext,
  resultingStateRevision: string,
  run: ProductionRunRow,
  reservations: readonly InventoryReservationRow[],
  errorCode: string,
): Promise<PreparedEffect | CommerceScheduledCommandResult> {
  const eventId = ids.next();
  for (const reservation of reservations) {
    const quantityAtoms = parsePostgresQuantityV1(reservation.quantity, reservation.scale, {
      positive: true,
    });
    const mutation = releaseInventoryReservation(
      inventoryStateFromReservation(reservation),
      quantityAtoms,
      BigInt(reservation.inventory_row_version),
    );
    await updateInventory(client, request, context, resultingStateRevision, {
      inventoryId: reservation.inventory_id,
      previousVersion: reservation.inventory_row_version,
      quantity: formatQuantity(mutation.quantityAtoms, reservation.scale),
      reservedQuantity: formatQuantity(mutation.reservedAtoms, reservation.scale),
    });
    await terminalizeReservation(
      client,
      request,
      context,
      resultingStateRevision,
      reservation,
      'released',
      eventId,
    );
  }
  const updated = await client.query(
    `update production_runs
        set status='failed',failure_code=$3,row_version=row_version+1,
            terminal_command_id=$4,terminal_event_id=$5,terminal_state_revision=$6::bigint,
            updated_at=greatest(updated_at,$7),completed_at=$7
      where world_id=$1 and id=$2 and status='ready' and row_version=$8::bigint`,
    [
      request.worldId,
      run.id,
      errorCode,
      request.commandId,
      eventId,
      resultingStateRevision,
      context.recorded_at,
      run.row_version,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) return { status: 'conflict' };
  await insertProductionTransition(
    client,
    request,
    context,
    resultingStateRevision,
    run,
    'failed',
    eventId,
  );
  return {
    coreChanged: false,
    events: [
      commerceEvent(eventId, run.id, 'production_run', 'ProductionFailedV1', {
        errorCode,
        productionRunId: run.id,
      }),
    ],
  };
}

async function expireMarketListing(
  client: SqlClient,
  ids: PostgresCommerceScheduledCommandOptions['ids'],
  request: Extract<CommerceScheduledCommandRequest, { actionType: 'ExpireMarketListingV1' }>,
  context: ScheduledContext,
  resultingStateRevision: string,
): Promise<PreparedEffect | CommerceScheduledCommandResult> {
  const result = await client.query(
    `select listing.id::text,listing.scheduled_action_id::text,listing.status::text,
            listing.expires_at_tick::text,listing.remaining_quantity::text,
            listing.row_version::text,listing.seller_entity_id::text,
            listing.seller_inventory_id::text,resource.quantity_scale,
            inventory.quantity::text as inventory_quantity,
            inventory.reserved_quantity::text as inventory_reserved_quantity,
            inventory.row_version::text as inventory_row_version,
            reservation.id::text as reservation_id,reservation.quantity::text as reservation_quantity,
            reservation.status::text as reservation_status,
            reservation.row_version::text as reservation_row_version
       from market_listings listing
       join resource_types resource
         on resource.world_id=listing.world_id and resource.id=listing.resource_type_id
       join inventories inventory
         on inventory.world_id=listing.world_id and inventory.id=listing.seller_inventory_id
       join inventory_reservations reservation
         on reservation.world_id=listing.world_id
        and reservation.purpose_type='market_listing'
        and reservation.purpose_id=listing.id
        and reservation.inventory_id=listing.seller_inventory_id
      where listing.world_id=$1 and listing.id=$2
      for update of listing,inventory,reservation`,
    [request.worldId, request.payload.listingId],
  );
  const listing = result.rows[0] as ListingRow | undefined;
  if (!listing) return { status: 'conflict' };
  if (listing.status !== 'open') return { status: 'already_terminal' };
  if (
    listing.scheduled_action_id !== request.scheduledActionId ||
    listing.expires_at_tick !== request.dueTick
  ) {
    return { status: 'conflict' };
  }
  if (BigInt(context.current_tick) < BigInt(listing.expires_at_tick)) {
    return { status: 'not_ready' };
  }
  if (
    !listing.reservation_id ||
    listing.reservation_status !== 'active' ||
    !listing.reservation_quantity ||
    !listing.reservation_row_version ||
    listing.reservation_quantity !== listing.remaining_quantity
  ) {
    throw new Error('COMMERCE_LISTING_RESERVATION_INVALID');
  }
  const releasedAtoms = parsePostgresQuantityV1(
    listing.remaining_quantity,
    listing.quantity_scale,
    { positive: true },
  );
  const mutation = releaseInventoryReservation(
    inventoryState({
      id: listing.seller_inventory_id,
      quantity: listing.inventory_quantity,
      reserved_quantity: listing.inventory_reserved_quantity,
      resource_type_id: '',
      row_version: listing.inventory_row_version,
      scale: listing.quantity_scale,
    }),
    releasedAtoms,
    BigInt(listing.inventory_row_version),
  );
  const eventId = ids.next();
  await updateInventory(client, request, context, resultingStateRevision, {
    inventoryId: listing.seller_inventory_id,
    previousVersion: listing.inventory_row_version,
    quantity: formatQuantity(mutation.quantityAtoms, listing.quantity_scale),
    reservedQuantity: formatQuantity(mutation.reservedAtoms, listing.quantity_scale),
  });
  const reservationUpdated = await client.query(
    `update inventory_reservations
        set status='expired',row_version=row_version+1,terminal_command_id=$3,
            terminal_event_id=$4,terminal_state_revision=$5::bigint,
            updated_at=greatest(updated_at,$6),terminal_at=$6
      where world_id=$1 and id=$2 and status='active' and row_version=$7::bigint`,
    [
      request.worldId,
      listing.reservation_id,
      request.commandId,
      eventId,
      resultingStateRevision,
      context.recorded_at,
      listing.reservation_row_version,
    ],
  );
  if ((reservationUpdated.rowCount ?? 0) !== 1) return { status: 'conflict' };
  const listingUpdated = await client.query(
    `update market_listings
        set status='expired',reserved_quantity=0,row_version=row_version+1,
            terminal_command_id=$3,terminal_event_id=$4,terminal_state_revision=$5::bigint,
            updated_at=greatest(updated_at,$6),terminal_at=$6
      where world_id=$1 and id=$2 and status='open' and row_version=$7::bigint`,
    [
      request.worldId,
      listing.id,
      request.commandId,
      eventId,
      resultingStateRevision,
      context.recorded_at,
      listing.row_version,
    ],
  );
  if ((listingUpdated.rowCount ?? 0) !== 1) return { status: 'conflict' };
  return {
    coreChanged: false,
    events: [
      commerceEvent(eventId, listing.id, 'market_listing', 'MarketListingExpiredV1', {
        listingId: listing.id,
        remainingQuantity: listing.remaining_quantity,
        status: 'expired',
      }),
    ],
  };
}

async function settlePayroll(
  client: SqlClient,
  ids: PostgresCommerceScheduledCommandOptions['ids'],
  request: Extract<CommerceScheduledCommandRequest, { actionType: 'SettlePayrollV1' }>,
  context: ScheduledContext,
  resultingStateRevision: string,
): Promise<PreparedEffect | CommerceScheduledCommandResult> {
  const result = await client.query(
    `select payroll.id::text,payroll.contract_id::text,payroll.scheduled_action_id::text,
            payroll.gross_minor::text,payroll.tax_minor::text,payroll.net_minor::text,
            payroll.tax_policy_id::text,payroll.status::text,payroll.row_version::text,
            work.performed_tick::text,
            contract.employer_wallet_id::text,contract.worker_wallet_id::text,
            contract.worker_entity_id::text,contract.currency_id::text,
            business.backing_organization_entity_id::text as employer_entity_id
       from payroll_records payroll
       join work_records work
         on work.world_id=payroll.world_id and work.id=payroll.work_record_id
       join employment_contracts contract
         on contract.world_id=payroll.world_id and contract.id=payroll.contract_id
       join businesses business
         on business.world_id=contract.world_id and business.id=contract.business_id
      where payroll.world_id=$1 and payroll.id=$2
      for update of payroll`,
    [request.worldId, request.payload.payrollRecordId],
  );
  const payroll = result.rows[0] as PayrollRow | undefined;
  if (!payroll) return { status: 'conflict' };
  if (payroll.status !== 'pending') return { status: 'already_terminal' };
  if (payroll.scheduled_action_id !== request.scheduledActionId) {
    return { status: 'conflict' };
  }
  const gross = BigInt(payroll.gross_minor);
  const taxMinor = BigInt(payroll.tax_minor);
  const net = BigInt(payroll.net_minor);
  if (gross <= 0n || taxMinor < 0n || net <= 0n || gross !== taxMinor + net) {
    throw new Error('COMMERCE_PAYROLL_SNAPSHOT_INVALID');
  }

  const policy = payroll.tax_policy_id
    ? await taxPolicyByIdAt(
        client,
        request.worldId,
        payroll.tax_policy_id,
        'payroll',
        payroll.performed_tick,
      )
    : null;
  if (taxMinor > 0n) {
    if (
      !policy ||
      payroll.tax_policy_id !== policy.id ||
      policy.collection_mode !== 'withheld_from_recipient'
    ) {
      throw new Error('COMMERCE_PAYROLL_POLICY_INVALID');
    }
    // PerformJob persisted the exact policy identity after validating that policy at
    // performed_tick. Policy records are immutable once referenced, so settlement
    // must replay that snapshot even if its effective window has since elapsed or
    // its current lifecycle status has been retired.
    const decision = assessTax(snapshottedTaxPolicyState(policy), gross);
    if (decision.amountMinor !== taxMinor) {
      throw new Error('COMMERCE_PAYROLL_TAX_SNAPSHOT_INVALID');
    }
  } else {
    if (payroll.tax_policy_id !== null || policy !== null) {
      throw new Error('COMMERCE_PAYROLL_TAX_SNAPSHOT_INVALID');
    }
  }

  const walletIds = [
    payroll.employer_wallet_id,
    payroll.worker_wallet_id,
    ...(taxMinor > 0n && policy ? [policy.treasury_wallet_id] : []),
  ];
  const wallets = await lockWallets(client, request.worldId, walletIds);
  if (
    wallets.size !== new Set(walletIds).size ||
    wallets.get(payroll.employer_wallet_id)?.currency_id !== payroll.currency_id ||
    wallets.get(payroll.worker_wallet_id)?.currency_id !== payroll.currency_id ||
    [...wallets.values()].some((wallet) => wallet.status !== 'active')
  ) {
    return failPayroll(
      client,
      ids,
      request,
      context,
      resultingStateRevision,
      payroll,
      'WALLET_UNAVAILABLE',
    );
  }
  const postings: EconomyPosting[] = [
    { signedAmountMinor: -gross, walletId: payroll.employer_wallet_id },
    { signedAmountMinor: net, walletId: payroll.worker_wallet_id },
    ...(taxMinor > 0n && policy
      ? [{ signedAmountMinor: taxMinor, walletId: policy.treasury_wallet_id }]
      : []),
  ].sort((left, right) => left.walletId.localeCompare(right.walletId));
  let projected: ReadonlyMap<string, bigint>;
  try {
    const decision = assertBalancedTransaction({ postings, supplyDeltaMinor: 0n });
    projected = projectAccountingDecision({
      currentBalances: new Map(
        [...wallets].map(([id, wallet]) => [id, BigInt(wallet.available_minor)]),
      ),
      currentSupplyMinor: 0n,
      decision,
      maxSupplyMinor: null,
    }).balances;
  } catch (error) {
    if (error instanceof EconomyDomainError && error.code === 'INSUFFICIENT_FUNDS') {
      return failPayroll(
        client,
        ids,
        request,
        context,
        resultingStateRevision,
        payroll,
        'INSUFFICIENT_FUNDS',
      );
    }
    throw error;
  }

  const eventId = ids.next();
  const transactionId = ids.next();
  await applyFinancialTransaction(client, ids, {
    commandId: request.commandId,
    currencyId: payroll.currency_id,
    eventId,
    memoCode: 'payroll',
    occurredTick: context.current_tick,
    postings,
    projectedBalances: projected,
    recordedAt: context.recorded_at,
    resultingStateRevision,
    transactionId,
    transactionKind: 'payroll',
    wallets,
    worldId: request.worldId,
  });
  if (taxMinor > 0n && policy) {
    await insertTaxAssessment(client, {
      amountMinor: taxMinor.toString(),
      assessmentId: ids.next(),
      basisMinor: gross.toString(),
      commandId: request.commandId,
      currencyId: payroll.currency_id,
      eventId,
      occurredTick: payroll.performed_tick,
      payerEntityId: payroll.employer_entity_id,
      payerWalletId: payroll.employer_wallet_id,
      policyId: policy.id,
      recordedAt: context.recorded_at,
      sourceId: payroll.id,
      sourceType: 'payroll',
      stateRevision: resultingStateRevision,
      transactionId,
      treasuryWalletId: policy.treasury_wallet_id,
      worldId: request.worldId,
    });
  }
  const updated = await client.query(
    `update payroll_records
        set status='paid',financial_transaction_id=$3,row_version=row_version+1,
            terminal_command_id=$4,terminal_event_id=$5,terminal_state_revision=$6::bigint,
            updated_at=greatest(updated_at,$7),terminal_at=$7
      where world_id=$1 and id=$2 and status='pending' and row_version=$8::bigint`,
    [
      request.worldId,
      payroll.id,
      transactionId,
      request.commandId,
      eventId,
      resultingStateRevision,
      context.recorded_at,
      payroll.row_version,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) return { status: 'conflict' };
  return {
    coreChanged: true,
    events: [
      commerceEvent(eventId, payroll.id, 'payroll_record', 'PayrollSettledV1', {
        contractId: payroll.contract_id,
        financialTransactionId: transactionId,
        grossMinor: payroll.gross_minor,
        netMinor: payroll.net_minor,
        payrollRecordId: payroll.id,
        taxMinor: payroll.tax_minor,
      }),
    ],
    participantHistory: [
      {
        category: 'payroll',
        eventId,
        firstEntityId: payroll.employer_entity_id,
        secondEntityId: payroll.worker_entity_id,
        summaryArgs: {
          contractId: payroll.contract_id,
          payrollRecordId: payroll.id,
          status: 'paid',
        },
        summaryCode: 'PAYROLL_SETTLED',
      },
    ],
  };
}

async function failPayroll(
  client: SqlClient,
  ids: PostgresCommerceScheduledCommandOptions['ids'],
  request: Extract<CommerceScheduledCommandRequest, { actionType: 'SettlePayrollV1' }>,
  context: ScheduledContext,
  resultingStateRevision: string,
  payroll: PayrollRow,
  errorCode: string,
): Promise<PreparedEffect | CommerceScheduledCommandResult> {
  const eventId = ids.next();
  const updated = await client.query(
    `update payroll_records
        set status='failed',error_code=$3,row_version=row_version+1,
            terminal_command_id=$4,terminal_event_id=$5,terminal_state_revision=$6::bigint,
            updated_at=greatest(updated_at,$7),terminal_at=$7
      where world_id=$1 and id=$2 and status='pending' and row_version=$8::bigint`,
    [
      request.worldId,
      payroll.id,
      errorCode,
      request.commandId,
      eventId,
      resultingStateRevision,
      context.recorded_at,
      payroll.row_version,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) return { status: 'conflict' };
  return {
    coreChanged: false,
    events: [
      commerceEvent(eventId, payroll.id, 'payroll_record', 'PayrollFailedV1', {
        contractId: payroll.contract_id,
        errorCode,
        payrollRecordId: payroll.id,
      }),
    ],
    participantHistory: [
      {
        category: 'payroll',
        eventId,
        firstEntityId: payroll.employer_entity_id,
        secondEntityId: payroll.worker_entity_id,
        summaryArgs: {
          contractId: payroll.contract_id,
          payrollRecordId: payroll.id,
          status: 'failed',
        },
        summaryCode: 'PAYROLL_FAILED',
      },
    ],
  };
}

async function assessPeriodicTax(
  client: SqlClient,
  ids: PostgresCommerceScheduledCommandOptions['ids'],
  request: Extract<CommerceScheduledCommandRequest, { actionType: 'AssessPeriodicTaxV1' }>,
  context: ScheduledContext,
  resultingStateRevision: string,
): Promise<PreparedEffect | CommerceScheduledCommandResult> {
  const result = await client.query(
    `select id::text,treasury_wallet_id::text,currency_id::text,tax_type::text,
            collection_mode::text,rounding_mode,rate_basis_points,
            fixed_amount_minor::text,applicability,effective_from_tick::text,
            effective_until_tick::text,status::text
       from tax_policies
      where world_id=$1 and id=$2`,
    [request.worldId, request.payload.taxPolicyId],
  );
  const policy = result.rows[0] as TaxPolicyRow | undefined;
  if (!policy) return { status: 'conflict' };
  if (policy.status !== 'active') return { status: 'already_terminal' };
  if (
    policy.tax_type !== 'periodic_flat' ||
    !policy.fixed_amount_minor ||
    BigInt(policy.fixed_amount_minor) <= 0n ||
    BigInt(context.current_tick) < BigInt(policy.effective_from_tick) ||
    (policy.effective_until_tick !== null &&
      BigInt(context.current_tick) >= BigInt(policy.effective_until_tick))
  ) {
    return { status: 'conflict' };
  }
  const applicability = periodicApplicability(policy.applicability);
  // Recurrence v1 intentionally skips missed periods. The next occurrence is
  // based on the locked authoritative execution tick, never on worker time.
  const candidateNextTick = BigInt(context.current_tick) + BigInt(applicability.intervalTicks);
  const nextTick =
    candidateNextTick <= INT64_MAX &&
    (policy.effective_until_tick === null ||
      candidateNextTick < BigInt(policy.effective_until_tick))
      ? candidateNextTick.toString()
      : null;
  if (nextTick !== null && !(await hasScheduledActionCapacity(client, request.worldId, nextTick))) {
    return { status: 'not_ready' };
  }
  const wallets = await lockWallets(client, request.worldId, [
    applicability.payerWalletId,
    policy.treasury_wallet_id,
  ]);
  const payer = wallets.get(applicability.payerWalletId);
  const treasury = wallets.get(policy.treasury_wallet_id);
  if (
    !payer ||
    !treasury ||
    payer.owner_entity_id !== applicability.payerEntityId ||
    payer.currency_id !== policy.currency_id ||
    treasury.currency_id !== policy.currency_id ||
    payer.status !== 'active' ||
    treasury.status !== 'active'
  ) {
    return { status: 'conflict' };
  }
  const assessment = assessTax(taxPolicyState(policy), 0n);
  const postings: EconomyPosting[] = [
    { signedAmountMinor: -assessment.amountMinor, walletId: payer.id },
    { signedAmountMinor: assessment.amountMinor, walletId: treasury.id },
  ].sort((left, right) => left.walletId.localeCompare(right.walletId));
  let projected: ReadonlyMap<string, bigint>;
  try {
    projected = projectAccountingDecision({
      currentBalances: new Map(
        [...wallets].map(([id, wallet]) => [id, BigInt(wallet.available_minor)]),
      ),
      currentSupplyMinor: 0n,
      decision: assertBalancedTransaction({ postings, supplyDeltaMinor: 0n }),
      maxSupplyMinor: null,
    }).balances;
  } catch (error) {
    if (error instanceof EconomyDomainError && error.code === 'INSUFFICIENT_FUNDS') {
      return { status: 'not_ready' };
    }
    throw error;
  }

  const assessmentEventId = ids.next();
  const revenueEventId = ids.next();
  const assessmentId = ids.next();
  const transactionId = ids.next();
  await applyFinancialTransaction(client, ids, {
    commandId: request.commandId,
    currencyId: policy.currency_id,
    eventId: assessmentEventId,
    memoCode: 'periodic_tax',
    occurredTick: context.current_tick,
    postings,
    projectedBalances: projected,
    recordedAt: context.recorded_at,
    resultingStateRevision,
    transactionId,
    transactionKind: 'periodic_tax',
    wallets,
    worldId: request.worldId,
  });
  await insertTaxAssessment(client, {
    amountMinor: assessment.amountMinor.toString(),
    assessmentId,
    basisMinor: '0',
    commandId: request.commandId,
    currencyId: policy.currency_id,
    eventId: assessmentEventId,
    occurredTick: context.current_tick,
    payerEntityId: applicability.payerEntityId,
    payerWalletId: applicability.payerWalletId,
    policyId: policy.id,
    recordedAt: context.recorded_at,
    sourceId: request.scheduledActionId,
    sourceType: 'periodic_tax',
    stateRevision: resultingStateRevision,
    transactionId,
    treasuryWalletId: policy.treasury_wallet_id,
    worldId: request.worldId,
  });
  const events: PlannedEvent[] = [
    commerceEvent(assessmentEventId, assessmentId, 'tax_assessment', 'TaxAssessedV1', {
      amountMinor: assessment.amountMinor.toString(),
      assessmentId,
      basisMinor: '0',
      policyId: policy.id,
      sourceId: request.scheduledActionId,
    }),
    commerceEvent(revenueEventId, assessmentId, 'tax_assessment', 'TreasuryRevenueRecordedV1', {
      amountMinor: assessment.amountMinor.toString(),
      assessmentId,
      treasuryWalletId: policy.treasury_wallet_id,
    }),
  ];

  if (nextTick !== null) {
    const nextScheduleId = ids.next();
    const nextScheduleEventId = ids.next();
    const sequenceResult = await client.query(
      `select worldgraph_allocate_schedule_sequence($1)::text as sequence`,
      [request.worldId],
    );
    const sequence = (sequenceResult.rows[0] as { sequence?: string } | undefined)?.sequence;
    if (!sequence || !positiveInt64(sequence)) {
      throw new Error('COMMERCE_PERIODIC_TAX_SCHEDULE_SEQUENCE_INVALID');
    }
    const schedulePayload = { taxPolicyId: policy.id };
    const schedulePayloadHash = digest(schedulePayload);
    await client.query(
      `insert into scheduled_actions(
         id,world_id,schedule_sequence,due_tick,priority,action_type,action_schema_version,
         payload,payload_hash,process_version,created_by_actor_type,created_by_actor_id,
         created_command_id,created_state_revision,created_at,updated_at
       ) values ($1,$2,$3::bigint,$4::bigint,50,'AssessPeriodicTaxV1',1,$5,$6,'1.0.0',
         'system',$7,$8,$9::bigint,$10,$10)`,
      [
        nextScheduleId,
        request.worldId,
        sequence,
        nextTick,
        JSON.stringify(schedulePayload),
        schedulePayloadHash,
        COMMERCE_SCHEDULER_ACTOR_ID,
        request.commandId,
        resultingStateRevision,
        context.recorded_at,
      ],
    );
    events.push({
      aggregateId: nextScheduleId,
      aggregateType: 'scheduled_action',
      commerceBase: false,
      eventId: nextScheduleEventId,
      eventType: 'ScheduledActionCreatedV1',
      payload: {
        actionSchemaVersion: 1,
        actionType: 'AssessPeriodicTaxV1',
        dueTick: nextTick,
        payload: schedulePayload,
        payloadHash: schedulePayloadHash.toString('hex'),
        priority: 50,
        processVersion: '1.0.0',
        scheduleId: nextScheduleId,
        scheduleSequence: sequence,
      },
    });
  }
  return { coreChanged: true, events };
}

async function hasScheduledActionCapacity(
  client: SqlClient,
  worldId: string,
  dueTick: string,
): Promise<boolean> {
  const result = await client.query(
    `select count(*)::text as world_count,
            count(*) filter (where due_tick=$2::bigint)::text as tick_count
       from scheduled_actions
      where world_id=$1 and status='scheduled'`,
    [worldId, dueTick],
  );
  const counts = result.rows[0] as ScheduleCapacityRow | undefined;
  if (!counts) throw new Error('COMMERCE_SCHEDULE_CAPACITY_INVALID');
  return commerceScheduleCapacityAvailableV1(counts);
}

function parseResourceSnapshot(value: unknown): ResourceSnapshotItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error('COMMERCE_PRODUCTION_SNAPSHOT_INVALID');
  }
  const items = value.map((candidate) => {
    if (!isObject(candidate)) throw new Error('COMMERCE_PRODUCTION_SNAPSHOT_INVALID');
    const keys = Object.keys(candidate).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== 'quantity' ||
      keys[1] !== 'resourceTypeId' ||
      typeof candidate.quantity !== 'string' ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(candidate.quantity) ||
      typeof candidate.resourceTypeId !== 'string' ||
      !UUID.test(candidate.resourceTypeId)
    ) {
      throw new Error('COMMERCE_PRODUCTION_SNAPSHOT_INVALID');
    }
    return { quantity: candidate.quantity, resourceTypeId: candidate.resourceTypeId };
  });
  if (new Set(items.map((item) => item.resourceTypeId)).size !== items.length) {
    throw new Error('COMMERCE_PRODUCTION_SNAPSHOT_INVALID');
  }
  return items;
}

function resourcePayload(items: readonly ResourceSnapshotItem[]): JsonValue[] {
  return items.map((item) => ({
    quantity: item.quantity,
    resourceTypeId: item.resourceTypeId,
  }));
}

function assertProductionReservations(
  inputs: readonly ResourceSnapshotItem[],
  reservations: readonly InventoryReservationRow[],
): void {
  if (inputs.length !== reservations.length) {
    throw new Error('COMMERCE_PRODUCTION_RESERVATION_INVALID');
  }
  const byResource = new Map(reservations.map((row) => [row.resource_type_id, row]));
  if (byResource.size !== reservations.length) {
    throw new Error('COMMERCE_PRODUCTION_RESERVATION_INVALID');
  }
  for (const input of inputs) {
    const reservation = byResource.get(input.resourceTypeId);
    if (
      !reservation ||
      reservation.status !== 'active' ||
      parsePostgresQuantityV1(reservation.quantity, reservation.scale, { positive: true }) !==
        parseCanonicalQuantity(input.quantity, reservation.scale, { positive: true }) ||
      parseCanonicalQuantity(input.quantity, reservation.scale, { positive: true }) <= 0n
    ) {
      throw new Error('COMMERCE_PRODUCTION_RESERVATION_INVALID');
    }
  }
}

function inventoryState(row: InventoryRow): InventoryState {
  return {
    id: row.id,
    quantityAtoms: parsePostgresQuantityV1(row.quantity, row.scale),
    reservedAtoms: parsePostgresQuantityV1(row.reserved_quantity, row.scale),
    rowVersion: BigInt(row.row_version),
  };
}

function inventoryStateFromReservation(row: InventoryReservationRow): InventoryState {
  return {
    id: row.inventory_id,
    quantityAtoms: parsePostgresQuantityV1(row.inventory_quantity, row.scale),
    reservedAtoms: parsePostgresQuantityV1(row.inventory_reserved_quantity, row.scale),
    rowVersion: BigInt(row.inventory_row_version),
  };
}

async function updateInventory(
  client: SqlClient,
  request: CommerceScheduledCommandRequest,
  context: ScheduledContext,
  resultingStateRevision: string,
  mutation: {
    inventoryId: string;
    previousVersion: string;
    quantity: string;
    reservedQuantity: string;
  },
): Promise<void> {
  const updated = await client.query(
    `update inventories
        set quantity=$3::numeric,reserved_quantity=$4::numeric,row_version=row_version+1,
            updated_state_revision=$5::bigint,updated_at=greatest(updated_at,$6)
      where world_id=$1 and id=$2 and row_version=$7::bigint`,
    [
      request.worldId,
      mutation.inventoryId,
      mutation.quantity,
      mutation.reservedQuantity,
      resultingStateRevision,
      context.recorded_at,
      mutation.previousVersion,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) throw new Error('COMMERCE_INVENTORY_CONFLICT');
}

async function terminalizeReservation(
  client: SqlClient,
  request: CommerceScheduledCommandRequest,
  context: ScheduledContext,
  resultingStateRevision: string,
  reservation: InventoryReservationRow,
  status: 'consumed' | 'released',
  eventId: string,
): Promise<void> {
  const updated = await client.query(
    `update inventory_reservations
        set status=$3,row_version=row_version+1,terminal_command_id=$4,
            terminal_event_id=$5,terminal_state_revision=$6::bigint,
            updated_at=greatest(updated_at,$7),terminal_at=$7
      where world_id=$1 and id=$2 and status='active' and row_version=$8::bigint`,
    [
      request.worldId,
      reservation.reservation_id,
      status,
      request.commandId,
      eventId,
      resultingStateRevision,
      context.recorded_at,
      reservation.reservation_row_version,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) throw new Error('COMMERCE_RESERVATION_CONFLICT');
}

async function insertInventoryMovement(
  client: SqlClient,
  movementId: string,
  input: {
    commandId: string;
    eventId: string;
    fromInventoryId: string | null;
    movementKind: 'production_consume' | 'production_output';
    occurredTick: string;
    quantity: string;
    recordedAt: Date;
    resourceTypeId: string;
    sourceId: string;
    sourceOrdinal: number;
    stateRevision: string;
    toInventoryId: string | null;
    worldId: string;
  },
): Promise<void> {
  await client.query(
    `insert into inventory_movements(
       id,world_id,resource_type_id,from_inventory_id,to_inventory_id,quantity,
       movement_kind,source_type,source_id,source_ordinal,command_id,event_id,
       occurred_tick,state_revision,created_at
     ) values ($1,$2,$3,$4,$5,$6::numeric,$7,'production_run',$8,$9,$10,$11,
       $12::bigint,$13::bigint,$14)`,
    [
      movementId,
      input.worldId,
      input.resourceTypeId,
      input.fromInventoryId,
      input.toInventoryId,
      input.quantity,
      input.movementKind,
      input.sourceId,
      input.sourceOrdinal,
      input.commandId,
      input.eventId,
      input.occurredTick,
      input.stateRevision,
      input.recordedAt,
    ],
  );
}

async function insertProductionTransition(
  client: SqlClient,
  request: Extract<CommerceScheduledCommandRequest, { actionType: 'CompleteProductionRunV1' }>,
  context: ScheduledContext,
  resultingStateRevision: string,
  run: ProductionRunRow,
  status: 'completed' | 'failed',
  eventId: string,
): Promise<void> {
  const versionResult = await client.query(
    `select (coalesce(max(transition_version),0)+1)::text as version
       from production_run_transitions where world_id=$1 and run_id=$2`,
    [request.worldId, run.id],
  );
  const version = (versionResult.rows[0] as { version?: string } | undefined)?.version;
  if (!version || !positiveInt64(version)) {
    throw new Error('COMMERCE_PRODUCTION_TRANSITION_VERSION_INVALID');
  }
  await client.query(
    `insert into production_run_transitions(
       run_id,world_id,transition_version,status,command_id,event_id,
       occurred_tick,state_revision,snapshot_hash,created_at
     ) values ($1,$2,$3::bigint,$4,$5,$6,$7::bigint,$8::bigint,$9,$10)`,
    [
      run.id,
      request.worldId,
      version,
      status,
      request.commandId,
      eventId,
      context.current_tick,
      resultingStateRevision,
      run.snapshot_checksum,
      context.recorded_at,
    ],
  );
}

function commerceEvent(
  eventId: string,
  aggregateId: string,
  aggregateType: string,
  eventType: string,
  payload: Record<string, JsonValue>,
): PlannedEvent {
  return { aggregateId, aggregateType, commerceBase: true, eventId, eventType, payload };
}

async function taxPolicyByIdAt(
  client: SqlClient,
  worldId: string,
  policyId: string,
  taxType: 'payroll',
  tick: string,
): Promise<TaxPolicyRow | null> {
  const result = await client.query(
    `select id::text,treasury_wallet_id::text,currency_id::text,tax_type::text,
            collection_mode::text,rounding_mode,rate_basis_points,
            fixed_amount_minor::text,applicability,effective_from_tick::text,
            effective_until_tick::text,status::text
       from tax_policies
      where world_id=$1 and id=$2 and tax_type=$3
        and effective_from_tick <= $4::bigint
        and (effective_until_tick is null or effective_until_tick > $4::bigint)`,
    [worldId, policyId, taxType, tick],
  );
  return (result.rows[0] as TaxPolicyRow | undefined) ?? null;
}

function taxPolicyState(row: TaxPolicyRow): TaxPolicyState {
  return {
    basisPoints: row.rate_basis_points,
    collectionMode: row.collection_mode,
    fixedMinor: row.fixed_amount_minor === null ? null : BigInt(row.fixed_amount_minor),
    id: row.id,
    roundingMode: row.rounding_mode,
    status: row.status === 'active' ? 'active' : 'disabled',
    taxType: row.tax_type === 'periodic_flat' ? 'flat_periodic' : row.tax_type,
    treasuryWalletId: row.treasury_wallet_id,
  };
}

function snapshottedTaxPolicyState(row: TaxPolicyRow): TaxPolicyState {
  return { ...taxPolicyState(row), status: 'active' };
}

async function lockWallets(
  client: SqlClient,
  worldId: string,
  walletIds: readonly string[],
): Promise<Map<string, WalletRow>> {
  const sorted = [...new Set(walletIds)].sort();
  const result = await client.query(
    `select wallet.id::text,wallet.currency_id::text,wallet.owner_entity_id::text,
            wallet.status::text,balance.available_minor::text,balance.row_version::text
       from wallets wallet
       join wallet_balances balance
         on balance.world_id=wallet.world_id and balance.wallet_id=wallet.id
      where wallet.world_id=$1 and wallet.id=any($2::uuid[])
      order by wallet.id
      for update of wallet,balance`,
    [worldId, sorted],
  );
  return new Map((result.rows as unknown as WalletRow[]).map((row) => [row.id, row]));
}

function periodicApplicability(value: unknown): PeriodicApplicability {
  if (!isObject(value)) throw new Error('COMMERCE_PERIODIC_TAX_APPLICABILITY_INVALID');
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'intervalTicks' ||
    keys[1] !== 'payerEntityId' ||
    keys[2] !== 'payerWalletId' ||
    typeof value.intervalTicks !== 'string' ||
    !positiveInt64(value.intervalTicks) ||
    typeof value.payerEntityId !== 'string' ||
    !UUID.test(value.payerEntityId) ||
    typeof value.payerWalletId !== 'string' ||
    !UUID.test(value.payerWalletId)
  ) {
    throw new Error('COMMERCE_PERIODIC_TAX_APPLICABILITY_INVALID');
  }
  return {
    intervalTicks: value.intervalTicks,
    payerEntityId: value.payerEntityId,
    payerWalletId: value.payerWalletId,
  };
}

async function applyFinancialTransaction(
  client: SqlClient,
  ids: PostgresCommerceScheduledCommandOptions['ids'],
  input: {
    commandId: string;
    currencyId: string;
    eventId: string;
    memoCode: 'payroll' | 'periodic_tax';
    occurredTick: string;
    postings: readonly EconomyPosting[];
    projectedBalances: ReadonlyMap<string, bigint>;
    recordedAt: Date;
    resultingStateRevision: string;
    transactionId: string;
    transactionKind: 'payroll' | 'periodic_tax';
    wallets: ReadonlyMap<string, WalletRow>;
    worldId: string;
  },
): Promise<void> {
  await client.query(
    `insert into financial_transactions(
       id,world_id,currency_id,transaction_kind,supply_delta_minor,occurred_tick,
       command_id,event_id,memo_code,memo_text,state_revision,created_at
     ) values ($1,$2,$3,$4,0,$5::bigint,$6,$7,$8,null,$9::bigint,$10)`,
    [
      input.transactionId,
      input.worldId,
      input.currencyId,
      input.transactionKind,
      input.occurredTick,
      input.commandId,
      input.eventId,
      input.memoCode,
      input.resultingStateRevision,
      input.recordedAt,
    ],
  );
  for (const [ordinal, posting] of input.postings.entries()) {
    const wallet = input.wallets.get(posting.walletId);
    const balance = input.projectedBalances.get(posting.walletId);
    if (!wallet || balance === undefined) throw new Error('COMMERCE_FINANCIAL_WALLET_INVALID');
    await client.query(
      `insert into wallet_postings(
         id,world_id,transaction_id,posting_ordinal,wallet_id,currency_id,
         signed_amount_minor,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7::bigint,$8)`,
      [
        ids.next(),
        input.worldId,
        input.transactionId,
        ordinal,
        posting.walletId,
        input.currencyId,
        posting.signedAmountMinor.toString(),
        input.recordedAt,
      ],
    );
    const updated = await client.query(
      `update wallet_balances
          set available_minor=$3::bigint,row_version=row_version+1,
              updated_state_revision=$4::bigint,updated_at=greatest(updated_at,$5)
        where world_id=$1 and wallet_id=$2 and row_version=$6::bigint`,
      [
        input.worldId,
        posting.walletId,
        balance.toString(),
        input.resultingStateRevision,
        input.recordedAt,
        wallet.row_version,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error('COMMERCE_WALLET_CONFLICT');
  }
}

async function insertTaxAssessment(
  client: SqlClient,
  input: {
    amountMinor: string;
    assessmentId: string;
    basisMinor: string;
    commandId: string;
    currencyId: string;
    eventId: string;
    occurredTick: string;
    payerEntityId: string;
    payerWalletId: string;
    policyId: string;
    recordedAt: Date;
    sourceId: string;
    sourceType: 'payroll' | 'periodic_tax';
    stateRevision: string;
    transactionId: string;
    treasuryWalletId: string;
    worldId: string;
  },
): Promise<void> {
  await client.query(
    `insert into tax_assessments(
       id,world_id,policy_id,source_type,source_id,payer_entity_id,payer_wallet_id,
       treasury_wallet_id,currency_id,basis_minor,amount_minor,settlement_transaction_id,
       occurred_tick,command_id,event_id,state_revision,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint,$11::bigint,$12,
       $13::bigint,$14,$15,$16::bigint,$17)`,
    [
      input.assessmentId,
      input.worldId,
      input.policyId,
      input.sourceType,
      input.sourceId,
      input.payerEntityId,
      input.payerWalletId,
      input.treasuryWalletId,
      input.currencyId,
      input.basisMinor,
      input.amountMinor,
      input.transactionId,
      input.occurredTick,
      input.commandId,
      input.eventId,
      input.stateRevision,
      input.recordedAt,
    ],
  );
}

async function advanceExpansionHead(
  client: SqlClient,
  request: CommerceScheduledCommandRequest,
  context: ScheduledContext,
  resultingStateRevision: string,
): Promise<Buffer> {
  const result = await client.query(
    `select worldgraph_economy_expansion_projection_checksum($1) as checksum`,
    [request.worldId],
  );
  const checksum = requiredChecksum(
    (result.rows[0] as { checksum?: Buffer } | undefined)?.checksum,
    'COMMERCE_SCHEDULED_EXPANSION_CHECKSUM_INVALID',
  );
  const updated = await client.query(
    `update world_economy_expansion_heads
        set checksum=$2,row_version=row_version+1,updated_state_revision=$3::bigint,
            reconciliation_status='pending',last_reconciled_state_revision=null,
            last_reconciliation_run_id=null,updated_at=greatest(updated_at,$4)
      where world_id=$1 and row_version=$5::bigint`,
    [
      request.worldId,
      checksum,
      resultingStateRevision,
      context.recorded_at,
      context.expansion_row_version,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) throw new Error('COMMERCE_EXPANSION_HEAD_CONFLICT');
  return checksum;
}

async function advanceCoreHead(
  client: SqlClient,
  request: CommerceScheduledCommandRequest,
  context: ScheduledContext,
  resultingStateRevision: string,
): Promise<Buffer> {
  const result = await client.query(
    `select worldgraph_economy_projection_checksum($1) as checksum`,
    [request.worldId],
  );
  const checksum = requiredChecksum(
    (result.rows[0] as { checksum?: Buffer } | undefined)?.checksum,
    'COMMERCE_SCHEDULED_CORE_CHECKSUM_INVALID',
  );
  const updated = await client.query(
    `update world_economy_heads
        set checksum=$2,row_version=row_version+1,updated_state_revision=$3::bigint,
            reconciliation_status='pending',last_reconciled_state_revision=null,
            last_reconciliation_run_id=null,updated_at=greatest(updated_at,$4)
      where world_id=$1 and row_version=$5::bigint`,
    [
      request.worldId,
      checksum,
      resultingStateRevision,
      context.recorded_at,
      context.core_row_version,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) throw new Error('COMMERCE_CORE_HEAD_CONFLICT');
  return checksum;
}

async function finalizeScheduledCommand(
  client: SqlClient,
  ids: PostgresCommerceScheduledCommandOptions['ids'],
  input: {
    context: ScheduledContext;
    economyChecksum: Buffer;
    events: PlannedEvent[];
    expansionChecksum: Buffer;
    participantHistory: ParticipantHistoryPlan[];
    request: CommerceScheduledCommandRequest;
    resultingStateRevision: string;
  },
): Promise<Extract<CommerceScheduledCommandResult, { status: 'applied' }>> {
  if (input.events.length < 1 || input.events.length > 16) {
    throw new Error('COMMERCE_SCHEDULED_EVENT_COUNT_INVALID');
  }
  const eventIds = new Set(input.events.map((event) => event.eventId));
  if (
    input.participantHistory.length > input.events.length ||
    new Set(input.participantHistory.map((participant) => participant.eventId)).size !==
      input.participantHistory.length ||
    input.participantHistory.some((participant) => !eventIds.has(participant.eventId))
  ) {
    throw new Error('COMMERCE_SCHEDULED_PARTICIPANT_HISTORY_INVALID');
  }
  const allocationResult = await client.query(
    `select next_event_sequence::text,next_ledger_sequence::text,last_entry_hash
       from world_ledger_heads where world_id=$1`,
    [input.request.worldId],
  );
  const allocation = allocationResult.rows[0] as AllocationRow | undefined;
  if (!allocation) throw new Error('COMMERCE_SCHEDULED_LEDGER_HEAD_MISSING');

  const recordedAt = input.context.recorded_at.toISOString();
  const actor: LedgerActorV1 = {
    actorId: COMMERCE_SCHEDULER_ACTOR_ID,
    actorType: 'system',
  };
  const metadata: DomainEventMetadataV1 = {
    actor,
    authorizationRuleId: COMMERCE_SCHEDULER_AUTHORIZATION_RULE_ID,
    causationId: input.request.completedEventId,
    commandSchemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    commandType: input.request.actionType,
    correlationId: input.request.completedEventId,
    overrideId: null,
    payloadClassification: 'member',
  };
  const persisted: PersistedEvent[] = [];
  for (const [ordinal, planned] of input.events.entries()) {
    const aggregateResult = await client.query(
      `select coalesce((
         select current_version+1 from aggregate_stream_heads
          where world_id=$1 and aggregate_type=$2 and aggregate_id=$3
       ),1)::text as aggregate_version`,
      [input.request.worldId, planned.aggregateType, planned.aggregateId],
    );
    const aggregateVersion = (aggregateResult.rows[0] as { aggregate_version?: string } | undefined)
      ?.aggregate_version;
    if (!aggregateVersion || !positiveInt64(aggregateVersion)) {
      throw new Error('COMMERCE_SCHEDULED_AGGREGATE_VERSION_INVALID');
    }
    const payload = planned.commerceBase
      ? {
          aggregateVersion,
          ...planned.payload,
          tick: input.context.current_tick,
        }
      : planned.payload;
    const envelope = {
      aggregateId: planned.aggregateId,
      aggregateType: planned.aggregateType,
      aggregateVersion,
      commandId: input.request.commandId,
      eventId: planned.eventId,
      eventOrdinal: ordinal,
      eventSchemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
      eventType: planned.eventType,
      metadata,
      occurredAt: recordedAt,
      payload,
      recordedAt,
      resultingStateRevision: input.resultingStateRevision,
      worldEventSequence: addDecimal(allocation.next_event_sequence, ordinal),
      worldId: input.request.worldId,
    } as DomainEventHashInputV1;
    const eventHash = computeDomainEventHashV1(envelope);
    await client.query(
      `insert into domain_events(
         id,world_id,world_event_sequence,command_id,event_ordinal,
         aggregate_type,aggregate_id,aggregate_version,event_type,event_schema_version,
         payload,metadata,event_hash,occurred_at,recorded_at,resulting_state_revision
       ) values ($1,$2,$3::bigint,$4,$5,$6,$7,$8::bigint,$9,$10,$11,$12,$13,$14,$14,$15::bigint)`,
      [
        envelope.eventId,
        envelope.worldId,
        envelope.worldEventSequence,
        envelope.commandId,
        envelope.eventOrdinal,
        envelope.aggregateType,
        envelope.aggregateId,
        envelope.aggregateVersion,
        envelope.eventType,
        envelope.eventSchemaVersion,
        JSON.stringify(envelope.payload),
        JSON.stringify(envelope.metadata),
        Buffer.from(eventHash, 'hex'),
        input.context.recorded_at,
        envelope.resultingStateRevision,
      ],
    );
    persisted.push({
      envelope: { ...envelope, eventHash },
      ledgerSequence: addDecimal(allocation.next_ledger_sequence, ordinal + 1),
    });
  }

  const acceptedEntry = createLedgerEntry(ids.next(), {
    actor,
    commandId: input.request.commandId,
    entryKind: 'command_accepted',
    eventId: null,
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    ledgerSequence: allocation.next_ledger_sequence,
    previousHash: allocation.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
    publicSummaryCode: 'COMMAND_ACCEPTED',
    recordedAt,
    redactedDetails: {
      authorizationRuleId: COMMERCE_SCHEDULER_AUTHORIZATION_RULE_ID,
      commandType: input.request.actionType,
    },
    worldId: input.request.worldId,
  });
  await insertLedgerEntry(client, acceptedEntry);
  let previousHash = acceptedEntry.entryHash;
  for (const event of persisted) {
    const factEntry = createLedgerEntry(ids.next(), {
      actor,
      commandId: input.request.commandId,
      entryKind: 'domain_event',
      eventId: event.envelope.eventId,
      ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
      ledgerSequence: event.ledgerSequence,
      previousHash,
      publicSummaryCode: summaryCode(event.envelope.eventType),
      recordedAt,
      redactedDetails: {
        aggregateType: event.envelope.aggregateType,
        eventType: event.envelope.eventType,
        targetHash: digestText(event.envelope.aggregateId),
      },
      worldId: input.request.worldId,
    });
    await insertLedgerEntry(client, factEntry);
    previousHash = factEntry.entryHash;
    const history = projectWorldHistoryEntryV1(event.envelope as DomainEventEnvelopeV1, factEntry);
    await insertWorldHistory(client, history);
    const participant = input.participantHistory.find(
      (candidate) => candidate.eventId === event.envelope.eventId,
    );
    if (participant) {
      await insertParticipantHistory(
        client,
        input.request,
        participant,
        event.ledgerSequence,
        input.resultingStateRevision,
        input.context.recorded_at,
      );
    }
    await client.query(
      `insert into outbox_messages(
         id,world_id,event_id,message_type,message_schema_version,
         payload,status,attempts,available_at,created_at
       ) values ($1,$2,$3,'DomainEventReferenceV1',$4,$5,'pending',0,$6,$6)`,
      [
        ids.next(),
        input.request.worldId,
        event.envelope.eventId,
        OUTBOX_SCHEMA_VERSION,
        JSON.stringify({
          eventId: event.envelope.eventId,
          eventType: event.envelope.eventType,
          worldEventSequence: event.envelope.worldEventSequence,
          worldId: input.request.worldId,
        }),
        input.context.recorded_at,
      ],
    );
  }

  const lastEventSequence = persisted.at(-1)!.envelope.worldEventSequence;
  const lastLedgerSequence = persisted.at(-1)!.ledgerSequence;
  const graphResult = await client.query(
    `select worldgraph_projection_checksum($1,$2::bigint) as checksum`,
    [input.request.worldId, input.resultingStateRevision],
  );
  const simulationResult = await client.query(
    `select worldgraph_simulation_projection_checksum($1) as checksum`,
    [input.request.worldId],
  );
  const graphChecksum = requiredChecksum(
    (graphResult.rows[0] as { checksum?: Buffer } | undefined)?.checksum,
    'COMMERCE_SCHEDULED_GRAPH_CHECKSUM_INVALID',
  );
  const simulationChecksum = requiredChecksum(
    (simulationResult.rows[0] as { checksum?: Buffer } | undefined)?.checksum,
    'COMMERCE_SCHEDULED_SIMULATION_CHECKSUM_INVALID',
  );
  await upsertCheckpoint(
    client,
    input.request.worldId,
    'world_graph',
    PROJECTION_SCHEMA_VERSION,
    lastEventSequence,
    graphChecksum,
    input.context.recorded_at,
  );
  await upsertCheckpoint(
    client,
    input.request.worldId,
    'simulation_runtime',
    1,
    lastEventSequence,
    simulationChecksum,
    input.context.recorded_at,
  );
  await upsertCheckpoint(
    client,
    input.request.worldId,
    'economy_runtime',
    ECONOMY_SCHEMA_VERSION,
    lastEventSequence,
    input.economyChecksum,
    input.context.recorded_at,
  );
  await upsertCheckpoint(
    client,
    input.request.worldId,
    'economy_closed_loop',
    1,
    lastEventSequence,
    input.expansionChecksum,
    input.context.recorded_at,
  );
  const runtimeUpdated = await client.query(
    `update world_runtime_heads
        set state_revision=$2::bigint,last_ledger_sequence=$3::bigint,
            last_event_sequence=$4::bigint,projection_checksum=$5,
            updated_at=greatest(updated_at,$6)
      where world_id=$1 and state_revision=$7::bigint`,
    [
      input.request.worldId,
      input.resultingStateRevision,
      lastLedgerSequence,
      lastEventSequence,
      graphChecksum,
      input.context.recorded_at,
      input.context.state_revision,
    ],
  );
  if ((runtimeUpdated.rowCount ?? 0) !== 1) {
    throw new Error('COMMERCE_SCHEDULED_RUNTIME_CONFLICT');
  }
  const response: Extract<WorldCommandResultV1, { status: 'accepted' }> = {
    commandId: input.request.commandId,
    eventIds: persisted.map((event) => event.envelope.eventId),
    eventSequenceRange: {
      from: allocation.next_event_sequence,
      to: lastEventSequence,
    },
    ledgerSequenceRange: {
      from: allocation.next_ledger_sequence,
      to: lastLedgerSequence,
    },
    resultingStateRevision: input.resultingStateRevision,
    schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    status: 'accepted',
  };
  const accepted = await client.query(
    `update command_records
        set status='accepted',authorization_rule_id=$2,override_id=null,decided_at=$3,
            resulting_state_revision=$4::bigint,response_summary=$5
      where id=$1 and world_id=$6 and status='received'`,
    [
      input.request.commandId,
      COMMERCE_SCHEDULER_AUTHORIZATION_RULE_ID,
      input.context.recorded_at,
      input.resultingStateRevision,
      JSON.stringify(response),
      input.request.worldId,
    ],
  );
  if ((accepted.rowCount ?? 0) !== 1) throw new Error('COMMERCE_SCHEDULED_ACCEPT_FAILED');
  await client.query('select worldgraph_assert_economy_command_terminal($1)', [
    input.request.commandId,
  ]);
  await client.query('select worldgraph_assert_commerce_command_terminal($1)', [
    input.request.commandId,
  ]);
  return { resultingStateRevision: input.resultingStateRevision, status: 'applied' };
}

function createLedgerEntry(
  entryId: string,
  input: Omit<LedgerEntryHashInputV1, 'entryId'>,
): LedgerEntryV1 {
  const hashInput: LedgerEntryHashInputV1 = { ...input, entryId };
  return { ...hashInput, entryHash: computeLedgerEntryHashV1(hashInput) } as LedgerEntryV1;
}

async function insertLedgerEntry(client: SqlClient, entry: LedgerEntryV1): Promise<void> {
  await client.query(
    `insert into ledger_entries(
       id,world_id,ledger_sequence,entry_kind,command_id,event_id,
       actor_type,actor_id,public_summary_code,redacted_details,
       previous_hash,entry_hash,recorded_at
     ) values ($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      entry.entryId,
      entry.worldId,
      entry.ledgerSequence,
      entry.entryKind,
      entry.commandId,
      entry.eventId,
      entry.actor.actorType,
      entry.actor.actorId,
      entry.publicSummaryCode,
      JSON.stringify(entry.redactedDetails),
      Buffer.from(entry.previousHash, 'hex'),
      Buffer.from(entry.entryHash, 'hex'),
      new Date(entry.recordedAt),
    ],
  );
}

async function insertWorldHistory(client: SqlClient, history: WorldHistoryEntryV1): Promise<void> {
  await client.query(
    `insert into world_history_entries(
       world_id,ledger_sequence,command_id,event_id,event_type,history_schema_version,
       occurred_at,category,title_key,summary_args,actor_type,actor_id,
       target_type,target_id,visibility,correlation_id,resulting_state_revision
     ) values ($1,$2::bigint,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::bigint)`,
    [
      history.worldId,
      history.ledgerSequence,
      history.commandId,
      history.eventId,
      history.eventType,
      HISTORY_SCHEMA_VERSION,
      new Date(history.occurredAt),
      history.category,
      history.titleKey,
      JSON.stringify(history.summaryArgs),
      history.actor.actorType,
      history.actor.actorId,
      history.targetType,
      history.targetId,
      history.visibility,
      history.correlationId,
      history.resultingStateRevision,
    ],
  );
}

async function insertParticipantHistory(
  client: SqlClient,
  request: CommerceScheduledCommandRequest,
  participant: ParticipantHistoryPlan,
  ledgerSequence: string,
  resultingStateRevision: string,
  recordedAt: Date,
): Promise<void> {
  await client.query(
    `insert into economy_participant_history(
       world_id,ledger_sequence,user_id,participant_entity_id,counterparty_entity_id,
       command_id,event_id,category,summary_code,summary_args,visibility,state_revision,created_at
     )
     select distinct on (controller.user_id)
            $1,$2::bigint,controller.user_id,party.participant_entity_id,
            party.counterparty_entity_id,$5,$6,$7,$8,$9,'participant',$10::bigint,$11
       from (
         select $3::uuid as participant_entity_id,$4::uuid as counterparty_entity_id,
                0 as party_ordinal
         union all
         select $4::uuid,$3::uuid,1
       ) party
       join world_entity_controllers controller
         on controller.world_id=$1
        and controller.revoked_at is null
       join world_memberships membership
         on membership.world_id=controller.world_id
        and membership.user_id=controller.user_id
        and membership.status='active'
      where worldgraph_user_controls_economy_entity_v1(
        $1,controller.user_id,party.participant_entity_id
      )
      order by controller.user_id,party.party_ordinal
     on conflict (world_id,ledger_sequence,user_id) do nothing`,
    [
      request.worldId,
      ledgerSequence,
      participant.firstEntityId,
      participant.secondEntityId,
      request.commandId,
      participant.eventId,
      participant.category,
      participant.summaryCode,
      JSON.stringify(participant.summaryArgs),
      resultingStateRevision,
      recordedAt,
    ],
  );
}

async function upsertCheckpoint(
  client: SqlClient,
  worldId: string,
  projectionName: 'economy_closed_loop' | 'economy_runtime' | 'simulation_runtime' | 'world_graph',
  schemaVersion: number,
  lastEventSequence: string,
  checksum: Buffer,
  recordedAt: Date,
): Promise<void> {
  await client.query(
    `insert into projection_checkpoints(
       world_id,projection_name,projection_schema_version,last_event_sequence,
       checksum,status,updated_at
     ) values ($1,$2,$3,$4::bigint,$5,'current',$6)
     on conflict (world_id,projection_name) do update
       set projection_schema_version=excluded.projection_schema_version,
           last_event_sequence=excluded.last_event_sequence,checksum=excluded.checksum,
           status=excluded.status,
           updated_at=greatest(projection_checkpoints.updated_at,excluded.updated_at)`,
    [worldId, projectionName, schemaVersion, lastEventSequence, checksum, recordedAt],
  );
}

function requiredChecksum(value: Buffer | undefined, code: string): Buffer {
  if (!(value instanceof Buffer) || value.length !== 32) throw new Error(code);
  return value;
}

function summaryCode(eventType: string): string {
  return eventType
    .replace(/V[1-9][0-9]*$/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toUpperCase();
}

function digest(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function addDecimal(value: string, amount: number): string {
  return (BigInt(value) + BigInt(amount)).toString(10);
}

export function parsePostgresQuantityV1(
  value: string,
  scale: number,
  options: { positive?: boolean } = {},
): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value);
  if (!match) throw new Error('COMMERCE_DATABASE_QUANTITY_INVALID');
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  if (/[1-9]/u.test(fraction.slice(scale))) {
    throw new Error('COMMERCE_DATABASE_QUANTITY_INVALID');
  }
  const declaredFraction = fraction.slice(0, scale).padEnd(scale, '0');
  return parseCanonicalQuantity(
    scale === 0 ? whole : `${whole}.${declaredFraction}`,
    scale,
    options,
  );
}

function nonnegativeInt64(value: string): boolean {
  return NONNEGATIVE_INT64.test(value) && BigInt(value) <= INT64_MAX;
}

function positiveInt64(value: string): boolean {
  return POSITIVE_INT64.test(value) && BigInt(value) <= INT64_MAX;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializationFailure(error: unknown): boolean {
  return (
    isObject(error) &&
    typeof error.code === 'string' &&
    (error.code === '40001' || error.code === '40P01')
  );
}

function fatalConnectionError(error: unknown): Error | undefined {
  if (!isObject(error) || typeof error.code !== 'string') return undefined;
  return error.code.startsWith('08')
    ? error instanceof Error
      ? error
      : new Error('PostgreSQL connection failed.')
    : undefined;
}

async function defaultRetryDelay(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, 5 * 2 ** attempt)));
}
