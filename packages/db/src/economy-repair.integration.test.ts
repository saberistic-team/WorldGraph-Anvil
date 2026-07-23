import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sha256CanonicalV1 } from '@worldgraph/ledger';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const migrationTags = [
  '0001_platform_extensions',
  '0002_platform_metadata',
  '0003_identity_authority',
  '0004_primitive_registry',
  '0005_manifest_studio',
  '0006_deterministic_compiler',
  '0007_command_event_ledger',
  '0008_deterministic_clock_scheduler',
  '0009_wallets_transfers_ownership',
] as const;
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const incidentReason = 'The source effect was confirmed erroneous.';
const pitrNotUsedReason = 'Point-in-time recovery would discard valid later history.';

type RepairSourceKind = 'gift' | 'issuance' | 'purchase' | 'transfer';

interface RepairFixture {
  adminUserId: string;
  assetId: string;
  buyerWalletId: string;
  creatorUserId: string;
  offerId: string;
  sellerWalletId: string;
  sourceCommandId: string;
  sourceFinancialTransactionId: string;
  sourceTransferId: string;
  worldId: string;
}

interface RepairPlan extends Record<string, unknown> {
  expiresAt: string;
  planHash: string;
  preparedAt: string;
  repairKind: string;
  repairPlanId: string;
  reservedCommandId: string;
  sourceCommandId: string;
  worldId: string;
}

interface RepairReceipt {
  asset_transfer_id: string | null;
  command_id: string;
  economy_checksum: Buffer;
  event_id: string;
  financial_transaction_id: string | null;
  ledger_entry_id: string;
  repair_plan_id: string;
  resulting_event_sequence: string;
  resulting_ledger_sequence: string;
  resulting_state_revision: string;
}

const suiteNumber: Record<RepairSourceKind, number> = {
  transfer: 1,
  issuance: 2,
  gift: 3,
  purchase: 4,
};

function repairId(suite: number, value: number): string {
  return `098f8652-3cb6-7d52-904b-${String(suite * 1000 + value).padStart(12, '0')}`;
}

async function migrationFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-m08-repair-'));
  await mkdir(join(root, 'meta'));
  await Promise.all(
    migrationTags.map((tag) => cp(join(migrationRoot, `${tag}.sql`), join(root, `${tag}.sql`))),
  );
  await writeFile(
    join(root, 'meta/_journal.json'),
    JSON.stringify({
      dialect: 'postgresql',
      entries: migrationTags.map((tag, index) => ({
        breakpoints: true,
        idx: index,
        tag,
        version: '7',
        when: 1784635200000 + index * 60000,
      })),
      version: '7',
    }),
  );
  return root;
}

async function transaction<T>(pool: Pool, operation: (connection: PoolClient) => Promise<T>) {
  const connection = await pool.connect();
  try {
    await connection.query('begin');
    const value = await operation(connection);
    await connection.query('commit');
    return value;
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function seedRepairFixture(
  pool: Pool,
  kind: RepairSourceKind,
  suite = suiteNumber[kind],
): Promise<RepairFixture> {
  const id = (value: number) => repairId(suite, value);
  const ids = {
    creator: id(1),
    admin: id(2),
    world: id(3),
    version: id(4),
    manifest: id(5),
    compilation: id(6),
    sellerEntity: id(7),
    buyerEntity: id(8),
    currency: id(9),
    sellerWallet: id(10),
    buyerWallet: id(11),
    genesisCommand: id(12),
    simulationCommand: id(13),
    initializationCommand: id(14),
    sourceCommand: id(15),
    reconciliationCommand: id(16),
    genesisEvent: id(17),
    simulationEvent: id(18),
    initializationEvent: id(19),
    sourceEvent: id(20),
    reconciliationEvent: id(21),
    genesisLedger: id(22),
    simulationLedger: id(23),
    initializationLedger: id(24),
    sourceLedger: id(25),
    reconciliationLedger: id(26),
    initializationTransaction: id(27),
    sourceTransaction: id(28),
    initializationPosting: id(29),
    sourcePostingOne: id(30),
    sourcePostingTwo: id(31),
    asset: id(32),
    initializationTransfer: id(33),
    sourceTransfer: id(34),
    offer: id(35),
    reconciliationRun: id(36),
  };
  const sourceCommandType = {
    transfer: 'TransferCurrencyV1',
    issuance: 'IssueCurrencyV1',
    gift: 'TransferAssetV1',
    purchase: 'AcceptAssetTransferOfferV1',
  }[kind];
  const sourceEventType = {
    transfer: 'CurrencyTransferredV1',
    issuance: 'CurrencyIssuedV1',
    gift: 'AssetOwnershipTransferredV1',
    purchase: 'AssetPurchasedV1',
  }[kind];
  const hasFinancialSource = kind !== 'gift';
  const hasTitleSource = kind === 'gift' || kind === 'purchase';
  const currentSellerBalance =
    kind === 'transfer' ? 75 : kind === 'issuance' ? 125 : kind === 'purchase' ? 25 : 100;
  const currentBuyerBalance = kind === 'transfer' ? 25 : kind === 'purchase' ? 75 : 0;
  const currentSupply = kind === 'issuance' ? 125 : 100;
  const sourceTransactionKind =
    kind === 'issuance' ? 'issuance' : kind === 'purchase' ? 'asset_purchase' : 'transfer';
  const sourceSupplyDelta = kind === 'issuance' ? 25 : 0;
  const anchorTime = `2026-07-22T12:0${suite}:00.000Z`;
  const artifactHash = 'ab'.repeat(32);

  await transaction(pool, async (connection) => {
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into users(id,email,password_hash,display_name,status,platform_role)
       values
         ($1,$3,$5,'Repair Creator','active','user'),
         ($2,$4,$5,'Repair Administrator','active','platform_admin')`,
      [
        ids.creator,
        ids.admin,
        `repair-${kind}-${suite}-creator@example.test`,
        `repair-${kind}-${suite}-admin@example.test`,
        passwordHash,
      ],
    );
    await connection.query(
      `insert into worlds(
         id,slug,name,lifecycle,created_by_user_id,row_version,active_world_version_id,
         current_approved_manifest_revision_id
       ) values ($1,$2,$3,'active',$4,1,$5,$6)`,
      [
        ids.world,
        `repair-${kind}-${suite}-world`,
        `Repair ${kind} ${suite} world`,
        ids.creator,
        ids.version,
        ids.manifest,
      ],
    );
    await connection.query(
      `insert into world_memberships(
         world_id,user_id,role,status,granted_by_user_id
       ) values ($1,$2,'creator','active',$2),($1,$3,'player','active',$2)`,
      [ids.world, ids.creator, ids.admin],
    );
    await connection.query(
      `insert into world_versions(
         id,world_id,version_number,manifest_revision_id,compilation_run_id,
         world_schema_version,compiler_version,compiler_config_version,seed,
         artifact_hash,status,created_by_user_id,activated_at
       ) values ($1,$2,1,$3,$4,1,'1.0.0',1,'repair-seed',decode($5,'hex'),
         'active',$6,$7)`,
      [
        ids.version,
        ids.world,
        ids.manifest,
        ids.compilation,
        artifactHash,
        ids.creator,
        anchorTime,
      ],
    );
    await connection.query(
      `insert into world_entities(
         id,world_id,logical_key,entity_type,entity_schema_version,state,
         created_world_version_id,row_version
       ) values
         ($1,$3,'organization:seller','organization',1,
          '{"homeDistrictLogicalKey":"district:capital","name":"Seller",
            "parameters":{},"primitiveRef":"seller"}',$4,0),
         ($2,$3,'organization:buyer','organization',1,
          '{"homeDistrictLogicalKey":"district:capital","name":"Buyer",
            "parameters":{},"primitiveRef":"buyer"}',$4,0)`,
      [ids.sellerEntity, ids.buyerEntity, ids.world, ids.version],
    );
    await connection.query(
      `insert into world_entity_controllers(
         world_id,user_id,entity_id,control_scope,granted_world_version_id
       ) values ($1,$2,$3,'primary',$5),($1,$4,$6,'primary',$5)`,
      [ids.world, ids.creator, ids.sellerEntity, ids.admin, ids.version, ids.buyerEntity],
    );
    await connection.query(
      `insert into command_records(
         id,world_id,command_type,command_schema_version,actor_type,actor_id,
         payload,payload_hash,payload_classification,idempotency_key,request_hash,
         status,authorization_rule_id,correlation_id,requested_at,decided_at,
         resulting_state_revision,response_summary
       ) values
         ($1,$6,'WorldCompiledGenesisV1',1,'system','worldgraph:compiler',$11,
          decode(repeat('11',32),'hex'),'member',$12,decode(repeat('12',32),'hex'),
          'accepted','system.compiler.genesis',$1,$10,$10,1,'{}'),
         ($2,$6,'InitializeWorldSimulationV1',1,'system','worldgraph:simulation-bootstrap','{}',
          decode(repeat('13',32),'hex'),'member',$13,decode(repeat('14',32),'hex'),
          'accepted','system.simulation.initialize',$2,$10,$10,2,'{}'),
         ($3,$6,'InitializeWorldEconomyV1',1,'system','worldgraph:economy-bootstrap','{}',
          decode(repeat('15',32),'hex'),'member',$14,decode(repeat('16',32),'hex'),
          'accepted','system.economy.initialize',$3,$10,$10,3,'{}'),
         ($4,$6,$7,1,'user',$8,'{}',decode(repeat('17',32),'hex'),'member',$15,
          decode(repeat('18',32),'hex'),'accepted','economy.test.source',$4,$10,$10,4,'{}'),
         ($5,$6,'ReconcileWorldEconomyV1',1,'platform_admin',$9,'{}',
          decode(repeat('19',32),'hex'),'private',$16,decode(repeat('20',32),'hex'),
          'accepted','operations.economy.reconcile',$5,$10,$10,5,'{}')`,
      [
        ids.genesisCommand,
        ids.simulationCommand,
        ids.initializationCommand,
        ids.sourceCommand,
        ids.reconciliationCommand,
        ids.world,
        sourceCommandType,
        ids.creator,
        ids.admin,
        anchorTime,
        { activeWorldVersionId: ids.version, artifactHash },
        `repair-${kind}-${suite}-genesis`,
        `repair-${kind}-${suite}-simulation`,
        `repair-${kind}-${suite}-economy`,
        `repair-${kind}-${suite}-source`,
        `repair-${kind}-${suite}-reconcile`,
      ],
    );
    await connection.query(
      `insert into domain_events(
         id,world_id,world_event_sequence,command_id,event_ordinal,aggregate_type,
         aggregate_id,aggregate_version,event_type,event_schema_version,payload,
         metadata,event_hash,occurred_at,recorded_at,resulting_state_revision
       ) values
         ($1,$11,1,$6,0,'world',$11::uuid::text,1,'WorldCompiledGenesisV1',1,$16,'{}',
          decode(repeat('21',32),'hex'),$15,$15,1),
         ($2,$11,2,$7,0,'world_simulation',$11::uuid::text,1,
          'WorldSimulationInitializedV1',1,'{}','{}',decode(repeat('22',32),'hex'),$15,$15,2),
         ($3,$11,3,$8,0,'world_economy',$11::uuid::text,1,
          'WorldEconomyInitializedV1',1,'{}','{}',decode(repeat('23',32),'hex'),$15,$15,3),
         ($4,$11,4,$9,0,$13,$14,1,$12,1,'{}','{}',decode(repeat('24',32),'hex'),$15,$15,4),
         ($5,$11,5,$10,0,'world_economy',$11::uuid::text,2,
          'WorldEconomyReconciledV1',1,'{}','{}',decode(repeat('25',32),'hex'),$15,$15,5)`,
      [
        ids.genesisEvent,
        ids.simulationEvent,
        ids.initializationEvent,
        ids.sourceEvent,
        ids.reconciliationEvent,
        ids.genesisCommand,
        ids.simulationCommand,
        ids.initializationCommand,
        ids.sourceCommand,
        ids.reconciliationCommand,
        ids.world,
        sourceEventType,
        hasTitleSource ? 'asset' : 'financial_transaction',
        hasTitleSource ? ids.asset : ids.sourceTransaction,
        anchorTime,
        { activeWorldVersionId: ids.version, artifactHash },
      ],
    );
    await connection.query(
      `insert into ledger_entries(
         id,world_id,ledger_sequence,entry_kind,command_id,event_id,actor_type,
         actor_id,public_summary_code,redacted_details,previous_hash,entry_hash,recorded_at
       ) values
         ($1,$11,1,'domain_event',$6,$12,'system','worldgraph:compiler',
          'WORLD_COMPILED_GENESIS','{}',decode(repeat('00',32),'hex'),decode(repeat('31',32),'hex'),$16),
         ($2,$11,2,'domain_event',$7,$13,'system','worldgraph:simulation-bootstrap',
          'WORLD_SIMULATION_INITIALIZED','{}',decode(repeat('31',32),'hex'),decode(repeat('32',32),'hex'),$16),
         ($3,$11,3,'domain_event',$8,$14,'system','worldgraph:economy-bootstrap',
          'WORLD_ECONOMY_INITIALIZED','{}',decode(repeat('32',32),'hex'),decode(repeat('33',32),'hex'),$16),
         ($4,$11,4,'domain_event',$9,$15,'user',$17,'ECONOMY_SOURCE_APPLIED','{}',
          decode(repeat('33',32),'hex'),decode(repeat('34',32),'hex'),$16),
         ($5,$11,5,'domain_event',$10,$18,'platform_admin',$19,'WORLD_ECONOMY_RECONCILED','{}',
          decode(repeat('34',32),'hex'),decode(repeat('35',32),'hex'),$16)`,
      [
        ids.genesisLedger,
        ids.simulationLedger,
        ids.initializationLedger,
        ids.sourceLedger,
        ids.reconciliationLedger,
        ids.genesisCommand,
        ids.simulationCommand,
        ids.initializationCommand,
        ids.sourceCommand,
        ids.reconciliationCommand,
        ids.world,
        ids.genesisEvent,
        ids.simulationEvent,
        ids.initializationEvent,
        ids.sourceEvent,
        anchorTime,
        ids.creator,
        ids.reconciliationEvent,
        ids.admin,
      ],
    );
    await connection.query(
      `insert into currencies(
         id,world_id,stable_key,code,name,minor_unit_scale,max_supply_minor,
         issuer_entity_id,created_event_id,status,row_version
       ) values ($1,$2,$3,'RPR','Repair Credit',0,1000,$4,$5,'active',1)`,
      [
        ids.currency,
        ids.world,
        `currency:repair-${kind}-${suite}`,
        ids.sellerEntity,
        ids.initializationEvent,
      ],
    );
    await connection.query(
      `insert into wallets(
         id,world_id,currency_id,stable_key,owner_entity_id,wallet_kind,
         status,created_event_id,row_version
       ) values
         ($1,$3,$4,$5,$6,'treasury','active',$8,1),
         ($2,$3,$4,$7,$9,'player','active',$8,1)`,
      [
        ids.sellerWallet,
        ids.buyerWallet,
        ids.world,
        ids.currency,
        `wallet:repair-${kind}-${suite}-seller`,
        ids.sellerEntity,
        `wallet:repair-${kind}-${suite}-buyer`,
        ids.initializationEvent,
        ids.buyerEntity,
      ],
    );
    await connection.query(
      `insert into currency_supply(
         currency_id,world_id,current_supply_minor,row_version,updated_state_revision
       ) values ($1,$2,$3,$4,4)`,
      [ids.currency, ids.world, currentSupply, kind === 'issuance' ? 2 : 1],
    );
    await connection.query(
      `insert into wallet_balances(
         wallet_id,world_id,currency_id,available_minor,row_version,updated_state_revision
       ) values ($1,$3,$4,$5,$7,4),($2,$3,$4,$6,$8,4)`,
      [
        ids.sellerWallet,
        ids.buyerWallet,
        ids.world,
        ids.currency,
        currentSellerBalance,
        currentBuyerBalance,
        kind === 'gift' ? 1 : 2,
        kind === 'transfer' || kind === 'purchase' ? 2 : 1,
      ],
    );
    await connection.query(
      `insert into financial_transactions(
         id,world_id,currency_id,transaction_kind,supply_delta_minor,
         command_id,event_id,memo_code,occurred_tick,state_revision,created_at
       ) values ($1,$2,$3,'initialization',100,$4,$5,'initialization',0,3,$6)`,
      [
        ids.initializationTransaction,
        ids.world,
        ids.currency,
        ids.initializationCommand,
        ids.initializationEvent,
        anchorTime,
      ],
    );
    await connection.query(
      `insert into wallet_postings(
         id,transaction_id,world_id,currency_id,wallet_id,posting_ordinal,
         signed_amount_minor,created_at
       ) values ($1,$2,$3,$4,$5,0,100,$6)`,
      [
        ids.initializationPosting,
        ids.initializationTransaction,
        ids.world,
        ids.currency,
        kind === 'purchase' ? ids.buyerWallet : ids.sellerWallet,
        anchorTime,
      ],
    );
    if (hasFinancialSource) {
      await connection.query(
        `insert into financial_transactions(
           id,world_id,currency_id,transaction_kind,supply_delta_minor,
           command_id,event_id,memo_code,occurred_tick,state_revision,created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,'source_effect',1,4,$8)`,
        [
          ids.sourceTransaction,
          ids.world,
          ids.currency,
          sourceTransactionKind,
          sourceSupplyDelta,
          ids.sourceCommand,
          ids.sourceEvent,
          anchorTime,
        ],
      );
      if (kind === 'issuance') {
        await connection.query(
          `insert into wallet_postings(
             id,transaction_id,world_id,currency_id,wallet_id,posting_ordinal,
             signed_amount_minor,created_at
           ) values ($1,$2,$3,$4,$5,0,25,$6)`,
          [
            ids.sourcePostingOne,
            ids.sourceTransaction,
            ids.world,
            ids.currency,
            ids.sellerWallet,
            anchorTime,
          ],
        );
      } else {
        await connection.query(
          `insert into wallet_postings(
             id,transaction_id,world_id,currency_id,wallet_id,posting_ordinal,
             signed_amount_minor,created_at
           ) values
             ($1,$3,$4,$5,$6,0,-25,$8),($2,$3,$4,$5,$7,1,25,$8)`,
          [
            ids.sourcePostingOne,
            ids.sourcePostingTwo,
            ids.sourceTransaction,
            ids.world,
            ids.currency,
            kind === 'purchase' ? ids.buyerWallet : ids.sellerWallet,
            kind === 'purchase' ? ids.sellerWallet : ids.buyerWallet,
            anchorTime,
          ],
        );
      }
    }
    if (hasTitleSource) {
      await connection.query(
        `insert into assets(
           id,world_id,stable_key,asset_type,metadata,transferable,status,
           created_event_id,created_at
         ) values ($1,$2,$3,'repair_artifact',
           '{"displayName":"Repair Artifact","provenance":"repair-fixture-v1"}',
           true,'active',$4,$5)`,
        [
          ids.asset,
          ids.world,
          `asset:repair-${kind}-${suite}`,
          ids.initializationEvent,
          anchorTime,
        ],
      );
      await connection.query(
        `insert into asset_transfers(
           id,world_id,asset_id,from_owner_entity_id,to_owner_entity_id,
           transfer_kind,financial_transaction_id,command_id,event_id,
           occurred_tick,state_revision,created_at
         ) values
           ($1,$3,$4,null,$5,'initial',null,$7,$8,0,3,$11),
           ($2,$3,$4,$5,$6,$9,$10,$12,$13,1,4,$11)`,
        [
          ids.initializationTransfer,
          ids.sourceTransfer,
          ids.world,
          ids.asset,
          ids.sellerEntity,
          ids.buyerEntity,
          ids.initializationCommand,
          ids.initializationEvent,
          kind === 'purchase' ? 'purchase' : 'grant',
          kind === 'purchase' ? ids.sourceTransaction : null,
          anchorTime,
          ids.sourceCommand,
          ids.sourceEvent,
        ],
      );
      await connection.query(
        `insert into asset_ownership(
           asset_id,world_id,owner_entity_id,ownership_version,acquired_event_id,
           updated_state_revision,updated_at
         ) values ($1,$2,$3,2,$4,4,$5)`,
        [ids.asset, ids.world, ids.buyerEntity, ids.sourceEvent, anchorTime],
      );
      if (kind === 'purchase') {
        await connection.query(
          `insert into asset_transfer_offers(
             id,world_id,asset_id,seller_entity_id,buyer_entity_id,currency_id,
             seller_wallet_id,price_minor,expires_at_tick,created_at_tick,status,
             created_command_id,created_event_id,terminal_command_id,terminal_event_id,
             accepted_financial_transaction_id,accepted_asset_transfer_id,row_version,
             created_state_revision,terminal_state_revision,created_at,updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7,25,20,0,'accepted',$8,$9,$10,$11,
             $12,$13,2,3,4,$14,$14)`,
          [
            ids.offer,
            ids.world,
            ids.asset,
            ids.sellerEntity,
            ids.buyerEntity,
            ids.currency,
            ids.sellerWallet,
            ids.initializationCommand,
            ids.initializationEvent,
            ids.sourceCommand,
            ids.sourceEvent,
            ids.sourceTransaction,
            ids.sourceTransfer,
            anchorTime,
          ],
        );
      }
    }
    await connection.query(
      `insert into world_simulation_clocks(
         world_id,epoch_at,current_tick,world_milliseconds_per_tick,
         wall_cadence_milliseconds,mode,max_batch_ticks,max_catch_up_ticks,
         prng_algorithm_version,outcome_hash,row_version,updated_state_revision,updated_at
       ) values ($1,$2,10,1000,1000,'paused',8,64,'xorshift32-sha256-v1',
         decode(repeat('61',32),'hex'),1,2,$2)`,
      [ids.world, anchorTime],
    );
    await connection.query(
      `insert into world_schedule_heads(world_id,next_schedule_sequence,updated_at)
       values ($1,1,$2)`,
      [ids.world, anchorTime],
    );
    await connection.query(
      `insert into world_economy_heads(
         world_id,source_world_version_id,seed_plan_hash,initialized_command_id,
         initialized_event_id,checksum,row_version,updated_state_revision,
         reconciliation_status,last_reconciled_state_revision,last_reconciliation_run_id,
         initialized_at,updated_at
       ) values ($1,$2,decode(repeat('62',32),'hex'),$3,$4,
         decode(repeat('63',32),'hex'),3,5,'current',4,$5,$6,$6)`,
      [
        ids.world,
        ids.version,
        ids.initializationCommand,
        ids.initializationEvent,
        ids.reconciliationRun,
        anchorTime,
      ],
    );
    await connection.query(
      `with snapshot as (select worldgraph_economy_reconciliation_snapshot($2) value)
       insert into economy_reconciliation_runs(
         id,world_id,source_state_revision,source_event_sequence,status,
         live_wallet_checksum,rebuilt_wallet_checksum,live_supply_checksum,
         rebuilt_supply_checksum,live_ownership_checksum,rebuilt_ownership_checksum,
         live_projection_checksum,rebuilt_journal_checksum,wallet_count,currency_count,
         asset_count,mismatch_count,command_id,event_id,created_at
       )
       select $1,$2,4,4,'matched',decode(value->>'liveWalletChecksum','hex'),
         decode(value->>'rebuiltWalletChecksum','hex'),decode(value->>'liveSupplyChecksum','hex'),
         decode(value->>'rebuiltSupplyChecksum','hex'),decode(value->>'liveOwnershipChecksum','hex'),
         decode(value->>'rebuiltOwnershipChecksum','hex'),decode(value->>'liveProjectionChecksum','hex'),
         decode(value->>'rebuiltJournalChecksum','hex'),(value->>'walletCount')::integer,
         (value->>'currencyCount')::integer,(value->>'assetCount')::integer,0,$3,$4,$5
       from snapshot`,
      [
        ids.reconciliationRun,
        ids.world,
        ids.reconciliationCommand,
        ids.reconciliationEvent,
        anchorTime,
      ],
    );
    await connection.query(
      `insert into aggregate_stream_heads(
         world_id,aggregate_type,aggregate_id,current_version,updated_at
       ) values ($1,'world_economy',$1::uuid::text,2,$2)`,
      [ids.world, anchorTime],
    );
    await connection.query(
      `insert into world_ledger_heads(
         world_id,next_ledger_sequence,next_event_sequence,last_entry_hash,
         anchored_at,anchor_event_id,anchor_artifact_hash,updated_at
       ) values ($1,6,6,decode(repeat('35',32),'hex'),$2,$3,decode($4,'hex'),$2)`,
      [ids.world, anchorTime, ids.genesisEvent, artifactHash],
    );
    await connection.query(
      `insert into world_runtime_heads(
         world_id,active_world_version_id,state_revision,last_ledger_sequence,
         last_event_sequence,ledger_anchored_at,ledger_anchor_event_id,
         anchor_artifact_hash,projection_checksum,updated_at
       ) values ($1,$2,5,5,5,$3,$4,decode($5,'hex'),decode(repeat('64',32),'hex'),$3)`,
      [ids.world, ids.version, anchorTime, ids.genesisEvent, artifactHash],
    );

    for (const [eventId, ordinal] of [
      [ids.genesisEvent, 1],
      [ids.simulationEvent, 2],
      [ids.initializationEvent, 3],
      [ids.sourceEvent, 4],
      [ids.reconciliationEvent, 5],
    ] as const) {
      await connection.query(
        `update domain_events event
            set event_hash=worldgraph_domain_event_hash_v1(
              event.id,event.world_id,event.world_event_sequence,event.command_id,
              event.event_ordinal,event.aggregate_type,event.aggregate_id,
              event.aggregate_version,event.event_type,event.event_schema_version,
              event.payload,event.metadata,event.occurred_at,event.recorded_at,
              event.resulting_state_revision)
          where event.id=$1 and event.world_event_sequence=$2`,
        [eventId, ordinal],
      );
    }
    let previousHash = Buffer.alloc(32);
    for (const ledgerId of [
      ids.genesisLedger,
      ids.simulationLedger,
      ids.initializationLedger,
      ids.sourceLedger,
      ids.reconciliationLedger,
    ]) {
      const sealed = await connection.query<{ entry_hash: Buffer }>(
        `update ledger_entries entry
            set previous_hash=$2,
                entry_hash=worldgraph_ledger_entry_hash_v1(
                  entry.id,entry.world_id,entry.ledger_sequence,entry.entry_kind::text,
                  entry.command_id,entry.event_id,entry.actor_type::text,entry.actor_id,
                  entry.public_summary_code,entry.redacted_details,$2,entry.recorded_at)
          where entry.id=$1 returning entry_hash`,
        [ledgerId, previousHash],
      );
      previousHash = Buffer.from(sealed.rows[0]!.entry_hash);
    }
    await connection.query(`update world_ledger_heads set last_entry_hash=$2 where world_id=$1`, [
      ids.world,
      previousHash,
    ]);
    await connection.query(
      `update world_economy_heads
          set checksum=worldgraph_economy_projection_checksum($1)
        where world_id=$1`,
      [ids.world],
    );
    await connection.query(
      `update world_runtime_heads
          set projection_checksum=worldgraph_projection_checksum($1,5)
        where world_id=$1`,
      [ids.world],
    );
    await connection.query(
      `insert into projection_checkpoints(
         world_id,projection_name,projection_schema_version,last_event_sequence,
         checksum,status,updated_at
       )
       select $1,'world_graph',1,5,runtime.projection_checksum,
         'current'::projection_checkpoint_status,$2::timestamptz
         from world_runtime_heads runtime where runtime.world_id=$1
       union all
       select $1,'simulation_runtime',1,5,
         worldgraph_simulation_projection_checksum($1),
         'current'::projection_checkpoint_status,$2::timestamptz
       union all
       select $1,'economy_runtime',1,5,head.checksum,
         'current'::projection_checkpoint_status,$2::timestamptz
         from world_economy_heads head where head.world_id=$1`,
      [ids.world, anchorTime],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
  });

  return {
    adminUserId: ids.admin,
    assetId: hasTitleSource ? ids.asset : id(997),
    buyerWalletId: ids.buyerWallet,
    creatorUserId: ids.creator,
    offerId: kind === 'purchase' ? ids.offer : id(998),
    sellerWalletId: ids.sellerWallet,
    sourceCommandId: ids.sourceCommand,
    sourceFinancialTransactionId: hasFinancialSource ? ids.sourceTransaction : id(999),
    sourceTransferId: hasTitleSource ? ids.sourceTransfer : id(996),
    worldId: ids.world,
  };
}

async function prepareRepair(owner: DatabaseClient, fixture: RepairFixture): Promise<RepairPlan> {
  const result = await owner.pool.query<{ plan: RepairPlan }>(
    `select worldgraph_prepare_economy_repair(
       $1,$2,$3,'ERRONEOUS_EFFECT',$4,$5
     ) plan`,
    [
      fixture.worldId,
      fixture.sourceCommandId,
      fixture.adminUserId,
      incidentReason,
      pitrNotUsedReason,
    ],
  );
  const plan = result.rows[0]!.plan;
  const { planHash, ...body } = plan;
  expect(planHash).toBe(
    sha256CanonicalV1({ domain: 'worldgraph.economy-repair-plan-hash.v1', plan: body }),
  );
  const reserved = await owner.pool.query(`select 1 from command_records where id=$1`, [
    plan.reservedCommandId,
  ]);
  expect(reserved.rowCount).toBe(0);
  return plan;
}

async function approveRepair(
  app: DatabaseClient,
  fixture: RepairFixture,
  plan: RepairPlan,
  suite: number,
  concurrentCreator = false,
): Promise<void> {
  const creatorArgs = [
    plan.repairPlanId,
    fixture.creatorUserId,
    'creator',
    repairId(suite, 100),
    repairId(suite, 101),
    repairId(suite, 102),
    plan.planHash,
    'APPROVE APPEND-ONLY ECONOMY REPAIR',
  ];
  const creatorQuery = () =>
    app.pool.query<{ approval: Record<string, unknown> }>(
      `select worldgraph_approve_economy_repair(
         $1,$2,$3,$4,$5,$6,$7,$8
       ) approval`,
      creatorArgs,
    );
  if (concurrentCreator) {
    const [left, right] = await Promise.all([creatorQuery(), creatorQuery()]);
    expect(left.rows[0]?.approval).toEqual(right.rows[0]?.approval);
  } else {
    const first = await creatorQuery();
    const replay = await creatorQuery();
    expect(first.rows[0]?.approval).toEqual(replay.rows[0]?.approval);
  }
  await app.pool.query(
    `select worldgraph_approve_economy_repair(
       $1,$2,'platform_admin',$3,null,$4,$5,$6
     )`,
    [
      plan.repairPlanId,
      fixture.adminUserId,
      repairId(suite, 103),
      repairId(suite, 104),
      plan.planHash,
      'APPROVE APPEND-ONLY ECONOMY REPAIR',
    ],
  );
  const approvalCount = await app.pool.query<{ count: string }>(
    `select count(*)::text count from (
       select (worldgraph_economy_repair_plan($1,$2)->'approvalStatus') value
     ) approved where value='{"creator":true,"platformAdmin":true}'::jsonb`,
    [plan.repairPlanId, fixture.creatorUserId],
  );
  expect(approvalCount.rows[0]?.count).toBe('1');
}

async function executeRepair(
  owner: DatabaseClient,
  fixture: RepairFixture,
  plan: RepairPlan,
): Promise<RepairReceipt> {
  const result = await owner.pool.query<RepairReceipt>(
    `select * from worldgraph_execute_economy_repair($1,$2,$3,$4)`,
    [plan.repairPlanId, fixture.adminUserId, plan.planHash, 'APPLY APPEND-ONLY ECONOMY REPAIR'],
  );
  return result.rows[0]!;
}

async function sourceEvidenceSnapshot(
  pool: Pool,
  fixture: RepairFixture,
): Promise<Record<string, unknown>> {
  const result = await pool.query<{ snapshot: Record<string, unknown> }>(
    `select jsonb_build_object(
       'financialTransaction',(
         select to_jsonb(transaction) from financial_transactions transaction
          where transaction.id=$1
       ),
       'postings',coalesce((
         select jsonb_agg(to_jsonb(posting) order by posting.posting_ordinal)
           from wallet_postings posting where posting.transaction_id=$1
       ),'[]'::jsonb),
       'assetTransfer',(
         select to_jsonb(transfer) from asset_transfers transfer where transfer.id=$2
       ),
       'offer',(
         select to_jsonb(offer) from asset_transfer_offers offer where offer.id=$3
       )
     ) snapshot`,
    [fixture.sourceFinancialTransactionId, fixture.sourceTransferId, fixture.offerId],
  );
  return result.rows[0]!.snapshot;
}

async function appendMatchedReconciliation(
  pool: Pool,
  fixture: RepairFixture,
  receipt: RepairReceipt,
  suite: number,
): Promise<{ commandId: string; runId: string }> {
  const commandId = repairId(suite, 300);
  let generatedId = 400;
  const ids = { next: () => repairId(suite, generatedId++) };
  const modulePath = '../../../apps/api/src/economy/command-executor.js';
  const { executePostgresEconomyCommand } = (await import(modulePath)) as {
    executePostgresEconomyCommand: (
      executor: PoolClient,
      idGenerator: { next(): string },
      input: Record<string, unknown>,
    ) => Promise<{ commandId: string; status: string }>;
  };
  let runId = '';
  await transaction(pool, async (connection) => {
    const authority = await connection.query<{
      active_world_version_id: string;
      anchor_artifact_hash: Buffer;
      economy_head_version: string;
      ledger_anchored_at: Date;
      state_revision: string;
    }>(
      `select runtime.active_world_version_id::text,
              runtime.state_revision::text,runtime.ledger_anchored_at,
              runtime.anchor_artifact_hash,head.row_version::text economy_head_version
         from world_runtime_heads runtime
         join world_economy_heads head on head.world_id=runtime.world_id
        where runtime.world_id=$1`,
      [fixture.worldId],
    );
    const current = authority.rows[0]!;
    const decidedAt = new Date();
    decidedAt.setMilliseconds(Math.floor(decidedAt.getMilliseconds()));
    await connection.query(
      `insert into command_records(
         id,world_id,command_type,command_schema_version,actor_type,actor_id,
         payload,payload_hash,payload_classification,idempotency_key,request_hash,
         expected_world_version,expected_state_revision,correlation_id,causation_id,
         requested_at
       ) values ($1,$2,'ReconcileWorldEconomyV1',1,'user',$3,null,$4,'member',$5,$6,
         1,$7,$1,null,$8)`,
      [
        commandId,
        fixture.worldId,
        fixture.creatorUserId,
        Buffer.alloc(32, 0x71),
        `repair-${suite}-post-reconciliation`,
        Buffer.alloc(32, 0x72),
        current.state_revision,
        decidedAt,
      ],
    );
    await connection.query(`select worldgraph_open_command_write($1,$2)`, [
      commandId,
      fixture.worldId,
    ]);
    const result = await executePostgresEconomyCommand(connection, ids, {
      authorizationRuleId: 'economy.world_role.reconcile',
      command: {
        actorId: fixture.creatorUserId,
        actorType: 'user',
        causationId: null,
        commandId,
        commandType: 'ReconcileWorldEconomyV1',
        correlationId: commandId,
        expectedAggregateVersion: current.economy_head_version,
        expectedStateRevision: current.state_revision,
        expectedWorldVersion: '1',
        idempotencyKey: `repair-${suite}-post-reconciliation`,
        payloadClassification: 'member',
        payloadHash: Buffer.alloc(32, 0x71),
        requestHash: Buffer.alloc(32, 0x72),
        requestedAt: decidedAt,
        schemaVersion: 1,
        worldId: fixture.worldId,
      },
      decidedAt,
      policy: {
        debitsFrozen: false,
        issuanceEnabled: true,
        issuanceRateLimitPerHour: 100,
        offerRateLimitPerMinute: 100,
        offersEnabled: true,
        transferRateLimitPerMinute: 100,
        transfersEnabled: true,
      },
      request: {
        commandId,
        expectedAggregateVersion: current.economy_head_version,
        expectedStateRevision: current.state_revision,
        expectedWorldVersion: '1',
        idempotencyKey: `repair-${suite}-post-reconciliation`,
        payload: { expectedEconomyHeadVersion: current.economy_head_version },
        schemaVersion: 1,
        type: 'ReconcileWorldEconomyV1',
      },
      world: {
        activeWorldVersionId: current.active_world_version_id,
        anchorArtifactHash: current.anchor_artifact_hash.toString('hex'),
        designVersion: '1',
        ledgerAnchoredAt: current.ledger_anchored_at,
        lifecycle: 'active',
        membershipRole: 'creator',
        membershipStatus: 'active',
        stateRevision: current.state_revision,
        worldId: fixture.worldId,
      },
    });
    expect(result).toMatchObject({ commandId, status: 'accepted' });
    const run = await connection.query<{ id: string }>(
      `select id::text from economy_reconciliation_runs where command_id=$1`,
      [commandId],
    );
    runId = run.rows[0]!.id;
  });
  expect(BigInt(receipt.resulting_state_revision)).toBeGreaterThan(0n);
  return { commandId, runId };
}

async function resealPlanNearExpiry(
  connection: PoolClient,
  repairPlanId: string,
  millisecondsUntilExpiry: number,
): Promise<string> {
  await connection.query(`set local session_replication_role = 'replica'`);
  await connection.query(
    `update economy_repair_plans plan
        set expires_at=timing.expires_at,
            prepared_at=timing.expires_at-interval '24 hours'
       from (
         select date_trunc('milliseconds',clock_timestamp())
           + $2::integer * interval '1 millisecond' expires_at
       ) timing
      where plan.id=$1`,
    [repairPlanId, millisecondsUntilExpiry],
  );
  await connection.query(
    `update economy_repair_plans plan
        set plan_hash=extensions.digest(convert_to(
          worldgraph_canonical_jsonb(jsonb_build_object(
            'domain','worldgraph.economy-repair-plan-hash.v1',
            'plan',worldgraph_economy_repair_plan_body(plan.id)
          )),'UTF8'
        ),'sha256')
      where plan.id=$1`,
    [repairPlanId],
  );
  await connection.query(
    `update security_audit_records audit
        set redacted_metadata=jsonb_set(
          audit.redacted_metadata,'{planHash}',to_jsonb(encode(plan.plan_hash,'hex'))
        )
       from economy_repair_plans plan
      where plan.id=$1 and audit.id=plan.preparation_audit_id`,
    [repairPlanId],
  );
  await connection.query(`set local session_replication_role = 'origin'`);
  const sealed = await connection.query<{ plan_hash: string }>(
    `select encode(plan_hash,'hex') plan_hash from economy_repair_plans where id=$1`,
    [repairPlanId],
  );
  return sealed.rows[0]!.plan_hash;
}

describe('M08 append-only economy repair', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: DatabaseClient;
  let app: DatabaseClient;
  let migrations: string;

  beforeAll(async () => {
    migrations = await migrationFolder();
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'm08-repair-owner-test');
    await migrate(owner.db, { migrationsFolder: migrations });
    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    app = createDatabaseClient(appUrl.toString(), 'm08-repair-app-test');
  });

  afterAll(async () => {
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
    if (migrations) await rm(migrations, { force: true, recursive: true });
  });

  it.each(['transfer', 'issuance', 'gift', 'purchase'] as const)(
    'prepares, dual-approves, executes, and exactly replays a %s reversal',
    async (kind) => {
      const fixture = await seedRepairFixture(owner.pool, kind);
      const plan = await prepareRepair(owner, fixture);
      const visible = await app.pool.query<{ plan: RepairPlan }>(
        `select worldgraph_economy_repair_plan($1,$2) plan`,
        [plan.repairPlanId, fixture.creatorUserId],
      );
      expect(visible.rows[0]?.plan.planHash).toBe(plan.planHash);
      await approveRepair(app, fixture, plan, suiteNumber[kind], kind === 'transfer');
      const sourceBefore = await sourceEvidenceSnapshot(owner.pool, fixture);

      let receipt: RepairReceipt;
      if (kind === 'transfer') {
        const [left, right] = await Promise.all([
          executeRepair(owner, fixture, plan),
          executeRepair(owner, fixture, plan),
        ]);
        expect(left).toEqual(right);
        receipt = left;
      } else {
        receipt = await executeRepair(owner, fixture, plan);
      }
      await expect(executeRepair(owner, fixture, plan)).resolves.toEqual(receipt);
      await expect(sourceEvidenceSnapshot(owner.pool, fixture)).resolves.toEqual(sourceBefore);

      const evidence = await owner.pool.query<{
        commands: string;
        events: string;
        executions: string;
        ledgers: string;
      }>(
        `select
           (select count(*)::text from command_records where id=$1) commands,
           (select count(*)::text from domain_events where command_id=$1) events,
           (select count(*)::text from ledger_entries where command_id=$1) ledgers,
           (select count(*)::text from economy_repair_executions
             where repair_plan_id=$2) executions`,
        [receipt.command_id, plan.repairPlanId],
      );
      expect(evidence.rows[0]).toEqual({
        commands: '1',
        events: '1',
        executions: '1',
        ledgers: '1',
      });

      const sealedEnvelope = await owner.pool.query<{
        authorization_rule_id: string;
        causation_id: string;
        creator_override_id: string;
        metadata: Record<string, unknown>;
        override_id: string;
        payload_classification: string;
      }>(
        `select command.authorization_rule_id,
                command.causation_id::text,command.override_id::text,
                command.payload_classification::text,event.metadata,
                approval.creator_override_id::text
           from command_records command
           join domain_events event on event.command_id=command.id
           join economy_repair_approvals approval
             on approval.repair_plan_id=$2 and approval.authority_kind='creator'
          where command.id=$1`,
        [receipt.command_id, plan.repairPlanId],
      );
      expect(sealedEnvelope.rows[0]).toMatchObject({
        authorization_rule_id: 'operations.economy.repair.execute',
        causation_id: fixture.sourceCommandId,
        override_id: sealedEnvelope.rows[0]!.creator_override_id,
        payload_classification: 'private',
      });
      expect(sealedEnvelope.rows[0]!.metadata).toMatchObject({
        authorizationRuleId: 'operations.economy.repair.execute',
        causationId: fixture.sourceCommandId,
        commandType: 'RepairWorldEconomyV1',
        overrideId: sealedEnvelope.rows[0]!.creator_override_id,
        payloadClassification: 'private',
      });

      if (kind === 'transfer' || kind === 'issuance' || kind === 'purchase') {
        const exactFinancial = await owner.pool.query<{ exact: boolean }>(
          `select not exists (
             (select posting_ordinal,wallet_id,signed_amount_minor
                from wallet_postings where transaction_id=$1
              except
              select posting_ordinal,wallet_id,-signed_amount_minor
                from wallet_postings where transaction_id=$2)
             union all
             (select posting_ordinal,wallet_id,-signed_amount_minor
                from wallet_postings where transaction_id=$2
              except
              select posting_ordinal,wallet_id,signed_amount_minor
                from wallet_postings where transaction_id=$1)
           ) exact`,
          [receipt.financial_transaction_id, fixture.sourceFinancialTransactionId],
        );
        expect(exactFinancial.rows[0]?.exact).toBe(true);
        const reversal = await owner.pool.query<{
          compensation_supply_delta: string;
          reversal_count: string;
          reversal_of_transaction_id: string;
          source_supply_delta: string;
        }>(
          `select compensation.supply_delta_minor::text compensation_supply_delta,
                  compensation.reversal_of_transaction_id::text reversal_of_transaction_id,
                  source.supply_delta_minor::text source_supply_delta,
                  (select count(*)::text from financial_transactions candidate
                    where candidate.reversal_of_transaction_id=source.id) reversal_count
             from financial_transactions compensation
             join financial_transactions source
               on source.id=compensation.reversal_of_transaction_id
            where compensation.id=$1`,
          [receipt.financial_transaction_id],
        );
        expect(reversal.rows[0]?.reversal_of_transaction_id).toBe(
          fixture.sourceFinancialTransactionId,
        );
        expect(BigInt(reversal.rows[0]!.compensation_supply_delta)).toBe(
          -BigInt(reversal.rows[0]!.source_supply_delta),
        );
        expect(reversal.rows[0]?.reversal_count).toBe('1');
      } else {
        expect(receipt.financial_transaction_id).toBeNull();
      }
      if (kind === 'gift' || kind === 'purchase') {
        const exactTitle = await owner.pool.query<{ exact: boolean }>(
          `select exists (
             select 1 from asset_transfers compensation
             join asset_transfers source
               on source.world_id=compensation.world_id
              and source.id=compensation.reversal_of_transfer_id
             join asset_ownership ownership
               on ownership.world_id=compensation.world_id
              and ownership.asset_id=compensation.asset_id
            where compensation.id=$1
              and compensation.from_owner_entity_id=source.to_owner_entity_id
              and compensation.to_owner_entity_id=source.from_owner_entity_id
              and ownership.owner_entity_id=source.from_owner_entity_id
              and ownership.acquired_event_id=compensation.event_id
           ) exact`,
          [receipt.asset_transfer_id],
        );
        expect(exactTitle.rows[0]?.exact).toBe(true);
        const reversalCount = await owner.pool.query<{ count: string }>(
          `select count(*)::text count from asset_transfers
            where reversal_of_transfer_id=$1`,
          [fixture.sourceTransferId],
        );
        expect(reversalCount.rows[0]?.count).toBe('1');
      } else {
        expect(receipt.asset_transfer_id).toBeNull();
      }
      if (kind === 'purchase') {
        const offer = await owner.pool.query<{ status: string; terminal_command_id: string }>(
          `select status::text,terminal_command_id::text
             from asset_transfer_offers where id=$1`,
          [fixture.offerId],
        );
        expect(offer.rows[0]).toMatchObject({
          status: 'accepted',
          terminal_command_id: fixture.sourceCommandId,
        });
      }

      const reconciliation = await owner.pool.query<{
        live_projection_checksum: string;
        mismatch_count: number;
        rebuilt_journal_checksum: string;
      }>(
        `select (value->>'mismatchCount')::integer mismatch_count,
                value->>'liveProjectionChecksum' live_projection_checksum,
                value->>'rebuiltJournalChecksum' rebuilt_journal_checksum
           from (select worldgraph_economy_reconciliation_snapshot($1) value) snapshot`,
        [fixture.worldId],
      );
      expect(reconciliation.rows[0]?.mismatch_count).toBe(0);
      expect(reconciliation.rows[0]?.live_projection_checksum).toBe(
        reconciliation.rows[0]?.rebuilt_journal_checksum,
      );
      const checkpoints = await owner.pool.query<{ projection_name: string }>(
        `select projection_name from projection_checkpoints
          where world_id=$1 and status='current' and last_event_sequence=$2
            and (
              (projection_name='world_graph' and checksum=worldgraph_projection_checksum($1))
              or (projection_name='simulation_runtime'
                and checksum=worldgraph_simulation_projection_checksum($1))
              or (projection_name='economy_runtime'
                and checksum=worldgraph_economy_projection_checksum($1))
            ) order by projection_name`,
        [fixture.worldId, receipt.resulting_event_sequence],
      );
      expect(checkpoints.rows.map((row) => row.projection_name)).toEqual([
        'economy_runtime',
        'simulation_runtime',
        'world_graph',
      ]);
      const ledgerValid = await owner.pool.query<{ valid: boolean }>(
        `select bool_and(
           entry.entry_hash=worldgraph_ledger_entry_hash_v1(
             entry.id,entry.world_id,entry.ledger_sequence,entry.entry_kind::text,
             entry.command_id,entry.event_id,entry.actor_type::text,entry.actor_id,
             entry.public_summary_code,entry.redacted_details,entry.previous_hash,
             entry.recorded_at)
           and entry.previous_hash=coalesce(previous.entry_hash,decode(repeat('00',32),'hex'))
         ) valid
         from ledger_entries entry
         left join ledger_entries previous
           on previous.world_id=entry.world_id
          and previous.ledger_sequence=entry.ledger_sequence-1
        where entry.world_id=$1`,
        [fixture.worldId],
      );
      expect(ledgerValid.rows[0]?.valid).toBe(true);

      const postRepairReconciliation = await appendMatchedReconciliation(
        owner.pool,
        fixture,
        receipt,
        suiteNumber[kind],
      );
      const reconciledAuthority = await owner.pool.query<{
        event_type: string;
        ledger_valid: boolean;
        mismatch_count: number;
        reconciliation_status: string;
        run_status: string;
        source_event_sequence: string;
        source_state_revision: string;
      }>(
        `select head.reconciliation_status::text,
                run.status::text run_status,run.mismatch_count,
                run.source_state_revision::text,run.source_event_sequence::text,
                event.event_type,
                (select bool_and(
                   entry.entry_hash=worldgraph_ledger_entry_hash_v1(
                     entry.id,entry.world_id,entry.ledger_sequence,entry.entry_kind::text,
                     entry.command_id,entry.event_id,entry.actor_type::text,entry.actor_id,
                     entry.public_summary_code,entry.redacted_details,entry.previous_hash,
                     entry.recorded_at)
                   and entry.previous_hash=coalesce(
                     previous.entry_hash,decode(repeat('00',32),'hex')
                   )
                 )
                   from ledger_entries entry
                   left join ledger_entries previous
                     on previous.world_id=entry.world_id
                    and previous.ledger_sequence=entry.ledger_sequence-1
                  where entry.world_id=head.world_id) ledger_valid
           from world_economy_heads head
           join economy_reconciliation_runs run
             on run.world_id=head.world_id and run.id=head.last_reconciliation_run_id
           join domain_events event on event.world_id=run.world_id and event.id=run.event_id
          where head.world_id=$1 and run.id=$2 and run.command_id=$3`,
        [fixture.worldId, postRepairReconciliation.runId, postRepairReconciliation.commandId],
      );
      expect(reconciledAuthority.rows[0]).toMatchObject({
        event_type: 'WorldEconomyReconciledV1',
        ledger_valid: true,
        mismatch_count: 0,
        reconciliation_status: 'current',
        run_status: 'matched',
        source_event_sequence: receipt.resulting_event_sequence,
        source_state_revision: receipt.resulting_state_revision,
      });
    },
  );

  it('enforces app grants, private evidence denial, and the aggregate repair metric', async () => {
    const privileges = await owner.pool.query<{
      approve: boolean;
      execute: boolean;
      metric: boolean;
      plan: boolean;
      prepare: boolean;
    }>(
      `select
         has_function_privilege('worldgraph_app',
           'worldgraph_economy_repair_plan(uuid,uuid)','EXECUTE') plan,
         has_function_privilege('worldgraph_app',
           'worldgraph_approve_economy_repair(uuid,uuid,text,uuid,uuid,uuid,text,text)',
           'EXECUTE') approve,
         has_function_privilege('worldgraph_app',
           'worldgraph_economy_last_repair_timestamp_seconds()','EXECUTE') metric,
         has_function_privilege('worldgraph_app',
           'worldgraph_prepare_economy_repair(uuid,uuid,uuid,text,text,text)','EXECUTE') prepare,
         has_function_privilege('worldgraph_app',
           'worldgraph_execute_economy_repair(uuid,uuid,text,text)','EXECUTE') execute`,
    );
    expect(privileges.rows[0]).toEqual({
      approve: true,
      execute: false,
      metric: true,
      plan: true,
      prepare: false,
    });
    for (const table of [
      'economy_repair_plans',
      'economy_repair_approvals',
      'economy_repair_executions',
    ]) {
      await expect(app.pool.query(`select * from ${table} limit 1`)).rejects.toMatchObject({
        code: '42501',
      });
      await expect(app.pool.query(`delete from ${table} where false`)).rejects.toMatchObject({
        code: '42501',
      });
    }
    await expect(
      app.pool.query(`select worldgraph_prepare_economy_repair(null,null,null,null,null,null)`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.pool.query(`select * from worldgraph_execute_economy_repair(null,null,null,null)`),
    ).rejects.toMatchObject({ code: '42501' });
    const privacy = await app.pool.query<{
      evidence_count: string;
      incident_leaked: boolean;
      pitr_leaked: boolean;
      reasons_are_generic: boolean;
    }>(
      `with evidence(document) as (
         select to_jsonb(override)::text from creator_override_records override
          where override.authority_rule_id='economy.creator_explicit_repair_approval'
         union all
         select to_jsonb(audit)::text from security_audit_records audit
          where audit.category='economy_repair'
         union all
         select to_jsonb(command)::text from command_records command
          where command.command_type='RepairWorldEconomyV1'
         union all
         select to_jsonb(event)::text from domain_events event
          where event.event_type='WorldEconomyRepairedV1'
         union all
         select to_jsonb(entry)::text from ledger_entries entry
          where entry.entry_kind='repair_anchor'
         union all
         select to_jsonb(message)::text from outbox_messages message
          where message.event_id in (
            select event.id from domain_events event
             where event.event_type='WorldEconomyRepairedV1'
          )
         union all
         select to_jsonb(history)::text from world_history_entries history
          where history.command_id in (
            select command.id from command_records command
             where command.command_type='RepairWorldEconomyV1'
          )
         union all
         select to_jsonb(history)::text from economy_participant_history history
          where history.category='repair'
       )
       select count(*)::text evidence_count,
              coalesce(bool_or(strpos(document,$1)>0),false) incident_leaked,
              coalesce(bool_or(strpos(document,$2)>0),false) pitr_leaked,
              coalesce(bool_and(
                case when document like '%economy.creator_explicit_repair_approval%'
                  then document like '%Approved append-only economy repair%'
                  else true end
              ),false) reasons_are_generic
         from evidence`,
      [incidentReason, pitrNotUsedReason],
    );
    expect(Number(privacy.rows[0]?.evidence_count)).toBeGreaterThan(0);
    expect(privacy.rows[0]).toMatchObject({
      incident_leaked: false,
      pitr_leaked: false,
      reasons_are_generic: true,
    });
    const overrideReasons = await app.pool.query<{ reason: string }>(
      `select reason from creator_override_records
        where authority_rule_id='economy.creator_explicit_repair_approval'`,
    );
    expect(overrideReasons.rows.length).toBeGreaterThan(0);
    expect(
      overrideReasons.rows.every(({ reason }) => reason === 'Approved append-only economy repair'),
    ).toBe(true);
    const metric = await app.pool.query<{ value: string }>(
      `select worldgraph_economy_last_repair_timestamp_seconds()::text value`,
    );
    expect(Number(metric.rows[0]?.value)).toBeGreaterThan(0);
  });

  it('matches Unicode code-point, control, and ASCII edge-space reason semantics', async () => {
    const cases: ReadonlyArray<[string, boolean]> = [
      ['x'.repeat(8), true],
      ['😀'.repeat(300), true],
      ['😀'.repeat(501), false],
      [`valid${String.fromCodePoint(0x85)}reason`, false],
      [' leading reason', false],
      ['trailing reason ', false],
      ['\tnot valid', false],
    ];
    for (const [reason, expected] of cases) {
      const result = await owner.pool.query<{ valid: boolean }>(
        `select worldgraph_economy_repair_reason_is_valid($1) valid`,
        [reason],
      );
      expect(result.rows[0]?.valid, JSON.stringify(reason.slice(0, 20))).toBe(expected);
    }
  });

  it('rejects NULL across repair preparation, approval, and execution entry points', async () => {
    const fixture = await seedRepairFixture(owner.pool, 'transfer', 13);
    await expect(
      owner.pool.query(
        `select worldgraph_prepare_economy_repair(
           null,$1,$2,'ERRONEOUS_EFFECT',$3,$4
         )`,
        [fixture.sourceCommandId, fixture.adminUserId, incidentReason, pitrNotUsedReason],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      owner.pool.query(`select worldgraph_prepare_economy_repair($1,$2,$3,null,$4,$5)`, [
        fixture.worldId,
        fixture.sourceCommandId,
        fixture.adminUserId,
        incidentReason,
        pitrNotUsedReason,
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    const plan = await prepareRepair(owner, fixture);
    const approvalValues: Array<string | null> = [
      plan.repairPlanId,
      fixture.creatorUserId,
      'creator',
      repairId(13, 100),
      repairId(13, 101),
      repairId(13, 102),
      plan.planHash,
      'APPROVE APPEND-ONLY ECONOMY REPAIR',
    ];
    for (const nullIndex of [2, 6, 7]) {
      const values = [...approvalValues];
      values[nullIndex] = null;
      await expect(
        app.pool.query(`select worldgraph_approve_economy_repair($1,$2,$3,$4,$5,$6,$7,$8)`, values),
      ).rejects.toMatchObject({ code: '22023' });
    }
    for (const values of [
      [plan.repairPlanId, null, plan.planHash, 'APPLY APPEND-ONLY ECONOMY REPAIR'],
      [plan.repairPlanId, fixture.adminUserId, null, 'APPLY APPEND-ONLY ECONOMY REPAIR'],
      [plan.repairPlanId, fixture.adminUserId, plan.planHash, null],
    ]) {
      await expect(
        owner.pool.query(`select * from worldgraph_execute_economy_repair($1,$2,$3,$4)`, values),
      ).rejects.toMatchObject({ code: '22023' });
    }
  });

  it('requires both approvals from distinct creator and executing-admin actors', async () => {
    const fixture = await seedRepairFixture(owner.pool, 'transfer', 14);
    const plan = await prepareRepair(owner, fixture);
    await expect(executeRepair(owner, fixture, plan)).rejects.toMatchObject({ code: '55000' });
    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(`update users set platform_role='platform_admin' where id=$1`, [
        fixture.creatorUserId,
      ]);
      await connection.query(`set local session_replication_role = 'origin'`);
    });
    await app.pool.query(
      `select worldgraph_approve_economy_repair(
         $1,$2,'creator',$3,$4,$5,$6,'APPROVE APPEND-ONLY ECONOMY REPAIR'
       )`,
      [
        plan.repairPlanId,
        fixture.creatorUserId,
        repairId(14, 100),
        repairId(14, 101),
        repairId(14, 102),
        plan.planHash,
      ],
    );
    await expect(
      app.pool.query(
        `select worldgraph_approve_economy_repair(
           $1,$2,'platform_admin',$3,null,$4,$5,'APPROVE APPEND-ONLY ECONOMY REPAIR'
         )`,
        [
          plan.repairPlanId,
          fixture.creatorUserId,
          repairId(14, 103),
          repairId(14, 104),
          plan.planHash,
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(executeRepair(owner, fixture, plan)).rejects.toMatchObject({ code: '55000' });
  });

  it.each(['creator_disabled', 'creator_membership_removed', 'admin_demoted'] as const)(
    'rechecks locked active repair authority when %s after approval',
    async (revocation) => {
      const suite =
        30 +
        ['creator_disabled', 'creator_membership_removed', 'admin_demoted'].indexOf(revocation);
      const fixture = await seedRepairFixture(owner.pool, 'transfer', suite);
      const plan = await prepareRepair(owner, fixture);
      await approveRepair(app, fixture, plan, suite);
      await transaction(owner.pool, async (connection) => {
        await connection.query(`set local session_replication_role = 'replica'`);
        if (revocation === 'creator_disabled') {
          await connection.query(`update users set status='disabled' where id=$1`, [
            fixture.creatorUserId,
          ]);
        } else if (revocation === 'creator_membership_removed') {
          await connection.query(
            `update world_memberships
                set status='removed',removed_at=date_trunc('milliseconds',now()),
                    updated_at=date_trunc('milliseconds',now()),row_version=row_version+1
              where world_id=$1 and user_id=$2`,
            [fixture.worldId, fixture.creatorUserId],
          );
        } else {
          await connection.query(`update users set platform_role='user' where id=$1`, [
            fixture.adminUserId,
          ]);
        }
        await connection.query(`set local session_replication_role = 'origin'`);
      });
      await expect(executeRepair(owner, fixture, plan)).rejects.toMatchObject({ code: '55000' });
    },
  );

  it.each(['approval', 'execution'] as const)(
    'rejects a pre-expiry %s queued behind a lock and released after expiry',
    async (operation) => {
      const suite = operation === 'approval' ? 50 : 51;
      const fixture = await seedRepairFixture(owner.pool, 'transfer', suite);
      const plan = await prepareRepair(owner, fixture);
      const locker = await owner.pool.connect();
      try {
        await locker.query('begin');
        plan.planHash = await resealPlanNearExpiry(locker, plan.repairPlanId, 4_000);
        await locker.query('commit');
        if (operation === 'execution') {
          await approveRepair(app, fixture, plan, suite);
        }
        await locker.query('begin');
        if (operation === 'approval') {
          await locker.query(
            `select 1 from world_memberships
              where world_id=$1 and user_id=$2 for update`,
            [fixture.worldId, fixture.creatorUserId],
          );
        } else {
          await locker.query(`select 1 from economy_repair_plans where id=$1 for update`, [
            plan.repairPlanId,
          ]);
        }
        const queued =
          operation === 'approval'
            ? app.pool.query(
                `select worldgraph_approve_economy_repair(
                   $1,$2,'creator',$3,$4,$5,$6,'APPROVE APPEND-ONLY ECONOMY REPAIR'
                 )`,
                [
                  plan.repairPlanId,
                  fixture.creatorUserId,
                  repairId(suite, 100),
                  repairId(suite, 101),
                  repairId(suite, 102),
                  plan.planHash,
                ],
              )
            : owner.pool.query(
                `select * from worldgraph_execute_economy_repair(
                   $1,$2,$3,'APPLY APPEND-ONLY ECONOMY REPAIR'
                 )`,
                [plan.repairPlanId, fixture.adminUserId, plan.planHash],
              );
        const rejected = expect(queued).rejects.toMatchObject({ code: '55000' });
        await new Promise((resolve) => setTimeout(resolve, 4_500));
        await locker.query('commit');
        await rejected;
      } finally {
        await locker.query('rollback').catch(() => undefined);
        locker.release();
      }
    },
  );

  it('rejects changed approval retries and changed repair execution hashes', async () => {
    const fixture = await seedRepairFixture(owner.pool, 'transfer', 9);
    const plan = await prepareRepair(owner, fixture);
    const suite = 9;
    await approveRepair(app, fixture, plan, suite);
    await expect(
      app.pool.query(
        `select worldgraph_approve_economy_repair(
           $1,$2,'creator',$3,$4,$5,$6,$7
         )`,
        [
          plan.repairPlanId,
          fixture.adminUserId,
          repairId(suite, 100),
          repairId(suite, 101),
          repairId(suite, 102),
          plan.planHash,
          'APPROVE APPEND-ONLY ECONOMY REPAIR',
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.pool.query(`select * from worldgraph_execute_economy_repair($1,$2,$3,$4)`, [
        plan.repairPlanId,
        fixture.adminUserId,
        '0'.repeat(64),
        'APPLY APPEND-ONLY ECONOMY REPAIR',
      ]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it.each([
    'expired',
    'head_changed',
    'source_reversed',
    'plan_tampered',
    'reason_code_tampered',
    'private_reason_tampered',
    'expiry_extended',
  ] as const)('fails closed when a prepared plan becomes %s', async (failure) => {
    const suite =
      20 +
      [
        'expired',
        'head_changed',
        'source_reversed',
        'plan_tampered',
        'reason_code_tampered',
        'private_reason_tampered',
        'expiry_extended',
      ].indexOf(failure);
    const fixture = await seedRepairFixture(owner.pool, 'transfer', suite);
    const plan = await prepareRepair(owner, fixture);
    await approveRepair(app, fixture, plan, suite);
    await transaction(owner.pool, async (connection) => {
      await connection.query(`set local session_replication_role = 'replica'`);
      if (failure === 'expired') {
        await connection.query(
          `update economy_repair_plans
                set prepared_at=date_trunc('milliseconds',now())-interval '25 hours',
                    expires_at=date_trunc('milliseconds',now())-interval '1 hour'
              where id=$1`,
          [plan.repairPlanId],
        );
      } else if (failure === 'head_changed') {
        await connection.query(
          `update world_economy_heads set row_version=row_version+1 where world_id=$1`,
          [fixture.worldId],
        );
      } else if (failure === 'source_reversed') {
        await connection.query(
          `insert into financial_transactions(
               id,world_id,currency_id,transaction_kind,supply_delta_minor,
               command_id,event_id,memo_code,reversal_of_transaction_id,
               occurred_tick,state_revision
             )
             select $2,source.world_id,source.currency_id,'compensation',
                    -source.supply_delta_minor,$3,$4,'tampered_reversal',source.id,10,6
               from financial_transactions source where source.id=$1`,
          [
            fixture.sourceFinancialTransactionId,
            repairId(suite, 200),
            repairId(suite, 201),
            repairId(suite, 202),
          ],
        );
      } else if (failure === 'plan_tampered') {
        await connection.query(
          `update economy_repair_plans
                set canonical_delta=canonical_delta || '{"tampered":true}'::jsonb
              where id=$1`,
          [plan.repairPlanId],
        );
      } else if (failure === 'reason_code_tampered') {
        await connection.query(
          `update economy_repair_plans set reason_code='DUPLICATE_EFFECT' where id=$1`,
          [plan.repairPlanId],
        );
      } else if (failure === 'private_reason_tampered') {
        await connection.query(
          `update economy_repair_plans
                set incident_reason='This private incident narrative was silently changed.'
              where id=$1`,
          [plan.repairPlanId],
        );
      } else {
        await connection.query(
          `update economy_repair_plans
                set prepared_at=prepared_at+interval '1 day',
                    expires_at=expires_at+interval '1 day'
              where id=$1`,
          [plan.repairPlanId],
        );
      }
      await connection.query(`set local session_replication_role = 'origin'`);
    });
    if (
      failure === 'plan_tampered' ||
      failure === 'reason_code_tampered' ||
      failure === 'private_reason_tampered' ||
      failure === 'expiry_extended'
    ) {
      await expect(
        app.pool.query(`select worldgraph_economy_repair_plan($1,$2)`, [
          plan.repairPlanId,
          fixture.creatorUserId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query(
          `select worldgraph_approve_economy_repair(
               $1,$2,'creator',$3,$4,$5,$6,'APPROVE APPEND-ONLY ECONOMY REPAIR'
             )`,
          [
            plan.repairPlanId,
            fixture.creatorUserId,
            repairId(suite, 100),
            repairId(suite, 101),
            repairId(suite, 102),
            plan.planHash,
          ],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    }
    await expect(executeRepair(owner, fixture, plan)).rejects.toMatchObject({ code: '55000' });
  });
});
