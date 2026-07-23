import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  importStarterPrimitives,
  type DatabaseClient,
  readRuntimeVersions,
} from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const userA = '018f0000-0000-7000-8000-000000000001';
const userB = '018f0000-0000-7000-8000-000000000002';
const userC = '018f0000-0000-7000-8000-000000000003';
const worldA = '018f0000-0000-7000-8000-000000000101';
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const m11MigrationTags = [
  '0001_platform_extensions',
  '0002_platform_metadata',
  '0003_identity_authority',
  '0004_primitive_registry',
  '0005_manifest_studio',
  '0006_deterministic_compiler',
  '0007_command_event_ledger',
  '0008_deterministic_clock_scheduler',
  '0009_wallets_transfers_ownership',
  '0010_production_business_market_tax',
  '0011_commerce_projection_repair',
] as const;

const commerceUpgradeFixture = {
  buyerEntity: '018f0000-0000-7000-8000-00000000c103',
  buyerInventory: '018f0000-0000-7000-8000-00000000c10f',
  buyerWallet: '018f0000-0000-7000-8000-00000000c107',
  business: '018f0000-0000-7000-8000-00000000c108',
  contract: '018f0000-0000-7000-8000-00000000c110',
  currency: '018f0000-0000-7000-8000-00000000c104',
  facility: '018f0000-0000-7000-8000-00000000c109',
  listing: '018f0000-0000-7000-8000-00000000c114',
  listingReservation: '018f0000-0000-7000-8000-00000000c116',
  marketMovement: '018f0000-0000-7000-8000-00000000c118',
  productionInputInventory: '018f0000-0000-7000-8000-00000000c10c',
  productionOutputInventory: '018f0000-0000-7000-8000-00000000c10d',
  productionReservation: '018f0000-0000-7000-8000-00000000c113',
  productionRun: '018f0000-0000-7000-8000-00000000c111',
  productionSchedule: '018f0000-0000-7000-8000-00000000c112',
  recipeVersion: '018f0000-0000-7000-8000-00000000c10a',
  resourceType: '018f0000-0000-7000-8000-00000000c10b',
  sellerEntity: '018f0000-0000-7000-8000-00000000c101',
  sellerInventory: '018f0000-0000-7000-8000-00000000c10e',
  sellerWallet: '018f0000-0000-7000-8000-00000000c105',
  trade: '018f0000-0000-7000-8000-00000000c117',
  transaction: '018f0000-0000-7000-8000-00000000c119',
  workerEntity: '018f0000-0000-7000-8000-00000000c102',
  workerWallet: '018f0000-0000-7000-8000-00000000c106',
  worldVersion: '018f0000-0000-7000-8000-00000000c100',
  commands: {
    acceptContract: '018f0000-0000-7000-8000-00000000c121',
    completeProduction: '018f0000-0000-7000-8000-00000000c124',
    createContract: '018f0000-0000-7000-8000-00000000c120',
    createListing: '018f0000-0000-7000-8000-00000000c125',
    endContract: '018f0000-0000-7000-8000-00000000c122',
    purchaseListing: '018f0000-0000-7000-8000-00000000c126',
    startProduction: '018f0000-0000-7000-8000-00000000c123',
  },
  events: {
    contractAccepted: '018f0000-0000-7000-8000-00000000c131',
    contractCreated: '018f0000-0000-7000-8000-00000000c130',
    contractEnded: '018f0000-0000-7000-8000-00000000c132',
    inventoryTransferred: '018f0000-0000-7000-8000-00000000c139',
    listingCreated: '018f0000-0000-7000-8000-00000000c137',
    listingFilled: '018f0000-0000-7000-8000-00000000c13a',
    listingScheduled: '018f0000-0000-7000-8000-00000000c138',
    productionConsumed: '018f0000-0000-7000-8000-00000000c135',
    productionProduced: '018f0000-0000-7000-8000-00000000c136',
    productionScheduled: '018f0000-0000-7000-8000-00000000c134',
    productionStarted: '018f0000-0000-7000-8000-00000000c133',
    tradeCompleted: '018f0000-0000-7000-8000-00000000c13b',
  },
  listingSchedule: '018f0000-0000-7000-8000-00000000c115',
} as const;

async function createM11MigrationRoot(prefix: string): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(temporaryRoot, 'meta'));
  await Promise.all(
    m11MigrationTags.map((tag) =>
      cp(join(migrationRoot, `${tag}.sql`), join(temporaryRoot, `${tag}.sql`)),
    ),
  );
  await writeFile(
    join(temporaryRoot, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: m11MigrationTags.map((tag, idx) => ({
        idx,
        version: '7',
        when: 1784635200000 + idx * 60000,
        tag,
        breakpoints: true,
      })),
    }),
  );
  return temporaryRoot;
}

interface HistoricalEvent {
  aggregateId: string;
  aggregateType: string;
  aggregateVersion: number;
  commandId: string;
  eventId: string;
  eventOrdinal: number;
  eventType: string;
  payload: Record<string, unknown>;
  resultingStateRevision: number;
  worldEventSequence: number;
}

async function insertHistoricalEvent(
  connection: PoolClient,
  worldId: string,
  event: HistoricalEvent,
): Promise<void> {
  await connection.query(
    `insert into domain_events(
       id,world_id,world_event_sequence,command_id,event_ordinal,
       aggregate_type,aggregate_id,aggregate_version,event_type,
       event_schema_version,payload,metadata,event_hash,occurred_at,
       recorded_at,resulting_state_revision
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10::jsonb,'{}'::jsonb,
       decode(repeat('33',32),'hex'),'2026-01-01T00:00:00.000Z',
       '2026-01-01T00:00:00.000Z',$11
     )`,
    [
      event.eventId,
      worldId,
      event.worldEventSequence,
      event.commandId,
      event.eventOrdinal,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.eventType,
      JSON.stringify(event.payload),
      event.resultingStateRevision,
    ],
  );
}

async function seedM11CommercePayloadBaselines(
  client: DatabaseClient,
  worldId: string,
  options: { ambiguousListingReservation?: boolean } = {},
): Promise<void> {
  const fixture = commerceUpgradeFixture;
  const commands = [
    {
      commandId: fixture.commands.createContract,
      commandType: 'CreateEmploymentContractV1',
      stateRevision: 8,
    },
    {
      commandId: fixture.commands.acceptContract,
      commandType: 'AcceptEmploymentContractV1',
      stateRevision: 9,
    },
    {
      commandId: fixture.commands.endContract,
      commandType: 'EndEmploymentContractV1',
      stateRevision: 10,
    },
    {
      commandId: fixture.commands.startProduction,
      commandType: 'StartProductionRunV1',
      stateRevision: 11,
    },
    {
      commandId: fixture.commands.completeProduction,
      commandType: 'CompleteProductionRunV1',
      stateRevision: 12,
    },
    {
      commandId: fixture.commands.createListing,
      commandType: 'CreateMarketListingV1',
      stateRevision: 13,
    },
    {
      commandId: fixture.commands.purchaseListing,
      commandType: 'PurchaseMarketListingV1',
      stateRevision: 14,
    },
  ] as const;
  const events: HistoricalEvent[] = [
    {
      aggregateId: fixture.contract,
      aggregateType: 'employment_contract',
      aggregateVersion: 1,
      commandId: fixture.commands.createContract,
      eventId: fixture.events.contractCreated,
      eventOrdinal: 0,
      eventType: 'EmploymentContractCreatedV1',
      payload: {
        aggregateVersion: '1',
        businessId: fixture.business,
        contractId: fixture.contract,
        status: 'offered',
        tick: '8',
        workerEntityId: fixture.workerEntity,
      },
      resultingStateRevision: 8,
      worldEventSequence: 2,
    },
    {
      aggregateId: fixture.contract,
      aggregateType: 'employment_contract',
      aggregateVersion: 2,
      commandId: fixture.commands.acceptContract,
      eventId: fixture.events.contractAccepted,
      eventOrdinal: 0,
      eventType: 'EmploymentContractAcceptedV1',
      payload: {
        aggregateVersion: '2',
        contractId: fixture.contract,
        status: 'active',
        tick: '9',
      },
      resultingStateRevision: 9,
      worldEventSequence: 3,
    },
    {
      aggregateId: fixture.contract,
      aggregateType: 'employment_contract',
      aggregateVersion: 3,
      commandId: fixture.commands.endContract,
      eventId: fixture.events.contractEnded,
      eventOrdinal: 0,
      eventType: 'EmploymentContractEndedV1',
      payload: {
        aggregateVersion: '3',
        contractId: fixture.contract,
        reason: 'historical-upgrade',
        status: 'ended',
        tick: '10',
      },
      resultingStateRevision: 10,
      worldEventSequence: 4,
    },
    {
      aggregateId: fixture.productionRun,
      aggregateType: 'production_run',
      aggregateVersion: 1,
      commandId: fixture.commands.startProduction,
      eventId: fixture.events.productionStarted,
      eventOrdinal: 0,
      eventType: 'ProductionRunStartedV1',
      payload: {
        aggregateVersion: '1',
        dueTick: '12',
        productionRunId: fixture.productionRun,
        recipeVersionId: fixture.recipeVersion,
        scheduledActionId: fixture.productionSchedule,
        tick: '11',
      },
      resultingStateRevision: 11,
      worldEventSequence: 5,
    },
    {
      aggregateId: fixture.productionSchedule,
      aggregateType: 'scheduled_action',
      aggregateVersion: 1,
      commandId: fixture.commands.startProduction,
      eventId: fixture.events.productionScheduled,
      eventOrdinal: 1,
      eventType: 'ScheduledActionCreatedV1',
      payload: {
        actionType: 'CompleteProductionRunV1',
        aggregateVersion: '1',
        dueTick: '12',
        scheduleId: fixture.productionSchedule,
        tick: '11',
      },
      resultingStateRevision: 11,
      worldEventSequence: 6,
    },
    {
      aggregateId: fixture.productionRun,
      aggregateType: 'production_run',
      aggregateVersion: 2,
      commandId: fixture.commands.completeProduction,
      eventId: fixture.events.productionConsumed,
      eventOrdinal: 0,
      eventType: 'ResourcesConsumedV1',
      payload: {
        aggregateVersion: '2',
        productionRunId: fixture.productionRun,
        resources: [{ quantity: '2.000000000000', resourceTypeId: fixture.resourceType }],
        tick: '12',
      },
      resultingStateRevision: 12,
      worldEventSequence: 7,
    },
    {
      aggregateId: fixture.productionRun,
      aggregateType: 'production_run',
      aggregateVersion: 3,
      commandId: fixture.commands.completeProduction,
      eventId: fixture.events.productionProduced,
      eventOrdinal: 1,
      eventType: 'ResourcesProducedV1',
      payload: {
        aggregateVersion: '3',
        productionRunId: fixture.productionRun,
        resources: [{ quantity: '1.000000000000', resourceTypeId: fixture.resourceType }],
        tick: '12',
      },
      resultingStateRevision: 12,
      worldEventSequence: 8,
    },
    {
      aggregateId: fixture.listing,
      aggregateType: 'market_listing',
      aggregateVersion: 1,
      commandId: fixture.commands.createListing,
      eventId: fixture.events.listingCreated,
      eventOrdinal: 0,
      eventType: 'MarketListingCreatedV1',
      payload: {
        aggregateVersion: '1',
        listingId: fixture.listing,
        remainingQuantity: '4.000000000000',
        status: 'open',
        tick: '13',
      },
      resultingStateRevision: 13,
      worldEventSequence: 9,
    },
    {
      aggregateId: fixture.listingSchedule,
      aggregateType: 'scheduled_action',
      aggregateVersion: 1,
      commandId: fixture.commands.createListing,
      eventId: fixture.events.listingScheduled,
      eventOrdinal: 1,
      eventType: 'ScheduledActionCreatedV1',
      payload: {
        actionType: 'ExpireMarketListingV1',
        aggregateVersion: '1',
        dueTick: '20',
        scheduleId: fixture.listingSchedule,
        tick: '13',
      },
      resultingStateRevision: 13,
      worldEventSequence: 10,
    },
    {
      aggregateId: fixture.marketMovement,
      aggregateType: 'inventory_movement',
      aggregateVersion: 1,
      commandId: fixture.commands.purchaseListing,
      eventId: fixture.events.inventoryTransferred,
      eventOrdinal: 0,
      eventType: 'InventoryTransferredV1',
      payload: {
        aggregateVersion: '1',
        fromInventoryId: fixture.sellerInventory,
        quantity: '4.000000000000',
        resourceTypeId: fixture.resourceType,
        tick: '14',
        toInventoryId: fixture.buyerInventory,
        tradeId: fixture.trade,
      },
      resultingStateRevision: 14,
      worldEventSequence: 11,
    },
    {
      aggregateId: fixture.listing,
      aggregateType: 'market_listing',
      aggregateVersion: 2,
      commandId: fixture.commands.purchaseListing,
      eventId: fixture.events.listingFilled,
      eventOrdinal: 1,
      eventType: 'MarketListingFilledV1',
      payload: {
        aggregateVersion: '2',
        listingId: fixture.listing,
        remainingQuantity: '0.000000000000',
        status: 'filled',
        tick: '14',
      },
      resultingStateRevision: 14,
      worldEventSequence: 12,
    },
    {
      aggregateId: fixture.trade,
      aggregateType: 'market_trade',
      aggregateVersion: 1,
      commandId: fixture.commands.purchaseListing,
      eventId: fixture.events.tradeCompleted,
      eventOrdinal: 2,
      eventType: 'MarketTradeCompletedV1',
      payload: {
        aggregateVersion: '1',
        buyerTotalMinor: '100',
        feeMinor: '0',
        grossMinor: '100',
        listingId: fixture.listing,
        quantity: '4.000000000000',
        sellerNetMinor: '100',
        taxMinor: '0',
        tick: '14',
        tradeId: fixture.trade,
      },
      resultingStateRevision: 14,
      worldEventSequence: 13,
    },
  ];

  await inTransaction(client, async (connection) => {
    await connection.query(`set local session_replication_role='replica'`);
    await connection.query(
      `insert into command_records(
         id,world_id,command_type,command_schema_version,actor_type,actor_id,
         payload,payload_hash,payload_classification,idempotency_key,
         request_hash,status,authorization_rule_id,correlation_id,
         requested_at,decided_at,resulting_state_revision,response_summary
       )
       select command.id,$1,command.command_type,1,'user',$2,null,
         decode(repeat('11',32),'hex'),'public',
         'm11-' || lower(command.command_type),
         decode(repeat('22',32),'hex'),'accepted','world.command',command.id,
         '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
         command.state_revision,'{"status":"accepted"}'::jsonb
       from unnest($3::uuid[],$4::text[],$5::bigint[])
         as command(id,command_type,state_revision)`,
      [
        worldId,
        userA,
        commands.map((command) => command.commandId),
        commands.map((command) => command.commandType),
        commands.map((command) => command.stateRevision),
      ],
    );
    for (const event of events) {
      await insertHistoricalEvent(connection, worldId, event);
    }
    await connection.query(
      `insert into world_entities(
         id,world_id,logical_key,entity_type,entity_schema_version,state,
         created_world_version_id,row_version
       ) values
         ($1,$4,'org:seller','organization',1,
          '{"homeDistrictLogicalKey":"district:harbor","name":"Seller Guild","parameters":{},"primitiveRef":"faction"}',
          $5,1),
         ($2,$4,'org:worker','organization',1,
          '{"homeDistrictLogicalKey":"district:harbor","name":"Worker Guild","parameters":{},"primitiveRef":"faction"}',
          $5,1),
         ($3,$4,'org:buyer','organization',1,
          '{"homeDistrictLogicalKey":"district:harbor","name":"Buyer Guild","parameters":{},"primitiveRef":"faction"}',
          $5,1)`,
      [
        fixture.sellerEntity,
        fixture.workerEntity,
        fixture.buyerEntity,
        worldId,
        fixture.worldVersion,
      ],
    );
    await connection.query(
      `insert into wallets(
         id,world_id,currency_id,stable_key,owner_entity_id,wallet_kind,
         status,row_version,created_event_id
       ) values
         ($1,$7,$4,'wallet:seller',$5,'organization','active',1,$8),
         ($2,$7,$4,'wallet:worker',$6,'organization','active',1,$8),
         ($3,$7,$4,'wallet:buyer',$9,'organization','active',1,$8)`,
      [
        fixture.sellerWallet,
        fixture.workerWallet,
        fixture.buyerWallet,
        fixture.currency,
        fixture.sellerEntity,
        fixture.workerEntity,
        worldId,
        fixture.events.contractCreated,
        fixture.buyerEntity,
      ],
    );
    await connection.query(
      `insert into businesses(
         id,world_id,stable_key,display_name,backing_organization_entity_id,
         wallet_id,currency_id,status,metadata,row_version,created_command_id,
         created_event_id,created_state_revision,updated_state_revision
       ) values (
         $1,$2,'business:harbor','Harbor Works',$3,$4,$5,'active','{}',1,
         $6,$7,8,14
       )`,
      [
        fixture.business,
        worldId,
        fixture.sellerEntity,
        fixture.sellerWallet,
        fixture.currency,
        fixture.commands.createContract,
        fixture.events.contractCreated,
      ],
    );
    await connection.query(
      `insert into employment_contracts(
         id,world_id,stable_key,business_id,worker_entity_id,
         employer_wallet_id,worker_wallet_id,currency_id,role_code,wage_rule,
         wage_minor,cadence_ticks,cooldown_ticks,reward_cap_minor,
         max_payments_per_period,effective_from_tick,effective_until_tick,status,
         row_version,created_command_id,created_event_id,accepted_command_id,
         accepted_event_id,terminal_command_id,terminal_event_id,terminal_reason,
         created_state_revision,accepted_state_revision,terminal_state_revision,
         created_at,updated_at,ended_at
       ) values (
         $1,$2,'contract:harbor-worker',$3,$4,$5,$6,$7,'smith','per_shift',
         25,5,1,100,4,8,100,'ended',3,$8,$9,$10,$11,$12,$13,
         'historical-upgrade',8,9,10,
         '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z'
       )`,
      [
        fixture.contract,
        worldId,
        fixture.business,
        fixture.workerEntity,
        fixture.sellerWallet,
        fixture.workerWallet,
        fixture.currency,
        fixture.commands.createContract,
        fixture.events.contractCreated,
        fixture.commands.acceptContract,
        fixture.events.contractAccepted,
        fixture.commands.endContract,
        fixture.events.contractEnded,
      ],
    );
    await connection.query(
      `insert into inventories(
         id,world_id,stable_key,owner_entity_id,container_asset_id,
         resource_type_id,quantity,reserved_quantity,row_version,
         updated_state_revision,created_command_id,created_event_id
       ) values
         ($1,$6,'inventory:production-input',$7,
          '018f0000-0000-7000-8000-00000000c11f',$5,8,0,2,12,$8,$9),
         ($2,$6,'inventory:production-output',$7,
          '018f0000-0000-7000-8000-00000000c12f',$5,1,0,2,12,$8,$10),
         ($3,$6,'inventory:market-seller',$7,null,$5,0,0,2,14,$11,$12),
         ($4,$6,'inventory:market-buyer',$13,null,$5,4,0,2,14,$11,$14)`,
      [
        fixture.productionInputInventory,
        fixture.productionOutputInventory,
        fixture.sellerInventory,
        fixture.buyerInventory,
        fixture.resourceType,
        worldId,
        fixture.sellerEntity,
        fixture.commands.startProduction,
        fixture.events.productionStarted,
        fixture.events.productionStarted,
        fixture.commands.createListing,
        fixture.events.listingCreated,
        fixture.buyerEntity,
        fixture.events.listingCreated,
      ],
    );
    await connection.query(
      `insert into scheduled_actions(
         id,world_id,schedule_sequence,due_tick,priority,action_type,
         action_schema_version,payload,payload_hash,process_version,status,
         created_by_actor_type,created_by_actor_id,created_command_id,
         completed_event_id,created_state_revision,completed_state_revision,
         created_at,updated_at
       ) values
         ($1,$3,1,12,0,'CompleteProductionRunV1',1,
          jsonb_build_object('productionRunId',$4::text),
          extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
            jsonb_build_object('productionRunId',$4::text)
          ),'UTF8'),'sha256'),
          '1.0.0','completed','user',$5,$6,$7,11,12,
          '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
         ($2,$3,2,20,0,'ExpireMarketListingV1',1,
          jsonb_build_object('listingId',$8::text),
          extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
            jsonb_build_object('listingId',$8::text)
          ),'UTF8'),'sha256'),
          '1.0.0','scheduled','user',$5,$9,null,13,null,
          '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      [
        fixture.productionSchedule,
        fixture.listingSchedule,
        worldId,
        fixture.productionRun,
        userA,
        fixture.commands.startProduction,
        fixture.events.productionProduced,
        fixture.listing,
        fixture.commands.createListing,
      ],
    );
    await connection.query(
      `with snapshot as (
         select
           jsonb_build_array(jsonb_build_object(
             'quantity','2.000000000000','resourceTypeId',$2::text
           )) as inputs,
           jsonb_build_array(jsonb_build_object(
             'quantity','1.000000000000','resourceTypeId',$2::text
           )) as outputs
       )
       insert into production_runs(
         id,world_id,business_id,facility_id,recipe_version_id,
         scheduled_action_id,quantity,status,due_tick,input_snapshot,
         output_snapshot,snapshot_checksum,row_version,start_command_id,
         start_event_id,terminal_command_id,terminal_event_id,
         created_state_revision,terminal_state_revision,created_at,updated_at,
         completed_at
       )
       select $1,$3,$4,$5,$6,$7,1,'completed',12,snapshot.inputs,
         snapshot.outputs,
         extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
           jsonb_build_object('inputs',snapshot.inputs,'outputs',snapshot.outputs)
         ),'UTF8'),'sha256'),
         2,$8,$9,$10,$11,11,12,
         '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z'
       from snapshot`,
      [
        fixture.productionRun,
        fixture.resourceType,
        worldId,
        fixture.business,
        fixture.facility,
        fixture.recipeVersion,
        fixture.productionSchedule,
        fixture.commands.startProduction,
        fixture.events.productionStarted,
        fixture.commands.completeProduction,
        fixture.events.productionProduced,
      ],
    );
    await connection.query(
      `insert into production_run_transitions(
         run_id,world_id,transition_version,status,command_id,event_id,
         occurred_tick,state_revision,snapshot_hash
       )
       select run.id,run.world_id,1,'ready',$2,$3,11,11,run.snapshot_checksum
       from production_runs run where run.id=$1
       union all
       select run.id,run.world_id,2,'completed',$4,$5,12,12,run.snapshot_checksum
       from production_runs run where run.id=$1`,
      [
        fixture.productionRun,
        fixture.commands.startProduction,
        fixture.events.productionStarted,
        fixture.commands.completeProduction,
        fixture.events.productionProduced,
      ],
    );
    await connection.query(
      `insert into inventory_reservations(
         id,world_id,inventory_id,purpose_type,purpose_id,quantity,status,
         row_version,created_command_id,created_event_id,terminal_command_id,
         terminal_event_id,created_state_revision,terminal_state_revision,
         created_at,updated_at,terminal_at
       ) values (
         $1,$2,$3,'production_input',$4,2,'consumed',2,$5,$6,$7,$8,11,12,
         '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z'
       )`,
      [
        fixture.productionReservation,
        worldId,
        fixture.productionInputInventory,
        fixture.productionRun,
        fixture.commands.startProduction,
        fixture.events.productionStarted,
        fixture.commands.completeProduction,
        fixture.events.productionConsumed,
      ],
    );
    await connection.query(
      `insert into inventory_movements(
         id,world_id,resource_type_id,from_inventory_id,to_inventory_id,
         quantity,movement_kind,source_type,source_id,source_ordinal,
         command_id,event_id,occurred_tick,state_revision,created_at
       ) values
         ('018f0000-0000-7000-8000-00000000c11c',$1,$2,$3,null,2,
          'production_consume','production_run',$4,0,$5,$6,12,12,
          '2026-01-01T00:00:00.000Z'),
         ('018f0000-0000-7000-8000-00000000c11d',$1,$2,null,$7,1,
          'production_output','production_run',$4,1,$5,$8,12,12,
          '2026-01-01T00:00:00.000Z')`,
      [
        worldId,
        fixture.resourceType,
        fixture.productionInputInventory,
        fixture.productionRun,
        fixture.commands.completeProduction,
        fixture.events.productionConsumed,
        fixture.productionOutputInventory,
        fixture.events.productionProduced,
      ],
    );
    await connection.query(
      `insert into market_listings(
         id,world_id,seller_entity_id,seller_inventory_id,resource_type_id,
         seller_wallet_id,currency_id,scheduled_action_id,offered_quantity,
         remaining_quantity,reserved_quantity,unit_price_minor,status,
         expires_at_tick,row_version,created_command_id,created_event_id,
         terminal_command_id,terminal_event_id,created_state_revision,
         terminal_state_revision,created_at,updated_at,terminal_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,4,0,0,25,'filled',20,2,$9,$10,$11,$12,
         13,14,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z'
       )`,
      [
        fixture.listing,
        worldId,
        fixture.sellerEntity,
        fixture.sellerInventory,
        fixture.resourceType,
        fixture.sellerWallet,
        fixture.currency,
        fixture.listingSchedule,
        fixture.commands.createListing,
        fixture.events.listingCreated,
        fixture.commands.purchaseListing,
        fixture.events.listingFilled,
      ],
    );
    await connection.query(
      `insert into inventory_reservations(
         id,world_id,inventory_id,purpose_type,purpose_id,quantity,status,
         expires_at_tick,row_version,created_command_id,created_event_id,
         terminal_command_id,terminal_event_id,created_state_revision,
         terminal_state_revision,created_at,updated_at,terminal_at
       ) values (
         $1,$2,$3,'market_listing',$4,4,'consumed',20,2,$5,$6,$7,$8,13,14,
         '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z'
       )`,
      [
        fixture.listingReservation,
        worldId,
        fixture.sellerInventory,
        fixture.listing,
        fixture.commands.createListing,
        fixture.events.listingCreated,
        fixture.commands.purchaseListing,
        fixture.events.listingFilled,
      ],
    );
    if (options.ambiguousListingReservation) {
      await connection.query(
        `insert into inventory_reservations(
           id,world_id,inventory_id,purpose_type,purpose_id,quantity,status,
           expires_at_tick,row_version,created_command_id,created_event_id,
           terminal_command_id,terminal_event_id,created_state_revision,
           terminal_state_revision,created_at,updated_at,terminal_at
         ) values (
           '018f0000-0000-7000-8000-00000000c11e',$1,$2,'market_listing',$3,
           4,'consumed',20,2,$4,$5,$6,$7,13,14,
           '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z'
         )`,
        [
          worldId,
          fixture.buyerInventory,
          fixture.listing,
          fixture.commands.createListing,
          fixture.events.listingCreated,
          fixture.commands.purchaseListing,
          fixture.events.listingFilled,
        ],
      );
    }
    await connection.query(
      `insert into financial_transactions(
         id,world_id,currency_id,transaction_kind,supply_delta_minor,
         command_id,event_id,memo_code,occurred_tick,state_revision,created_at
       ) values (
         $1,$2,$3,'market_purchase',0,$4,$5,'market.purchase',14,14,
         '2026-01-01T00:00:00.000Z'
       )`,
      [
        fixture.transaction,
        worldId,
        fixture.currency,
        fixture.commands.purchaseListing,
        fixture.events.tradeCompleted,
      ],
    );
    await connection.query(
      `insert into wallet_postings(
         id,transaction_id,world_id,currency_id,wallet_id,posting_ordinal,
         signed_amount_minor,created_at
       ) values
         ('018f0000-0000-7000-8000-00000000c11a',$1,$2,$3,$4,0,-100,
          '2026-01-01T00:00:00.000Z'),
         ('018f0000-0000-7000-8000-00000000c11b',$1,$2,$3,$5,1,100,
          '2026-01-01T00:00:00.000Z')`,
      [fixture.transaction, worldId, fixture.currency, fixture.buyerWallet, fixture.sellerWallet],
    );
    await connection.query(
      `insert into inventory_movements(
         id,world_id,resource_type_id,from_inventory_id,to_inventory_id,
         quantity,movement_kind,source_type,source_id,source_ordinal,
         command_id,event_id,occurred_tick,state_revision,created_at
       ) values (
         $1,$2,$3,$4,$5,4,'market_trade','market_trade',$6,0,$7,$8,14,14,
         '2026-01-01T00:00:00.000Z'
       )`,
      [
        fixture.marketMovement,
        worldId,
        fixture.resourceType,
        fixture.sellerInventory,
        fixture.buyerInventory,
        fixture.trade,
        fixture.commands.purchaseListing,
        fixture.events.inventoryTransferred,
      ],
    );
    await connection.query(
      `insert into market_trades(
         id,world_id,listing_id,buyer_entity_id,seller_entity_id,
         buyer_inventory_id,seller_inventory_id,quantity,unit_price_minor,
         gross_minor,buyer_total_minor,seller_net_minor,tax_minor,fee_minor,
         currency_id,wallet_transaction_id,occurred_tick,idempotency_key,
         command_id,event_id,state_revision,created_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,4,25,100,100,100,0,0,$8,$9,14,
         'historical-purchase',$10,$11,14,'2026-01-01T00:00:00.000Z'
       )`,
      [
        fixture.trade,
        worldId,
        fixture.listing,
        fixture.buyerEntity,
        fixture.sellerEntity,
        fixture.buyerInventory,
        fixture.sellerInventory,
        fixture.currency,
        fixture.transaction,
        fixture.commands.purchaseListing,
        fixture.events.tradeCompleted,
      ],
    );
    await connection.query(
      `insert into world_runtime_heads(
         world_id,active_world_version_id,state_revision,last_ledger_sequence,
         last_event_sequence,ledger_anchored_at,ledger_anchor_event_id,
         anchor_artifact_hash,projection_checksum
       ) values (
         $1,$2,14,13,13,'2026-01-01T00:00:00.000Z',$3,
         decode(repeat('44',32),'hex'),decode(repeat('55',32),'hex')
       )`,
      [worldId, fixture.worldVersion, fixture.events.tradeCompleted],
    );
    await connection.query(
      `insert into world_economy_expansion_heads(
         world_id,source_world_version_id,seed_plan_hash,checksum,row_version,
         updated_state_revision,initialized_command_id,initialized_event_id,
         reconciliation_status
       ) values (
         $1,$2,decode(repeat('66',32),'hex'),decode(repeat('77',32),'hex'),
         1,14,$3,$4,'pending'
       )`,
      [
        worldId,
        fixture.worldVersion,
        fixture.commands.createContract,
        fixture.events.contractCreated,
      ],
    );
    await connection.query(
      `insert into projection_checkpoints(
         world_id,projection_name,projection_schema_version,
         last_event_sequence,checksum,status
       ) values (
         $1,'economy_closed_loop',1,13,decode(repeat('77',32),'hex'),'current'
       )`,
      [worldId],
    );
  });
}

async function inTransaction(
  client: DatabaseClient,
  operation: (connection: PoolClient) => Promise<void>,
): Promise<void> {
  const connection = await client.pool.connect();
  try {
    await connection.query('begin');
    await operation(connection);
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

interface TaxPolicyWindowFixture {
  applicability: Record<string, string>;
  effectiveFromTick: string;
  effectiveUntilTick: string | null;
  id: string;
  policyVersion: number;
  stableKey: string;
  taxType: 'periodic_flat' | 'sales';
}

async function insertTaxPolicyWindowFixtures(
  connection: PoolClient,
  worldId: string,
  rows: readonly TaxPolicyWindowFixture[],
): Promise<void> {
  await connection.query(
    `insert into tax_policies(
       id,world_id,stable_key,policy_version,authority_entity_id,
       treasury_wallet_id,currency_id,tax_type,collection_mode,rounding_mode,
       rate_basis_points,fixed_amount_minor,applicability,effective_from_tick,
       effective_until_tick,primitive_ref,primitive_key,primitive_version,
       primitive_version_id,primitive_content_hash,source_world_version_id,
       source_plan_hash,status,calculation_version,tax_policy_schema_version,
       checksum,created_command_id,created_event_id,created_state_revision,
       created_at
     )
     select
       (item ->> 'id')::uuid,$1::uuid,item ->> 'stableKey',
       (item ->> 'policyVersion')::integer,
       '018f0000-0000-7000-8000-00000000d701'::uuid,
       '018f0000-0000-7000-8000-00000000d702'::uuid,
       '018f0000-0000-7000-8000-00000000d703'::uuid,
       (item ->> 'taxType')::tax_policy_type,
       'added_to_payer'::tax_collection_mode,'floor',
       case when item ->> 'taxType' = 'periodic_flat' then null else 250 end,
       case when item ->> 'taxType' = 'periodic_flat' then 10 else null end,
       item -> 'applicability',(item ->> 'effectiveFromTick')::bigint,
       (item ->> 'effectiveUntilTick')::bigint,
       'tax-test','worldgraph.tax.test','1.0.0',
       '018f0000-0000-7000-8000-00000000d704'::uuid,
       decode(repeat('88',32),'hex'),
       '018f0000-0000-7000-8000-00000000d705'::uuid,
       decode(repeat('99',32),'hex'),'active',1,1,
       decode(repeat('aa',32),'hex'),
       '018f0000-0000-7000-8000-00000000d706'::uuid,
       '018f0000-0000-7000-8000-00000000d707'::uuid,1,
       '2026-01-01T00:00:00.000Z'
     from jsonb_array_elements($2::jsonb) item`,
    [worldId, JSON.stringify(rows)],
  );
}

async function insertWorldWithCreator(
  client: DatabaseClient,
  worldId: string,
  creatorId: string,
  slug: string,
): Promise<void> {
  await inTransaction(client, async (connection) => {
    await connection.query(
      `insert into worlds(id, slug, name, created_by_user_id)
       values ($1, $2, $3, $4)`,
      [worldId, slug, 'Floating Guild City', creatorId],
    );
    await connection.query(
      `insert into world_memberships(world_id, user_id, role, granted_by_user_id)
       values ($1, $2, 'creator', $2)`,
      [worldId, creatorId],
    );
  });
}

describe('platform and identity-authority migrations', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let client: DatabaseClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    client = createDatabaseClient(container.getConnectionUri(), 'migration-integration-test');
    await migrate(client.db, { migrationsFolder: migrationRoot });

    await client.pool.query(
      `insert into users(id, email, password_hash, display_name)
       values
         ($1, 'creator@example.test', $4, 'Creator'),
         ($2, 'member@example.test', $4, 'Member'),
         ($3, 'observer@example.test', $4, 'Observer')`,
      [userA, userB, userC, passwordHash],
    );
    await insertWorldWithCreator(client, worldA, userA, 'floating-guild-city');
  });

  afterAll(async () => {
    await client?.pool.end();
    await container?.stop();
  });

  it('installs required extensions and advances both public schema versions', async () => {
    const extensions = await client.pool.query<{ extname: string }>(
      "select extname from pg_extension where extname = any(array['postgis','vector','citext','pgcrypto','btree_gist']) order by extname",
    );
    expect(extensions.rows.map((row) => row.extname)).toEqual([
      'btree_gist',
      'citext',
      'pgcrypto',
      'postgis',
      'vector',
    ]);
    await expect(readRuntimeVersions(client.pool)).resolves.toMatchObject({
      compiler: '1.2.0',
      compilerArtifactSchema: 3,
      compilerConfigSchema: 1,
      compilationQueueSchema: 1,
      commerceProjectionRepairSchema: 1,
      contracts: 9,
      economyExpansionReconciliationSchema: 2,
      economyExpansionSchema: 1,
      economySeedPlanSchema: 2,
      manifestSchema: 1,
      primitiveSchema: 1,
      runtimeSchema: 9,
      simulationProcessRegistry: 2,
      worldGraphSchema: 1,
    });
  });

  it('enforces half-open active tax windows for one identical semantic scope', async () => {
    const testWorld = '018f0000-0000-7000-8000-00000000d100';
    await expect(
      inTransaction(client, async (connection) => {
        await connection.query(`set local session_replication_role='replica'`);
        await insertTaxPolicyWindowFixtures(connection, testWorld, [
          {
            applicability: {},
            effectiveFromTick: '0',
            effectiveUntilTick: '10',
            id: '018f0000-0000-7000-8000-00000000d101',
            policyVersion: 1,
            stableKey: 'tax-policy:test:sales-a',
            taxType: 'sales',
          },
          {
            applicability: {},
            effectiveFromTick: '10',
            effectiveUntilTick: null,
            id: '018f0000-0000-7000-8000-00000000d102',
            policyVersion: 2,
            stableKey: 'tax-policy:test:sales-b',
            taxType: 'sales',
          },
          {
            applicability: {
              intervalTicks: '5',
              payerEntityId: '018f0000-0000-7000-8000-00000000d711',
              payerWalletId: '018f0000-0000-7000-8000-00000000d712',
            },
            effectiveFromTick: '0',
            effectiveUntilTick: null,
            id: '018f0000-0000-7000-8000-00000000d103',
            policyVersion: 1,
            stableKey: 'tax-policy:test:dues-a',
            taxType: 'periodic_flat',
          },
          {
            applicability: {
              intervalTicks: '5',
              payerEntityId: '018f0000-0000-7000-8000-00000000d713',
              payerWalletId: '018f0000-0000-7000-8000-00000000d714',
            },
            effectiveFromTick: '0',
            effectiveUntilTick: null,
            id: '018f0000-0000-7000-8000-00000000d104',
            policyVersion: 2,
            stableKey: 'tax-policy:test:dues-b',
            taxType: 'periodic_flat',
          },
        ]);
        await connection.query(`delete from tax_policies where world_id=$1`, [testWorld]);
      }),
    ).resolves.toBeUndefined();
    await expect(
      inTransaction(client, async (connection) => {
        await connection.query(`set local session_replication_role='replica'`);
        await insertTaxPolicyWindowFixtures(connection, testWorld, [
          {
            applicability: {},
            effectiveFromTick: '0',
            effectiveUntilTick: '10',
            id: '018f0000-0000-7000-8000-00000000d101',
            policyVersion: 1,
            stableKey: 'tax-policy:test:sales-a',
            taxType: 'sales',
          },
          {
            applicability: {},
            effectiveFromTick: '9',
            effectiveUntilTick: '11',
            id: '018f0000-0000-7000-8000-00000000d105',
            policyVersion: 3,
            stableKey: 'tax-policy:test:sales-overlap',
            taxType: 'sales',
          },
        ]);
      }),
    ).rejects.toMatchObject({
      code: '23P01',
      constraint: 'tax_policies_active_scope_window_exclusion',
    });
    await expect(
      inTransaction(client, async (connection) => {
        await connection.query(`set local session_replication_role='replica'`);
        await insertTaxPolicyWindowFixtures(connection, testWorld, [
          {
            applicability: {
              intervalTicks: '5',
              payerEntityId: '018f0000-0000-7000-8000-00000000d711',
              payerWalletId: '018f0000-0000-7000-8000-00000000d712',
            },
            effectiveFromTick: '0',
            effectiveUntilTick: null,
            id: '018f0000-0000-7000-8000-00000000d106',
            policyVersion: 1,
            stableKey: 'tax-policy:test:dues-c',
            taxType: 'periodic_flat',
          },
          {
            applicability: {
              intervalTicks: '7',
              payerEntityId: '018f0000-0000-7000-8000-00000000d711',
              payerWalletId: '018f0000-0000-7000-8000-00000000d712',
            },
            effectiveFromTick: '5',
            effectiveUntilTick: '20',
            id: '018f0000-0000-7000-8000-00000000d107',
            policyVersion: 2,
            stableKey: 'tax-policy:test:dues-d',
            taxType: 'periodic_flat',
          },
        ]);
      }),
    ).rejects.toMatchObject({
      code: '23P01',
      constraint: 'tax_policies_active_scope_window_exclusion',
    });
  });

  it('installs the bounded deterministic M09 tax and reconciliation functions', async () => {
    const amount = await client.pool.query<{ amount: string }>(
      `select worldgraph_tax_amount_v1(101,250,0,'sales')::text as amount`,
    );
    expect(amount.rows[0]?.amount).toBe('2');
    await expect(
      client.pool.query(`select worldgraph_tax_amount_v1(100,5001,0,'sales')`),
    ).rejects.toMatchObject({ code: '22003' });
    const functions = await client.pool.query<{ proname: string }>(
      `select proname from pg_proc where proname in (
        'worldgraph_economy_expansion_projection_checksum',
        'worldgraph_materialize_world_commerce',
        'worldgraph_reconcile_economy_expansion',
        'worldgraph_user_controls_economy_entity_v1'
      ) order by proname`,
    );
    expect(functions.rows.map((row) => row.proname)).toEqual([
      'worldgraph_economy_expansion_projection_checksum',
      'worldgraph_materialize_world_commerce',
      'worldgraph_reconcile_economy_expansion',
      'worldgraph_user_controls_economy_entity_v1',
    ]);
    const authorityHelper = await client.pool.query<{
      app_can_execute: boolean;
      null_target_allowed: boolean;
      prosecdef: boolean;
      provolatile: string;
    }>(
      `select function.prosecdef,function.provolatile,
         has_function_privilege(
           'worldgraph_app',
           'worldgraph_user_controls_economy_entity_v1(uuid,uuid,uuid)',
           'EXECUTE'
         ) app_can_execute,
         not worldgraph_user_controls_economy_entity_v1($1,$2,null::uuid)
           null_target_allowed
       from pg_proc function
       where function.oid =
         'worldgraph_user_controls_economy_entity_v1(uuid,uuid,uuid)'::regprocedure`,
      [worldA, userA],
    );
    expect(authorityHelper.rows[0]).toEqual({
      app_can_execute: true,
      null_target_allowed: true,
      prosecdef: true,
      provolatile: 's',
    });
    const seedValidatorPrivileges = await client.pool.query<{
      public_can_execute: boolean;
      runtime_can_execute: boolean;
    }>(
      `select
         has_function_privilege(
           'worldgraph_app','worldgraph_economy_seed_plan_v2_is_valid(jsonb)','EXECUTE'
         ) runtime_can_execute,
         exists (
           select 1
           from pg_proc function,
             aclexplode(coalesce(function.proacl,acldefault('f',function.proowner))) privilege
           where function.oid =
             'worldgraph_economy_seed_plan_v2_is_valid(jsonb)'::regprocedure
             and privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
         ) public_can_execute`,
    );
    expect(seedValidatorPrivileges.rows[0]).toEqual({
      public_can_execute: false,
      runtime_can_execute: true,
    });
    const runtimeHelperPrivileges = await client.pool.query<{
      public_can_execute: boolean;
      runtime_can_execute: boolean;
      signature: string;
    }>(
      `select procedure.oid::regprocedure::text signature,
         has_function_privilege('worldgraph_app',procedure.oid,'EXECUTE')
           runtime_can_execute,
         exists (
           select 1
           from aclexplode(coalesce(
             procedure.proacl,acldefault('f',procedure.proowner)
           )) privilege
           where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
         ) public_can_execute
       from pg_proc procedure
       where procedure.oid = any(array[
         'worldgraph_quantity_fits_scale_v1(numeric,smallint)'::regprocedure,
         'worldgraph_recipe_version_is_valid_v1(uuid)'::regprocedure,
         'worldgraph_resource_tags_are_valid_v1(text[])'::regprocedure,
         'worldgraph_schedule_pair_is_valid_v2(text,text)'::regprocedure,
         'worldgraph_tax_amount_v1(bigint,integer,bigint,tax_policy_type)'::regprocedure
       ])
       order by signature`,
    );
    expect(runtimeHelperPrivileges.rows).toHaveLength(5);
    expect(runtimeHelperPrivileges.rows).toEqual(
      runtimeHelperPrivileges.rows.map((row) => ({
        public_can_execute: false,
        runtime_can_execute: true,
        signature: row.signature,
      })),
    );
    const scheduleGuard = await client.pool.query<{
      public_can_execute: boolean;
      prosecdef: boolean;
    }>(
      `select procedure.prosecdef,
         exists (
           select 1
           from aclexplode(coalesce(
             procedure.proacl,acldefault('f',procedure.proowner)
           )) privilege
           where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
         ) public_can_execute
       from pg_proc procedure
       where procedure.oid = 'worldgraph_protect_scheduled_action()'::regprocedure`,
    );
    expect(scheduleGuard.rows[0]).toEqual({ public_can_execute: false, prosecdef: true });

    const facilityTitleGuard = await client.pool.query<{
      public_can_execute: boolean;
      tgdeferrable: boolean;
      tginitdeferred: boolean;
      tgname: string;
    }>(
      `select trigger.tgname,trigger.tgdeferrable,trigger.tginitdeferred,
              exists (
                select 1
                  from aclexplode(coalesce(
                    procedure.proacl,acldefault('f',procedure.proowner)
                  )) privilege
                 where privilege.grantee=0 and privilege.privilege_type='EXECUTE'
              ) as public_can_execute
         from pg_trigger trigger
         join pg_proc procedure on procedure.oid=trigger.tgfoid
        where trigger.tgname='asset_ownership_preserves_facility_title'
          and procedure.oid=
            'worldgraph_assert_facility_asset_title_preserved()'::regprocedure`,
    );
    expect(facilityTitleGuard.rows).toEqual([
      {
        public_can_execute: false,
        tgdeferrable: true,
        tginitdeferred: true,
        tgname: 'asset_ownership_preserves_facility_title',
      },
    ]);

    const repairTables = await client.pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema='public' and table_name in (
          'commerce_projection_repair_plans',
          'commerce_projection_repair_plan_items',
          'commerce_projection_repair_approvals',
          'commerce_projection_repair_facts',
          'commerce_projection_repair_executions'
        )
        order by table_name`,
    );
    expect(repairTables.rows.map((row) => row.table_name)).toEqual([
      'commerce_projection_repair_approvals',
      'commerce_projection_repair_executions',
      'commerce_projection_repair_facts',
      'commerce_projection_repair_plan_items',
      'commerce_projection_repair_plans',
    ]);
    const repairTablePrivileges = await client.pool.query<{ privilege_count: number }>(
      `select count(*)::integer as privilege_count
         from information_schema.role_table_grants
        where grantee='worldgraph_app'
          and table_name like 'commerce_projection_repair_%'`,
    );
    expect(repairTablePrivileges.rows).toEqual([{ privilege_count: 0 }]);
    const repairFunctionPrivileges = await client.pool.query<{
      app_can_execute: boolean;
      prosecdef: boolean;
      public_can_execute: boolean;
      signature: string;
    }>(
      `select procedure.oid::regprocedure::text as signature,
              procedure.prosecdef,
              has_function_privilege('worldgraph_app',procedure.oid,'EXECUTE')
                as app_can_execute,
              exists (
                select 1 from aclexplode(coalesce(
                  procedure.proacl,acldefault('f',procedure.proowner)
                )) privilege
                 where privilege.grantee=0 and privilege.privilege_type='EXECUTE'
              ) as public_can_execute
         from pg_proc procedure
        where procedure.oid=any(array[
          'worldgraph_prepare_commerce_projection_repair(uuid,uuid,text)'::regprocedure,
          'worldgraph_approve_commerce_projection_repair(uuid,uuid,uuid,text,text)'::regprocedure,
          'worldgraph_execute_commerce_projection_repair(uuid,uuid,text,text)'::regprocedure
        ])
        order by signature`,
    );
    expect(repairFunctionPrivileges.rows).toHaveLength(3);
    expect(repairFunctionPrivileges.rows).toEqual(
      repairFunctionPrivileges.rows.map((row) => ({
        app_can_execute: false,
        prosecdef: true,
        public_can_execute: false,
        signature: row.signature,
      })),
    );
  });

  it('seals the M09 reconciliation helpers behind exact deferred evidence', async () => {
    const helperPrivileges = await client.pool.query<{
      app_can_execute: boolean;
      prosecdef: boolean;
      public_can_execute: boolean;
      signature: string;
    }>(
      `select procedure.oid::regprocedure::text as signature,
              procedure.prosecdef,
              has_function_privilege('worldgraph_app',procedure.oid,'EXECUTE')
                as app_can_execute,
              exists (
                select 1
                  from aclexplode(coalesce(
                    procedure.proacl,acldefault('f',procedure.proowner)
                  )) privilege
                 where privilege.grantee=0 and privilege.privilege_type='EXECUTE'
              ) as public_can_execute
         from pg_proc procedure
        where procedure.oid=any(array[
          'worldgraph_assert_economy_expansion_reconciliation_run()'::regprocedure,
          'worldgraph_commerce_command_authority_document(uuid,uuid,jsonb)'::regprocedure,
          'worldgraph_economy_reconciliation_documents_v2(uuid,uuid)'::regprocedure,
          'worldgraph_reconcile_economy_expansion(uuid)'::regprocedure,
          'worldgraph_reconcile_economy_expansion_v2(uuid,uuid)'::regprocedure,
          'worldgraph_record_commerce_command_payload_fact(uuid,uuid,jsonb)'::regprocedure
        ])
        order by signature`,
    );
    expect(helperPrivileges.rows).toEqual([
      {
        app_can_execute: false,
        prosecdef: true,
        public_can_execute: false,
        signature: 'worldgraph_assert_economy_expansion_reconciliation_run()',
      },
      {
        app_can_execute: false,
        prosecdef: false,
        public_can_execute: false,
        signature: 'worldgraph_commerce_command_authority_document(uuid,uuid,jsonb)',
      },
      {
        app_can_execute: false,
        prosecdef: false,
        public_can_execute: false,
        signature: 'worldgraph_economy_reconciliation_documents_v2(uuid,uuid)',
      },
      {
        app_can_execute: true,
        prosecdef: true,
        public_can_execute: false,
        signature: 'worldgraph_reconcile_economy_expansion(uuid)',
      },
      {
        app_can_execute: false,
        prosecdef: false,
        public_can_execute: false,
        signature: 'worldgraph_reconcile_economy_expansion_v2(uuid,uuid)',
      },
      {
        app_can_execute: true,
        prosecdef: true,
        public_can_execute: false,
        signature: 'worldgraph_record_commerce_command_payload_fact(uuid,uuid,jsonb)',
      },
    ]);

    const exactTrigger = await client.pool.query<{
      prosecdef: boolean;
      tgdeferrable: boolean;
      tginitdeferred: boolean;
    }>(
      `select procedure.prosecdef,trigger.tgdeferrable,trigger.tginitdeferred
         from pg_trigger trigger
         join pg_proc procedure on procedure.oid=trigger.tgfoid
        where trigger.tgname=
          'economy_expansion_reconciliation_runs_require_exact_evidence'
          and trigger.tgrelid='economy_expansion_reconciliation_runs'::regclass`,
    );
    expect(exactTrigger.rows).toEqual([
      { prosecdef: true, tgdeferrable: true, tginitdeferred: true },
    ]);

    const payrollFactTrigger = await client.pool.query<{
      prosecdef: boolean;
      tgdeferrable: boolean;
      tginitdeferred: boolean;
    }>(
      `select procedure.prosecdef,trigger.tgdeferrable,trigger.tginitdeferred
         from pg_trigger trigger
         join pg_proc procedure on procedure.oid=trigger.tgfoid
        where trigger.tgname='payroll_records_require_policy_selection_fact'
          and trigger.tgrelid='payroll_records'::regclass`,
    );
    expect(payrollFactTrigger.rows).toEqual([
      { prosecdef: true, tgdeferrable: true, tginitdeferred: true },
    ]);

    const factPrivileges = await client.pool.query<{
      commerce_delete: boolean;
      commerce_insert: boolean;
      commerce_select: boolean;
      commerce_update: boolean;
      payroll_insert: boolean;
      payroll_select: boolean;
      rate_scope_insert: boolean;
    }>(
      `select
         has_table_privilege(
           'worldgraph_app','commerce_command_payload_facts','SELECT'
         ) as commerce_select,
         has_table_privilege(
           'worldgraph_app','commerce_command_payload_facts','INSERT'
         ) as commerce_insert,
         has_table_privilege(
           'worldgraph_app','commerce_command_payload_facts','UPDATE'
         ) as commerce_update,
         has_table_privilege(
           'worldgraph_app','commerce_command_payload_facts','DELETE'
         ) as commerce_delete,
         has_table_privilege(
           'worldgraph_app','payroll_policy_selection_facts','SELECT'
         ) as payroll_select,
         has_table_privilege(
           'worldgraph_app','payroll_policy_selection_facts','INSERT'
         ) as payroll_insert,
         has_column_privilege(
           'worldgraph_app','command_records','rate_limit_scope_hash','INSERT'
         ) as rate_scope_insert`,
    );
    expect(factPrivileges.rows).toEqual([
      {
        commerce_delete: false,
        commerce_insert: false,
        commerce_select: false,
        commerce_update: false,
        payroll_insert: true,
        payroll_select: false,
        rate_scope_insert: true,
      },
    ]);

    const integrityShape = await client.pool.query<{
      checkpoint_columns: number;
      payload_fact_columns: number;
      rate_scope_columns: number;
      item_kind_constraint: string;
      timeline_indexes: string[];
    }>(
      `select
         (select count(*)::integer
            from information_schema.columns
           where table_schema='public'
             and table_name='economy_expansion_command_write_snapshots'
             and column_name in (
               'opened_checkpoint_event_sequence',
               'opened_checkpoint_checksum',
               'opened_checkpoint_status'
             )) as checkpoint_columns,
         (select count(*)::integer
            from information_schema.columns
           where table_schema='public'
             and table_name='commerce_command_payload_facts'
             and column_name in (
               'payload','authority','payload_hash','authority_hash',
               'boundary_event_sequence','boundary_head_checksum',
               'boundary_checkpoint_checksum','evidence_checksum'
             )) as payload_fact_columns,
         (select count(*)::integer
            from information_schema.columns
           where table_schema='public' and table_name='command_records'
             and column_name='rate_limit_scope_hash') as rate_scope_columns,
         (select pg_get_constraintdef(constraint.oid)
            from pg_constraint constraint
           where constraint.conname='economy_expansion_reconciliation_items_kind')
           as item_kind_constraint,
         (select array_agg(index.relname::text order by index.relname)
            from pg_class index
           where index.relname in (
             'financial_transactions_commerce_timeline_idx',
             'tax_assessments_world_cursor_idx',
             'command_records_commerce_rate_scope_idx'
           )) as timeline_indexes`,
    );
    expect(integrityShape.rows[0]).toMatchObject({
      checkpoint_columns: 3,
      payload_fact_columns: 8,
      rate_scope_columns: 1,
      timeline_indexes: [
        'command_records_commerce_rate_scope_idx',
        'financial_transactions_commerce_timeline_idx',
        'tax_assessments_world_cursor_idx',
      ],
    });
    expect(integrityShape.rows[0]!.item_kind_constraint).toContain("'reservation_lifecycle'::text");
    expect(integrityShape.rows[0]!.item_kind_constraint).toContain("'recipe_version'::text");
    expect(integrityShape.rows[0]!.item_kind_constraint).toContain("'tax_policy'::text");
  });

  it('supports an upgrade from the exact M01 head as well as the fresh install', async () => {
    const upgradeDatabase = 'worldgraph_m01_upgrade';
    await client.pool.query(`create database ${upgradeDatabase}`);

    const upgradeUrl = new URL(container.getConnectionUri());
    upgradeUrl.pathname = `/${upgradeDatabase}`;
    const upgradeClient = createDatabaseClient(upgradeUrl.toString(), 'm01-upgrade-test');
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'worldgraph-m01-migrations-'));

    try {
      await mkdir(join(temporaryRoot, 'meta'));
      await Promise.all([
        cp(
          join(migrationRoot, '0001_platform_extensions.sql'),
          join(temporaryRoot, '0001_platform_extensions.sql'),
        ),
        cp(
          join(migrationRoot, '0002_platform_metadata.sql'),
          join(temporaryRoot, '0002_platform_metadata.sql'),
        ),
      ]);
      await writeFile(
        join(temporaryRoot, 'meta/_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [
            {
              idx: 0,
              version: '7',
              when: 1784635200000,
              tag: '0001_platform_extensions',
              breakpoints: true,
            },
            {
              idx: 1,
              version: '7',
              when: 1784635260000,
              tag: '0002_platform_metadata',
              breakpoints: true,
            },
          ],
        }),
      );

      await migrate(upgradeClient.db, { migrationsFolder: temporaryRoot });
      await expect(readRuntimeVersions(upgradeClient.pool)).resolves.toMatchObject({
        contracts: 1,
        runtimeSchema: 1,
      });

      await migrate(upgradeClient.db, { migrationsFolder: migrationRoot });
      await expect(readRuntimeVersions(upgradeClient.pool)).resolves.toMatchObject({
        contracts: 9,
        manifestSchema: 1,
        primitiveSchema: 1,
        runtimeSchema: 9,
      });
      const tables = await upgradeClient.pool.query<{ table_name: string }>(
        `select table_name
         from information_schema.tables
         where table_schema = 'public'
           and table_name in ('users', 'sessions', 'worlds', 'world_memberships',
             'world_invitations', 'idempotency_records', 'security_audit_records',
             'creator_override_records')
         order by table_name`,
      );
      expect(tables.rowCount).toBe(8);
    } finally {
      await upgradeClient.pool.end();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('upgrades the exact M02 head without losing identity data and seeds idempotently', async () => {
    const upgradeDatabase = 'worldgraph_m02_upgrade';
    await client.pool.query(`create database ${upgradeDatabase}`);

    const upgradeUrl = new URL(container.getConnectionUri());
    upgradeUrl.pathname = `/${upgradeDatabase}`;
    const upgradeClient = createDatabaseClient(upgradeUrl.toString(), 'm02-upgrade-test');
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'worldgraph-m02-migrations-'));
    try {
      await mkdir(join(temporaryRoot, 'meta'));
      await Promise.all([
        cp(
          join(migrationRoot, '0001_platform_extensions.sql'),
          join(temporaryRoot, '0001_platform_extensions.sql'),
        ),
        cp(
          join(migrationRoot, '0002_platform_metadata.sql'),
          join(temporaryRoot, '0002_platform_metadata.sql'),
        ),
        cp(
          join(migrationRoot, '0003_identity_authority.sql'),
          join(temporaryRoot, '0003_identity_authority.sql'),
        ),
      ]);
      await writeFile(
        join(temporaryRoot, 'meta/_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [
            {
              idx: 0,
              version: '7',
              when: 1784635200000,
              tag: '0001_platform_extensions',
              breakpoints: true,
            },
            {
              idx: 1,
              version: '7',
              when: 1784635260000,
              tag: '0002_platform_metadata',
              breakpoints: true,
            },
            {
              idx: 2,
              version: '7',
              when: 1784635320000,
              tag: '0003_identity_authority',
              breakpoints: true,
            },
          ],
        }),
      );
      await migrate(upgradeClient.db, { migrationsFolder: temporaryRoot });
      await expect(readRuntimeVersions(upgradeClient.pool)).resolves.toMatchObject({
        contracts: 2,
        primitiveSchema: 0,
        runtimeSchema: 2,
      });
      await upgradeClient.pool.query(
        `insert into users(id, email, password_hash, display_name)
         values ($1, 'm02-upgrade@example.test', $2, 'M02 Upgrade')`,
        [userA, passwordHash],
      );
      await insertWorldWithCreator(upgradeClient, worldA, userA, 'm02-preserved-world');
      await upgradeClient.pool.query(
        `insert into sessions(
          id, user_id, token_hash, csrf_hash, auth_version, idle_expires_at, absolute_expires_at
        ) values ($1,$2,$3,$4,1,now() + interval '1 hour',now() + interval '1 day')`,
        ['018f0000-0000-7000-8000-000000000201', userA, Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
      );
      await upgradeClient.pool.query(
        `insert into idempotency_records(
          scope, actor_id, key, request_hash, response_status, response_body,
          state, expires_at
        ) values ('world.create',$1,'m02-preserve-key',$2,201,'{"id":"preserved"}'::jsonb,
          'completed',now() + interval '1 day')`,
        [userA, Buffer.alloc(32, 3)],
      );
      await upgradeClient.pool.query(
        `insert into security_audit_records(
          id, actor_user_id, world_id, category, action, outcome, reason_code,
          target_type, target_id, request_id, correlation_id
        ) values ($1,$2,$3,'world','world.created','succeeded','WORLD_CREATED',
          'world',$3,'m02-upgrade-request','m02-upgrade-correlation')`,
        ['018f0000-0000-7000-8000-000000000301', userA, worldA],
      );

      await migrate(upgradeClient.db, { migrationsFolder: migrationRoot });
      await expect(readRuntimeVersions(upgradeClient.pool)).resolves.toMatchObject({
        contracts: 9,
        manifestSchema: 1,
        primitiveSchema: 1,
        runtimeSchema: 9,
      });
      await expect(
        upgradeClient.pool.query(
          'select id from worlds where id = $1 and created_by_user_id = $2',
          [worldA, userA],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      const preserved = await upgradeClient.pool.query<{
        audits: string;
        idempotency: string;
        memberships: string;
        sessions: string;
      }>(
        `select
          (select count(*) from world_memberships where world_id = $1 and user_id = $2)::text as memberships,
          (select count(*) from sessions where id = '018f0000-0000-7000-8000-000000000201')::text as sessions,
          (select count(*) from idempotency_records where scope = 'world.create' and actor_id = $2 and key = 'm02-preserve-key')::text as idempotency,
          (select count(*) from security_audit_records where id = '018f0000-0000-7000-8000-000000000301')::text as audits`,
        [worldA, userA],
      );
      expect(preserved.rows[0]).toEqual({
        audits: '1',
        idempotency: '1',
        memberships: '1',
        sessions: '1',
      });
      await expect(importStarterPrimitives(upgradeClient.pool)).resolves.toEqual({
        imported: 19,
        unchanged: 0,
      });
      await expect(importStarterPrimitives(upgradeClient.pool)).resolves.toEqual({
        imported: 0,
        unchanged: 19,
      });
    } finally {
      await upgradeClient.pool.end();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('supports one spatial and vector query and repeat migration is a no-op', async () => {
    const result = await client.pool.query<{ distance: number; intersects: boolean }>(
      "select extensions.st_intersects(extensions.st_point(0, 0), extensions.st_point(0, 0)) as intersects, ('[1,2,3]'::extensions.vector OPERATOR(extensions.<->) '[1,2,4]'::extensions.vector)::float8 as distance",
    );
    expect(result.rows[0]).toEqual({ distance: 1, intersects: true });

    await migrate(client.db, { migrationsFolder: migrationRoot });
    await expect(
      client.pool.query(
        "insert into platform_metadata(key,value,value_schema_version) values ('invalid','{}',0)",
      ),
    ).rejects.toThrow();
  });

  it('requires exactly one active creator when an unarchived world commits', async () => {
    const missingCreatorWorld = '018f0000-0000-7000-8000-000000000102';
    await expect(
      inTransaction(client, async (connection) => {
        await connection.query(
          `insert into worlds(id, slug, name, created_by_user_id)
           values ($1, 'missing-creator', 'Missing Creator', $2)`,
          [missingCreatorWorld, userA],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });

    const missing = await client.pool.query('select id from worlds where id = $1', [
      missingCreatorWorld,
    ]);
    expect(missing.rowCount).toBe(0);

    await expect(
      client.pool.query(
        `insert into world_memberships(world_id, user_id, role, granted_by_user_id)
         values ($1, $2, 'creator', $3)`,
        [worldA, userB, userA],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      inTransaction(client, async (connection) => {
        await connection.query(
          `update world_memberships
           set role = 'player', row_version = row_version + 1, updated_at = now()
           where world_id = $1 and user_id = $2`,
          [worldA, userA],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });

    const creator = await client.pool.query<{ count: string }>(
      `select count(*)::text as count
       from world_memberships
       where world_id = $1 and role = 'creator' and status = 'active'`,
      [worldA],
    );
    expect(creator.rows[0]?.count).toBe('1');
  });

  it('preserves the last creator under concurrent removal attempts', async () => {
    const removeWithStatus = inTransaction(client, async (connection) => {
      await connection.query(
        `update world_memberships
         set status = 'removed', removed_at = now(), row_version = row_version + 1, updated_at = now()
         where world_id = $1 and user_id = $2`,
        [worldA, userA],
      );
    });
    const deleteRow = inTransaction(client, async (connection) => {
      await connection.query('delete from world_memberships where world_id = $1 and user_id = $2', [
        worldA,
        userA,
      ]);
    });

    const results = await Promise.allSettled([removeWithStatus, deleteRow]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);

    const creator = await client.pool.query<{ count: string }>(
      `select count(*)::text as count
       from world_memberships
       where world_id = $1 and role = 'creator' and status = 'active'`,
      [worldA],
    );
    expect(creator.rows[0]?.count).toBe('1');
  });

  it('stores only fixed-size session and invitation hashes and constrains invite grants', async () => {
    const secretColumns = await client.pool.query<{ column_name: string; table_name: string }>(
      `select table_name, column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name in ('sessions', 'world_invitations')
         and column_name in ('token', 'raw_token', 'csrf_token', 'session_token')`,
    );
    expect(secretColumns.rows).toEqual([]);

    await client.pool.query(
      `insert into sessions(
         id, user_id, token_hash, csrf_hash, auth_version, idle_expires_at, absolute_expires_at
       ) values (
         '018f0000-0000-7000-8000-000000000201', $1, decode(repeat('aa', 32), 'hex'),
         decode(repeat('bb', 32), 'hex'), 1, now() + interval '1 hour', now() + interval '1 day'
       )`,
      [userA],
    );
    await expect(
      client.pool.query(
        `insert into sessions(
           id, user_id, token_hash, csrf_hash, auth_version, idle_expires_at, absolute_expires_at
         ) values (
           '018f0000-0000-7000-8000-000000000202', $1, convert_to('plaintext', 'utf8'),
           decode(repeat('cc', 32), 'hex'), 1, now() + interval '1 hour', now() + interval '1 day'
         )`,
        [userA],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await client.pool.query(
      `insert into world_invitations(
         id, world_id, email, intended_role, token_hash, expires_at, created_by_user_id
       ) values (
         '018f0000-0000-7000-8000-000000000301', $1, 'invitee@example.test', 'player',
         decode(repeat('01', 32), 'hex'), now() + interval '1 day', $2
       )`,
      [worldA, userA],
    );
    await expect(
      client.pool.query(
        `insert into world_invitations(
           id, world_id, email, intended_role, token_hash, status, expires_at,
           created_by_user_id, accepted_by_user_id, accepted_at
         ) values (
           '018f0000-0000-7000-8000-000000000305', $1, 'late@example.test', 'player',
           decode(repeat('05', 32), 'hex'), 'accepted', now() + interval '1 hour',
           $2, $3, now() + interval '2 hours'
         )`,
        [worldA, userA, userB],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.pool.query(
        `insert into world_invitations(
           id, world_id, email, intended_role, token_hash, expires_at, created_by_user_id
         ) values (
           '018f0000-0000-7000-8000-000000000302', $1, 'admin@example.test', 'administrator',
           decode(repeat('02', 32), 'hex'), now() + interval '1 day', $2
         )`,
        [worldA, userA],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.pool.query(
        `insert into world_invitations(
           id, world_id, email, intended_role, token_hash, expires_at, created_by_user_id
         ) values (
           '018f0000-0000-7000-8000-000000000303', $1, 'INVITEE@example.test', 'observer',
           decode(repeat('03', 32), 'hex'), now() + interval '1 day', $2
         )`,
        [worldA, userA],
      ),
    ).rejects.toThrow();

    await client.pool.query(
      `update world_invitations
       set status = 'revoked', revoked_at = now(), row_version = row_version + 1
       where id = '018f0000-0000-7000-8000-000000000301'`,
    );
    await client.pool.query(
      `insert into world_invitations(
         id, world_id, email, intended_role, token_hash, expires_at, created_by_user_id
       ) values (
         '018f0000-0000-7000-8000-000000000304', $1, 'invitee@example.test', 'observer',
         decode(repeat('04', 32), 'hex'), now() + interval '1 day', $2
       )`,
      [worldA, userA],
    );
  });

  it('bounds optimistic versions and preserves immutable world provenance', async () => {
    await expect(
      client.pool.query('update users set row_version = 0 where id = $1', [userB]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.pool.query('update worlds set created_by_user_id = $2 where id = $1', [worldA, userB]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('keeps idempotency responses bounded and free of secret-bearing keys', async () => {
    await client.pool.query(
      `insert into idempotency_records(
         scope, actor_id, key, request_hash, response_status, response_body, state, expires_at
       ) values (
         'world.create', $1, 'safe-key-0001', decode(repeat('10', 32), 'hex'), 201,
         '{"worldId":"018f0000-0000-7000-8000-000000000101"}', 'completed',
         now() + interval '1 day'
       )`,
      [userA],
    );
    await expect(
      client.pool.query(
        `insert into idempotency_records(
           scope, actor_id, key, request_hash, response_status, response_body, state, expires_at
         ) values (
           'invitation.create', $1, 'unsafe-key-01', decode(repeat('11', 32), 'hex'), 201,
           '{"invitation":{"raw_token":"must-not-persist"}}', 'completed',
           now() + interval '1 day'
         )`,
        [userA],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('makes audit and creator-override records append-only and enforces their link', async () => {
    const auditId = '018f0000-0000-7000-8000-000000000401';
    await client.pool.query(
      `insert into security_audit_records(
         id, actor_user_id, world_id, category, action, outcome, reason_code,
         target_type, target_id, request_id, correlation_id, redacted_metadata
       ) values (
         $1, $2, $3, 'authority', 'membership.forceRemove', 'succeeded', 'OVERRIDE_APPLIED',
         'membership', $4, 'request-0001', 'correlation-0001', '{"role":"administrator"}'
       )`,
      [auditId, userA, worldA, userB],
    );
    await client.pool.query(
      `insert into creator_override_records(
         id, world_id, actor_user_id, action, target_type, target_id, reason,
         authority_rule_id, command_id, audit_record_id
       ) values (
         '018f0000-0000-7000-8000-000000000402', $1, $2, 'membership.forceRemove',
         'membership', $3, 'Administrator removal requires an explicit override.',
         'world.creator.explicitOverride', '018f0000-0000-7000-8000-000000000403', $4
       )`,
      [worldA, userA, userB, auditId],
    );

    await expect(
      client.pool.query('update security_audit_records set outcome = $2 where id = $1', [
        auditId,
        'failed',
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      client.pool.query('delete from creator_override_records where audit_record_id = $1', [
        auditId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      client.pool.query(
        `insert into security_audit_records(
           id, actor_user_id, world_id, category, action, outcome, reason_code,
           request_id, correlation_id, redacted_metadata
         ) values (
           '018f0000-0000-7000-8000-000000000404', $1, $2, 'identity', 'session.created',
           'succeeded', 'SESSION_CREATED', 'request-0002', 'correlation-0002',
           '{"nested":{"sessionToken":"must-not-persist"}}'
         )`,
        [userA, worldA],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const otherAuditId = '018f0000-0000-7000-8000-000000000405';
    await client.pool.query(
      `insert into security_audit_records(
         id, actor_user_id, world_id, category, action, outcome, reason_code,
         request_id, correlation_id
       ) values (
         $1, $2, $3, 'authority', 'membership.forceRemove', 'succeeded',
         'OVERRIDE_APPLIED', 'request-0003', 'correlation-0003'
       )`,
      [otherAuditId, userB, worldA],
    );
    await expect(
      client.pool.query(
        `insert into creator_override_records(
           id, world_id, actor_user_id, action, target_type, target_id, reason,
           authority_rule_id, command_id, audit_record_id
         ) values (
           '018f0000-0000-7000-8000-000000000406', $1, $2, 'membership.forceRemove',
           'membership', $3, 'This link deliberately has the wrong actor.',
           'world.creator.explicitOverride', '018f0000-0000-7000-8000-000000000407', $4
         )`,
        [worldA, userA, userB, otherAuditId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('grants only required user mutation and no audit rewrite access to the runtime role', async () => {
    const privileges = await client.pool.query<{
      privilege_type: string;
      table_name: string;
    }>(
      `select table_name, privilege_type
       from information_schema.role_table_grants
       where grantee = 'worldgraph_app'
         and table_name in ('security_audit_records', 'creator_override_records')
       order by table_name, privilege_type`,
    );
    expect(privileges.rows).toEqual([
      { table_name: 'creator_override_records', privilege_type: 'INSERT' },
      { table_name: 'creator_override_records', privilege_type: 'SELECT' },
      { table_name: 'security_audit_records', privilege_type: 'INSERT' },
      { table_name: 'security_audit_records', privilege_type: 'SELECT' },
    ]);

    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'worldgraph_app';
    runtimeUrl.password = 'worldgraph_app_local_only';
    const runtimeClient = createDatabaseClient(runtimeUrl.toString(), 'runtime-role-test');
    const runtimeAuditId = '018f0000-0000-7000-8000-000000000408';
    const runtimeUserId = '018f0000-0000-7000-8000-000000000409';
    try {
      await runtimeClient.pool.query(
        `insert into users(id, email, password_hash, display_name)
         values ($1, 'runtime-created@example.test', $2, 'Runtime Created')`,
        [runtimeUserId, passwordHash],
      );
      await runtimeClient.pool.query('update users set last_login_at = now() where id = $1', [
        runtimeUserId,
      ]);
      for (const [column, value] of [
        ['platform_role', "'platform_admin'"],
        ['status', "'disabled'"],
        ['auth_version', '2'],
        ['password_hash', "'$argon2id$v=19$m=65536,t=3,p=1$changed$changed-hash-value'"],
      ]) {
        await expect(
          runtimeClient.pool.query(`update users set ${column} = ${value} where id = $1`, [
            runtimeUserId,
          ]),
        ).rejects.toMatchObject({ code: '42501' });
      }
      await runtimeClient.pool.query(
        `insert into security_audit_records(
           id, category, action, outcome, reason_code, request_id, correlation_id
         ) values ($1, 'identity', 'session.checked', 'allowed', 'SESSION_ACTIVE',
                   'request-runtime', 'correlation-runtime')`,
        [runtimeAuditId],
      );
      await expect(
        runtimeClient.pool.query(
          `update security_audit_records set outcome = 'failed' where id = $1`,
          [runtimeAuditId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtimeClient.pool.end();
    }
  });

  it('upgrades the exact M11 head to M12 once with stable metadata', async () => {
    const upgradeDatabase = 'worldgraph_m11_upgrade';
    await client.pool.query(`create database ${upgradeDatabase}`);
    const upgradeUrl = new URL(container.getConnectionUri());
    upgradeUrl.pathname = `/${upgradeDatabase}`;
    const upgradeClient = createDatabaseClient(upgradeUrl.toString(), 'm11-upgrade-test');
    const temporaryRoot = await createM11MigrationRoot('worldgraph-m11-migrations-');
    const historicalWorld = '018f0000-0000-7000-8000-00000000b120';
    try {
      await migrate(upgradeClient.db, { migrationsFolder: temporaryRoot });
      const before = await upgradeClient.pool.query<{
        checkpoint_columns: number;
        selection_table: string | null;
      }>(
        `select
           (select count(*)::integer
              from information_schema.columns
             where table_schema='public'
               and table_name='economy_expansion_command_write_snapshots'
               and column_name like 'opened_checkpoint_%') as checkpoint_columns,
           to_regclass('public.payroll_policy_selection_facts')::text as selection_table`,
      );
      expect(before.rows).toEqual([{ checkpoint_columns: 0, selection_table: null }]);

      await upgradeClient.pool.query(
        `insert into users(id,email,password_hash,display_name)
         values ($1,'m11-upgrade@example.test',$2,'M11 Upgrade')`,
        [userA, passwordHash],
      );
      await insertWorldWithCreator(upgradeClient, historicalWorld, userA, 'm11-commerce-history');
      const historicalCommand = '018f0000-0000-7000-8000-00000000b121';
      const historicalContract = '018f0000-0000-7000-8000-00000000b122';
      const historicalWork = '018f0000-0000-7000-8000-00000000b123';
      const historicalPayroll = '018f0000-0000-7000-8000-00000000b124';
      const historicalEvent = '018f0000-0000-7000-8000-00000000b125';
      const historicalSchedule = '018f0000-0000-7000-8000-00000000b126';
      await inTransaction(upgradeClient, async (connection) => {
        await connection.query(`set local session_replication_role='replica'`);
        await connection.query(
          `insert into command_records(
             id,world_id,command_type,command_schema_version,actor_type,actor_id,
             payload,payload_hash,payload_classification,idempotency_key,
             request_hash,status,authorization_rule_id,correlation_id,
             requested_at,decided_at,resulting_state_revision,response_summary
           ) values (
             $1,$2,'PerformJobV1',1,'user',$3,null,
             decode(repeat('11',32),'hex'),'public','historical-payroll',
             decode(repeat('22',32),'hex'),'accepted','world.command',
             $1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',7,
             '{"status":"accepted"}'::jsonb
           )`,
          [historicalCommand, historicalWorld, userA],
        );
        await connection.query(
          `insert into domain_events(
             id,world_id,world_event_sequence,command_id,event_ordinal,
             aggregate_type,aggregate_id,aggregate_version,event_type,
             event_schema_version,payload,metadata,event_hash,occurred_at,
             recorded_at,resulting_state_revision
           ) values (
             $1,$2,1,$3,0,'work_record',$4,1,'WorkRecordedV1',1,
             jsonb_build_object(
               'aggregateVersion','1','contractId',$5::text,
               'payrollRecordId',$6::text,'taxPolicyId',null,
               'tick','5','workRecordId',$4::text
             ),
             '{}'::jsonb,decode(repeat('33',32),'hex'),
             '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',7
           )`,
          [
            historicalEvent,
            historicalWorld,
            historicalCommand,
            historicalWork,
            historicalContract,
            historicalPayroll,
          ],
        );
        await connection.query(
          `insert into work_records(
             id,world_id,contract_id,work_key,performed_tick,validated_output,
             gross_minor,command_id,event_id,state_revision,created_at
           ) values (
             $1,$2,$3,'historical-work',5,'{}'::jsonb,100,$4,$5,7,
             '2026-01-01T00:00:00.000Z'
           )`,
          [historicalWork, historicalWorld, historicalContract, historicalCommand, historicalEvent],
        );
        await connection.query(
          `insert into payroll_records(
             id,world_id,contract_id,work_record_id,scheduled_action_id,
             pay_period_key,gross_minor,tax_minor,net_minor,tax_policy_id,
             status,row_version,created_command_id,created_event_id,
             created_state_revision,created_at,updated_at
           ) values (
             $1,$2,$3,$4,$5,'0:historical',100,0,100,null,
             'pending',1,$6,$7,7,
             '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
           )`,
          [
            historicalPayroll,
            historicalWorld,
            historicalContract,
            historicalWork,
            historicalSchedule,
            historicalCommand,
            historicalEvent,
          ],
        );
      });
      await seedM11CommercePayloadBaselines(upgradeClient, historicalWorld);

      await migrate(upgradeClient.db, { migrationsFolder: migrationRoot });
      const after = await upgradeClient.pool.query<{
        checkpoint_columns: number;
        payload_fact_table: string | null;
        rate_scope_columns: number;
        migration_count: number;
        selection_count: number;
        selection_table: string | null;
      }>(
        `select
           (select count(*)::integer
              from information_schema.columns
             where table_schema='public'
               and table_name='economy_expansion_command_write_snapshots'
               and column_name like 'opened_checkpoint_%') as checkpoint_columns,
           (select count(*)::integer from drizzle.__drizzle_migrations)
             as migration_count,
           to_regclass('public.payroll_policy_selection_facts')::text
             as selection_table,
           to_regclass('public.commerce_command_payload_facts')::text
             as payload_fact_table,
           (select count(*)::integer
              from information_schema.columns
             where table_schema='public' and table_name='command_records'
               and column_name='rate_limit_scope_hash') as rate_scope_columns,
           (select count(*)::integer
              from payroll_policy_selection_facts
             where payroll_record_id=$1) as selection_count`,
        [historicalPayroll],
      );
      expect(after.rows).toEqual([
        {
          checkpoint_columns: 3,
          migration_count: 12,
          payload_fact_table: 'commerce_command_payload_facts',
          rate_scope_columns: 1,
          selection_count: 1,
          selection_table: 'payroll_policy_selection_facts',
        },
      ]);
      const payloadFacts = await upgradeClient.pool.query<{
        authority_id: string | null;
        command_payload_is_private: boolean;
        command_type: string;
        evidence_source: string;
        hashes_valid: boolean;
        payload_binding: string | null;
      }>(
        `select fact.command_type,fact.evidence_source,
           command.payload is null as command_payload_is_private,
           fact.payload_hash=extensions.digest(convert_to(
             worldgraph_canonical_jsonb(fact.payload),'UTF8'
           ),'sha256')
           and fact.authority_hash=extensions.digest(convert_to(
             worldgraph_canonical_jsonb(fact.authority),'UTF8'
           ),'sha256')
           and fact.evidence_checksum=extensions.digest(convert_to(
             worldgraph_canonical_jsonb(jsonb_build_object(
               'commandId',fact.command_id::text,
               'commandType',fact.command_type,
               'evidenceSource',fact.evidence_source,
               'authorityHash',encode(fact.authority_hash,'hex'),
               'boundaryCheckpointChecksum',
                 encode(fact.boundary_checkpoint_checksum,'hex'),
               'boundaryEventSequence',fact.boundary_event_sequence::text,
               'boundaryHeadChecksum',encode(fact.boundary_head_checksum,'hex'),
               'payloadHash',encode(fact.payload_hash,'hex'),
               'worldId',fact.world_id::text
             )
           ),'UTF8'),'sha256')
           and fact.boundary_event_sequence=runtime.last_event_sequence
           and fact.boundary_head_checksum=head.checksum
           and fact.boundary_checkpoint_checksum=checkpoint.checksum
             as hashes_valid,
           case fact.command_type
             when 'CreateEmploymentContractV1'
               then fact.payload->>'workerEntityKey'
             when 'EndEmploymentContractV1' then fact.payload->>'reason'
             when 'StartProductionRunV1'
               then fact.payload->>'recipeVersionId'
             when 'CreateMarketListingV1'
               then fact.payload->>'sellerInventoryId'
             when 'PurchaseMarketListingV1'
               then fact.payload->>'buyerInventoryId'
           end as payload_binding,
           case fact.command_type
             when 'CreateEmploymentContractV1'
               then fact.authority->>'contractId'
             when 'EndEmploymentContractV1'
               then fact.authority->>'contractId'
             when 'StartProductionRunV1'
               then fact.authority->>'productionRunId'
             when 'CreateMarketListingV1'
               then fact.authority->>'listingId'
             when 'PurchaseMarketListingV1'
               then fact.authority->>'tradeId'
           end as authority_id
         from commerce_command_payload_facts fact
         join command_records command
           on command.id=fact.command_id and command.world_id=fact.world_id
         join world_runtime_heads runtime on runtime.world_id=fact.world_id
         join world_economy_expansion_heads head on head.world_id=fact.world_id
         join projection_checkpoints checkpoint
           on checkpoint.world_id=fact.world_id
          and checkpoint.projection_name='economy_closed_loop'
        where fact.world_id=$1
        order by fact.command_type`,
        [historicalWorld],
      );
      expect(payloadFacts.rows).toEqual([
        {
          authority_id: commerceUpgradeFixture.contract,
          command_payload_is_private: true,
          command_type: 'CreateEmploymentContractV1',
          evidence_source: 'migration_baseline',
          hashes_valid: true,
          payload_binding: 'org:worker',
        },
        {
          authority_id: commerceUpgradeFixture.listing,
          command_payload_is_private: true,
          command_type: 'CreateMarketListingV1',
          evidence_source: 'migration_baseline',
          hashes_valid: true,
          payload_binding: commerceUpgradeFixture.sellerInventory,
        },
        {
          authority_id: commerceUpgradeFixture.contract,
          command_payload_is_private: true,
          command_type: 'EndEmploymentContractV1',
          evidence_source: 'migration_baseline',
          hashes_valid: true,
          payload_binding: 'historical-upgrade',
        },
        {
          authority_id: commerceUpgradeFixture.trade,
          command_payload_is_private: true,
          command_type: 'PurchaseMarketListingV1',
          evidence_source: 'migration_baseline',
          hashes_valid: true,
          payload_binding: commerceUpgradeFixture.buyerInventory,
        },
        {
          authority_id: commerceUpgradeFixture.productionRun,
          command_payload_is_private: true,
          command_type: 'StartProductionRunV1',
          evidence_source: 'migration_baseline',
          hashes_valid: true,
          payload_binding: commerceUpgradeFixture.recipeVersion,
        },
      ]);
      const terminalHistory = await upgradeClient.pool.query<{
        listing_reservation_status: string;
        listing_status: string;
        production_reservation_status: string;
        production_status: string;
        production_transitions: number;
      }>(
        `select
           (select status::text from production_runs where id=$1)
             as production_status,
           (select count(*)::integer from production_run_transitions
             where run_id=$1) as production_transitions,
           (select status::text from inventory_reservations where id=$2)
             as production_reservation_status,
           (select status::text from market_listings where id=$3)
             as listing_status,
           (select status::text from inventory_reservations where id=$4)
             as listing_reservation_status`,
        [
          commerceUpgradeFixture.productionRun,
          commerceUpgradeFixture.productionReservation,
          commerceUpgradeFixture.listing,
          commerceUpgradeFixture.listingReservation,
        ],
      );
      expect(terminalHistory.rows).toEqual([
        {
          listing_reservation_status: 'consumed',
          listing_status: 'filled',
          production_reservation_status: 'consumed',
          production_status: 'completed',
          production_transitions: 2,
        },
      ]);
      const retryAuthority = await upgradeClient.pool.query<{
        app_can_delete: boolean;
        app_can_execute: boolean;
        app_can_execute_protect: boolean;
        app_can_insert: boolean;
        app_can_select: boolean;
        app_can_update: boolean;
        check_constraints: string[];
        function_is_security_definer: boolean;
        function_is_owned_by_current_user: boolean;
        message_world_fk: string;
        outbox_message_world_identity: string;
        protect_function_is_security_definer: boolean;
        public_can_execute_protect: boolean;
        public_can_execute_retry: boolean;
        retry_function: string | null;
        retry_table: string | null;
      }>(
        `select
           to_regclass('public.outbox_retry_intents')::text as retry_table,
           to_regprocedure(
             'public.worldgraph_retry_dead_outbox_message(uuid,uuid,uuid,uuid,text,text)'
           )::text as retry_function,
           procedure.prosecdef as function_is_security_definer,
           procedure.proowner=current_user::regrole
             as function_is_owned_by_current_user,
           (select guard.prosecdef
              from pg_proc guard
             where guard.oid='worldgraph_protect_outbox_message()'::regprocedure)
             as protect_function_is_security_definer,
           exists (
             select 1
             from aclexplode(coalesce(
               procedure.proacl,acldefault('f',procedure.proowner)
             )) privilege
             where privilege.grantee=0
               and privilege.privilege_type='EXECUTE'
           ) as public_can_execute_retry,
           exists (
             select 1
             from pg_proc guard,
               aclexplode(coalesce(
                 guard.proacl,acldefault('f',guard.proowner)
               )) privilege
             where guard.oid='worldgraph_protect_outbox_message()'::regprocedure
               and privilege.grantee=0
               and privilege.privilege_type='EXECUTE'
           ) as public_can_execute_protect,
           has_table_privilege(
             'worldgraph_app','outbox_retry_intents','SELECT'
           ) as app_can_select,
           has_table_privilege(
             'worldgraph_app','outbox_retry_intents','INSERT'
           ) as app_can_insert,
           has_table_privilege(
             'worldgraph_app','outbox_retry_intents','UPDATE'
           ) as app_can_update,
           has_table_privilege(
             'worldgraph_app','outbox_retry_intents','DELETE'
           ) as app_can_delete,
           has_function_privilege(
             'worldgraph_app',
             'worldgraph_retry_dead_outbox_message(uuid,uuid,uuid,uuid,text,text)',
             'EXECUTE'
           ) as app_can_execute,
           has_function_privilege(
             'worldgraph_app','worldgraph_protect_outbox_message()','EXECUTE'
           ) as app_can_execute_protect,
           (select pg_get_constraintdef(constraint.oid)
              from pg_constraint constraint
             where constraint.conrelid='outbox_retry_intents'::regclass
               and constraint.conname='outbox_retry_intents_message_world_fk')
             as message_world_fk,
           (select pg_get_constraintdef(constraint.oid)
              from pg_constraint constraint
             where constraint.conrelid='outbox_messages'::regclass
               and constraint.conname='outbox_messages_world_identity')
             as outbox_message_world_identity,
           (select array_agg(constraint.conname order by constraint.conname)
              from pg_constraint constraint
             where constraint.conrelid='outbox_retry_intents'::regclass
               and constraint.conname in (
                 'outbox_retry_intents_attempts_positive',
                 'outbox_retry_intents_gate_hash_length',
                 'outbox_retry_intents_reason_valid',
                 'outbox_retry_intents_timestamp_canonical'
               )) as check_constraints
         from pg_proc procedure
        where procedure.oid=
          'worldgraph_retry_dead_outbox_message(uuid,uuid,uuid,uuid,text,text)'
          ::regprocedure`,
      );
      expect(retryAuthority.rows).toEqual([
        {
          app_can_delete: false,
          app_can_execute: false,
          app_can_execute_protect: false,
          app_can_insert: false,
          app_can_select: false,
          app_can_update: false,
          check_constraints: [
            'outbox_retry_intents_attempts_positive',
            'outbox_retry_intents_gate_hash_length',
            'outbox_retry_intents_reason_valid',
            'outbox_retry_intents_timestamp_canonical',
          ],
          function_is_owned_by_current_user: true,
          function_is_security_definer: true,
          message_world_fk:
            'FOREIGN KEY (world_id, outbox_message_id) REFERENCES outbox_messages(world_id, id) ON DELETE RESTRICT',
          outbox_message_world_identity: 'UNIQUE (world_id, id)',
          protect_function_is_security_definer: true,
          public_can_execute_protect: false,
          public_can_execute_retry: false,
          retry_function: 'worldgraph_retry_dead_outbox_message(uuid,uuid,uuid,uuid,text,text)',
          retry_table: 'outbox_retry_intents',
        },
      ]);
      await migrate(upgradeClient.db, { migrationsFolder: migrationRoot });
      const repeated = await upgradeClient.pool.query<{ migration_count: number }>(
        `select count(*)::integer as migration_count
           from drizzle.__drizzle_migrations`,
      );
      expect(repeated.rows).toEqual([{ migration_count: 12 }]);
    } finally {
      await upgradeClient.pool.end();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rejects overlapping M11 tax scopes without leaving partial M12 effects', async () => {
    const upgradeDatabase = 'worldgraph_m11_overlapping_tax_upgrade';
    await client.pool.query(`create database ${upgradeDatabase}`);
    const upgradeUrl = new URL(container.getConnectionUri());
    upgradeUrl.pathname = `/${upgradeDatabase}`;
    const upgradeClient = createDatabaseClient(
      upgradeUrl.toString(),
      'm11-overlapping-tax-upgrade-test',
    );
    const temporaryRoot = await createM11MigrationRoot(
      'worldgraph-m11-overlapping-tax-migrations-',
    );
    const historicalWorld = '018f0000-0000-7000-8000-00000000d200';
    try {
      await migrate(upgradeClient.db, { migrationsFolder: temporaryRoot });
      await inTransaction(upgradeClient, async (connection) => {
        await connection.query(`set local session_replication_role='replica'`);
        await insertTaxPolicyWindowFixtures(connection, historicalWorld, [
          {
            applicability: {
              intervalTicks: '5',
              payerEntityId: '018f0000-0000-7000-8000-00000000d711',
              payerWalletId: '018f0000-0000-7000-8000-00000000d712',
            },
            effectiveFromTick: '0',
            effectiveUntilTick: null,
            id: '018f0000-0000-7000-8000-00000000d201',
            policyVersion: 1,
            stableKey: 'tax-policy:test:dues-old',
            taxType: 'periodic_flat',
          },
          {
            applicability: {
              intervalTicks: '7',
              payerEntityId: '018f0000-0000-7000-8000-00000000d711',
              payerWalletId: '018f0000-0000-7000-8000-00000000d712',
            },
            effectiveFromTick: '5',
            effectiveUntilTick: '20',
            id: '018f0000-0000-7000-8000-00000000d202',
            policyVersion: 2,
            stableKey: 'tax-policy:test:dues-new',
            taxType: 'periodic_flat',
          },
        ]);
      });

      await expect(
        migrate(upgradeClient.db, { migrationsFolder: migrationRoot }),
      ).rejects.toMatchObject({
        cause: {
          code: '23514',
          constraint: 'tax_policies_active_scope_window_exclusion',
        },
      });
      const rollback = await upgradeClient.pool.query<{
        constraint_name: string | null;
        extension_installed: boolean;
        migration_count: number;
      }>(
        `select
           (select count(*)::integer from drizzle.__drizzle_migrations)
             as migration_count,
           exists (
             select 1 from pg_extension where extname='btree_gist'
           ) as extension_installed,
           (
             select constraint.conname
             from pg_constraint constraint
             where constraint.conrelid='tax_policies'::regclass
               and constraint.conname=
                 'tax_policies_active_scope_window_exclusion'
           ) as constraint_name`,
      );
      expect(rollback.rows).toEqual([
        {
          constraint_name: null,
          extension_installed: false,
          migration_count: 11,
        },
      ]);
    } finally {
      await upgradeClient.pool.end();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rejects ambiguous M11 commerce evidence without leaving partial M12 effects', async () => {
    const upgradeDatabase = 'worldgraph_m11_ambiguous_upgrade';
    await client.pool.query(`create database ${upgradeDatabase}`);
    const upgradeUrl = new URL(container.getConnectionUri());
    upgradeUrl.pathname = `/${upgradeDatabase}`;
    const upgradeClient = createDatabaseClient(upgradeUrl.toString(), 'm11-ambiguous-upgrade-test');
    const temporaryRoot = await createM11MigrationRoot('worldgraph-m11-ambiguous-migrations-');
    const historicalWorld = '018f0000-0000-7000-8000-00000000b220';
    try {
      await migrate(upgradeClient.db, { migrationsFolder: temporaryRoot });
      await upgradeClient.pool.query(
        `insert into users(id,email,password_hash,display_name)
         values ($1,'m11-ambiguous@example.test',$2,'M11 Ambiguous')`,
        [userA, passwordHash],
      );
      await insertWorldWithCreator(
        upgradeClient,
        historicalWorld,
        userA,
        'm11-ambiguous-commerce-history',
      );
      await seedM11CommercePayloadBaselines(upgradeClient, historicalWorld, {
        ambiguousListingReservation: true,
      });

      await expect(
        migrate(upgradeClient.db, { migrationsFolder: migrationRoot }),
      ).rejects.toMatchObject({
        cause: {
          code: '23514',
          constraint: 'commerce_command_authority_listing_reservation_exact',
        },
      });
      const rollback = await upgradeClient.pool.query<{
        checkpoint_columns: number;
        migration_count: number;
        outbox_world_identity_constraints: number;
        payload_fact_table: string | null;
        rate_scope_columns: number;
        retry_function: string | null;
        retry_intent_table: string | null;
      }>(
        `select
           (select count(*)::integer from drizzle.__drizzle_migrations)
             as migration_count,
           (select count(*)::integer
              from information_schema.columns
             where table_schema='public'
               and table_name='economy_expansion_command_write_snapshots'
               and column_name like 'opened_checkpoint_%') as checkpoint_columns,
           (select count(*)::integer
              from information_schema.columns
             where table_schema='public' and table_name='command_records'
               and column_name='rate_limit_scope_hash') as rate_scope_columns,
           to_regclass('public.commerce_command_payload_facts')::text
             as payload_fact_table,
           to_regclass('public.outbox_retry_intents')::text
             as retry_intent_table,
           to_regprocedure(
             'public.worldgraph_retry_dead_outbox_message(uuid,uuid,uuid,uuid,text,text)'
           )::text as retry_function,
           (select count(*)::integer
              from pg_constraint constraint
             where constraint.conrelid='outbox_messages'::regclass
               and constraint.conname='outbox_messages_world_identity')
             as outbox_world_identity_constraints`,
      );
      expect(rollback.rows).toEqual([
        {
          checkpoint_columns: 0,
          migration_count: 11,
          outbox_world_identity_constraints: 0,
          payload_fact_table: null,
          rate_scope_columns: 0,
          retry_function: null,
          retry_intent_table: null,
        },
      ]);
    } finally {
      await upgradeClient.pool.end();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('declares the creator constraint triggers deferred by default', async () => {
    const triggers = await client.pool.query<{
      tgdeferrable: boolean;
      tginitdeferred: boolean;
      tgname: string;
    }>(
      `select tgname, tgdeferrable, tginitdeferred
       from pg_trigger
       where tgname in ('worlds_require_active_creator', 'world_memberships_require_active_creator')
       order by tgname`,
    );
    expect(triggers.rows).toEqual([
      {
        tgname: 'world_memberships_require_active_creator',
        tgdeferrable: true,
        tginitdeferred: true,
      },
      { tgname: 'worlds_require_active_creator', tgdeferrable: true, tginitdeferred: true },
    ]);
  });
});
