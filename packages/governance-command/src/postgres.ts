import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  canonicalJson,
  DOMAIN_EVENT_SCHEMA_VERSION,
  GOVERNANCE_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  type DomainEventMetadataV1,
  type LedgerActorV1,
  type LedgerEntryV1,
  type WorldCommandResultV1,
} from '@worldgraph/contracts';
import {
  LEDGER_GENESIS_PREVIOUS_HASH,
  computeDomainEventHashV1,
  computeLedgerEntryHashV1,
  type DomainEventHashInputV1,
  type LedgerEntryHashInputV1,
} from '@worldgraph/ledger';

import {
  GovernanceCommandError,
  RecentCredentialProofError,
  isRetryableGovernanceTransactionError,
} from './errors.js';
import { dispatchGovernanceHandler } from './handlers.js';
import {
  addDecimal,
  sanitizeGovernanceContext,
  safeJson,
  sha256Buffer,
  type GovernanceCreatorOverrideProvenance,
  type GovernanceHandlerOutcome,
  type GovernancePlannedEvent,
  type WorldTransactionContext,
} from './internal.js';
import { governanceRecentCredentialCommandHashV1 } from './recent-credential.js';
import {
  governanceActorModeIsCompatible,
  isInternalGovernanceCommandType,
  isPublicGovernanceCommandType,
  type GovernanceCommandExecutionInput,
  type GovernanceCommandExecutionResult,
  type GovernanceCommandPolicy,
  type GovernanceSqlClient,
  type GovernanceSqlExecutor,
  type GovernanceSqlPool,
  type InternalGovernanceCommandExecutionInput,
  type PostgresGovernanceCommandOptions,
  type PublicGovernanceCommandExecutionInput,
} from './types.js';

interface StoredCommandRow {
  actor_id: string;
  actor_type: string;
  command_type: string;
  id: string;
  idempotency_key: string;
  request_hash: Buffer;
  response_summary: unknown;
  status: string;
  world_id: string;
}

interface AllocationRow {
  last_entry_hash: Buffer | null;
  next_event_sequence: string;
  next_ledger_sequence: string;
}

interface ScheduledActionRow {
  action_type: string;
  completed_event_id: string | null;
  completed_state_revision: string | null;
  due_tick: string;
  payload: unknown;
  status: string;
}

interface PersistedEvent {
  event: DomainEventHashInputV1;
  eventHash: string;
}

interface TransactionResolution {
  commit: boolean;
  execution: GovernanceCommandExecutionResult;
}

interface TransactionIds {
  acceptedLedgerEntryId: string;
  authorityDecisionId: string;
  creatorOverrideId: string | null;
  eventId: string;
  eventLedgerEntryId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const NONNEGATIVE = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE = /^[1-9][0-9]{0,18}$/u;
const INT64_MAX = 9_223_372_036_854_775_807n;

export const GOVERNANCE_COMMAND_LOCK_ORDER = [
  'world_runtime',
  'governance_head',
  'simulation_clock',
  'governance_aggregate',
] as const;

export const DEFAULT_GOVERNANCE_COMMAND_POLICY: GovernanceCommandPolicy = {
  allowEnactment: true,
  allowNewContests: true,
  allowOverrides: true,
  allowVoting: true,
  contestRateLimitPerHour: 6,
  maximumTaxRateBps: 5_000,
  minimumTaxRateBps: 0,
  nominationRateLimitPerMinute: 10,
  requireTwoPersonOverride: true,
  requireTwoPersonRepair: true,
  sponsorRateLimitPerMinute: 20,
  voteRateLimitPerMinute: 30,
};

export function governanceCommandRequestHashV1(input: GovernanceCommandExecutionInput): Buffer {
  return sha256Buffer(governanceCommandRequestMaterialV1(input));
}

export function governanceCommandPrivateRequestHashV1(
  input: GovernanceCommandExecutionInput,
  secretHashKey: string,
): Buffer {
  return hmacSha256Buffer(secretHashKey, governanceCommandRequestMaterialV1(input));
}

export function governanceCommandPayloadHashV1(
  input: GovernanceCommandExecutionInput,
  secretHashKey?: string,
): Buffer {
  return secretHashKey && isBallotCommand(input)
    ? hmacSha256Buffer(secretHashKey, input.command.payload)
    : sha256Buffer(input.command.payload);
}

export function governanceProjectionChecksumV1(input: {
  eventHashes: readonly string[];
  previousChecksum: string | null;
  resultingStateRevision: string;
  worldId: string;
}): Buffer {
  if (
    input.eventHashes.length < 1 ||
    input.eventHashes.some((eventHash) => !HASH.test(eventHash))
  ) {
    throw new Error('GOVERNANCE_PROJECTION_EVENT_HASHES_INVALID');
  }
  return sha256Buffer({
    domain: 'worldgraph.governance-projection-checkpoint.v1',
    eventHashes: input.eventHashes,
    previousChecksum: input.previousChecksum,
    resultingStateRevision: input.resultingStateRevision,
    worldId: input.worldId,
  });
}

function governanceCommandRequestMaterialV1(
  input: GovernanceCommandExecutionInput,
): Record<string, unknown> {
  return {
    actorMode: input.command.actorMode,
    domain: 'worldgraph.governance-command-request.v1',
    expectedAggregateVersion: input.command.expectedAggregateVersion,
    expectedStateRevision: input.command.expectedStateRevision,
    expectedTick: input.command.expectedTick,
    expectedWorldVersion: input.command.expectedWorldVersion,
    payload: input.command.payload,
    schemaVersion: input.command.schemaVersion,
    type: input.command.type,
    worldId: input.worldId,
  };
}

/** The storable command payload deliberately excludes every individual choice. */
export function governanceCommandStoredPayloadV1(
  input: GovernanceCommandExecutionInput,
): Record<string, unknown> {
  const payload = { ...input.command.payload } as Record<string, unknown>;
  delete payload.choice;
  return sanitizeGovernanceContext(payload);
}

export class PostgresGovernanceCommandExecutor {
  private readonly maximumSerializationAttempts: number;
  private readonly policy: GovernanceCommandPolicy;
  private readonly retryDelay: (attempt: number) => Promise<void>;

  public constructor(
    private readonly pool: GovernanceSqlPool,
    private readonly options: PostgresGovernanceCommandOptions,
  ) {
    this.maximumSerializationAttempts = options.maximumSerializationAttempts ?? 3;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    this.policy = { ...DEFAULT_GOVERNANCE_COMMAND_POLICY, ...options.policy };
    assertConfiguration(this.maximumSerializationAttempts, this.policy);
  }

  public async execute(
    input: GovernanceCommandExecutionInput,
  ): Promise<GovernanceCommandExecutionResult> {
    assertExecutionInput(input);
    const secretHashKey = commandSecretHashKey(input, this.options.secretHashKey);
    const requestHash = secretHashKey
      ? governanceCommandPrivateRequestHashV1(input, secretHashKey)
      : governanceCommandRequestHashV1(input);
    const payloadHash = governanceCommandPayloadHashV1(input, secretHashKey);
    const ids = new ReplayableIds(this.options.ids);

    for (let attempt = 0; attempt < this.maximumSerializationAttempts; attempt += 1) {
      ids.reset();
      const client = await this.pool.connect();
      let releaseError: Error | undefined;
      const connectionError = (error: Error): void => {
        releaseError ??= error;
      };
      client.on?.('error', connectionError);
      try {
        await client.query('begin isolation level serializable');
        const resolution = await this.executeTransaction(
          client,
          ids,
          input,
          payloadHash,
          requestHash,
        );
        await client.query(resolution.commit ? 'commit' : 'rollback');
        return resolution.execution;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        releaseError ??= fatalConnectionError(error);
        if (
          isRetryableGovernanceTransactionError(error) &&
          attempt + 1 < this.maximumSerializationAttempts
        ) {
          await this.retryDelay(attempt);
          continue;
        }
        throw error;
      } finally {
        client.removeListener?.('error', connectionError);
        client.release(releaseError);
      }
    }
    throw new Error('GOVERNANCE_COMMAND_SERIALIZATION_RETRY_EXHAUSTED');
  }

  public async executePublic(
    input: PublicGovernanceCommandExecutionInput,
  ): Promise<GovernanceCommandExecutionResult> {
    if (!isPublicGovernanceCommandType(input.command.type)) {
      throw new GovernanceCommandError(
        'COMMAND_TYPE_DISABLED',
        'Internal governance commands are worker-only.',
      );
    }
    return this.execute(input);
  }

  public async executeInternal(
    input: InternalGovernanceCommandExecutionInput,
  ): Promise<GovernanceCommandExecutionResult> {
    if (!isInternalGovernanceCommandType(input.command.type)) {
      throw new GovernanceCommandError(
        'COMMAND_TYPE_DISABLED',
        'This is not a scheduled governance command.',
      );
    }
    return this.execute(input);
  }

  private async executeTransaction(
    client: GovernanceSqlClient,
    ids: ReplayableIds,
    input: GovernanceCommandExecutionInput,
    payloadHash: Buffer,
    requestHash: Buffer,
  ): Promise<TransactionResolution> {
    const txIds: TransactionIds = {
      acceptedLedgerEntryId: ids.next(),
      authorityDecisionId: ids.next(),
      creatorOverrideId: null,
      eventId: ids.next(),
      eventLedgerEntryId: ids.next(),
    };
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `worldgraph-command-v1:${input.worldId}`,
    ]);
    const replay = await replayStoredCommand(client, input, requestHash);
    if (replay) {
      await verifyRecentCredentialReplay(client, input);
      return { commit: false, execution: replay };
    }
    await insertReceived(client, input, payloadHash, requestHash);
    await client.query('select worldgraph_open_command_write($1,$2)', [
      input.command.commandId,
      input.worldId,
    ]);
    await consumeRecentCredential(client, input);
    const creatorOverride = await insertCreatorOverrideProvenance(client, ids, input);
    txIds.creatorOverrideId = creatorOverride?.creatorOverrideId ?? null;
    const world = await loadWorldContext(client, input.worldId);
    if (!world) throw new Error('GOVERNANCE_WORLD_CONTEXT_MISSING');
    const allocation = await loadAllocation(client, input.worldId);
    const earlyRejection = validateAgainstWorld(input, world);
    await insertAuthorityDecision(client, ids, input, world, txIds.authorityDecisionId);
    if (earlyRejection) {
      if (isRetryableInternalPrecondition(input, earlyRejection)) {
        throw new GovernanceCommandError(earlyRejection.code, earlyRejection.message, false);
      }
      return {
        commit: true,
        execution: await finalizeRejection(
          client,
          input,
          world,
          allocation,
          txIds.acceptedLedgerEntryId,
          earlyRejection,
          txIds.creatorOverrideId,
        ),
      };
    }
    if (!input.authorization.allowed) {
      return {
        commit: true,
        execution: await finalizeRejection(
          client,
          input,
          world,
          allocation,
          txIds.acceptedLedgerEntryId,
          new GovernanceCommandError(
            'AUTHORIZATION_DENIED',
            'Governance authority denied this command.',
          ),
          txIds.creatorOverrideId,
        ),
      };
    }

    const provenanceRejection = await validateScheduledInvocation(client, input, world);
    if (provenanceRejection) {
      return {
        commit: true,
        execution: await finalizeRejection(
          client,
          input,
          world,
          allocation,
          txIds.acceptedLedgerEntryId,
          provenanceRejection,
          txIds.creatorOverrideId,
        ),
      };
    }
    const rateLimitRejection = await checkGovernanceVelocity(client, input, this.policy);
    if (rateLimitRejection) {
      return {
        commit: true,
        execution: await finalizeRejection(
          client,
          input,
          world,
          allocation,
          txIds.acceptedLedgerEntryId,
          rateLimitRejection,
          txIds.creatorOverrideId,
        ),
      };
    }

    await client.query('savepoint governance_command_body');
    let outcome: GovernanceHandlerOutcome;
    const additionalEvents: GovernancePlannedEvent[] = [];
    try {
      outcome = await dispatchGovernanceHandler({
        additionalEvents,
        client,
        command: input.command,
        ...(creatorOverride ? { creatorOverride } : {}),
        eventId: txIds.eventId,
        eventLedgerEntryId: txIds.eventLedgerEntryId,
        ids,
        input,
        policy: this.policy,
        resultingStateRevision: addDecimal(world.state_revision),
        ...(this.options.restrictedTallyExecutor
          ? { restrictedTallyExecutor: this.options.restrictedTallyExecutor }
          : {}),
        world,
      });
      outcome = { ...outcome, additionalEvents };
      await client.query('release savepoint governance_command_body');
    } catch (error) {
      if (!(error instanceof GovernanceCommandError) || !error.safeFailure) throw error;
      await client.query('rollback to savepoint governance_command_body');
      await client.query('release savepoint governance_command_body');
      if (isRetryableInternalPrecondition(input, error)) {
        throw new GovernanceCommandError(error.code, error.message, false);
      }
      return {
        commit: true,
        execution: await finalizeRejection(
          client,
          input,
          world,
          allocation,
          txIds.acceptedLedgerEntryId,
          error,
          txIds.creatorOverrideId,
        ),
      };
    }

    const execution = await finalizeAcceptance(
      client,
      ids,
      input,
      world,
      allocation,
      txIds,
      outcome,
    );
    return {
      commit: true,
      execution: outcome.responseDetails
        ? {
            ...execution,
            details: sanitizeGovernanceContext(outcome.responseDetails),
          }
        : execution,
    };
  }
}

export async function executePostgresGovernanceCommand(
  pool: GovernanceSqlPool,
  input: GovernanceCommandExecutionInput,
  options: PostgresGovernanceCommandOptions,
): Promise<GovernanceCommandExecutionResult> {
  return new PostgresGovernanceCommandExecutor(pool, options).execute(input);
}

async function consumeRecentCredential(
  client: GovernanceSqlExecutor,
  input: GovernanceCommandExecutionInput,
): Promise<void> {
  if (!requiresRecentCredential(input)) return;
  const proof = input.recentCredential;
  if (!proof) throw new RecentCredentialProofError();
  const result = await client.query<{ authorized: boolean }>(
    `/* governance:recent-credential:consume */
     select public.worldgraph_consume_recent_credential_proof_v1(
       $1,$2,$3,$4,$5,$6,$7,$8
     ) as authorized`,
    [
      proof.proofHash,
      proof.sessionId,
      proof.userId,
      input.worldId,
      input.command.commandId,
      input.command.type,
      proof.commandRequestHash,
      input.correlationId,
    ],
  );
  if (result.rows[0]?.authorized !== true) throw new RecentCredentialProofError();
}

async function verifyRecentCredentialReplay(
  client: GovernanceSqlExecutor,
  input: GovernanceCommandExecutionInput,
): Promise<void> {
  if (!requiresRecentCredential(input)) return;
  const proof = input.recentCredential;
  if (!proof) throw new RecentCredentialProofError();
  const result = await client.query<{ authorized: boolean }>(
    `/* governance:recent-credential:verify-replay */
     select public.worldgraph_verify_recent_credential_replay_v1(
       $1,$2,$3,$4,$5,$6,$7,$8
     ) as authorized`,
    [
      proof.proofHash,
      proof.sessionId,
      proof.userId,
      input.worldId,
      input.command.commandId,
      input.command.type,
      proof.commandRequestHash,
      input.correlationId,
    ],
  );
  if (result.rows[0]?.authorized !== true) throw new RecentCredentialProofError();
}

async function replayStoredCommand(
  client: GovernanceSqlExecutor,
  input: GovernanceCommandExecutionInput,
  requestHash: Buffer,
): Promise<GovernanceCommandExecutionResult | null> {
  const byId = await client.query<StoredCommandRow>(
    `/* governance:command:replay-id */
     select id,world_id,command_type,actor_type,actor_id,idempotency_key,
       request_hash,status,response_summary
      from command_records where id=$1 for update`,
    [input.command.commandId],
  );
  if (byId.rows[0]) return replayStored(client, byId.rows[0], input, requestHash);
  const byKey = await client.query<StoredCommandRow>(
    `/* governance:command:replay-key */
     select id,world_id,command_type,actor_type,actor_id,idempotency_key,
       request_hash,status,response_summary
      from command_records
     where world_id=$1 and actor_type=$2 and actor_id=$3
       and command_type=$4 and idempotency_key=$5 for update`,
    [
      input.worldId,
      input.actor.actorType,
      input.actor.actorId,
      input.command.type,
      input.command.idempotencyKey,
    ],
  );
  return byKey.rows[0] ? replayStored(client, byKey.rows[0], input, requestHash) : null;
}

async function replayStored(
  client: GovernanceSqlExecutor,
  stored: StoredCommandRow,
  input: GovernanceCommandExecutionInput,
  requestHash: Buffer,
): Promise<GovernanceCommandExecutionResult> {
  const identityMatches =
    stored.world_id === input.worldId &&
    stored.command_type === input.command.type &&
    stored.actor_type === input.actor.actorType &&
    stored.actor_id === input.actor.actorId &&
    stored.idempotency_key === input.command.idempotencyKey &&
    buffersEqual(stored.request_hash, requestHash);
  if (identityMatches && isWorldCommandResult(stored.response_summary)) {
    return { replayed: true, result: stored.response_summary };
  }
  const runtime = await client.query<{ state_revision: string }>(
    `/* governance:command:replay-conflict-revision */
     select state_revision::text from world_runtime_heads where world_id=$1`,
    [input.worldId],
  );
  return {
    replayed: true,
    result: {
      commandId: input.command.commandId,
      currentStateRevision: runtime.rows[0]?.state_revision ?? '0',
      eventIds: [],
      rejectionCode: 'IDEMPOTENCY_KEY_REUSED',
      schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      status: 'rejected',
    },
  };
}

async function insertReceived(
  client: GovernanceSqlExecutor,
  input: GovernanceCommandExecutionInput,
  payloadHash: Buffer,
  requestHash: Buffer,
): Promise<void> {
  const storedPayload = governanceCommandStoredPayloadV1(input);
  await client.query(
    `/* governance:command:insert-received */
     insert into command_records(
       id,world_id,command_type,command_schema_version,actor_type,actor_id,
       payload,payload_hash,payload_classification,idempotency_key,request_hash,
       rate_limit_scope_hash,expected_world_version,expected_state_revision,
       expected_aggregate_version,expected_tick,correlation_id,causation_id,requested_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,'member',$9,$10,$11,$12::bigint,
       $13::bigint,$14::bigint,$15::bigint,$16,$17,
       date_trunc('milliseconds',transaction_timestamp()))`,
    [
      input.command.commandId,
      input.worldId,
      input.command.type,
      GOVERNANCE_SCHEMA_VERSION,
      input.actor.actorType,
      input.actor.actorId,
      safeJson(storedPayload),
      payloadHash,
      input.command.idempotencyKey,
      requestHash,
      rateLimitScopeHash(input),
      input.command.expectedWorldVersion,
      input.command.expectedStateRevision,
      input.command.expectedAggregateVersion,
      input.command.expectedTick,
      input.correlationId,
      input.causationId,
    ],
  );
}

async function insertCreatorOverrideProvenance(
  client: GovernanceSqlExecutor,
  ids: ReplayableIds,
  input: GovernanceCommandExecutionInput,
): Promise<GovernanceCreatorOverrideProvenance | null> {
  if (input.command.type !== 'ExecuteCreatorOverrideV1' || !input.authorization.allowed)
    return null;
  const payload = input.command.payload;
  const target = creatorOverrideTarget(input);
  const auditRecordId = ids.next();
  const creatorOverrideId = ids.next();
  const action = creatorOverrideAction(input);
  const effectHash = sha256Buffer(payload.effect).toString('hex');
  await client.query(
    `/* governance:override:insert-audit */
     insert into security_audit_records(
       id,actor_user_id,world_id,category,action,outcome,reason_code,
       target_type,target_id,request_id,correlation_id,redacted_metadata,occurred_at
     ) values ($1,$2,$3,'creator_override',$4,'allowed',
       'EXPLICIT_GOVERNANCE_OVERRIDE',$5,$6,$7,$8,$9,
       date_trunc('milliseconds',transaction_timestamp()))`,
    [
      auditRecordId,
      input.actor.actorId,
      input.worldId,
      action,
      target.targetType,
      target.targetId,
      input.command.commandId,
      input.correlationId,
      safeJson({
        actorMode: input.command.actorMode,
        actorType: input.actor.actorType,
        authorizationRuleId: input.authorization.ruleId,
        commandType: input.command.type,
        effect: payload.effect,
        effectHash,
        impactHash: sha256Buffer(payload.impact).toString('hex'),
      }),
    ],
  );
  await client.query(
    `/* governance:override:insert-provenance */
     insert into creator_override_records(
       id,world_id,actor_user_id,action,target_type,target_id,reason,
       authority_rule_id,command_id,audit_record_id,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       date_trunc('milliseconds',transaction_timestamp()))`,
    [
      creatorOverrideId,
      input.worldId,
      input.actor.actorId,
      action,
      target.targetType,
      target.targetId,
      payload.reason,
      input.authorization.ruleId,
      input.command.commandId,
      auditRecordId,
    ],
  );
  return {
    action,
    auditRecordId,
    creatorOverrideId,
    effectHash,
    targetId: target.targetId,
    targetType: target.targetType,
  };
}

function creatorOverrideAction(input: GovernanceCommandExecutionInput): string {
  if (input.command.type !== 'ExecuteCreatorOverrideV1') {
    throw new Error('GOVERNANCE_OVERRIDE_COMMAND_REQUIRED');
  }
  const effect = input.command.payload.effect;
  return effect.effectType === 'execute_proposal_action'
    ? `governance.override.${effect.proposalAction.actionType}`
    : `governance.override.${effect.effectType}`;
}

function creatorOverrideTarget(input: GovernanceCommandExecutionInput): {
  targetId: string;
  targetType: string;
} {
  if (input.command.type !== 'ExecuteCreatorOverrideV1') {
    throw new Error('GOVERNANCE_OVERRIDE_COMMAND_REQUIRED');
  }
  const effect = input.command.payload.effect;
  if (effect.effectType === 'appoint_officeholder') {
    return { targetId: effect.appointment.officeId, targetType: 'office' };
  }
  if (effect.effectType === 'remove_officeholder') {
    return { targetId: effect.removal.termId, targetType: 'office_term' };
  }
  const action = effect.proposalAction;
  switch (action.actionType) {
    case 'amend_law':
    case 'repeal_law':
      return { targetId: action.lawId, targetType: 'law' };
    case 'create_law':
      return { targetId: input.worldId, targetType: 'world_governance' };
  }
}

async function loadWorldContext(
  client: GovernanceSqlExecutor,
  worldId: string,
): Promise<WorldTransactionContext | null> {
  const result = await client.query<WorldTransactionContext>(
    `/* governance:command:load-world */
     select runtime.active_world_version_id,runtime.state_revision::text,
       runtime.anchor_artifact_hash,world.lifecycle::text,
       version.version_number::text as design_version,clock.current_tick::text,
       governance.row_version::text as governance_row_version,
       governance.checksum as governance_checksum,
       governance.seed_plan_hash as governance_seed_plan_hash,
       ledger.next_event_sequence::text,ledger.next_ledger_sequence::text,
       ledger.last_entry_hash,date_trunc('milliseconds',transaction_timestamp()) as recorded_at
      from worlds world
      join world_runtime_heads runtime on runtime.world_id=world.id
      join world_versions version on version.world_id=runtime.world_id
        and version.id=runtime.active_world_version_id
      join world_ledger_heads ledger on ledger.world_id=world.id
      join world_simulation_clocks clock on clock.world_id=world.id
     left join world_governance_heads governance on governance.world_id=world.id
     where world.id=$1 and world.archived_at is null
     for update of runtime,clock`,
    [worldId],
  );
  return result.rows[0] ?? null;
}

async function loadAllocation(
  client: GovernanceSqlExecutor,
  worldId: string,
): Promise<AllocationRow> {
  const result = await client.query<AllocationRow>(
    `/* governance:command:allocation */
     select next_event_sequence::text,next_ledger_sequence::text,last_entry_hash
      from world_ledger_heads where world_id=$1`,
    [worldId],
  );
  const allocation = result.rows[0];
  if (!allocation) throw new Error('GOVERNANCE_LEDGER_HEAD_MISSING');
  return allocation;
}

function validateAgainstWorld(
  input: GovernanceCommandExecutionInput,
  world: WorldTransactionContext,
): GovernanceCommandError | null {
  if (world.lifecycle !== 'active') {
    return new GovernanceCommandError('WORLD_NOT_ACTIVE', 'The world is not active.');
  }
  if (!world.anchor_artifact_hash) {
    return new GovernanceCommandError('WORLD_NOT_ANCHORED', 'The world ledger is not anchored.');
  }
  if (world.design_version !== input.command.expectedWorldVersion) {
    return new GovernanceCommandError(
      'WORLD_VERSION_CONFLICT',
      'The active world version changed.',
    );
  }
  if (world.state_revision !== input.command.expectedStateRevision) {
    return new GovernanceCommandError('REVISION_CONFLICT', 'The world state revision changed.');
  }
  if (world.current_tick !== input.command.expectedTick) {
    return new GovernanceCommandError('EXPECTED_TICK_MISMATCH', 'The simulation tick changed.');
  }
  if (!governanceActorModeIsCompatible(input.command.actorMode, input.actor)) {
    return new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Actor mode does not match the command.',
    );
  }
  if (isInternalGovernanceCommandType(input.command.type)) {
    if (input.actor.actorType !== 'system' || !input.scheduler) {
      return new GovernanceCommandError(
        'AUTHORIZATION_DENIED',
        'Internal governance commands are scheduler-only.',
      );
    }
    if (BigInt(input.scheduler.dueTick) > BigInt(world.current_tick)) {
      return new GovernanceCommandError(
        'TALLY_NOT_DUE',
        'Scheduled governance command is not due.',
      );
    }
  } else if (input.scheduler) {
    return new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Public governance commands cannot impersonate the scheduler.',
    );
  }
  return null;
}

async function validateScheduledInvocation(
  client: GovernanceSqlExecutor,
  input: GovernanceCommandExecutionInput,
  world: WorldTransactionContext,
): Promise<GovernanceCommandError | null> {
  if (!isInternalGovernanceCommandType(input.command.type)) return null;
  const scheduler = input.scheduler;
  if (!scheduler) {
    return new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Scheduled command provenance is missing.',
    );
  }
  const result = await client.query<ScheduledActionRow>(
    `/* governance:schedule:validate-completed */
     select action_type,due_tick::text,status,completed_event_id::text,
       completed_state_revision::text,payload
      from scheduled_actions
     where world_id=$1 and id=$2
     for update`,
    [input.worldId, scheduler.scheduledActionId],
  );
  const row = result.rows[0];
  const identity = scheduledIdentity(input);
  const targetKey = identity.targetKind === 'proposal' ? 'proposalId' : 'electionId';
  const exactPayload =
    isRecord(row?.payload) &&
    Object.keys(row.payload).length === 1 &&
    row.payload[targetKey] === identity.targetId;
  if (
    !row ||
    row.action_type !== input.command.type ||
    row.due_tick !== scheduler.dueTick ||
    row.status !== 'completed' ||
    row.completed_event_id !== scheduler.completedEventId ||
    row.completed_state_revision === null ||
    !exactPayload
  ) {
    return new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Scheduled command completion evidence is invalid.',
    );
  }
  if (BigInt(row.due_tick) > BigInt(world.current_tick)) {
    return new GovernanceCommandError('TALLY_NOT_DUE', 'Scheduled governance command is not due.');
  }
  return null;
}

function isRetryableInternalPrecondition(
  input: GovernanceCommandExecutionInput,
  error: GovernanceCommandError,
): boolean {
  return (
    isInternalGovernanceCommandType(input.command.type) &&
    [
      'AGGREGATE_VERSION_CONFLICT',
      'EXPECTED_TICK_MISMATCH',
      'REVISION_CONFLICT',
      'WORLD_VERSION_CONFLICT',
    ].includes(error.code)
  );
}

async function insertAuthorityDecision(
  client: GovernanceSqlExecutor,
  ids: ReplayableIds,
  input: GovernanceCommandExecutionInput,
  world: WorldTransactionContext,
  decisionId: string,
): Promise<void> {
  const safeContext = sanitizeGovernanceContext(input.authorization.context);
  const inputChecksum = sha256Buffer({
    actionCode: input.authorization.actionCode,
    actor: input.actor,
    context: safeContext,
    resourceId: input.authorization.resourceId,
    resourceType: input.authorization.resourceType,
    tick: world.current_tick,
  });
  const decisionChecksum = sha256Buffer({
    allowed: input.authorization.allowed,
    inputChecksum: inputChecksum.toString('hex'),
    reasonCode: input.authorization.reasonCode,
    ruleId: input.authorization.ruleId,
    sources: input.authorization.sources ?? [],
  });
  await client.query(
    `/* governance:authority:decision */
     insert into governance_authority_decisions(
       id,world_id,command_id,actor_mode,actor_type,actor_id,actor_entity_id,
       action_code,resource_type,resource_id,evaluated_tick,decision,reason_code,
       policy_dsl_version,input_context,input_checksum,decision_checksum
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12,$13,1,$14,$15,$16)`,
    [
      decisionId,
      input.worldId,
      input.command.commandId,
      input.command.actorMode,
      input.actor.actorType,
      input.actor.actorId,
      input.actor.actorEntityId,
      input.authorization.actionCode,
      input.authorization.resourceType,
      input.authorization.resourceId,
      world.current_tick,
      input.authorization.allowed ? 'allow' : 'deny',
      input.authorization.reasonCode,
      safeJson(safeContext),
      inputChecksum,
      decisionChecksum,
    ],
  );
  for (const [ordinal, source] of (input.authorization.sources ?? []).entries()) {
    await client.query(
      `/* governance:authority:source */
       insert into governance_authority_decision_sources(
         id,world_id,decision_id,source_ordinal,source_kind,source_id,source_version,
         source_effective_ticks,source_checksum,contribution
       ) values ($1,$2,$3,$4,$5,$6,$7::bigint,
         case when $8::bigint is null then null else int8range($8::bigint,$9::bigint,'[)') end,
         $10,$11)`,
      [
        ids.next(),
        input.worldId,
        decisionId,
        ordinal,
        source.sourceKind,
        source.sourceId,
        source.sourceVersion,
        source.effectiveFromTick ?? null,
        source.effectiveUntilTick ?? null,
        Buffer.from(source.sourceChecksum, 'hex'),
        source.contribution,
      ],
    );
  }
}

async function finalizeAcceptance(
  client: GovernanceSqlExecutor,
  ids: ReplayableIds,
  input: GovernanceCommandExecutionInput,
  world: WorldTransactionContext,
  allocation: AllocationRow,
  txIds: TransactionIds,
  outcome: GovernanceHandlerOutcome,
): Promise<GovernanceCommandExecutionResult> {
  const resultingStateRevision = addDecimal(world.state_revision);
  const plannedEvents = [outcome.event, ...(outcome.additionalEvents ?? [])];
  if (
    plannedEvents.length < 1 ||
    plannedEvents.length > 64 ||
    new Set(plannedEvents.map((event) => event.eventId)).size !== plannedEvents.length ||
    new Set(plannedEvents.map((event) => event.ledgerEntryId)).size !== plannedEvents.length
  ) {
    throw new Error('GOVERNANCE_EVENT_PLAN_INVALID');
  }
  const lastEventSequence = addDecimal(allocation.next_event_sequence, plannedEvents.length - 1);
  const lastLedgerSequence = addDecimal(allocation.next_ledger_sequence, plannedEvents.length);
  const persisted: PersistedEvent[] = [];
  for (const [ordinal, plannedEvent] of plannedEvents.entries()) {
    persisted.push(
      await appendDomainEvent(
        client,
        input,
        world,
        addDecimal(allocation.next_event_sequence, ordinal),
        resultingStateRevision,
        plannedEvent,
        ordinal,
        txIds.creatorOverrideId,
      ),
    );
  }
  const accepted = ledgerEntry(txIds.acceptedLedgerEntryId, {
    actor: ledgerActor(input),
    commandId: input.command.commandId,
    entryKind: 'command_accepted',
    eventId: null,
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    ledgerSequence: allocation.next_ledger_sequence,
    previousHash: allocation.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
    publicSummaryCode: 'COMMAND_ACCEPTED',
    recordedAt: world.recorded_at.toISOString(),
    redactedDetails: {
      authorizationRuleId: input.authorization.ruleId,
      commandType: input.command.type,
    },
    worldId: input.worldId,
  });
  await insertLedgerEntry(client, accepted);
  let previousEntryHash = accepted.entryHash;
  for (const [index, plannedEvent] of plannedEvents.entries()) {
    const fact = ledgerEntry(plannedEvent.ledgerEntryId, {
      actor: ledgerActor(input),
      commandId: input.command.commandId,
      entryKind: plannedEvent.ledgerKind ?? 'domain_event',
      eventId: plannedEvent.eventId,
      ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
      ledgerSequence: addDecimal(allocation.next_ledger_sequence, index + 1),
      previousHash: previousEntryHash,
      publicSummaryCode: plannedEvent.summaryCode,
      recordedAt: world.recorded_at.toISOString(),
      redactedDetails: {
        aggregateType: plannedEvent.aggregateType,
        eventType: plannedEvent.eventType,
        targetHash: sha256Text(plannedEvent.aggregateId),
      },
      worldId: input.worldId,
    });
    await insertLedgerEntry(client, fact);
    await insertHistory(
      client,
      input,
      world,
      fact.ledgerSequence,
      resultingStateRevision,
      plannedEvent,
    );
    await insertOutbox(client, ids, input, world, persisted[index]!);
    previousEntryHash = fact.entryHash;
  }
  if (input.scheduler) {
    await finalizeScheduledOccurrence(
      client,
      ids,
      input,
      resultingStateRevision,
      outcome.event.eventId,
    );
  }
  const governanceChecksum = governanceProjectionChecksumV1({
    eventHashes: persisted.map((item) => item.eventHash),
    previousChecksum: world.governance_checksum?.toString('hex') ?? null,
    resultingStateRevision,
    worldId: input.worldId,
  });
  const head = await client.query(
    `/* governance:command:update-head */
     update world_governance_heads set
       checksum=$2,
       row_version=case when initialized_command_id=$3 then row_version else row_version+1 end,
       updated_state_revision=$4::bigint,updated_at=$5
      where world_id=$1
      returning row_version::text`,
    [
      input.worldId,
      governanceChecksum,
      input.command.commandId,
      resultingStateRevision,
      world.recorded_at,
    ],
  );
  if ((head.rowCount ?? 0) !== 1) throw new Error('GOVERNANCE_HEAD_UPDATE_FAILED');
  const graphChecksumResult = await client.query<{ checksum: Buffer }>(
    `/* governance:command:graph-checksum */
     select worldgraph_projection_checksum($1,$2::bigint) as checksum`,
    [input.worldId, resultingStateRevision],
  );
  const graphChecksum = graphChecksumResult.rows[0]?.checksum;
  if (!graphChecksum) throw new Error('GOVERNANCE_GRAPH_CHECKSUM_FAILED');
  await client.query(
    `/* governance:command:checkpoints */
     insert into projection_checkpoints(
       world_id,projection_name,projection_schema_version,last_event_sequence,
       checksum,status,updated_at
     ) values
       ($1,'world_graph',$2,$3::bigint,$4,'current',$6),
       ($1,'governance_runtime',$2,$3::bigint,$5,'current',$6)
     on conflict (world_id,projection_name) do update set
       projection_schema_version=excluded.projection_schema_version,
       last_event_sequence=excluded.last_event_sequence,checksum=excluded.checksum,
       status='current',updated_at=greatest(projection_checkpoints.updated_at,excluded.updated_at)`,
    [
      input.worldId,
      PROJECTION_SCHEMA_VERSION,
      lastEventSequence,
      graphChecksum,
      governanceChecksum,
      world.recorded_at,
    ],
  );
  const updatedRuntime = await client.query(
    `/* governance:command:update-runtime */
     update world_runtime_heads set
       state_revision=$3::bigint,last_ledger_sequence=$4::bigint,
       last_event_sequence=$5::bigint,projection_checksum=$6,updated_at=$7
      where world_id=$1 and state_revision=$2::bigint`,
    [
      input.worldId,
      world.state_revision,
      resultingStateRevision,
      lastLedgerSequence,
      lastEventSequence,
      graphChecksum,
      world.recorded_at,
    ],
  );
  if ((updatedRuntime.rowCount ?? 0) !== 1) throw new Error('GOVERNANCE_RUNTIME_UPDATE_FAILED');
  const result: Extract<WorldCommandResultV1, { status: 'accepted' }> = {
    commandId: input.command.commandId,
    eventIds: plannedEvents.map((event) => event.eventId),
    eventSequenceRange: {
      from: allocation.next_event_sequence,
      to: lastEventSequence,
    },
    ledgerSequenceRange: {
      from: allocation.next_ledger_sequence,
      to: lastLedgerSequence,
    },
    resultingStateRevision,
    schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    status: 'accepted',
  };
  const terminal = await client.query(
    `/* governance:command:accept */
     update command_records set status='accepted',authorization_rule_id=$2,
       decided_at=$3,resulting_state_revision=$4::bigint,response_summary=$5,
       override_id=$6
      where id=$1 and world_id=$7 and status='received'`,
    [
      input.command.commandId,
      input.authorization.ruleId,
      world.recorded_at,
      resultingStateRevision,
      safeJson(result),
      txIds.creatorOverrideId,
      input.worldId,
    ],
  );
  if ((terminal.rowCount ?? 0) !== 1) throw new Error('GOVERNANCE_COMMAND_ACCEPT_FAILED');
  await client.query('select worldgraph_assert_command_terminal($1)', [input.command.commandId]);
  return { replayed: false, result };
}

async function finalizeRejection(
  client: GovernanceSqlExecutor,
  input: GovernanceCommandExecutionInput,
  world: WorldTransactionContext,
  allocation: AllocationRow,
  ledgerEntryId: string,
  rejection: GovernanceCommandError,
  creatorOverrideId: string | null,
): Promise<GovernanceCommandExecutionResult> {
  const result: Extract<WorldCommandResultV1, { status: 'rejected' }> = {
    commandId: input.command.commandId,
    currentStateRevision: world.state_revision,
    eventIds: [],
    rejectionCode: rejection.code,
    schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
    status: 'rejected',
  };
  const entry = ledgerEntry(ledgerEntryId, {
    actor: ledgerActor(input),
    commandId: input.command.commandId,
    entryKind: 'command_rejected',
    eventId: null,
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    ledgerSequence: allocation.next_ledger_sequence,
    previousHash: allocation.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
    publicSummaryCode: rejection.code,
    recordedAt: world.recorded_at.toISOString(),
    redactedDetails: {
      authorizationRuleId: input.authorization.ruleId,
      commandType: input.command.type,
      rejectionCode: rejection.code,
    },
    worldId: input.worldId,
  });
  await insertLedgerEntry(client, entry);
  const runtime = await client.query(
    `/* governance:command:reject-runtime */
     update world_runtime_heads set last_ledger_sequence=$3::bigint,updated_at=$4
      where world_id=$1 and state_revision=$2::bigint`,
    [input.worldId, world.state_revision, allocation.next_ledger_sequence, world.recorded_at],
  );
  if ((runtime.rowCount ?? 0) !== 1) throw new Error('GOVERNANCE_REJECTION_RUNTIME_FAILED');
  const terminal = await client.query(
    `/* governance:command:reject */
     update command_records set status='rejected',rejection_code=$2,
       authorization_rule_id=$3,decided_at=$4,resulting_state_revision=null,
       response_summary=$5,override_id=$6
      where id=$1 and world_id=$7 and status='received'`,
    [
      input.command.commandId,
      rejection.code,
      input.authorization.ruleId,
      world.recorded_at,
      safeJson(result),
      creatorOverrideId,
      input.worldId,
    ],
  );
  if ((terminal.rowCount ?? 0) !== 1) throw new Error('GOVERNANCE_COMMAND_REJECT_FAILED');
  await client.query('select worldgraph_assert_command_terminal($1)', [input.command.commandId]);
  return { replayed: false, result };
}

async function appendDomainEvent(
  client: GovernanceSqlExecutor,
  input: GovernanceCommandExecutionInput,
  world: WorldTransactionContext,
  eventSequence: string,
  resultingStateRevision: string,
  plannedEvent: GovernancePlannedEvent,
  eventOrdinal: number,
  creatorOverrideId: string | null,
): Promise<PersistedEvent> {
  const metadata: DomainEventMetadataV1 = {
    actor: ledgerActor(input),
    authorizationRuleId: input.authorization.ruleId,
    causationId: input.causationId,
    commandSchemaVersion: GOVERNANCE_SCHEMA_VERSION,
    commandType: input.command.type,
    correlationId: input.correlationId,
    overrideId: creatorOverrideId,
    payloadClassification: 'member',
  };
  const timestamp = world.recorded_at.toISOString();
  const event = {
    aggregateId: plannedEvent.aggregateId,
    aggregateType: plannedEvent.aggregateType,
    aggregateVersion: plannedEvent.aggregateVersion,
    commandId: input.command.commandId,
    eventId: plannedEvent.eventId,
    eventOrdinal,
    eventSchemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
    eventType: plannedEvent.eventType,
    metadata,
    occurredAt: timestamp,
    payload: plannedEvent.payload,
    recordedAt: timestamp,
    resultingStateRevision,
    worldEventSequence: eventSequence,
    worldId: input.worldId,
  } as unknown as DomainEventHashInputV1;
  const eventHash = computeDomainEventHashV1(event);
  await client.query(
    `/* governance:event:append */
     insert into domain_events(
       id,world_id,world_event_sequence,command_id,event_ordinal,aggregate_type,
       aggregate_id,aggregate_version,event_type,event_schema_version,payload,
       metadata,event_hash,occurred_at,recorded_at,resulting_state_revision
     ) values ($1,$2,$3::bigint,$4,$5,$6,$7,$8::bigint,$9,$10,$11,$12,$13,$14,$14,$15::bigint)`,
    [
      event.eventId,
      event.worldId,
      event.worldEventSequence,
      event.commandId,
      event.eventOrdinal,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.eventType,
      event.eventSchemaVersion,
      safeJson(event.payload),
      safeJson(event.metadata),
      Buffer.from(eventHash, 'hex'),
      world.recorded_at,
      event.resultingStateRevision,
    ],
  );
  return { event, eventHash };
}

function ledgerEntry(
  entryId: string,
  input: Omit<LedgerEntryHashInputV1, 'entryId'>,
): LedgerEntryV1 {
  const material: LedgerEntryHashInputV1 = { ...input, entryId };
  return { ...material, entryHash: computeLedgerEntryHashV1(material) } as LedgerEntryV1;
}

async function insertLedgerEntry(
  client: GovernanceSqlExecutor,
  entry: LedgerEntryV1,
): Promise<void> {
  await client.query(
    `/* governance:ledger:append */
     insert into ledger_entries(
       id,world_id,ledger_sequence,entry_kind,command_id,event_id,actor_type,
       actor_id,public_summary_code,redacted_details,previous_hash,entry_hash,recorded_at
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
      safeJson(entry.redactedDetails),
      Buffer.from(entry.previousHash, 'hex'),
      Buffer.from(entry.entryHash, 'hex'),
      new Date(entry.recordedAt),
    ],
  );
}

async function insertHistory(
  client: GovernanceSqlExecutor,
  input: GovernanceCommandExecutionInput,
  world: WorldTransactionContext,
  ledgerSequence: string,
  resultingStateRevision: string,
  plannedEvent: GovernancePlannedEvent,
): Promise<void> {
  await client.query(
    `/* governance:history:append */
     insert into world_history_entries(
       world_id,ledger_sequence,command_id,event_id,event_type,history_schema_version,
       occurred_at,category,title_key,summary_args,actor_type,actor_id,target_type,
       target_id,visibility,correlation_id,resulting_state_revision
     ) values ($1,$2::bigint,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::bigint)`,
    [
      input.worldId,
      ledgerSequence,
      input.command.commandId,
      plannedEvent.eventId,
      plannedEvent.eventType,
      world.recorded_at,
      plannedEvent.history.category,
      plannedEvent.history.titleKey,
      safeJson(sanitizeGovernanceContext(plannedEvent.history.summaryArgs)),
      input.actor.actorType,
      input.actor.actorId,
      plannedEvent.history.targetType,
      plannedEvent.history.targetId,
      plannedEvent.history.visibility,
      input.correlationId,
      resultingStateRevision,
    ],
  );
}

async function insertOutbox(
  client: GovernanceSqlExecutor,
  ids: ReplayableIds,
  input: GovernanceCommandExecutionInput,
  world: WorldTransactionContext,
  persisted: PersistedEvent,
): Promise<void> {
  await client.query(
    `/* governance:outbox:append */
     insert into outbox_messages(
       id,world_id,event_id,message_type,message_schema_version,payload,status,
       attempts,available_at,created_at
     ) values ($1,$2,$3,'DomainEventReferenceV1',$4,$5,'pending',0,$6,$6)`,
    [
      ids.next(),
      input.worldId,
      persisted.event.eventId,
      OUTBOX_SCHEMA_VERSION,
      safeJson({
        eventId: persisted.event.eventId,
        eventType: persisted.event.eventType,
        worldEventSequence: persisted.event.worldEventSequence,
        worldId: input.worldId,
      }),
      world.recorded_at,
    ],
  );
}

async function finalizeScheduledOccurrence(
  client: GovernanceSqlExecutor,
  ids: ReplayableIds,
  input: GovernanceCommandExecutionInput,
  resultingStateRevision: string,
  eventId: string,
): Promise<void> {
  const scheduler = input.scheduler!;
  const identity = scheduledIdentity(input);
  await client.query(
    `/* governance:schedule:occurrence */
     insert into governance_schedule_occurrences(
       id,world_id,scheduled_action_id,occurrence_key,target_kind,target_id,
       transition_kind,due_tick,command_id,event_id,state_revision
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9,$10,$11::bigint)`,
    [
      ids.next(),
      input.worldId,
      scheduler.scheduledActionId,
      scheduler.occurrenceKey,
      identity.targetKind,
      identity.targetId,
      identity.transitionKind,
      scheduler.dueTick,
      input.command.commandId,
      eventId,
      resultingStateRevision,
    ],
  );
}

function scheduledIdentity(input: GovernanceCommandExecutionInput): {
  targetId: string;
  targetKind: 'election' | 'proposal';
  transitionKind: 'certify' | 'close_tally' | 'open';
} {
  switch (input.command.type) {
    case 'OpenProposalVotingV1':
      return {
        targetId: input.command.payload.proposalId,
        targetKind: 'proposal',
        transitionKind: 'open',
      };
    case 'CloseAndTallyProposalV1':
      return {
        targetId: input.command.payload.proposalId,
        targetKind: 'proposal',
        transitionKind: 'close_tally',
      };
    case 'CertifyAndEnactProposalV1':
      return {
        targetId: input.command.payload.proposalId,
        targetKind: 'proposal',
        transitionKind: 'certify',
      };
    case 'OpenElectionV1':
      return {
        targetId: input.command.payload.electionId,
        targetKind: 'election',
        transitionKind: 'open',
      };
    case 'CloseAndTallyElectionV1':
      return {
        targetId: input.command.payload.electionId,
        targetKind: 'election',
        transitionKind: 'close_tally',
      };
    case 'CertifyElectionV1':
      return {
        targetId: input.command.payload.electionId,
        targetKind: 'election',
        transitionKind: 'certify',
      };
    default:
      throw new Error('GOVERNANCE_SCHEDULE_COMMAND_INVALID');
  }
}

function ledgerActor(input: GovernanceCommandExecutionInput): LedgerActorV1 {
  return {
    actorId: input.actor.actorId,
    actorType: input.actor.actorType,
  };
}

interface GovernanceVelocityScope {
  commandTypes: readonly string[];
  family: 'contest' | 'nomination' | 'sponsor' | 'vote';
  interval: '1 hour' | '1 minute';
}

function governanceVelocityScope(
  input: GovernanceCommandExecutionInput,
): GovernanceVelocityScope | null {
  switch (input.command.type) {
    case 'CreateProposalV1':
      return { commandTypes: ['CreateProposalV1'], family: 'contest', interval: '1 hour' };
    case 'SponsorProposalV1':
      return { commandTypes: ['SponsorProposalV1'], family: 'sponsor', interval: '1 minute' };
    case 'CastElectionBallotV1':
    case 'CastProposalBallotV1':
      return {
        commandTypes: ['CastElectionBallotV1', 'CastProposalBallotV1'],
        family: 'vote',
        interval: '1 minute',
      };
    case 'AcceptNominationV1':
    case 'NominateCandidateV1':
      return {
        commandTypes: ['AcceptNominationV1', 'NominateCandidateV1'],
        family: 'nomination',
        interval: '1 minute',
      };
    default:
      return null;
  }
}

function rateLimitScopeHash(input: GovernanceCommandExecutionInput): Buffer | null {
  const scope = governanceVelocityScope(input);
  if (!scope) return null;
  return sha256Buffer({
    actorId: input.actor.actorId,
    domain: 'worldgraph.governance-rate-limit-scope.v1',
    family: scope.family,
    worldId: input.worldId,
  });
}

async function checkGovernanceVelocity(
  client: GovernanceSqlExecutor,
  input: GovernanceCommandExecutionInput,
  policy: GovernanceCommandPolicy,
): Promise<GovernanceCommandError | null> {
  const scope = governanceVelocityScope(input);
  const scopeHash = rateLimitScopeHash(input);
  if (!scope || !scopeHash) return null;
  const limit =
    scope.family === 'contest'
      ? policy.contestRateLimitPerHour
      : scope.family === 'sponsor'
        ? policy.sponsorRateLimitPerMinute
        : scope.family === 'vote'
          ? policy.voteRateLimitPerMinute
          : policy.nominationRateLimitPerMinute;
  const result = await client.query<{ command_count: number }>(
    `/* governance:command:velocity */
     select count(*)::integer as command_count
       from command_records
      where world_id=$1 and actor_type=$2 and actor_id=$3
        and rate_limit_scope_hash=$4
        and command_type=any($5::text[])
        and requested_at >= transaction_timestamp() - $6::interval`,
    [
      input.worldId,
      input.actor.actorType,
      input.actor.actorId,
      scopeHash,
      scope.commandTypes,
      scope.interval,
    ],
  );
  if ((result.rows[0]?.command_count ?? 0) > limit) {
    return new GovernanceCommandError(
      'GOVERNANCE_RATE_LIMITED',
      'Governance command velocity limit exceeded.',
    );
  }
  return null;
}

function assertConfiguration(attempts: number, policy: GovernanceCommandPolicy): void {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error('GOVERNANCE_COMMAND_CONFIGURATION_INVALID');
  }
  if (
    !Number.isInteger(policy.minimumTaxRateBps) ||
    !Number.isInteger(policy.maximumTaxRateBps) ||
    policy.minimumTaxRateBps < 0 ||
    policy.maximumTaxRateBps > 10_000 ||
    policy.minimumTaxRateBps > policy.maximumTaxRateBps
  ) {
    throw new Error('GOVERNANCE_COMMAND_POLICY_INVALID');
  }
  if (
    ![
      policy.contestRateLimitPerHour,
      policy.nominationRateLimitPerMinute,
      policy.sponsorRateLimitPerMinute,
      policy.voteRateLimitPerMinute,
    ].every((value) => Number.isInteger(value) && value >= 1 && value <= 1_000)
  ) {
    throw new Error('GOVERNANCE_COMMAND_POLICY_INVALID');
  }
}

function assertExecutionInput(input: GovernanceCommandExecutionInput): void {
  const command = input.command;
  if (
    !UUID.test(input.worldId) ||
    !UUID.test(command.commandId) ||
    !UUID.test(input.correlationId) ||
    (input.causationId !== null && !UUID.test(input.causationId)) ||
    !IDEMPOTENCY.test(command.idempotencyKey) ||
    command.schemaVersion !== GOVERNANCE_SCHEMA_VERSION ||
    !positiveInt64(command.expectedWorldVersion) ||
    !nonnegativeInt64(command.expectedStateRevision) ||
    !nonnegativeInt64(command.expectedAggregateVersion) ||
    !nonnegativeInt64(command.expectedTick) ||
    (!isPublicGovernanceCommandType(command.type) &&
      !isInternalGovernanceCommandType(command.type)) ||
    input.actor.actorId.length < 1 ||
    input.actor.actorId.length > 160 ||
    (input.actor.actorEntityId !== null && !UUID.test(input.actor.actorEntityId)) ||
    !/^[a-z][a-z0-9._-]{2,119}$/u.test(input.authorization.actionCode) ||
    !/^[a-z][a-z0-9._-]{0,79}$/u.test(input.authorization.resourceType) ||
    input.authorization.resourceId.length < 1 ||
    input.authorization.resourceId.length > 240 ||
    !/^[A-Z][A-Z0-9_]*$/u.test(input.authorization.reasonCode)
  ) {
    throw new GovernanceCommandError('VALIDATION_FAILED', 'Governance command input is invalid.');
  }
  if (
    command.actorMode === 'in_world' &&
    input.actor.actorEntityId === null &&
    input.authorization.allowed
  ) {
    throw new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'An in-world actor entity is required.',
    );
  }
  if (
    (command.type === 'ExecuteCreatorOverrideV1' || command.type === 'RepairGovernanceResultV1') &&
    (!['platform_admin', 'user'].includes(input.actor.actorType) || !UUID.test(input.actor.actorId))
  ) {
    throw new GovernanceCommandError(
      'AUTHORIZATION_DENIED',
      'Governance operator provenance is invalid.',
    );
  }
  if (requiresRecentCredential(input)) {
    const proof = input.recentCredential;
    if (
      !proof ||
      !UUID.test(proof.sessionId) ||
      proof.userId !== input.actor.actorId ||
      proof.proofHash.length !== 32 ||
      proof.commandRequestHash.length !== 32 ||
      !buffersEqual(
        proof.commandRequestHash,
        governanceRecentCredentialCommandHashV1(input.command),
      )
    ) {
      throw new RecentCredentialProofError();
    }
  }
  if (isInternalGovernanceCommandType(command.type)) {
    if (
      !input.scheduler ||
      !UUID.test(input.scheduler.scheduledActionId) ||
      !UUID.test(input.scheduler.completedEventId) ||
      !nonnegativeInt64(input.scheduler.dueTick) ||
      input.scheduler.occurrenceKey.length < 8 ||
      input.scheduler.occurrenceKey.length > 200 ||
      !/^[a-z0-9][a-z0-9:._-]*$/u.test(input.scheduler.occurrenceKey)
    ) {
      throw new GovernanceCommandError(
        'VALIDATION_FAILED',
        'Scheduled governance provenance is invalid.',
      );
    }
  }
  for (const source of input.authorization.sources ?? []) {
    if (
      !UUID.test(source.sourceId) ||
      !positiveInt64(source.sourceVersion) ||
      !HASH.test(source.sourceChecksum) ||
      (source.effectiveFromTick !== undefined && !nonnegativeInt64(source.effectiveFromTick)) ||
      (source.effectiveUntilTick !== undefined &&
        source.effectiveUntilTick !== null &&
        !nonnegativeInt64(source.effectiveUntilTick))
    ) {
      throw new GovernanceCommandError(
        'VALIDATION_FAILED',
        'Authority source evidence is invalid.',
      );
    }
  }
}

function isWorldCommandResult(value: unknown): value is WorldCommandResultV1 {
  if (!isRecord(value) || value.schemaVersion !== AUTHORITATIVE_COMMAND_SCHEMA_VERSION)
    return false;
  if (typeof value.commandId !== 'string' || !UUID.test(value.commandId)) return false;
  if (!Array.isArray(value.eventIds)) return false;
  return ['accepted', 'failed', 'received', 'rejected'].includes(String(value.status));
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function isBallotCommand(input: GovernanceCommandExecutionInput): boolean {
  return (
    input.command.type === 'CastProposalBallotV1' || input.command.type === 'CastElectionBallotV1'
  );
}

function requiresRecentCredential(input: GovernanceCommandExecutionInput): boolean {
  return (
    input.command.type === 'ExecuteCreatorOverrideV1' ||
    input.command.type === 'RepairGovernanceResultV1'
  );
}

function commandSecretHashKey(
  input: GovernanceCommandExecutionInput,
  secretHashKey: string | undefined,
): string | undefined {
  if (!isBallotCommand(input)) return undefined;
  if (!secretHashKey || secretHashKey.length < 32) {
    throw new Error('GOVERNANCE_COMMAND_SECRET_HASH_KEY_REQUIRED');
  }
  return secretHashKey;
}

function hmacSha256Buffer(secretHashKey: string, value: unknown): Buffer {
  return createHmac('sha256', secretHashKey).update(canonicalJson(value), 'utf8').digest();
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nonnegativeInt64(value: string): boolean {
  return NONNEGATIVE.test(value) && BigInt(value) <= INT64_MAX;
}

function positiveInt64(value: string): boolean {
  return POSITIVE.test(value) && BigInt(value) <= INT64_MAX;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fatalConnectionError(error: unknown): Error | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined;
  return error.code.startsWith('08')
    ? error instanceof Error
      ? error
      : new Error('PostgreSQL connection failed.')
    : undefined;
}

async function defaultRetryDelay(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, 5 * 2 ** attempt)));
}

class ReplayableIds {
  private readonly values: string[] = [];
  private offset = 0;

  public constructor(private readonly source: { next(): string }) {}

  public next(): string {
    const existing = this.values[this.offset];
    if (existing) {
      this.offset += 1;
      return existing;
    }
    const generated = this.source.next();
    if (!UUID.test(generated)) throw new Error('GOVERNANCE_ID_GENERATOR_INVALID');
    this.values.push(generated);
    this.offset += 1;
    return generated;
  }

  public reset(): void {
    this.offset = 0;
  }
}
