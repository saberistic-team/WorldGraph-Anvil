import { createHash, timingSafeEqual } from 'node:crypto';

import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  DOMAIN_EVENT_SCHEMA_VERSION,
  ECONOMY_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  canonicalJson,
  type AssetTransferOfferExpiredPayloadV1,
  type DomainEventMetadataV1,
  type ExpireAssetTransferOfferPayloadV1,
  type IdGenerator,
  type LedgerActorV1,
  type LedgerEntryV1,
  type WorldCommandResultV1,
} from '@worldgraph/contracts';
import type { Pool } from '@worldgraph/db';
import { decideExpireAssetTransferOffer, EconomyDomainError } from '@worldgraph/economy';
import {
  LEDGER_GENESIS_PREVIOUS_HASH,
  computeDomainEventHashV1,
  computeLedgerEntryHashV1,
  type DomainEventHashInputV1,
  type LedgerEntryHashInputV1,
} from '@worldgraph/ledger';

import {
  ECONOMY_OFFER_EXPIRY_ACTOR_ID,
  ECONOMY_OFFER_EXPIRY_AUTHORIZATION_RULE_ID,
  type EconomyOfferExpiryCommandPort,
  type ExpireAssetTransferOfferRequest,
  type ExpireAssetTransferOfferResult,
  type PostgresEconomyOfferExpiryCommandOptions,
} from './types.js';

interface Client {
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
  command_type: string;
  id: string;
  idempotency_key: string;
  request_hash: Buffer;
  response_summary: unknown;
  status: string;
  world_id: string;
}

interface ExpiryContextRow {
  active_world_version_id: string;
  anchor_artifact_hash: Buffer | null;
  asset_id: string;
  buyer_entity_id: string | null;
  currency_id: string;
  current_tick: string;
  design_version: string;
  economy_row_version: string;
  expires_at_tick: string;
  last_event_sequence: string;
  last_ledger_sequence: string;
  ledger_anchored_at: Date | null;
  lifecycle: string;
  offer_aggregate_version: string;
  offer_row_version: string;
  offer_status: 'accepted' | 'cancelled' | 'expired' | 'open';
  price_minor: string;
  recorded_at: Date;
  seller_entity_id: string;
  seller_wallet_id: string;
  state_revision: string;
  world_id: string;
}

interface ExpiryWorldRow {
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
  economy_row_version: string;
}

interface ClockTickRow {
  current_tick: string;
}

interface OfferExpiryRow {
  asset_id: string;
  buyer_entity_id: string | null;
  currency_id: string;
  expires_at_tick: string;
  offer_aggregate_version: string;
  offer_row_version: string;
  offer_status: 'accepted' | 'cancelled' | 'expired' | 'open';
  price_minor: string;
  seller_entity_id: string;
  seller_wallet_id: string;
}

interface AllocationRow {
  last_entry_hash: Buffer | null;
  next_event_sequence: string;
  next_ledger_sequence: string;
}

interface PersistedEvent {
  event: DomainEventHashInputV1;
  eventHash: string;
}

interface TransactionResolution {
  commit: boolean;
  result: ExpireAssetTransferOfferResult;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const NONNEGATIVE_INT64 = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE_INT64 = /^[1-9][0-9]{0,18}$/u;
const INT64_MAX = 9_223_372_036_854_775_807n;

export const ECONOMY_EXPIRY_LOCK_ORDER = [
  'world_runtime',
  'economy_head',
  'simulation_clock',
  'offer',
] as const;

export function economyOfferExpiryRequestHashV1(request: ExpireAssetTransferOfferRequest): Buffer {
  return sha256({
    expectedAggregateVersion: request.expectedOfferVersion,
    expectedStateRevision: request.expectedStateRevision,
    expectedTick: request.expectedTick,
    expectedWorldVersion: request.expectedWorldVersion,
    payload: expiryPayload(request),
    schemaVersion: ECONOMY_SCHEMA_VERSION,
    type: 'ExpireAssetTransferOfferV1',
    worldId: request.worldId,
  });
}

/** A narrow system-only adapter; it cannot transfer funds or title. */
export class PostgresEconomyOfferExpiryCommand implements EconomyOfferExpiryCommandPort {
  private readonly ids: IdGenerator;
  private readonly maximumSerializationAttempts: number;
  private readonly retryDelay: (attempt: number) => Promise<void>;

  public constructor(
    private readonly pool: Pool,
    options: PostgresEconomyOfferExpiryCommandOptions,
  ) {
    this.ids = options.ids;
    this.maximumSerializationAttempts = options.maximumSerializationAttempts ?? 3;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    if (
      !Number.isSafeInteger(this.maximumSerializationAttempts) ||
      this.maximumSerializationAttempts < 1 ||
      this.maximumSerializationAttempts > 5
    ) {
      throw new Error('ECONOMY_EXPIRY_COMMAND_CONFIGURATION_INVALID');
    }
  }

  public async expire(
    request: ExpireAssetTransferOfferRequest,
  ): Promise<ExpireAssetTransferOfferResult> {
    assertRequest(request);
    const payload = expiryPayload(request);
    const payloadHash = sha256(payload);
    const requestHash = economyOfferExpiryRequestHashV1(request);

    for (let attempt = 0; attempt < this.maximumSerializationAttempts; attempt += 1) {
      const client = (await this.pool.connect()) as unknown as Client;
      let releaseError: Error | undefined;
      const connectionError = (error: Error): void => {
        releaseError ??= error;
      };
      client.on?.('error', connectionError);
      try {
        await client.query('begin isolation level serializable');
        const resolution = await this.expireTransaction(client, request, payloadHash, requestHash);
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
    throw new Error('ECONOMY_EXPIRY_SERIALIZATION_RETRY_EXHAUSTED');
  }

  private async expireTransaction(
    client: Client,
    request: ExpireAssetTransferOfferRequest,
    payloadHash: Buffer,
    requestHash: Buffer,
  ): Promise<TransactionResolution> {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `worldgraph-command-v1:${request.worldId}`,
    ]);
    const replay = await this.replay(client, request, requestHash);
    if (replay) return { commit: false, result: replay };
    await this.insertReceived(client, request, payloadHash, requestHash);
    await client.query('select worldgraph_open_command_write($1,$2)', [
      request.commandId,
      request.worldId,
    ]);
    const context = await this.loadContext(client, request);
    if (!context) return { commit: false, result: { status: 'conflict' } };
    if (context.offer_status !== 'open') {
      return { commit: false, result: { status: 'already_terminal' } };
    }
    if (BigInt(context.current_tick) < BigInt(context.expires_at_tick)) {
      return { commit: false, result: { status: 'not_due' } };
    }
    if (!matchesExpected(context, request)) {
      return { commit: false, result: { status: 'conflict' } };
    }
    assertContextIntegrity(context);
    try {
      decideExpireAssetTransferOffer({
        currentTick: BigInt(context.current_tick),
        expectedOfferVersion: BigInt(request.expectedOfferVersion),
        offer: {
          assetId: context.asset_id,
          buyerEntityLogicalKey: context.buyer_entity_id,
          currencyId: context.currency_id,
          expiresAtTick: BigInt(context.expires_at_tick),
          id: request.offerId,
          priceMinor: BigInt(context.price_minor),
          rowVersion: BigInt(context.offer_row_version),
          sellerEntityLogicalKey: context.seller_entity_id,
          sellerWalletId: context.seller_wallet_id,
          status: context.offer_status,
          worldId: request.worldId,
        },
      });
    } catch (error) {
      if (error instanceof EconomyDomainError) {
        if (error.code === 'OFFER_NOT_DUE') {
          return { commit: false, result: { status: 'not_due' } };
        }
        if (error.code === 'OFFER_NOT_OPEN') {
          return { commit: false, result: { status: 'already_terminal' } };
        }
        return { commit: false, result: { status: 'conflict' } };
      }
      throw error;
    }

    const resultingStateRevision = addDecimal(context.state_revision, 1);
    const resultingOfferVersion = addDecimal(context.offer_row_version, 1);
    const allocation = await this.loadAllocation(client, request.worldId);
    const updatedOffer = await client.query(
      `update asset_transfer_offers
          set status = 'expired', row_version = row_version + 1,
              terminal_command_id = $3, terminal_event_id = $4,
              terminal_state_revision = $5::bigint,
              accepted_financial_transaction_id = null,
              accepted_asset_transfer_id = null,
              updated_at = greatest(updated_at,$6)
        where world_id = $1 and id = $2 and status = 'open'
          and row_version = $7::bigint
          and expires_at_tick <= $8::bigint
       returning row_version::text`,
      [
        request.worldId,
        request.offerId,
        request.commandId,
        request.eventId,
        resultingStateRevision,
        context.recorded_at,
        request.expectedOfferVersion,
        context.current_tick,
      ],
    );
    if (
      (updatedOffer.rowCount ?? 0) !== 1 ||
      (updatedOffer.rows[0] as { row_version?: string } | undefined)?.row_version !==
        resultingOfferVersion
    ) {
      return { commit: false, result: { status: 'conflict' } };
    }

    const economyChecksum = await this.computeEconomyChecksum(client, request.worldId);
    const updatedHead = await client.query(
      `update world_economy_heads
          set checksum = $2, row_version = row_version + 1,
              updated_state_revision = $3::bigint,
              reconciliation_status = 'pending',
              last_reconciled_state_revision = null,
              last_reconciliation_run_id = null,
              updated_at = greatest(updated_at,$4)
        where world_id = $1 and row_version = $5::bigint
       returning row_version::text`,
      [
        request.worldId,
        economyChecksum,
        resultingStateRevision,
        context.recorded_at,
        context.economy_row_version,
      ],
    );
    if ((updatedHead.rowCount ?? 0) !== 1) {
      return { commit: false, result: { status: 'conflict' } };
    }

    const event = await this.appendEvent(
      client,
      request,
      context,
      allocation,
      resultingOfferVersion,
      resultingStateRevision,
    );
    const eventLedgerSequence = await this.appendLedger(
      client,
      request,
      context.recorded_at,
      allocation,
      event,
    );
    await this.insertParticipants(
      client,
      request.worldId,
      context.seller_entity_id,
      context.buyer_entity_id,
      eventLedgerSequence,
      request.commandId,
      request.eventId,
      request.offerId,
      resultingOfferVersion,
      context.current_tick,
      resultingStateRevision,
      context.recorded_at,
    );
    await this.publishOutbox(client, request, context.recorded_at, event);

    const graphChecksum = await this.computeGraphChecksum(
      client,
      request.worldId,
      resultingStateRevision,
    );
    await updateCheckpoint(
      client,
      request.worldId,
      allocation.next_event_sequence,
      economyChecksum,
      graphChecksum,
      context.recorded_at,
    );
    await this.assertProjectionCheckpoints(
      client,
      request.worldId,
      allocation.next_event_sequence,
      economyChecksum,
      graphChecksum,
    );
    const updatedRuntime = await client.query(
      `update world_runtime_heads
          set state_revision = $3::bigint,
              last_ledger_sequence = $4::bigint,
              last_event_sequence = $5::bigint,
              projection_checksum = $6,
              updated_at = greatest(updated_at,$7)
        where world_id = $1 and state_revision = $2::bigint`,
      [
        request.worldId,
        context.state_revision,
        resultingStateRevision,
        addDecimal(allocation.next_ledger_sequence, 1),
        allocation.next_event_sequence,
        graphChecksum,
        context.recorded_at,
      ],
    );
    if ((updatedRuntime.rowCount ?? 0) !== 1) {
      return { commit: false, result: { status: 'conflict' } };
    }

    const result: Extract<WorldCommandResultV1, { status: 'accepted' }> = {
      commandId: request.commandId,
      eventIds: [request.eventId],
      eventSequenceRange: {
        from: allocation.next_event_sequence,
        to: allocation.next_event_sequence,
      },
      ledgerSequenceRange: {
        from: allocation.next_ledger_sequence,
        to: addDecimal(allocation.next_ledger_sequence, 1),
      },
      resultingStateRevision,
      schemaVersion: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      status: 'accepted',
    };
    const accepted = await client.query(
      `update command_records
          set status = 'accepted', authorization_rule_id = $2,
              decided_at = $3, resulting_state_revision = $4::bigint,
              response_summary = $5
        where id = $1 and status = 'received'`,
      [
        request.commandId,
        ECONOMY_OFFER_EXPIRY_AUTHORIZATION_RULE_ID,
        context.recorded_at,
        resultingStateRevision,
        JSON.stringify(result),
      ],
    );
    if ((accepted.rowCount ?? 0) !== 1) throw new Error('ECONOMY_EXPIRY_COMMAND_ACCEPT_FAILED');
    await client.query('select worldgraph_assert_economy_command_terminal($1)', [
      request.commandId,
    ]);
    return { commit: true, result: { resultingStateRevision, status: 'expired' } };
  }

  private async replay(
    client: Client,
    request: ExpireAssetTransferOfferRequest,
    requestHash: Buffer,
  ): Promise<ExpireAssetTransferOfferResult | null> {
    const byId = await client.query(
      `select id, world_id, command_type, actor_type, actor_id, idempotency_key,
              request_hash, status, response_summary
         from command_records where id = $1 for update`,
      [request.commandId],
    );
    const storedById = byId.rows[0] as StoredCommandRow | undefined;
    if (storedById) return replayStored(storedById, request, requestHash);
    const byKey = await client.query(
      `select id, world_id, command_type, actor_type, actor_id, idempotency_key,
              request_hash, status, response_summary
         from command_records
        where world_id = $1 and actor_type = 'system' and actor_id = $2
          and command_type = 'ExpireAssetTransferOfferV1' and idempotency_key = $3
        for update`,
      [request.worldId, ECONOMY_OFFER_EXPIRY_ACTOR_ID, request.idempotencyKey],
    );
    const storedByKey = byKey.rows[0] as StoredCommandRow | undefined;
    return storedByKey ? replayStored(storedByKey, request, requestHash) : null;
  }

  private async insertReceived(
    client: Client,
    request: ExpireAssetTransferOfferRequest,
    payloadHash: Buffer,
    requestHash: Buffer,
  ): Promise<void> {
    await client.query(
      `insert into command_records(
         id, world_id, command_type, command_schema_version, actor_type, actor_id,
         payload, payload_hash, payload_classification, idempotency_key, request_hash,
         expected_world_version, expected_state_revision, expected_aggregate_version,
         correlation_id, causation_id, requested_at
       ) values (
         $1,$2,'ExpireAssetTransferOfferV1',$3,'system',$4,
         null,$5,'member',$6,$7,$8::bigint,$9::bigint,$10::bigint,
         $1,null,date_trunc('milliseconds',transaction_timestamp())
       )`,
      [
        request.commandId,
        request.worldId,
        ECONOMY_SCHEMA_VERSION,
        ECONOMY_OFFER_EXPIRY_ACTOR_ID,
        payloadHash,
        request.idempotencyKey,
        requestHash,
        request.expectedWorldVersion,
        request.expectedStateRevision,
        request.expectedOfferVersion,
      ],
    );
  }

  private async loadContext(
    client: Client,
    request: ExpireAssetTransferOfferRequest,
  ): Promise<ExpiryContextRow | null> {
    // The order is an integrity boundary shared with public economy commands.
    // Database-owned ledger/aggregate allocator heads remain behind their
    // existing gate and trigger functions.
    const worldResult = await client.query(
      `select world.id as world_id, world.lifecycle::text,
              runtime.active_world_version_id, runtime.state_revision::text,
              runtime.last_event_sequence::text, runtime.last_ledger_sequence::text,
              runtime.ledger_anchored_at, runtime.anchor_artifact_hash,
              version.version_number::text as design_version,
              date_trunc('milliseconds',transaction_timestamp()) as recorded_at
         from worlds world
         join world_runtime_heads runtime on runtime.world_id = world.id
         join world_versions version
           on version.id = runtime.active_world_version_id
          and version.world_id = runtime.world_id
        where world.id = $1 and world.archived_at is null
        for update of runtime`,
      [request.worldId],
    );
    const world = worldResult.rows[0] as ExpiryWorldRow | undefined;
    if (!world) return null;

    const economyResult = await client.query(
      `select row_version::text as economy_row_version
         from world_economy_heads
        where world_id = $1
        for update`,
      [request.worldId],
    );
    const economy = economyResult.rows[0] as EconomyHeadRow | undefined;
    if (!economy) return null;

    const clockResult = await client.query(
      `select current_tick::text
         from world_simulation_clocks
        where world_id = $1
        for update`,
      [request.worldId],
    );
    const clock = clockResult.rows[0] as ClockTickRow | undefined;
    if (!clock) return null;

    const offerResult = await client.query(
      `select offer.asset_id::text, offer.buyer_entity_id::text,
              offer.currency_id::text, offer.price_minor::text,
              offer.seller_wallet_id::text,
              offer.status::text as offer_status,
              offer.row_version::text as offer_row_version,
              offer.expires_at_tick::text, offer.seller_entity_id::text,
              stream.current_version::text as offer_aggregate_version
         from asset_transfer_offers offer
         join aggregate_stream_heads stream
           on stream.world_id = offer.world_id
          and stream.aggregate_type = 'asset_transfer_offer'
          and stream.aggregate_id = offer.id::text
        where offer.world_id = $1 and offer.id = $2
        for update of offer`,
      [request.worldId, request.offerId],
    );
    const offer = offerResult.rows[0] as OfferExpiryRow | undefined;
    return offer
      ? {
          ...world,
          ...economy,
          ...clock,
          ...offer,
        }
      : null;
  }

  private async loadAllocation(client: Client, worldId: string): Promise<AllocationRow> {
    const result = await client.query(
      `select next_event_sequence::text, next_ledger_sequence::text, last_entry_hash
         from world_ledger_heads where world_id = $1`,
      [worldId],
    );
    const row = result.rows[0] as AllocationRow | undefined;
    if (!row) throw new Error('ECONOMY_EXPIRY_LEDGER_HEAD_MISSING');
    return row;
  }

  private async appendEvent(
    client: Client,
    request: ExpireAssetTransferOfferRequest,
    context: ExpiryContextRow,
    allocation: AllocationRow,
    resultingOfferVersion: string,
    resultingStateRevision: string,
  ): Promise<PersistedEvent> {
    const metadata: DomainEventMetadataV1 = {
      actor: { actorId: ECONOMY_OFFER_EXPIRY_ACTOR_ID, actorType: 'system' },
      authorizationRuleId: ECONOMY_OFFER_EXPIRY_AUTHORIZATION_RULE_ID,
      causationId: null,
      commandSchemaVersion: ECONOMY_SCHEMA_VERSION,
      commandType: 'ExpireAssetTransferOfferV1',
      correlationId: request.commandId,
      overrideId: null,
      payloadClassification: 'member',
    };
    const payload: AssetTransferOfferExpiredPayloadV1 = {
      expiredAtTick: context.current_tick,
      offerId: request.offerId,
      offerVersion: resultingOfferVersion,
    };
    const event: DomainEventHashInputV1 = {
      aggregateId: request.offerId,
      aggregateType: 'asset_transfer_offer',
      aggregateVersion: addDecimal(context.offer_aggregate_version, 1),
      commandId: request.commandId,
      eventId: request.eventId,
      eventOrdinal: 0,
      eventSchemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
      eventType: 'AssetTransferOfferExpiredV1',
      metadata,
      occurredAt: context.recorded_at.toISOString(),
      payload,
      recordedAt: context.recorded_at.toISOString(),
      resultingStateRevision,
      worldEventSequence: allocation.next_event_sequence,
      worldId: request.worldId,
    };
    const eventHash = computeDomainEventHashV1(event);
    await client.query(
      `insert into domain_events(
         id, world_id, world_event_sequence, command_id, event_ordinal,
         aggregate_type, aggregate_id, aggregate_version, event_type,
         event_schema_version, payload, metadata, event_hash, occurred_at,
         recorded_at, resulting_state_revision
       ) values (
         $1,$2,$3::bigint,$4,0,$5,$6,$7::bigint,$8,$9,$10,$11,$12,$13,$13,$14::bigint
       )`,
      [
        event.eventId,
        event.worldId,
        event.worldEventSequence,
        event.commandId,
        event.aggregateType,
        event.aggregateId,
        event.aggregateVersion,
        event.eventType,
        event.eventSchemaVersion,
        JSON.stringify(event.payload),
        JSON.stringify(event.metadata),
        Buffer.from(eventHash, 'hex'),
        context.recorded_at,
        event.resultingStateRevision,
      ],
    );
    return { event, eventHash };
  }

  private async appendLedger(
    client: Client,
    request: ExpireAssetTransferOfferRequest,
    recordedAtDate: Date,
    allocation: AllocationRow,
    persisted: PersistedEvent,
  ): Promise<string> {
    const actor: LedgerActorV1 = {
      actorId: ECONOMY_OFFER_EXPIRY_ACTOR_ID,
      actorType: 'system',
    };
    const recordedAt = recordedAtDate.toISOString();
    const accepted = ledgerEntry(this.ids.next(), {
      actor,
      commandId: request.commandId,
      entryKind: 'command_accepted',
      eventId: null,
      ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
      ledgerSequence: allocation.next_ledger_sequence,
      previousHash: allocation.last_entry_hash?.toString('hex') ?? LEDGER_GENESIS_PREVIOUS_HASH,
      publicSummaryCode: 'COMMAND_ACCEPTED',
      recordedAt,
      redactedDetails: {
        authorizationRuleId: ECONOMY_OFFER_EXPIRY_AUTHORIZATION_RULE_ID,
        commandType: 'ExpireAssetTransferOfferV1',
      },
      worldId: request.worldId,
    });
    await insertLedgerEntry(client, accepted);
    const fact = ledgerEntry(this.ids.next(), {
      actor,
      commandId: request.commandId,
      entryKind: 'domain_event',
      eventId: persisted.event.eventId,
      ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
      ledgerSequence: addDecimal(allocation.next_ledger_sequence, 1),
      previousHash: accepted.entryHash,
      publicSummaryCode: 'ASSET_TRANSFER_OFFER_EXPIRED',
      recordedAt,
      redactedDetails: {
        aggregateType: 'asset_transfer_offer',
        eventType: 'AssetTransferOfferExpiredV1',
        targetHash: sha256Text(request.offerId),
      },
      worldId: request.worldId,
    });
    await insertLedgerEntry(client, fact);
    return fact.ledgerSequence;
  }

  private async insertParticipants(
    client: Client,
    worldId: string,
    sellerEntityId: string,
    buyerEntityId: string | null,
    ledgerSequence: string,
    commandId: string,
    eventId: string,
    offerId: string,
    offerVersion: string,
    expiredAtTick: string,
    stateRevision: string,
    createdAt: Date,
  ): Promise<void> {
    await client.query(
      `insert into economy_participant_history(
         world_id, ledger_sequence, user_id, participant_entity_id,
         counterparty_entity_id, command_id, event_id, category, summary_code,
         summary_args, visibility, state_revision, created_at
       )
       select distinct on (controller.user_id)
              $1,$2::bigint,controller.user_id,party.participant_entity_id,
              party.counterparty_entity_id,$5,$6,'offer','ASSET_TRANSFER_OFFER_EXPIRED',
              jsonb_build_object(
                'offerId',$7::text,
                'offerVersion',$8::text,
                'expiredAtTick',$9::text
              ),
              'participant',$10::bigint,$11
         from (
           select $3::uuid as participant_entity_id,
                  $4::uuid as counterparty_entity_id, 0 as party_ordinal
           union all
           select $4::uuid, $3::uuid, 1 where $4::uuid is not null
         ) party
         join world_entity_controllers controller
           on controller.world_id = $1
          and controller.entity_id = party.participant_entity_id
          and controller.revoked_at is null
         join world_memberships membership
           on membership.world_id = controller.world_id
          and membership.user_id = controller.user_id
          and membership.status = 'active'
        order by controller.user_id, party.party_ordinal
       on conflict do nothing`,
      [
        worldId,
        ledgerSequence,
        sellerEntityId,
        buyerEntityId,
        commandId,
        eventId,
        offerId,
        offerVersion,
        expiredAtTick,
        stateRevision,
        createdAt,
      ],
    );
  }

  private async assertProjectionCheckpoints(
    client: Client,
    worldId: string,
    lastEventSequence: string,
    economyChecksum: Buffer,
    graphChecksum: Buffer,
  ): Promise<void> {
    const result = await client.query(
      `select count(*)::integer as current_count
         from projection_checkpoints checkpoint
        where checkpoint.world_id = $1
          and checkpoint.projection_name in (
            'world_graph','simulation_runtime','economy_runtime'
          )
          and checkpoint.status = 'current'
          and checkpoint.last_event_sequence = $2::bigint
          and (
            (checkpoint.projection_name = 'economy_runtime' and checkpoint.checksum = $3)
            or (checkpoint.projection_name = 'world_graph' and checkpoint.checksum = $4)
            or (
              checkpoint.projection_name = 'simulation_runtime'
              and checkpoint.checksum = worldgraph_simulation_projection_checksum($1)
            )
          )`,
      [worldId, lastEventSequence, economyChecksum, graphChecksum],
    );
    const count = (result.rows[0] as { current_count?: number } | undefined)?.current_count;
    if (count !== 3) throw new Error('ECONOMY_EXPIRY_CHECKPOINT_ADVANCE_FAILED');
  }

  private async publishOutbox(
    client: Client,
    request: ExpireAssetTransferOfferRequest,
    recordedAt: Date,
    persisted: PersistedEvent,
  ): Promise<void> {
    await client.query(
      `insert into outbox_messages(
         id, world_id, event_id, message_type, message_schema_version,
         payload, status, attempts, available_at, created_at
       ) values ($1,$2,$3,'DomainEventReferenceV1',$4,$5,'pending',0,$6,$6)`,
      [
        this.ids.next(),
        request.worldId,
        request.eventId,
        OUTBOX_SCHEMA_VERSION,
        JSON.stringify({
          eventId: request.eventId,
          eventType: 'AssetTransferOfferExpiredV1',
          worldEventSequence: persisted.event.worldEventSequence,
          worldId: request.worldId,
        }),
        recordedAt,
      ],
    );
  }

  private async computeEconomyChecksum(client: Client, worldId: string): Promise<Buffer> {
    const result = await client.query(
      'select worldgraph_economy_projection_checksum($1) as checksum',
      [worldId],
    );
    const checksum = (result.rows[0] as { checksum?: Buffer } | undefined)?.checksum;
    if (!checksum) throw new Error('ECONOMY_EXPIRY_CHECKSUM_FAILED');
    return checksum;
  }

  private async computeGraphChecksum(
    client: Client,
    worldId: string,
    stateRevision: string,
  ): Promise<Buffer> {
    const result = await client.query(
      'select worldgraph_projection_checksum($1,$2::bigint) as checksum',
      [worldId, stateRevision],
    );
    const checksum = (result.rows[0] as { checksum?: Buffer } | undefined)?.checksum;
    if (!checksum) throw new Error('ECONOMY_EXPIRY_GRAPH_CHECKSUM_FAILED');
    return checksum;
  }
}

function assertRequest(request: ExpireAssetTransferOfferRequest): void {
  if (
    !UUID.test(request.commandId) ||
    !UUID.test(request.eventId) ||
    !UUID.test(request.offerId) ||
    !UUID.test(request.worldId) ||
    !IDEMPOTENCY_KEY.test(request.idempotencyKey) ||
    !positiveInt64(request.expectedOfferVersion) ||
    !nonnegativeInt64(request.expectedStateRevision) ||
    !nonnegativeInt64(request.expectedTick) ||
    !positiveInt64(request.expectedWorldVersion)
  ) {
    throw new Error('ECONOMY_EXPIRY_REQUEST_INVALID');
  }
}

function expiryPayload(
  request: ExpireAssetTransferOfferRequest,
): ExpireAssetTransferOfferPayloadV1 {
  return {
    expectedOfferVersion: request.expectedOfferVersion,
    expectedTick: request.expectedTick,
    offerId: request.offerId,
  };
}

function matchesExpected(
  context: ExpiryContextRow,
  request: ExpireAssetTransferOfferRequest,
): boolean {
  return (
    context.lifecycle === 'active' &&
    context.offer_row_version === request.expectedOfferVersion &&
    context.offer_aggregate_version === request.expectedOfferVersion &&
    context.state_revision === request.expectedStateRevision &&
    context.current_tick === request.expectedTick &&
    context.design_version === request.expectedWorldVersion
  );
}

function assertContextIntegrity(context: ExpiryContextRow): void {
  if (
    !context.ledger_anchored_at ||
    !context.anchor_artifact_hash ||
    !UUID.test(context.world_id) ||
    !UUID.test(context.seller_entity_id) ||
    !positiveInt64(context.offer_row_version) ||
    !positiveInt64(context.offer_aggregate_version) ||
    !nonnegativeInt64(context.current_tick) ||
    !nonnegativeInt64(context.expires_at_tick) ||
    !nonnegativeInt64(context.state_revision) ||
    !positiveInt64(context.design_version) ||
    !positiveInt64(context.economy_row_version)
  ) {
    throw new Error('ECONOMY_EXPIRY_CONTEXT_INVALID');
  }
}

function replayStored(
  stored: StoredCommandRow,
  request: ExpireAssetTransferOfferRequest,
  requestHash: Buffer,
): ExpireAssetTransferOfferResult {
  const identityMatches =
    stored.world_id === request.worldId &&
    stored.command_type === 'ExpireAssetTransferOfferV1' &&
    stored.actor_type === 'system' &&
    stored.actor_id === ECONOMY_OFFER_EXPIRY_ACTOR_ID &&
    stored.idempotency_key === request.idempotencyKey;
  if (!identityMatches || !hashesEqual(stored.request_hash, requestHash)) {
    return { status: 'conflict' };
  }
  if (stored.status !== 'accepted' || !isObject(stored.response_summary)) {
    return { status: 'conflict' };
  }
  const revision = stored.response_summary.resultingStateRevision;
  return typeof revision === 'string' && nonnegativeInt64(revision)
    ? { resultingStateRevision: revision, status: 'expired' }
    : { status: 'conflict' };
}

function ledgerEntry(
  entryId: string,
  input: Omit<LedgerEntryHashInputV1, 'entryId'>,
): LedgerEntryV1 {
  const withoutHash: LedgerEntryHashInputV1 = { ...input, entryId };
  return { ...withoutHash, entryHash: computeLedgerEntryHashV1(withoutHash) } as LedgerEntryV1;
}

async function insertLedgerEntry(client: Client, entry: LedgerEntryV1): Promise<void> {
  await client.query(
    `insert into ledger_entries(
       id, world_id, ledger_sequence, entry_kind, command_id, event_id,
       actor_type, actor_id, public_summary_code, redacted_details,
       previous_hash, entry_hash, recorded_at
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

async function updateCheckpoint(
  client: Client,
  worldId: string,
  lastEventSequence: string,
  economyChecksum: Buffer,
  graphChecksum: Buffer,
  recordedAt: Date,
): Promise<void> {
  await client.query(
    `insert into projection_checkpoints(
       world_id, projection_name, projection_schema_version,
       last_event_sequence, checksum, status, updated_at
     ) values
       ($1,'world_graph',$2,$3::bigint,$4,'current',$6),
       ($1,'simulation_runtime',$2,$3::bigint,
          worldgraph_simulation_projection_checksum($1),'current',$6),
       ($1,'economy_runtime',$2,$3::bigint,$5,'current',$6)
     on conflict (world_id, projection_name) do update
       set projection_schema_version = excluded.projection_schema_version,
           last_event_sequence = excluded.last_event_sequence,
           checksum = excluded.checksum, status = excluded.status,
           updated_at = greatest(projection_checkpoints.updated_at,excluded.updated_at)`,
    [
      worldId,
      PROJECTION_SCHEMA_VERSION,
      lastEventSequence,
      graphChecksum,
      economyChecksum,
      recordedAt,
    ],
  );
}

function sha256(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashesEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function addDecimal(value: string, amount: number): string {
  return (BigInt(value) + BigInt(amount)).toString(10);
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
