import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { canonicalJson } from '@worldgraph/contracts';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from './index.js';

const migrationRoot = resolve('packages/db/drizzle');
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const userId = id(1);
const worldId = id(2);
const sourceWorldVersionId = id(3);
const contestId = id(4);
const snapshotId = id(5);
const voterIds = [id(10), id(11), id(12), id(13)] as const;
const attemptCount = 103;

describe('M10 governance ballot concurrency boundary', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let database: DatabaseClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    database = createDatabaseClient(container.getConnectionUri(), 'governance-ballot-race');
    await migrate(database.db, { migrationsFolder: migrationRoot });
    await seedFixture(database);
  }, 120_000);

  afterAll(async () => {
    await database?.pool.end();
    await container?.stop();
  });

  it('allows one of 100 competing first ballots and does not block separate voters', async () => {
    const race = await Promise.all(
      Array.from({ length: 100 }, (_, index) => cast(database, index, voterIds[0])),
    );
    const accepted = race.filter((result) => result.ok);
    const rejected = race.filter((result) => !result.ok);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(99);
    for (const result of rejected) {
      expect(result).toMatchObject({
        code: '23505',
        constraint: 'ballot_participation_voter_unique',
        ok: false,
      });
    }

    const independent = await Promise.all(
      voterIds.slice(1).map((voterId, offset) => cast(database, 100 + offset, voterId)),
    );
    expect(independent).toEqual([{ ok: true }, { ok: true }, { ok: true }]);

    const counts = await database.pool.query<{
      effective_count: number;
      participation_count: number;
      public_count: number;
      secret_count: number;
    }>(
      `select
         (select count(*)::integer from ballot_participation
           where world_id=$1 and contest_id=$2) as participation_count,
         (select count(*)::integer from ballot_effective_revisions
           where world_id=$1 and contest_id=$2) as effective_count,
         (select count(*)::integer from secret_ballot_choices
           where world_id=$1 and contest_id=$2) as secret_count,
         (select count(*)::integer from public_ballot_choices
           where world_id=$1 and contest_id=$2) as public_count`,
      [worldId, contestId],
    );
    expect(counts.rows).toEqual([
      {
        effective_count: 4,
        participation_count: 4,
        public_count: 0,
        secret_count: 4,
      },
    ]);

    const receipt = await database.pool.query<{ choice_hash: Buffer }>(
      `select choice_hash from ballot_receipts
        where world_id=$1 and contest_id=$2 limit 1`,
      [worldId, contestId],
    );
    const dictionaryHash = createHash('sha256')
      .update(canonicalJson({ choice: 'yes' }), 'utf8')
      .digest('hex');
    expect(receipt.rows[0]?.choice_hash.toString('hex')).not.toBe(dictionaryHash);

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    const app = createDatabaseClient(appUrl.toString(), 'governance-ballot-app-privacy');
    try {
      await expect(
        app.pool.query('select * from ballot_choice_revisions limit 1'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.pool.query('select choice_payload from secret_ballot_choices limit 1'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.pool.end();
    }
  }, 120_000);
});

async function seedFixture(database: DatabaseClient): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = 'replica'`);
    await client.query(
      `insert into users(id,email,password_hash,display_name)
       values ($1,'governance-race@example.test',$2,'Governance Race')`,
      [userId, passwordHash],
    );
    await client.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'governance-race','Governance Race',$2)`,
      [worldId, userId],
    );
    await client.query(
      `insert into world_simulation_clocks(
         world_id,epoch_at,current_tick,world_milliseconds_per_tick,
         wall_cadence_milliseconds,mode,max_batch_ticks,max_catch_up_ticks,
         prng_algorithm_version,outcome_hash,row_version,updated_state_revision
       ) values ($1,now(),5,1000,1000,'paused',16,32,'xorshift32-sha256-v1',
         decode(repeat('01',32),'hex'),1,1)`,
      [worldId],
    );

    for (const [index, voterId] of voterIds.entries()) {
      await client.query(
        `insert into world_entities(
           id,world_id,logical_key,entity_type,entity_schema_version,state,
           created_world_version_id,row_version
         ) values ($1,$2,$3,'player_character',1,$4,$5,1)`,
        [
          voterId,
          worldId,
          `player:governance-race-${index + 1}`,
          {
            blueprintLogicalKey: 'blueprint:citizen',
            homeDistrictLogicalKey: 'district:civic-platform',
            membershipRole: 'player',
            name: `Race Voter ${index + 1}`,
            organizationLogicalKey: null,
          },
          sourceWorldVersionId,
        ],
      );
    }

    for (let index = 0; index < attemptCount; index += 1) {
      const commandId = commandIdFor(index);
      const eventId = eventIdFor(index);
      await client.query(
        `insert into command_records(
           id,world_id,command_type,command_schema_version,actor_type,actor_id,
           payload,payload_hash,payload_classification,idempotency_key,request_hash,
           expected_world_version,expected_state_revision,expected_aggregate_version,
           expected_tick,status,correlation_id
         ) values (
           $1,$2,'CastProposalBallotV1',1,'user',$3,$4,
           decode(repeat('02',32),'hex'),'member',$5,
           decode(repeat('03',32),'hex'),1,1,1,5,'received',$6
         )`,
        [
          commandId,
          worldId,
          userId,
          {
            eligibilitySnapshotId: snapshotId,
            expectedProposalVersion: '1',
            proposalId: id(6),
            replaceExisting: false,
          },
          `governance-race-${String(index).padStart(4, '0')}`,
          correlationIdFor(index),
        ],
      );
      await client.query(
        `insert into domain_events(
           id,world_id,world_event_sequence,command_id,event_ordinal,
           aggregate_type,aggregate_id,aggregate_version,event_type,
           event_schema_version,payload,metadata,event_hash,occurred_at,
           recorded_at,resulting_state_revision
         ) values (
           $1,$2,$3,$4,0,'ballot_participation',$5,1,
           'ProposalBallotRecordedSecretV1',1,$6,'{}'::jsonb,
           decode(repeat('04',32),'hex'),now(),now(),2
         )`,
        [
          eventId,
          worldId,
          index + 1,
          commandId,
          participationIdFor(index),
          {
            eventType: 'ProposalBallotRecordedSecretV1',
            receiptHash: hash(`fixture-receipt:${index}`).toString('hex'),
          },
        ],
      );
    }

    await client.query(
      `insert into governance_contests(
         id,world_id,contest_kind,ballot_mode,ballot_disclosure,status,
         opens_tick,closes_tick,allow_replacement,aggregate_version,
         created_command_id,created_event_id,created_state_revision
       ) values ($1,$2,'proposal','secret','aggregate_only','open',0,10,false,1,$3,$4,1)`,
      [contestId, worldId, commandIdFor(0), eventIdFor(0)],
    );
    await client.query(
      `insert into eligibility_snapshots(
         id,world_id,contest_id,snapshot_tick,source_state_revision,
         source_membership_cursor,eligible_count,rule_snapshot,checksum,
         generated_command_id,generated_event_id
       ) values ($1,$2,$3,0,1,1,$4,'{}'::jsonb,
         decode(repeat('05',32),'hex'),$5,$6)`,
      [snapshotId, worldId, contestId, voterIds.length, commandIdFor(0), eventIdFor(0)],
    );
    for (const [index, voterId] of voterIds.entries()) {
      await client.query(
        `insert into eligibility_snapshot_members(
           id,world_id,snapshot_id,contest_id,voter_entity_id,voting_weight,
           eligibility_basis,member_hash
         ) values ($1,$2,$3,$4,$5,1,$6,decode(repeat('06',32),'hex'))`,
        [
          memberIdFor(index),
          worldId,
          snapshotId,
          contestId,
          voterId,
          { membershipRole: 'player', membershipVersion: 1 },
        ],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function cast(
  database: DatabaseClient,
  index: number,
  voterId: string,
): Promise<{ code?: string; constraint?: string; ok: boolean }> {
  const client = await database.pool.connect();
  try {
    await openTestCommand(client, commandIdFor(index));
    await client.query(`set local role worldgraph_app`);
    await client.query(
      `select * from worldgraph_cast_governance_ballot_v1(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,false,5,$11,$12,2
       )`,
      [
        worldId,
        contestId,
        snapshotId,
        voterId,
        participationIdFor(index),
        choiceRevisionIdFor(index),
        receiptIdFor(index),
        hash(`receipt:${index}`),
        hash(`linkage:${index}`),
        { choice: 'yes' },
        commandIdFor(index),
        eventIdFor(index),
      ],
    );
    await client.query('reset role');
    await client.query('commit');
    return { ok: true };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    const postgres = error as { code?: string; constraint?: string };
    return {
      ...(postgres.code ? { code: postgres.code } : {}),
      ...(postgres.constraint ? { constraint: postgres.constraint } : {}),
      ok: false,
    };
  } finally {
    client.release();
  }
}

async function openTestCommand(client: PoolClient, commandId: string): Promise<void> {
  await client.query('begin');
  await client.query(`set local session_replication_role = 'replica'`);
  await client.query(
    `update command_records set
       opened_state_revision=1,opened_ledger_sequence=1,opened_event_sequence=1,
       write_gate_opened_at=transaction_timestamp()
      where id=$1 and world_id=$2`,
    [commandId, worldId],
  );
  await client.query(`set local session_replication_role = 'origin'`);
  await client.query(
    `select set_config('worldgraph.command_world_id',$1,true),
            set_config('worldgraph.command_id',$2,true)`,
    [worldId, commandId],
  );
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function id(value: number): string {
  return `018f0000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
}

function commandIdFor(index: number): string {
  return id(10_000 + index);
}

function eventIdFor(index: number): string {
  return id(20_000 + index);
}

function correlationIdFor(index: number): string {
  return id(30_000 + index);
}

function participationIdFor(index: number): string {
  return id(40_000 + index);
}

function choiceRevisionIdFor(index: number): string {
  return id(50_000 + index);
}

function receiptIdFor(index: number): string {
  return id(60_000 + index);
}

function memberIdFor(index: number): string {
  return id(70_000 + index);
}
