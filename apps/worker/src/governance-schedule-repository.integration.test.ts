import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { applyMigrations, createDatabaseClient } from '@worldgraph/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresGovernanceScheduleRepository } from './governance-schedule-repository.js';
import { PostgresGovernanceRestrictedTallyRepository } from './governance-tally-repository.js';

const migrationRoot = resolve('packages/db/drizzle');

function applicationUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = 'worldgraph_app';
  url.password = 'worldgraph_app_local_only';
  return url.toString();
}

function tallyUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = 'worldgraph_governance_tally';
  url.password = 'worldgraph_governance_tally_local_only';
  return url.toString();
}

describe('PostgreSQL governance schedule discovery', () => {
  let app: ReturnType<typeof createDatabaseClient>;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let owner: ReturnType<typeof createDatabaseClient>;
  let tally: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'governance-schedule-owner-test');
    await applyMigrations(owner, migrationRoot);
    app = createDatabaseClient(
      applicationUrl(container.getConnectionUri()),
      'governance-schedule-app-test',
    );
    tally = createDatabaseClient(
      tallyUrl(container.getConnectionUri()),
      'governance-schedule-tally-test',
    );
  }, 120_000);

  afterAll(async () => {
    await app?.pool.end();
    await tally?.pool.end();
    await owner?.pool.end();
    await container?.stop();
  });

  it('parses and executes policy-bound aggregate-only discovery as the application role', async () => {
    const repository = new PostgresGovernanceScheduleRepository(app.pool, {
      loadElectionResultChecksum: async () => null,
      loadProposalResultChecksum: async () => null,
    });

    await expect(repository.findPendingEffects(25)).resolves.toEqual([]);
  });

  it('reconciles valid work past terminal residual schedules without page starvation', async () => {
    const ids = {
      command: '018f8652-3cb6-7d52-904b-cce7901d7100',
      staleContest: '018f8652-3cb6-7d52-904b-cce7901d7101',
      staleProposal: '018f8652-3cb6-7d52-904b-cce7901d7102',
      staleCloseAction: '018f8652-3cb6-7d52-904b-cce7901d7103',
      staleCertifyAction: '018f8652-3cb6-7d52-904b-cce7901d7104',
      validContestOne: '018f8652-3cb6-7d52-904b-cce7901d7105',
      validProposalOne: '018f8652-3cb6-7d52-904b-cce7901d7106',
      validActionOne: '018f8652-3cb6-7d52-904b-cce7901d7107',
      validContestTwo: '018f8652-3cb6-7d52-904b-cce7901d7108',
      validProposalTwo: '018f8652-3cb6-7d52-904b-cce7901d7109',
      validActionTwo: '018f8652-3cb6-7d52-904b-cce7901d7110',
      version: '018f8652-3cb6-7d52-904b-cce7901d7111',
      world: '018f8652-3cb6-7d52-904b-cce7901d7112',
    } as const;
    const fixture = await owner.pool.connect();
    try {
      await fixture.query('begin');
      await fixture.query(`set local session_replication_role = 'replica'`);
      await fixture.query(
        `insert into worlds(
           id,slug,name,lifecycle,created_by_user_id,active_world_version_id
         ) values ($1,'governance-reconciliation','Governance Reconciliation','active',$2,$3)`,
        [ids.world, '018f8652-3cb6-7d52-904b-cce7901d7113', ids.version],
      );
      await fixture.query(
        `insert into world_versions(
           id,world_id,version_number,manifest_revision_id,compilation_run_id,
           world_schema_version,compiler_version,compiler_config_version,seed,
           artifact_hash,status,created_by_user_id,activated_at
         ) values ($1,$2,1,$3,$4,1,'1.3.0',1,'governance-reconciliation',
           decode(repeat('71',32),'hex'),'active',$5,now())`,
        [
          ids.version,
          ids.world,
          '018f8652-3cb6-7d52-904b-cce7901d7114',
          '018f8652-3cb6-7d52-904b-cce7901d7115',
          '018f8652-3cb6-7d52-904b-cce7901d7113',
        ],
      );
      await fixture.query(
        `insert into world_runtime_heads(
           world_id,active_world_version_id,state_revision,last_ledger_sequence
         ) values ($1,$2,5,0)`,
        [ids.world, ids.version],
      );
      await fixture.query(
        `insert into world_simulation_clocks(
           world_id,epoch_at,current_tick,world_milliseconds_per_tick,
           wall_cadence_milliseconds,mode,max_batch_ticks,max_catch_up_ticks,
           prng_algorithm_version,outcome_hash,row_version,updated_state_revision
         ) values ($1,now(),50,1000,1000,'paused',16,32,'xorshift32-sha256-v1',
           decode(repeat('72',32),'hex'),1,5)`,
        [ids.world],
      );

      const proposals = [
        [ids.staleProposal, ids.staleContest, 'rejected', '10'],
        [ids.validProposalOne, ids.validContestOne, 'tallied', '12'],
        [ids.validProposalTwo, ids.validContestTwo, 'tallied', '13'],
      ] as const;
      for (const [proposalId, contestId, status, closesTick] of proposals) {
        await fixture.query(
          `insert into proposals(
             id,world_id,institution_id,jurisdiction_entity_id,proposer_entity_id,
             proposal_type,title,body,status,sponsorship_closes_tick,
             debate_closes_tick,voting_opens_tick,voting_closes_tick,
             minimum_sponsors,quorum_numerator,quorum_denominator,
             threshold_numerator,threshold_denominator,ballot_mode,
             ballot_disclosure,allow_ballot_replacement,target_versions,
             aggregate_version,created_command_id,created_event_id,
             created_state_revision
           ) values ($1,$2,$3,$4,$5,'ordinary','Reconciliation proposal',
             'Proves terminal residual schedules cannot starve later work.',$6,
             1,2,3,$7::bigint,0,0,10000,5001,10000,'secret','aggregate_only',
             false,'{}'::jsonb,2,$8,$9,1)`,
          [
            proposalId,
            ids.world,
            '018f8652-3cb6-7d52-904b-cce7901d7116',
            '018f8652-3cb6-7d52-904b-cce7901d7117',
            '018f8652-3cb6-7d52-904b-cce7901d7118',
            status,
            closesTick,
            ids.command,
            contestId,
          ],
        );
        await fixture.query(
          `insert into governance_contests(
             id,world_id,contest_kind,ballot_mode,ballot_disclosure,status,
             opens_tick,closes_tick,allow_replacement,aggregate_version,
             created_command_id,created_event_id,created_state_revision
           ) values ($1,$2,'proposal','secret','aggregate_only',$3,3,$4::bigint,
             false,2,$5,$6,1)`,
          [
            contestId,
            ids.world,
            status === 'rejected' ? 'cancelled' : 'tallied',
            closesTick,
            ids.command,
            proposalId,
          ],
        );
        await fixture.query(
          `insert into proposal_contests(contest_id,world_id,proposal_id,question)
           values ($1,$2,$3,'Should reconciliation continue past terminal schedules?')`,
          [contestId, ids.world, proposalId],
        );
      }

      const schedules = [
        [ids.staleCloseAction, 1, '10', 'CloseAndTallyProposalV1', ids.staleProposal],
        [ids.staleCertifyAction, 2, '10', 'CertifyAndEnactProposalV1', ids.staleProposal],
        [ids.validActionOne, 3, '12', 'CertifyAndEnactProposalV1', ids.validProposalOne],
        [ids.validActionTwo, 4, '13', 'CertifyAndEnactProposalV1', ids.validProposalTwo],
      ] as const;
      for (const [actionId, sequence, dueTick, actionType, proposalId] of schedules) {
        await fixture.query(
          `insert into scheduled_actions(
             id,world_id,schedule_sequence,due_tick,priority,action_type,
             action_schema_version,payload,payload_hash,process_version,status,
             created_by_actor_type,created_by_actor_id,created_command_id,
             completed_event_id,created_state_revision,completed_state_revision
           ) values ($1,$2,$3,$4::bigint,0,$5,1,
             jsonb_build_object('proposalId',$6::text),
             extensions.digest(convert_to(public.worldgraph_canonical_jsonb(
               jsonb_build_object('proposalId',$6::text)
             ),'UTF8'),'sha256'),'1.0.0','completed','system',
             'worldgraph:governance-scheduler',$7,$8,1,5)`,
          [
            actionId,
            ids.world,
            sequence,
            dueTick,
            actionType,
            proposalId,
            ids.command,
            `018f8652-3cb6-7d52-904b-${(0x7900 + sequence).toString(16).padStart(12, '0')}`,
          ],
        );
      }
      await fixture.query('commit');
    } catch (error) {
      await fixture.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      fixture.release();
    }

    const repository = new PostgresGovernanceScheduleRepository(
      app.pool,
      {
        loadElectionResultChecksum: async () => null,
        loadProposalResultChecksum: async () => 'a'.repeat(64),
      },
      ids.world,
    );
    const markReconciled = async (
      actionId: string,
      proposalId: string,
      dueTick: string,
      ordinal: number,
    ): Promise<void> => {
      const connection = await owner.pool.connect();
      try {
        await connection.query('begin');
        await connection.query(`set local session_replication_role = 'replica'`);
        await connection.query(
          `insert into governance_schedule_occurrences(
             id,world_id,scheduled_action_id,occurrence_key,target_kind,target_id,
             transition_kind,due_tick,command_id,event_id,state_revision
           ) values ($1,$2,$3,$4,'proposal',$5,'certify',$6::bigint,$7,$8,6)`,
          [
            `018f8652-3cb6-7d52-904b-${(0x7a00 + ordinal).toString(16).padStart(12, '0')}`,
            ids.world,
            actionId,
            `governance:proposal:${proposalId}:certify:${dueTick}`,
            proposalId,
            dueTick,
            ids.command,
            `018f8652-3cb6-7d52-904b-${(0x7b00 + ordinal).toString(16).padStart(12, '0')}`,
          ],
        );
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    };

    const first = await repository.findPendingEffects(1);
    expect(first).toEqual([
      expect.objectContaining({
        actionType: 'CertifyAndEnactProposalV1',
        scheduledActionId: ids.validActionOne,
        targetId: ids.validProposalOne,
      }),
    ]);
    await markReconciled(ids.validActionOne, ids.validProposalOne, '12', 1);

    const second = await repository.findPendingEffects(1);
    expect(second).toEqual([
      expect.objectContaining({
        actionType: 'CertifyAndEnactProposalV1',
        scheduledActionId: ids.validActionTwo,
        targetId: ids.validProposalTwo,
      }),
    ]);
    await markReconciled(ids.validActionTwo, ids.validProposalTwo, '13', 2);
    await expect(repository.findPendingEffects(1)).resolves.toEqual([]);
  });

  it('executes only anonymous-choice tally reads through the restricted role', async () => {
    const repository = new PostgresGovernanceRestrictedTallyRepository(tally.pool);
    const worldId = '10000000-0000-4000-8000-000000000001';
    const contestId = '10000000-0000-4000-8000-000000000002';
    const eligibilitySnapshotId = '10000000-0000-4000-8000-000000000003';

    await expect(repository.assertRestrictedRole()).resolves.toBeUndefined();
    await expect(
      repository.loadProposalBallots({ contestId, eligibilitySnapshotId, worldId }),
    ).resolves.toEqual([]);
    await expect(
      repository.loadElectionBallots({
        candidateKeys: ['candidate:harbor-council:one'],
        contestId,
        eligibilitySnapshotId,
        worldId,
      }),
    ).resolves.toEqual([]);
    await expect(repository.loadProposalResultChecksum(worldId, contestId)).resolves.toBeNull();
    await expect(repository.loadElectionResultChecksum(worldId, contestId)).resolves.toBeNull();
    await expect(
      tally.pool.query('select count(*) from ballot_participation'),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
