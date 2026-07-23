import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient, readRuntimeVersions } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const tags = [
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

const validSeedPlan = {
  assets: [
    {
      assetSchemaVersion: 1,
      assetType: 'founding_seal',
      initialOwnerEntityLogicalKey: 'character:founder',
      metadata: {
        displayName: 'Founding Seal',
        provenance: 'compiler-economy-adapter-v1',
      },
      stableKey: 'asset:founding-seal',
      transferable: true,
      worldEntityLogicalKey: null,
    },
  ],
  currency: {
    cashOutAllowed: false,
    code: 'WGC',
    currencySchemaVersion: 1,
    issuerEntityLogicalKey: 'organization:treasury',
    maxSupplyMinor: '1000',
    minorUnitScale: 0,
    name: 'WorldGraph Credit',
    noCashValue: true,
    stableKey: 'currency:worldgraph-credit',
  },
  economySeedPlanSchemaVersion: 1,
  initialSupplyMinor: '1000',
  wallets: [
    {
      initialBalanceMinor: '1000',
      ownerEntityLogicalKey: 'character:founder',
      stableKey: 'wallet:founder',
      walletKind: 'player',
      walletSchemaVersion: 1,
    },
    {
      initialBalanceMinor: '0',
      ownerEntityLogicalKey: 'organization:treasury',
      stableKey: 'wallet:treasury',
      walletKind: 'treasury',
      walletSchemaVersion: 1,
    },
  ],
};

function withoutPath(value: unknown, path: ReadonlyArray<number | string>): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  let cursor: Record<string, unknown> | unknown[] = copy;
  for (const segment of path.slice(0, -1)) {
    const next = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[String(segment)];
    cursor = next as Record<string, unknown> | unknown[];
  }
  const leaf = path.at(-1);
  if (leaf === undefined || Array.isArray(cursor)) throw new Error('invalid required-key path');
  delete cursor[String(leaf)];
  return copy;
}

async function migrationFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-m08-'));
  await mkdir(join(root, 'meta'));
  await Promise.all(
    tags.map((tag) => cp(join(migrationRoot, `${tag}.sql`), join(root, `${tag}.sql`))),
  );
  await writeFile(
    join(root, 'meta/_journal.json'),
    JSON.stringify({
      dialect: 'postgresql',
      entries: tags.map((tag, index) => ({
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

type OverrideMode = 'missing' | 'mismatched' | 'non_treasury';

async function commitIssuanceWithInvalidOverride(pool: Pool, mode: OverrideMode): Promise<void> {
  const ids = {
    command: '088f0000-0000-7000-8000-000000000101',
    currency: '088f0000-0000-7000-8000-000000000102',
    entity: '088f0000-0000-7000-8000-000000000103',
    event: '088f0000-0000-7000-8000-000000000104',
    override: '088f0000-0000-7000-8000-000000000105',
    audit: '088f0000-0000-7000-8000-000000000106',
    posting: '088f0000-0000-7000-8000-000000000107',
    transaction: '088f0000-0000-7000-8000-000000000108',
    user: '088f0000-0000-7000-8000-000000000109',
    version: '088f0000-0000-7000-8000-000000000110',
    wallet: '088f0000-0000-7000-8000-000000000111',
    world: '088f0000-0000-7000-8000-000000000112',
  };
  await transaction(pool, async (connection) => {
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into users(id,email,password_hash,display_name)
       values ($1,$2,$3,'Issuance Creator')`,
      [ids.user, `m08-${mode}@example.test`, passwordHash],
    );
    await connection.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,$2,'M08 Issuance Guard',$3)`,
      [ids.world, `m08-issuance-${mode.replace('_', '-')}`, ids.user],
    );
    await connection.query(
      `insert into world_entities(
         id,world_id,logical_key,entity_type,entity_schema_version,state,created_world_version_id
       ) values ($1,$2,'organization:treasury','organization',1,
         '{"homeDistrictLogicalKey":"district:capital","name":"Treasury",
           "parameters":{},"primitiveRef":"treasury"}',$3)`,
      [ids.entity, ids.world, ids.version],
    );
    await connection.query(
      `insert into command_records(
         id,world_id,command_type,command_schema_version,actor_type,actor_id,
         payload,payload_hash,payload_classification,idempotency_key,request_hash,
         opened_state_revision,opened_ledger_sequence,opened_event_sequence,
         write_gate_opened_at,correlation_id,requested_at
       ) values ($1,$2,'IssueCurrencyV1',1,'user',$3,null,decode(repeat('11',32),'hex'),
         'member',$4,decode(repeat('12',32),'hex'),1,1,1,transaction_timestamp(),
         $1,date_trunc('milliseconds',now()))`,
      [ids.command, ids.world, ids.user, `m08-issuance-${mode}`],
    );
    await connection.query(
      `insert into domain_events(
         id,world_id,world_event_sequence,command_id,event_ordinal,aggregate_type,
         aggregate_id,aggregate_version,event_type,event_schema_version,payload,metadata,
         event_hash,occurred_at,recorded_at,resulting_state_revision
       ) values ($1,$2,1,$3,0,'currency',$4,1,'CurrencyIssuedV1',1,'{}','{}',
         decode(repeat('13',32),'hex'),date_trunc('milliseconds',now()),
         date_trunc('milliseconds',now()),1)`,
      [ids.event, ids.world, ids.command, ids.currency],
    );
    await connection.query(
      `insert into currencies(
         id,world_id,stable_key,code,name,minor_unit_scale,max_supply_minor,
         issuer_entity_id,created_event_id
       ) values ($1,$2,'currency:test-credit','TST','Test Credit',0,1000,$3,$4)`,
      [ids.currency, ids.world, ids.entity, ids.event],
    );
    await connection.query(
      `insert into wallets(
         id,world_id,currency_id,stable_key,owner_entity_id,wallet_kind,created_event_id
       ) values ($1,$2,$3,'wallet:treasury',$4,$6,$5)`,
      [
        ids.wallet,
        ids.world,
        ids.currency,
        ids.entity,
        ids.event,
        mode === 'non_treasury' ? 'player' : 'treasury',
      ],
    );
    await connection.query(
      `insert into currency_supply(currency_id,world_id,current_supply_minor,updated_state_revision)
       values ($1,$2,100,1)`,
      [ids.currency, ids.world],
    );
    await connection.query(
      `insert into wallet_balances(
         wallet_id,world_id,currency_id,available_minor,updated_state_revision
       ) values ($1,$2,$3,100,1)`,
      [ids.wallet, ids.world, ids.currency],
    );
    if (mode !== 'missing') {
      await connection.query(
        `insert into security_audit_records(
           id,actor_user_id,world_id,category,action,outcome,reason_code,target_type,
           target_id,request_id,correlation_id
         ) values ($1,$2,$3,'creator_override','economy.currency.issue','allowed',
           'CREATOR_OVERRIDE_USED','currency',$4,$5,$5)`,
        [ids.audit, ids.user, ids.world, ids.currency, ids.command],
      );
      await connection.query(
        `insert into creator_override_records(
           id,world_id,actor_user_id,action,target_type,target_id,reason,
           authority_rule_id,command_id,audit_record_id
         ) values ($1,$2,$3,'economy.currency.issue','currency',$4,
           $7,
           'economy.creator_explicit_issuance_override',$5,$6)`,
        [
          ids.override,
          ids.world,
          ids.user,
          ids.currency,
          ids.command,
          ids.audit,
          mode === 'mismatched'
            ? 'A deliberately different issuance reason'
            : 'Exact issuance reason',
        ],
      );
    }
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(
      `select set_config('worldgraph.command_world_id',$1,true),
              set_config('worldgraph.command_id',$2,true)`,
      [ids.world, ids.command],
    );
    const gate = await connection.query<{
      command_id: string;
      command_type: string | null;
      command_world_id: string;
      command_matches: boolean;
      exists_received: boolean;
      is_open: boolean;
      status: string;
      world_matches: boolean;
    }>(
      `select current_setting('worldgraph.command_id',true) command_id,
              current_setting('worldgraph.command_world_id',true) command_world_id,
              current_setting('worldgraph.command_id',true)=$2::uuid::text command_matches,
              current_setting('worldgraph.command_world_id',true)=$1::uuid::text world_matches,
              exists(select 1 from command_records received
                where received.id=$2::uuid and received.world_id=$1::uuid
                  and received.status='received') exists_received,
              command.status::text,worldgraph_command_write_is_open($1,$2) is_open,
              worldgraph_economy_open_command_type($1) command_type
         from command_records command where command.id=$2`,
      [ids.world, ids.command],
    );
    if (!gate.rows[0]?.is_open) throw new Error(JSON.stringify(gate.rows[0]));
    await connection.query(
      `insert into financial_transactions(
         id,world_id,currency_id,transaction_kind,supply_delta_minor,command_id,event_id,
         memo_code,memo_text,occurred_tick,state_revision
       ) values ($1,$2,$3,'issuance',100,$4,$5,'creator_issuance',
         'Exact issuance reason',0,1)`,
      [ids.transaction, ids.world, ids.currency, ids.command, ids.event],
    );
    await connection.query(
      `insert into wallet_postings(
         id,transaction_id,world_id,currency_id,wallet_id,posting_ordinal,signed_amount_minor
       ) values ($1,$2,$3,$4,$5,0,100)`,
      [ids.posting, ids.transaction, ids.world, ids.currency, ids.wallet],
    );
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `update command_records
          set status='accepted',authorization_rule_id='economy.creator_explicit_issuance_override',
              override_id=$2,decided_at=date_trunc('milliseconds',now()),
              resulting_state_revision=1,response_summary='{}'
        where id=$1`,
      [ids.command, mode === 'missing' ? null : ids.override],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
  });
}

async function commitReconciliationWithWrongItem(pool: Pool): Promise<void> {
  const ids = {
    command: '088f0000-0000-7000-8000-000000000301',
    currency: '088f0000-0000-7000-8000-000000000302',
    entity: '088f0000-0000-7000-8000-000000000303',
    event: '088f0000-0000-7000-8000-000000000304',
    run: '088f0000-0000-7000-8000-000000000305',
    user: '088f0000-0000-7000-8000-000000000306',
    version: '088f0000-0000-7000-8000-000000000307',
    wallet: '088f0000-0000-7000-8000-000000000308',
    world: '088f0000-0000-7000-8000-000000000309',
  };
  await transaction(pool, async (connection) => {
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into users(id,email,password_hash,display_name)
       values ($1,'m08-reconciliation@example.test',$2,'Reconciliation Operator')`,
      [ids.user, passwordHash],
    );
    await connection.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'m08-reconciliation-world','M08 Reconciliation World',$2)`,
      [ids.world, ids.user],
    );
    await connection.query(
      `insert into world_entities(
         id,world_id,logical_key,entity_type,entity_schema_version,state,created_world_version_id
       ) values ($1,$2,'organization:treasury','organization',1,
         '{"homeDistrictLogicalKey":"district:capital","name":"Treasury",
           "parameters":{},"primitiveRef":"treasury"}',$3)`,
      [ids.entity, ids.world, ids.version],
    );
    await connection.query(
      `insert into command_records(
         id,world_id,command_type,command_schema_version,actor_type,actor_id,
         payload,payload_hash,payload_classification,idempotency_key,request_hash,
         opened_state_revision,opened_ledger_sequence,opened_event_sequence,
         write_gate_opened_at,correlation_id,requested_at
       ) values ($1,$2,'ReconcileWorldEconomyV1',1,'user',$3,null,
         decode(repeat('31',32),'hex'),'private','m08-reconcile-wrong-item',
         decode(repeat('32',32),'hex'),1,1,1,transaction_timestamp(),
         $1,date_trunc('milliseconds',now()))`,
      [ids.command, ids.world, ids.user],
    );
    await connection.query(
      `insert into domain_events(
         id,world_id,world_event_sequence,command_id,event_ordinal,aggregate_type,
         aggregate_id,aggregate_version,event_type,event_schema_version,payload,metadata,
         event_hash,occurred_at,recorded_at,resulting_state_revision
       ) values ($1,$2,2,$3,0,'world_economy',$2::uuid::text,2,'WorldEconomyReconciledV1',
         1,'{}','{}',decode(repeat('33',32),'hex'),date_trunc('milliseconds',now()),
         date_trunc('milliseconds',now()),2)`,
      [ids.event, ids.world, ids.command],
    );
    await connection.query(
      `insert into currencies(
         id,world_id,stable_key,code,name,minor_unit_scale,max_supply_minor,
         issuer_entity_id,created_event_id
       ) values ($1,$2,'currency:reconcile-credit','REC','Reconcile Credit',0,1000,$3,$4)`,
      [ids.currency, ids.world, ids.entity, ids.event],
    );
    await connection.query(
      `insert into wallets(
         id,world_id,currency_id,stable_key,owner_entity_id,wallet_kind,created_event_id
       ) values ($1,$2,$3,'wallet:reconcile-treasury',$4,'treasury',$5)`,
      [ids.wallet, ids.world, ids.currency, ids.entity, ids.event],
    );
    await connection.query(
      `insert into currency_supply(currency_id,world_id,current_supply_minor,updated_state_revision)
       values ($1,$2,0,1)`,
      [ids.currency, ids.world],
    );
    await connection.query(
      `insert into wallet_balances(
         wallet_id,world_id,currency_id,available_minor,updated_state_revision
       ) values ($1,$2,$3,100,1)`,
      [ids.wallet, ids.world, ids.currency],
    );
    await connection.query(
      `insert into world_economy_heads(
         world_id,source_world_version_id,seed_plan_hash,initialized_command_id,
         initialized_event_id,checksum,row_version,updated_state_revision,
         reconciliation_status,last_reconciled_state_revision,last_reconciliation_run_id
       ) values ($1,$2,decode(repeat('34',32),'hex'),$3,$4,
         decode(repeat('35',32),'hex'),2,2,'mismatch',1,$5)`,
      [ids.world, ids.version, ids.command, ids.event, ids.run],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(
      `select set_config('worldgraph.command_world_id',$1,true),
              set_config('worldgraph.command_id',$2,true)`,
      [ids.world, ids.command],
    );
    await connection.query(
      `with snapshot as (
         select worldgraph_economy_reconciliation_snapshot($2) value
       )
       insert into economy_reconciliation_runs(
         id,world_id,source_state_revision,source_event_sequence,status,
         live_wallet_checksum,rebuilt_wallet_checksum,live_supply_checksum,
         rebuilt_supply_checksum,live_ownership_checksum,rebuilt_ownership_checksum,
         live_projection_checksum,rebuilt_journal_checksum,wallet_count,currency_count,
         asset_count,mismatch_count,command_id,event_id
       )
       select $1,$2,1,1,'mismatch',
         decode(value->>'liveWalletChecksum','hex'),
         decode(value->>'rebuiltWalletChecksum','hex'),
         decode(value->>'liveSupplyChecksum','hex'),
         decode(value->>'rebuiltSupplyChecksum','hex'),
         decode(value->>'liveOwnershipChecksum','hex'),
         decode(value->>'rebuiltOwnershipChecksum','hex'),
         decode(value->>'liveProjectionChecksum','hex'),
         decode(value->>'rebuiltJournalChecksum','hex'),
         (value->>'walletCount')::integer,(value->>'currencyCount')::integer,
         (value->>'assetCount')::integer,(value->>'mismatchCount')::integer,$3,$4
       from snapshot`,
      [ids.run, ids.world, ids.command, ids.event],
    );
    await connection.query(
      `with snapshot as (
         select worldgraph_economy_reconciliation_snapshot($2) value
       )
       insert into economy_reconciliation_items(
         run_id,item_ordinal,item_kind,item_key,item_key_hash,
         expected_value,actual_value,mismatch_code
       )
       select $1,0,'wallet_balance','wrong-wallet-key',
         extensions.digest(convert_to('wrong-wallet-key','UTF8'),'sha256'),
         value->>'rebuiltWalletChecksum',value->>'liveWalletChecksum',
         'WALLET_BALANCE_CHECKSUM_MISMATCH'
       from snapshot`,
      [ids.run, ids.world],
    );
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `update command_records
          set status='accepted',authorization_rule_id='economy.world_role.reconcile',
              decided_at=date_trunc('milliseconds',now()),resulting_state_revision=2,
              response_summary='{}'
        where id=$1`,
      [ids.command],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
  });
}

const projectionIds = {
  asset: '088f0000-0000-7000-8000-000000000401',
  secondAsset: '088f0000-0000-7000-8000-000000000411',
  command: '088f0000-0000-7000-8000-000000000402',
  currency: '088f0000-0000-7000-8000-000000000403',
  secondCurrency: '088f0000-0000-7000-8000-000000000412',
  event: '088f0000-0000-7000-8000-000000000404',
  owner: '088f0000-0000-7000-8000-000000000405',
  secondOwner: '088f0000-0000-7000-8000-000000000406',
  offer: '088f0000-0000-7000-8000-000000000413',
  terminalEvent: '088f0000-0000-7000-8000-000000000414',
  extraEvent: '088f0000-0000-7000-8000-000000000421',
  transaction: '088f0000-0000-7000-8000-000000000422',
  sourcePosting: '088f0000-0000-7000-8000-000000000423',
  destinationPosting: '088f0000-0000-7000-8000-000000000424',
  assetTransfer: '088f0000-0000-7000-8000-000000000425',
  forgedParticipant: '088f0000-0000-7000-8000-000000000426',
  ledgerEntry: '088f0000-0000-7000-8000-000000000427',
  reconciliationRun: '088f0000-0000-7000-8000-000000000415',
  seedPlan: '088f0000-0000-7000-8000-000000000418',
  compilationRun: '088f0000-0000-7000-8000-000000000419',
  sourceArtifact: '088f0000-0000-7000-8000-000000000420',
  user: '088f0000-0000-7000-8000-000000000407',
  version: '088f0000-0000-7000-8000-000000000408',
  wallet: '088f0000-0000-7000-8000-000000000409',
  destinationWallet: '088f0000-0000-7000-8000-000000000416',
  secondCurrencyWallet: '088f0000-0000-7000-8000-000000000417',
  world: '088f0000-0000-7000-8000-000000000410',
};

async function seedProjectionFixture(connection: PoolClient): Promise<void> {
  const ids = projectionIds;
  await connection.query(`set local session_replication_role = 'replica'`);
  await connection.query(
    `insert into users(id,email,password_hash,display_name)
     values ($1,'m08-projection@example.test',$2,'Projection Creator')`,
    [ids.user, passwordHash],
  );
  await connection.query(
    `insert into worlds(id,slug,name,created_by_user_id)
     values ($1,'m08-projection-world','M08 Projection World',$2)`,
    [ids.world, ids.user],
  );
  await connection.query(
    `insert into world_entities(
       id,world_id,logical_key,entity_type,entity_schema_version,state,created_world_version_id
     ) values
       ($1,$3,'organization:treasury','organization',1,
         '{"homeDistrictLogicalKey":"district:capital","name":"Treasury",
           "parameters":{},"primitiveRef":"treasury"}',$4),
       ($2,$3,'organization:buyer','organization',1,
         '{"homeDistrictLogicalKey":"district:capital","name":"Buyer",
           "parameters":{},"primitiveRef":"buyer"}',$4)`,
    [ids.owner, ids.secondOwner, ids.world, ids.version],
  );
  await connection.query(
    `insert into domain_events(
       id,world_id,world_event_sequence,command_id,event_ordinal,aggregate_type,
       aggregate_id,aggregate_version,event_type,event_schema_version,payload,metadata,
       event_hash,occurred_at,recorded_at,resulting_state_revision
     ) values ($1,$2,1,$3,0,'world_economy',$2::uuid::text,1,
       'WorldEconomyInitializedV1',1,'{}','{}',decode(repeat('41',32),'hex'),
       date_trunc('milliseconds',now()),date_trunc('milliseconds',now()),1)`,
    [ids.event, ids.world, ids.command],
  );
  await connection.query(
    `insert into currencies(
       id,world_id,stable_key,code,name,minor_unit_scale,max_supply_minor,
       issuer_entity_id,created_event_id
     ) values
       ($1,$3,'currency:projection-credit','PRJ','Projection Credit',0,1000,$4,$5),
       ($2,$3,'currency:alternate-credit','ALT','Alternate Credit',0,1000,$4,$5)`,
    [ids.currency, ids.secondCurrency, ids.world, ids.owner, ids.event],
  );
  await connection.query(
    `insert into wallets(
       id,world_id,currency_id,stable_key,owner_entity_id,wallet_kind,created_event_id
     ) values
       ($1,$4,$5,'wallet:projection-treasury',$6,'treasury',$8),
       ($2,$4,$5,'wallet:projection-destination',$7,'player',$8),
       ($3,$4,$9,'wallet:alternate-destination',$7,'player',$8)`,
    [
      ids.wallet,
      ids.destinationWallet,
      ids.secondCurrencyWallet,
      ids.world,
      ids.currency,
      ids.owner,
      ids.secondOwner,
      ids.event,
      ids.secondCurrency,
    ],
  );
  await connection.query(
    `insert into currency_supply(currency_id,world_id,current_supply_minor,updated_state_revision)
     values ($1,$3,0,1),($2,$3,0,1)`,
    [ids.currency, ids.secondCurrency, ids.world],
  );
  await connection.query(
    `insert into wallet_balances(
       wallet_id,world_id,currency_id,available_minor,updated_state_revision
     ) values
       ($1,$4,$5,0,1),($2,$4,$5,0,1),($3,$4,$6,0,1)`,
    [
      ids.wallet,
      ids.destinationWallet,
      ids.secondCurrencyWallet,
      ids.world,
      ids.currency,
      ids.secondCurrency,
    ],
  );
  await connection.query(
    `insert into assets(
       id,world_id,stable_key,asset_type,metadata,transferable,created_event_id
     ) values
       ($1,$3,'asset:projection-seal','founding_seal',
         '{"displayName":"Projection Seal","provenance":"compiler-economy-adapter-v1"}',
         true,$4),
       ($2,$3,'asset:alternate-seal','founding_seal',
         '{"displayName":"Alternate Seal","provenance":"compiler-economy-adapter-v1"}',
         true,$4)`,
    [ids.asset, ids.secondAsset, ids.world, ids.event],
  );
  await connection.query(
    `insert into asset_ownership(
       asset_id,world_id,owner_entity_id,ownership_version,acquired_event_id,
       updated_state_revision
     ) values ($1,$3,$4,1,$5,1),($2,$3,$4,1,$5,1)`,
    [ids.asset, ids.secondAsset, ids.world, ids.owner, ids.event],
  );
  await connection.query(
    `insert into asset_transfer_offers(
       id,world_id,asset_id,seller_entity_id,buyer_entity_id,currency_id,
       seller_wallet_id,price_minor,expires_at_tick,created_at_tick,
       created_command_id,created_event_id,created_state_revision
     ) values ($1,$2,$3,$4,$5,$6,$7,10,20,1,$8,$9,1)`,
    [
      ids.offer,
      ids.world,
      ids.asset,
      ids.owner,
      ids.secondOwner,
      ids.currency,
      ids.wallet,
      ids.command,
      ids.event,
    ],
  );
  await connection.query(
    `insert into compiled_economy_seed_plans(
       id,world_id,world_version_id,compilation_run_id,source_artifact_id,
       seed_plan_schema_version,source_kind,source_compiler_version,
       source_adapter_id,source_adapter_version,canonical_plan,plan_hash,
       source_artifact_hash
     ) values ($1,$2,$3,$4,$5,1,'compiler_1_1','1.1.0',
       'CompiledEconomySeedAdapterV1','1.0.0',$6::jsonb,
       extensions.digest(convert_to(worldgraph_canonical_jsonb(jsonb_build_object(
         'domain','worldgraph.economy-seed-plan.v1','plan',$6::jsonb
       )),'UTF8'),'sha256'),decode(repeat('45',32),'hex'))`,
    [
      ids.seedPlan,
      ids.world,
      ids.version,
      ids.compilationRun,
      ids.sourceArtifact,
      JSON.stringify(validSeedPlan),
    ],
  );
  await connection.query(
    `insert into world_economy_heads(
       world_id,source_world_version_id,seed_plan_hash,initialized_command_id,
       initialized_event_id,checksum,updated_state_revision
     ) select $1,$2,plan.plan_hash,$3,$4,
              worldgraph_economy_projection_checksum($1),1
         from compiled_economy_seed_plans plan where plan.id=$5`,
    [ids.world, ids.version, ids.command, ids.event, ids.seedPlan],
  );
  await connection.query(`set local session_replication_role = 'origin'`);
}

type ProjectionUpdateTarget = 'asset' | 'balance' | 'currency' | 'ownership' | 'supply';

async function attemptProjectionUpdateOutsideGate(
  pool: Pool,
  target: ProjectionUpdateTarget,
): Promise<void> {
  await transaction(pool, async (connection) => {
    await seedProjectionFixture(connection);
    await connection.query(`set local role worldgraph_app`);
    const statements: Record<ProjectionUpdateTarget, [string, unknown[]]> = {
      asset: [`update assets set metadata=metadata where id=$1`, [projectionIds.asset]],
      balance: [
        `update wallet_balances
            set available_minor=1,row_version=2,updated_state_revision=2,updated_at=now()
          where wallet_id=$1`,
        [projectionIds.wallet],
      ],
      currency: [
        `update currencies set status='frozen',row_version=2,updated_at=now() where id=$1`,
        [projectionIds.currency],
      ],
      ownership: [
        `update asset_ownership
            set owner_entity_id=$2,ownership_version=2,updated_state_revision=2,updated_at=now()
          where asset_id=$1`,
        [projectionIds.asset, projectionIds.secondOwner],
      ],
      supply: [
        `update currency_supply
            set current_supply_minor=1,row_version=2,updated_state_revision=2,updated_at=now()
          where currency_id=$1`,
        [projectionIds.currency],
      ],
    };
    const [statement, parameters] = statements[target];
    await connection.query(statement, parameters);
  });
}

type RejectedEconomyMutationTarget =
  'balance' | 'currency_status' | 'head' | 'offer' | 'ownership' | 'supply' | 'wallet_status';

const rejectedMutationCommand: Record<RejectedEconomyMutationTarget, string> = {
  balance: 'TransferCurrencyV1',
  currency_status: 'FreezeCurrencyV1',
  head: 'TransferCurrencyV1',
  offer: 'CancelAssetTransferOfferV1',
  ownership: 'TransferAssetV1',
  supply: 'IssueCurrencyV1',
  wallet_status: 'FreezeWalletV1',
};

async function seedReceivedEconomyCommand(
  connection: PoolClient,
  commandType: string,
): Promise<void> {
  const ids = projectionIds;
  await connection.query(`set local session_replication_role = 'replica'`);
  await connection.query(
    `insert into command_records(
       id,world_id,command_type,command_schema_version,actor_type,actor_id,
       payload,payload_hash,payload_classification,idempotency_key,request_hash,
       opened_state_revision,opened_ledger_sequence,opened_event_sequence,
       opened_projection_checksum,write_gate_opened_at,correlation_id,requested_at
     ) values ($1,$2,$3,1,'user',$4,null,decode(repeat('51',32),'hex'),
       'member',$5,decode(repeat('52',32),'hex'),1,1,1,
       decode(repeat('53',32),'hex'),transaction_timestamp(),$1,
       date_trunc('milliseconds',now()))`,
    [ids.command, ids.world, commandType, ids.user, `m08-${commandType}`],
  );
  await connection.query(
    `insert into economy_command_write_snapshots(
       command_id,world_id,economy_state_exists,
       opened_head_row_version,opened_head_checksum
     ) select $1,$2,true,head.row_version,head.checksum
         from world_economy_heads head where head.world_id=$2`,
    [ids.command, ids.world],
  );
  await connection.query(`set local session_replication_role = 'origin'`);
}

async function attemptRejectedEconomyMutation(
  pool: Pool,
  target: RejectedEconomyMutationTarget,
): Promise<void> {
  const ids = projectionIds;
  await transaction(pool, async (connection) => {
    await seedProjectionFixture(connection);
    await seedReceivedEconomyCommand(connection, rejectedMutationCommand[target]);
    await connection.query(
      `select set_config('worldgraph.command_world_id',$1,true),
              set_config('worldgraph.command_id',$2,true)`,
      [ids.world, ids.command],
    );
    await connection.query(`set local role worldgraph_app`);
    const statements: Record<RejectedEconomyMutationTarget, [string, unknown[]]> = {
      balance: [
        `update wallet_balances
            set available_minor=1,row_version=2,updated_state_revision=2,updated_at=now()
          where wallet_id=$1`,
        [ids.wallet],
      ],
      currency_status: [
        `update currencies set status='frozen',row_version=2,updated_at=now() where id=$1`,
        [ids.currency],
      ],
      head: [
        `update world_economy_heads
            set checksum=worldgraph_economy_projection_checksum(world_id),row_version=2,
                updated_state_revision=2,updated_at=now()
          where world_id=$1`,
        [ids.world],
      ],
      offer: [
        `update asset_transfer_offers
            set status='cancelled',terminal_command_id=$2,terminal_event_id=$3,
                row_version=2,terminal_state_revision=2,updated_at=now()
          where id=$1`,
        [ids.offer, ids.command, ids.terminalEvent],
      ],
      ownership: [
        `update asset_ownership
            set owner_entity_id=$2,ownership_version=2,acquired_event_id=$3,
                updated_state_revision=2,updated_at=now()
          where asset_id=$1`,
        [ids.asset, ids.secondOwner, ids.terminalEvent],
      ],
      supply: [
        `update currency_supply
            set current_supply_minor=1,row_version=2,updated_state_revision=2,updated_at=now()
          where currency_id=$1`,
        [ids.currency],
      ],
      wallet_status: [
        `update wallets set status='frozen',row_version=2,updated_at=now() where id=$1`,
        [ids.wallet],
      ],
    };
    const [statement, parameters] = statements[target];
    await connection.query(statement, parameters);
    await connection.query(`reset role`);
    const mutation = await connection.query<{ mutation_kind: string; target_id: string }>(
      `select mutation_kind,target_id::text
         from economy_command_mutations where command_id=$1`,
      [ids.command],
    );
    expect(mutation.rows).toHaveLength(1);
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `update command_records
          set status='rejected',rejection_code='TEST_REJECTED',
              decided_at=date_trunc('milliseconds',now()),response_summary='{}'
        where id=$1`,
      [ids.command],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(`select worldgraph_assert_economy_command_terminal($1)`, [ids.command]);
  });
}

async function attemptRejectedPartialInitialization(pool: Pool): Promise<void> {
  const ids = projectionIds;
  await transaction(pool, async (connection) => {
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into users(id,email,password_hash,display_name)
       values ($1,'m08-partial-init@example.test',$2,'Partial Init Creator')`,
      [ids.user, passwordHash],
    );
    await connection.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'m08-partial-init','M08 Partial Init',$2)`,
      [ids.world, ids.user],
    );
    await connection.query(
      `insert into world_entities(
         id,world_id,logical_key,entity_type,entity_schema_version,state,created_world_version_id
       ) values ($1,$2,'organization:treasury','organization',1,
         '{"homeDistrictLogicalKey":"district:capital","name":"Treasury",
           "parameters":{},"primitiveRef":"treasury"}',$3)`,
      [ids.owner, ids.world, ids.version],
    );
    await connection.query(
      `insert into domain_events(
         id,world_id,world_event_sequence,command_id,event_ordinal,aggregate_type,
         aggregate_id,aggregate_version,event_type,event_schema_version,payload,metadata,
         event_hash,occurred_at,recorded_at,resulting_state_revision
       ) values ($1,$2,1,$3,0,'world_economy',$2::uuid::text,1,
         'WorldEconomyInitializedV1',1,'{}','{}',decode(repeat('41',32),'hex'),
         date_trunc('milliseconds',now()),date_trunc('milliseconds',now()),1)`,
      [ids.event, ids.world, ids.command],
    );
    await connection.query(
      `insert into command_records(
         id,world_id,command_type,command_schema_version,actor_type,actor_id,
         payload,payload_hash,payload_classification,idempotency_key,request_hash,
         opened_state_revision,opened_ledger_sequence,opened_event_sequence,
         opened_projection_checksum,write_gate_opened_at,correlation_id,requested_at
       ) values ($1,$2,'InitializeWorldEconomyV1',1,'user',$3,null,
         decode(repeat('51',32),'hex'),'member','m08-partial-init-command',
         decode(repeat('52',32),'hex'),1,1,1,decode(repeat('53',32),'hex'),
         transaction_timestamp(),$1,date_trunc('milliseconds',now()))`,
      [ids.command, ids.world, ids.user],
    );
    await connection.query(
      `insert into economy_command_write_snapshots(
         command_id,world_id,economy_state_exists,
         opened_head_row_version,opened_head_checksum
       ) values ($1,$2,false,null,null)`,
      [ids.command, ids.world],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(
      `select set_config('worldgraph.command_world_id',$1,true),
              set_config('worldgraph.command_id',$2,true)`,
      [ids.world, ids.command],
    );
    await connection.query(`set local role worldgraph_app`);
    await connection.query(
      `insert into currencies(
         id,world_id,stable_key,code,name,minor_unit_scale,max_supply_minor,
         issuer_entity_id,created_event_id
       ) values ($1,$2,'currency:partial-credit','PRT','Partial Credit',0,1000,$3,$4)`,
      [ids.currency, ids.world, ids.owner, ids.event],
    );
    await connection.query(`reset role`);
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `update command_records
          set status='rejected',rejection_code='TEST_REJECTED',
              decided_at=date_trunc('milliseconds',now()),response_summary='{}'
        where id=$1`,
      [ids.command],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(`select worldgraph_assert_economy_command_terminal($1)`, [ids.command]);
  });
}

type AcceptedExtraTarget =
  | 'balance_cross_currency'
  | 'currency_status'
  | 'ownership'
  | 'supply_cross_currency'
  | 'wallet_status';

const acceptedScopeCommand: Record<AcceptedExtraTarget, string> = {
  balance_cross_currency: 'TransferCurrencyV1',
  currency_status: 'FreezeCurrencyV1',
  ownership: 'TransferAssetV1',
  supply_cross_currency: 'IssueCurrencyV1',
  wallet_status: 'FreezeWalletV1',
};

async function attemptAcceptedExtraTarget(pool: Pool, target: AcceptedExtraTarget): Promise<void> {
  const ids = projectionIds;
  await transaction(pool, async (connection) => {
    await seedProjectionFixture(connection);
    await seedReceivedEconomyCommand(connection, acceptedScopeCommand[target]);
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into economy_command_mutations(
         command_id,world_id,mutation_kind,target_id,operation
       ) values ($1,$2,'economy_head',$2,'update')`,
      [ids.command, ids.world],
    );
    if (target === 'wallet_status') {
      await connection.query(
        `update domain_events
            set event_type='WalletFrozenV1',aggregate_type='wallet',aggregate_id=$2
          where id=$1`,
        [ids.event, ids.wallet],
      );
    } else if (target === 'currency_status') {
      await connection.query(
        `update domain_events
            set event_type='CurrencyFrozenV1',aggregate_type='currency',aggregate_id=$2
          where id=$1`,
        [ids.event, ids.currency],
      );
    } else if (target === 'ownership') {
      await connection.query(
        `insert into asset_transfers(
           id,world_id,asset_id,from_owner_entity_id,to_owner_entity_id,
           transfer_kind,command_id,event_id,occurred_tick,state_revision
         ) values ($1,$2,$3,$4,$5,'grant',$6,$7,1,2)`,
        [
          ids.assetTransfer,
          ids.world,
          ids.asset,
          ids.owner,
          ids.secondOwner,
          ids.command,
          ids.terminalEvent,
        ],
      );
    } else {
      const issuance = target === 'supply_cross_currency';
      await connection.query(
        `insert into financial_transactions(
           id,world_id,currency_id,transaction_kind,supply_delta_minor,
           command_id,event_id,memo_code,memo_text,occurred_tick,state_revision
         ) values ($1,$2,$3,$4,$5,$6,$7,'scope_test',$8,1,2)`,
        [
          ids.transaction,
          ids.world,
          ids.currency,
          issuance ? 'issuance' : 'transfer',
          issuance ? 1 : 0,
          ids.command,
          ids.terminalEvent,
          issuance ? 'Exact scope reason' : null,
        ],
      );
      if (issuance) {
        await connection.query(
          `insert into wallet_postings(
             id,transaction_id,world_id,currency_id,wallet_id,
             posting_ordinal,signed_amount_minor
           ) values ($1,$2,$3,$4,$5,0,1)`,
          [ids.sourcePosting, ids.transaction, ids.world, ids.currency, ids.wallet],
        );
      } else {
        await connection.query(
          `insert into wallet_postings(
             id,transaction_id,world_id,currency_id,wallet_id,
             posting_ordinal,signed_amount_minor
           ) values ($1,$3,$4,$5,$6,0,-1),($2,$3,$4,$5,$7,1,1)`,
          [
            ids.sourcePosting,
            ids.destinationPosting,
            ids.transaction,
            ids.world,
            ids.currency,
            ids.wallet,
            ids.destinationWallet,
          ],
        );
      }
    }
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(
      `select set_config('worldgraph.command_world_id',$1,true),
              set_config('worldgraph.command_id',$2,true)`,
      [ids.world, ids.command],
    );
    await connection.query(`set local role worldgraph_app`);
    if (target === 'wallet_status') {
      await connection.query(
        `update wallets set status='frozen',row_version=2,updated_at=now() where id=$1`,
        [ids.wallet],
      );
    } else if (target === 'currency_status') {
      await connection.query(
        `update currencies set status='frozen',row_version=2,updated_at=now() where id=$1`,
        [ids.currency],
      );
    } else if (target === 'ownership') {
      await connection.query(
        `update asset_ownership
            set owner_entity_id=$2,ownership_version=2,acquired_event_id=$3,
                updated_state_revision=2,updated_at=now()
          where asset_id=$1`,
        [ids.asset, ids.secondOwner, ids.terminalEvent],
      );
    } else if (target === 'balance_cross_currency') {
      await connection.query(
        `update wallet_balances
            set available_minor=9,row_version=2,updated_state_revision=2,updated_at=now()
          where wallet_id=$1`,
        [ids.wallet],
      );
      await connection.query(
        `update wallet_balances
            set available_minor=1,row_version=2,updated_state_revision=2,updated_at=now()
          where wallet_id=$1`,
        [ids.destinationWallet],
      );
    } else {
      await connection.query(
        `update currency_supply
            set current_supply_minor=1,row_version=2,updated_state_revision=2,updated_at=now()
          where currency_id=$1`,
        [ids.currency],
      );
      await connection.query(
        `update wallet_balances
            set available_minor=1,row_version=2,updated_state_revision=2,updated_at=now()
          where wallet_id=$1`,
        [ids.wallet],
      );
    }
    await connection.query(`reset role`);
    const exactBefore = await connection.query<{ exact: boolean }>(
      `select worldgraph_economy_command_mutation_set_is_exact($1) exact`,
      [ids.command],
    );
    expect(exactBefore.rows[0]?.exact).toBe(true);

    await connection.query(`set local role worldgraph_app`);
    if (target === 'wallet_status') {
      await connection.query(
        `update wallets set status='frozen',row_version=2,updated_at=now() where id=$1`,
        [ids.destinationWallet],
      );
    } else if (target === 'currency_status') {
      await connection.query(
        `update currencies set status='frozen',row_version=2,updated_at=now() where id=$1`,
        [ids.secondCurrency],
      );
    } else if (target === 'ownership') {
      await connection.query(
        `update asset_ownership
            set owner_entity_id=$2,ownership_version=2,acquired_event_id=$3,
                updated_state_revision=2,updated_at=now()
          where asset_id=$1`,
        [ids.secondAsset, ids.secondOwner, ids.extraEvent],
      );
    } else if (target === 'balance_cross_currency') {
      await connection.query(
        `update wallet_balances
            set available_minor=1,row_version=2,updated_state_revision=2,updated_at=now()
          where wallet_id=$1`,
        [ids.secondCurrencyWallet],
      );
    } else {
      await connection.query(
        `update currency_supply
            set current_supply_minor=1,row_version=2,updated_state_revision=2,updated_at=now()
          where currency_id=$1`,
        [ids.secondCurrency],
      );
    }
    await connection.query(`reset role`);
    const exactAfter = await connection.query<{ exact: boolean }>(
      `select worldgraph_economy_command_mutation_set_is_exact($1) exact`,
      [ids.command],
    );
    expect(exactAfter.rows[0]?.exact).toBe(false);
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `update command_records
          set status='accepted',authorization_rule_id='economy.test.scope',
              decided_at=date_trunc('milliseconds',now()),resulting_state_revision=2,
              response_summary='{}'
        where id=$1`,
      [ids.command],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(`select worldgraph_assert_economy_command_terminal($1)`, [ids.command]);
  });
}

async function attemptForgedParticipantHistory(pool: Pool): Promise<void> {
  const ids = projectionIds;
  await transaction(pool, async (connection) => {
    await seedProjectionFixture(connection);
    await seedReceivedEconomyCommand(connection, 'TransferCurrencyV1');
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `insert into world_entities(
         id,world_id,logical_key,entity_type,entity_schema_version,state,created_world_version_id
       ) values ($1,$2,'organization:unrelated','organization',1,
         '{"homeDistrictLogicalKey":"district:capital","name":"Unrelated",
           "parameters":{},"primitiveRef":"unrelated"}',$3)`,
      [ids.forgedParticipant, ids.world, ids.version],
    );
    await connection.query(
      `insert into world_memberships(world_id,user_id,role,status,granted_by_user_id)
       values ($1,$2,'player','active',$2)`,
      [ids.world, ids.user],
    );
    await connection.query(
      `insert into world_entity_controllers(
         world_id,user_id,entity_id,control_scope,granted_world_version_id
       ) values ($1,$2,$3,'primary',$4)`,
      [ids.world, ids.user, ids.forgedParticipant, ids.version],
    );
    await connection.query(
      `update domain_events
          set event_type='CurrencyTransferredV1',aggregate_type='currency',
              aggregate_id=$2::text,payload=jsonb_build_object(
                'amountMinor','1','currencyId',$2::text,
                'destinationWalletId',$3::text,'sourceWalletId',$4::text,
                'transactionId',$5::text
              ),resulting_state_revision=1
        where id=$1`,
      [ids.event, ids.currency, ids.destinationWallet, ids.wallet, ids.transaction],
    );
    await connection.query(
      `insert into ledger_entries(
         id,world_id,ledger_sequence,entry_kind,command_id,event_id,
         actor_type,actor_id,public_summary_code,redacted_details,
         previous_hash,entry_hash,recorded_at
       ) values ($1,$2,1,'domain_event',$3,$4,'user',$5,
         'CURRENCY_TRANSFERRED','{}',decode(repeat('00',32),'hex'),
         decode(repeat('71',32),'hex'),date_trunc('milliseconds',now()))`,
      [ids.ledgerEntry, ids.world, ids.command, ids.event, ids.user],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(
      `select set_config('worldgraph.command_world_id',$1,true),
              set_config('worldgraph.command_id',$2,true)`,
      [ids.world, ids.command],
    );
    await connection.query(`set local role worldgraph_app`);
    await connection.query(
      `insert into economy_participant_history(
         world_id,ledger_sequence,user_id,participant_entity_id,
         counterparty_entity_id,command_id,event_id,category,summary_code,
         summary_args,visibility,state_revision
       ) values ($1,1,$2,$3,$4,$5,$6,'currency','CURRENCY_TRANSFERRED',
         jsonb_build_object('transactionId',$7::text),'participant',1)`,
      [
        ids.world,
        ids.user,
        ids.forgedParticipant,
        ids.owner,
        ids.command,
        ids.event,
        ids.transaction,
      ],
    );
    await connection.query(`reset role`);
    await connection.query(`set local session_replication_role = 'replica'`);
    await connection.query(
      `update command_records
          set status='accepted',authorization_rule_id='economy.test.participant',
              decided_at=date_trunc('milliseconds',now()),resulting_state_revision=1,
              response_summary='{}'
        where id=$1`,
      [ids.command],
    );
    await connection.query(`set local session_replication_role = 'origin'`);
    await connection.query(
      `set constraints economy_participant_history_require_exact_binding immediate`,
    );
  });
}

describe('M08 wallets, transfers, and ownership migration', () => {
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
    owner = createDatabaseClient(container.getConnectionUri(), 'm08-db-owner-test');
    await migrate(owner.db, { migrationsFolder: migrations });
    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    app = createDatabaseClient(appUrl.toString(), 'm08-db-app-test');
  });

  afterAll(async () => {
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
    if (migrations) await rm(migrations, { force: true, recursive: true });
  });

  it('publishes the exact M08 compatibility and history surface', async () => {
    await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
      assetSchema: 1,
      assetTransferOfferSchema: 1,
      compiler: '1.1.0',
      compilerArtifactSchema: 2,
      contracts: 8,
      currencySchema: 1,
      economyReconciliationSchema: 1,
      economySchema: 1,
      economySeedPlanSchema: 1,
      financialTransactionSchema: 1,
      ownershipSchema: 1,
      runtimeSchema: 8,
      walletSchema: 1,
    });
    const visibility = await owner.pool.query<{ enumlabel: string }>(
      `select enumlabel from pg_enum
        where enumtypid='history_visibility'::regtype order by enumsortorder`,
    );
    expect(visibility.rows.map((row) => row.enumlabel)).toEqual([
      'public',
      'member',
      'creator',
      'operator',
      'participant',
    ]);
    const tables = await owner.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema='public' and table_name in (
          'compiled_economy_seed_plans','currencies','currency_supply','wallets',
          'wallet_balances','financial_transactions','wallet_postings','assets',
          'asset_ownership','asset_transfers','asset_transfer_offers',
          'world_economy_heads','economy_reconciliation_runs',
          'economy_reconciliation_items','economy_participant_history',
          'economy_repair_plans','economy_repair_approvals','economy_repair_executions'
        ) order by table_name`,
    );
    expect(tables.rowCount).toBe(18);
  });

  it('accepts only the bounded canonical compiler economy seed plan', async () => {
    const accepted = await owner.pool.query<{ accepted: boolean }>(
      `select worldgraph_economy_seed_plan_is_valid($1::jsonb) accepted`,
      [validSeedPlan],
    );
    expect(accepted.rows[0]?.accepted).toBe(true);
    const requiredPaths: ReadonlyArray<ReadonlyArray<number | string>> = [
      ['economySeedPlanSchemaVersion'],
      ['initialSupplyMinor'],
      ['currency'],
      ['wallets'],
      ['assets'],
      ...Object.keys(validSeedPlan.currency).map((key) => ['currency', key]),
      ...Object.keys(validSeedPlan.wallets[0]!).map((key) => ['wallets', 0, key]),
      ...Object.keys(validSeedPlan.assets[0]!).map((key) => ['assets', 0, key]),
      ...Object.keys(validSeedPlan.assets[0]!.metadata).map((key) => [
        'assets',
        0,
        'metadata',
        key,
      ]),
    ];
    for (const path of requiredPaths) {
      const rejected = await owner.pool.query<{ accepted: boolean }>(
        `select worldgraph_economy_seed_plan_is_valid($1::jsonb) accepted`,
        [withoutPath(validSeedPlan, path)],
      );
      expect(rejected.rows[0]?.accepted, `missing ${path.join('.')}`).toBe(false);
    }
    const wrongDistribution = structuredClone(validSeedPlan);
    wrongDistribution.wallets[1]!.initialBalanceMinor = '1';
    const rejected = await owner.pool.query<{ accepted: boolean }>(
      `select worldgraph_economy_seed_plan_is_valid($1::jsonb) accepted`,
      [wrongDistribution],
    );
    expect(rejected.rows[0]?.accepted).toBe(false);
  });

  it('rejects compiler 1.1 artifacts when any economy provenance key is missing', async () => {
    await expect(
      transaction(owner.pool, async (connection) => {
        const userId = '088f0000-0000-7000-8000-000000000201';
        const worldId = '088f0000-0000-7000-8000-000000000202';
        const runId = '088f0000-0000-7000-8000-000000000203';
        await connection.query(`set local session_replication_role = 'replica'`);
        await connection.query(
          `insert into users(id,email,password_hash,display_name)
           values ($1,'m08-artifact@example.test',$2,'Artifact Creator')`,
          [userId, passwordHash],
        );
        await connection.query(
          `insert into worlds(id,slug,name,created_by_user_id)
           values ($1,'m08-artifact-world','M08 Artifact World',$2)`,
          [worldId, userId],
        );
        await connection.query(
          `insert into world_compilation_runs(
             id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
             compiler_version,compiler_config_version,seed,status,stage,progress_percent,
             requested_by_user_id,idempotency_key,attempts,claim_token,claimed_at,
             heartbeat_at,started_at
           ) values ($1,$2,$3,decode(repeat('21',32),'hex'),decode(repeat('22',32),'hex'),
             '1.1.0',1,'m08-seed','running','compiling',1,$4,
             'm08-artifact-run',1,$5,now(),now(),now())`,
          [
            runId,
            worldId,
            '088f0000-0000-7000-8000-000000000204',
            userId,
            '088f0000-0000-7000-8000-000000000205',
          ],
        );
        await connection.query(`set local session_replication_role = 'origin'`);
        await connection.query(
          `insert into compiled_world_artifacts(
             id,world_id,compilation_run_id,artifact_kind,artifact_schema_version,
             canonical_content,content_hash
           ) values ($1,$2,$3,'compiled_world',2,$4,decode(repeat('23',32),'hex'))`,
          [
            '088f0000-0000-7000-8000-000000000206',
            worldId,
            runId,
            {
              artifactSchemaVersion: 2,
              compilerConfigVersion: 1,
              compilerVersion: '1.1.0',
              economySeedPlan: validSeedPlan,
              // economySeedPlanHash is intentionally absent.
            },
          ],
        );
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'compiled_world_artifacts_compiler_schema_pair',
    });
  });

  it('keeps ordinary command admission constant-time and bounds expiry reads', async () => {
    const definition = await owner.pool.query<{ definition: string }>(
      `select pg_get_functiondef('worldgraph_open_command_write(uuid,uuid)'::regprocedure)
         definition`,
    );
    expect(definition.rows[0]?.definition).toContain(
      'worldgraph_assert_economy_projection_current',
    );
    expect(definition.rows[0]?.definition).not.toContain(
      'worldgraph_economy_reconciliation_snapshot',
    );
    await expect(
      app.pool.query(`select * from worldgraph_due_asset_transfer_offers(null,0)`),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      app.pool.query(`select * from worldgraph_due_asset_transfer_offers(null,251)`),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      app.pool.query(`select * from worldgraph_due_asset_transfer_offers(null,250)`),
    ).resolves.toMatchObject({ rows: [] });
  });

  it('rejects direct app-role projection inserts outside an open command', async () => {
    const worldId = '088f0000-0000-7000-8000-000000000501';
    const currencyId = '088f0000-0000-7000-8000-000000000502';
    const walletId = '088f0000-0000-7000-8000-000000000503';
    const eventId = '088f0000-0000-7000-8000-000000000504';
    const entityId = '088f0000-0000-7000-8000-000000000505';
    const assetId = '088f0000-0000-7000-8000-000000000506';
    const attempts: ReadonlyArray<[string, string, unknown[]]> = [
      [
        'currency',
        `insert into currencies(
           id,world_id,stable_key,code,name,minor_unit_scale,max_supply_minor,
           issuer_entity_id,created_event_id
         ) values ($1,$2,'currency:direct-credit','DIR','Direct Credit',0,1000,$3,$4)`,
        [currencyId, worldId, entityId, eventId],
      ],
      [
        'supply',
        `insert into currency_supply(currency_id,world_id,current_supply_minor,updated_state_revision)
         values ($1,$2,0,1)`,
        [currencyId, worldId],
      ],
      [
        'balance',
        `insert into wallet_balances(
           wallet_id,world_id,currency_id,available_minor,updated_state_revision
         ) values ($1,$2,$3,0,1)`,
        [walletId, worldId, currencyId],
      ],
      [
        'asset',
        `insert into assets(
           id,world_id,stable_key,asset_type,metadata,transferable,created_event_id
         ) values ($1,$2,'asset:direct-seal','founding_seal',
           '{"displayName":"Direct Seal","provenance":"compiler-economy-adapter-v1"}',
           true,$3)`,
        [assetId, worldId, eventId],
      ],
      [
        'ownership',
        `insert into asset_ownership(
           asset_id,world_id,owner_entity_id,ownership_version,acquired_event_id,
           updated_state_revision
         ) values ($1,$2,$3,1,$4,1)`,
        [assetId, worldId, entityId, eventId],
      ],
    ];
    for (const [name, statement, parameters] of attempts) {
      await expect(app.pool.query(statement, parameters), name).rejects.toMatchObject({
        code: '55000',
      });
    }
  });

  it.each([
    ['currency', '55000'],
    ['supply', '55000'],
    ['balance', '55000'],
    ['ownership', '55000'],
    ['asset', '42501'],
  ] as const)(
    'rejects a direct app-role %s update outside an open command',
    async (target, code) => {
      await expect(attemptProjectionUpdateOutsideGate(owner.pool, target)).rejects.toMatchObject({
        code,
      });
    },
  );

  it.each([
    'balance',
    'currency_status',
    'head',
    'offer',
    'ownership',
    'supply',
    'wallet_status',
  ] as const)(
    'rejects a rejected command that used its open gate to mutate %s authority',
    async (target) => {
      await expect(attemptRejectedEconomyMutation(owner.pool, target)).rejects.toMatchObject({
        code: '55000',
        message: 'rejected or failed economy command recorded authoritative mutations',
      });
    },
  );

  it('rejects partial initialization state when its command becomes rejected', async () => {
    await expect(attemptRejectedPartialInitialization(owner.pool)).rejects.toMatchObject({
      code: '55000',
      message: 'rejected or failed economy command recorded authoritative mutations',
    });
  });

  it.each([
    'balance_cross_currency',
    'currency_status',
    'ownership',
    'supply_cross_currency',
    'wallet_status',
  ] as const)('rejects accepted command scope widened to an extra %s target', async (target) => {
    await expect(attemptAcceptedExtraTarget(owner.pool, target)).rejects.toMatchObject({
      code: '55000',
      message: 'accepted economy command mutated rows outside its exact fact-derived scope',
    });
  });

  it('rejects participant history for a controller unrelated to the bound event parties', async () => {
    await expect(attemptForgedParticipantHistory(owner.pool)).rejects.toMatchObject({
      code: '55000',
      message: 'participant history is not the exact redacted event participant view',
    });
  });

  it('allows the exact wallet freeze shape without referencing offer-only columns', async () => {
    const connection = await owner.pool.connect();
    try {
      await connection.query('begin');
      await seedProjectionFixture(connection);
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           opened_state_revision,opened_ledger_sequence,opened_event_sequence,
           write_gate_opened_at,correlation_id,requested_at
         ) values ($1,$2,'FreezeWalletV1',1,'user',$3,null,
           decode(repeat('51',32),'hex'),'member','m08-wallet-freeze',
           decode(repeat('52',32),'hex'),1,1,1,transaction_timestamp(),$1,
           date_trunc('milliseconds',now()))`,
        [projectionIds.command, projectionIds.world, projectionIds.user],
      );
      await connection.query(`set local session_replication_role = 'origin'`);
      await connection.query(
        `select set_config('worldgraph.command_world_id',$1,true),
                set_config('worldgraph.command_id',$2,true)`,
        [projectionIds.world, projectionIds.command],
      );
      const updated = await connection.query<{ row_version: string; status: string }>(
        `update wallets set status='frozen',row_version=2,updated_at=now()
          where id=$1 returning status::text,row_version::text`,
        [projectionIds.wallet],
      );
      expect(updated.rows[0]).toEqual({ row_version: '2', status: 'frozen' });
    } finally {
      await connection.query('rollback').catch(() => undefined);
      connection.release();
    }
  });

  it.each(['missing', 'mismatched', 'non_treasury'] as const)(
    'rejects an issuance for invalid authority or treasury mode %s at deferred commit',
    async (mode) => {
      await expect(commitIssuanceWithInvalidOverride(owner.pool, mode)).rejects.toMatchObject({
        code: '23514',
        constraint: 'financial_transaction_balanced',
      });
    },
  );

  it('rejects non-canonical reconciliation detail rows at deferred commit', async () => {
    await expect(commitReconciliationWithWrongItem(owner.pool)).rejects.toMatchObject({
      code: '23514',
      constraint: 'economy_reconciliation_evidence_exact',
    });
  });

  it('keeps immutable journals private to inserts and exposes existing override audit writes', async () => {
    const privileges = await owner.pool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_select: boolean;
      table_name: string;
    }>(
      `select table_name,
              has_table_privilege('worldgraph_app',table_name,'SELECT') can_select,
              has_table_privilege('worldgraph_app',table_name,'INSERT') can_insert,
              has_table_privilege('worldgraph_app',table_name,'DELETE') can_delete
         from unnest(array[
           'financial_transactions','wallet_postings','asset_transfers',
           'economy_reconciliation_runs','economy_reconciliation_items',
           'creator_override_records','security_audit_records'
         ]) table_name order by table_name`,
    );
    for (const row of privileges.rows) {
      expect(row.can_delete).toBe(false);
      expect(row.can_insert).toBe(true);
      expect(row.can_select).toBe(true);
    }
  });
});
