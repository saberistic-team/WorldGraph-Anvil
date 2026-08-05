import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GOVERNANCE_PRIMITIVES,
  HARBOR_CITY_ECONOMY_PRIMITIVES,
  STARTER_PRIMITIVES,
} from '@worldgraph/catalog';
import { createCompilerInputBundle, memberPrincipalKey } from '@worldgraph/compiler';
import {
  COMPILER_VERSION,
  canonicalJson,
  type GovernanceCommandRequestV1,
  type GovernanceProposalActionV1,
} from '@worldgraph/contracts';
import { applyMigrations, createDatabaseClient, importStarterPrimitives } from '@worldgraph/db';
import {
  PostgresGovernanceCommandExecutor,
  type GovernanceCommandExecutionInput,
  type GovernanceCommandExecutionResult,
  type InternalGovernanceCommandExecutionInput,
} from '@worldgraph/governance-command';
import {
  createDeterministicGovernedHarborCityFallback,
  governedHarborCityManifestCatalog,
} from '@worldgraph/manifests';
import { createLogger } from '@worldgraph/observability';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresGovernanceScheduleRepository,
  type GovernanceScheduledEffectCandidate,
} from './governance-schedule-repository.js';
import { governanceScheduledCommandInput } from './governance-schedule-worker.js';
import { PostgresGovernanceRestrictedTallyRepository } from './governance-tally-repository.js';
import { PostgresWorldCompilationRepository } from './world-compilation-repository.js';
import {
  WorldCompilationRunner,
  type WorldCompilationMetrics,
} from './world-compilation-worker.js';

const migrationRoot = resolve('packages/db/drizzle');
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const creatorId = id(1);
const playerId = id(2);
const thirdPlayerId = id(3);
const worldId = id(101);
const revisionId = id(201);
const compilationRunId = id(301);
const validationReportId = id(401);
const initializeCommandId = id(501);
const initializeCorrelationId = id(502);
const seed = 'governance-concurrency-integration-seed';
const fallback = createDeterministicGovernedHarborCityFallback({
  catalog: governedHarborCityManifestCatalog(),
  prompt:
    'A governed harbor city used to prove ballot, tally, appointment, and enactment concurrency.',
  seed,
});
const pinnedPrimitiveVersionIds = new Set(
  fallback.envelope.manifest.primitiveRefs.map((entry) => entry.primitiveVersionId),
);
const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'governance-concurrency-integration',
});
const noOpMetrics: WorldCompilationMetrics = {
  recordArtifact: () => undefined,
  recordActivation: () => undefined,
  recordBacklog: () => undefined,
  recordIntegrityFinding: () => undefined,
  recordQueueLatency: () => undefined,
  recordRun: () => undefined,
  recordStage: () => undefined,
};

interface RuntimeState {
  active_world_version_id: string;
  current_tick: string;
  design_version: string;
  state_revision: string;
}

interface WorldActor {
  entityId: string;
  entityKey: string;
  role: 'creator' | 'player';
  userId: string;
}

interface ProposalRecord {
  aggregate_version: string;
  contest_id: string;
  id: string;
  status: string;
  voting_closes_tick: string;
  voting_opens_tick: string;
}

type LawProposalAction = Extract<
  GovernanceProposalActionV1,
  { actionType: 'amend_law' | 'create_law' }
>;

interface ApiActor {
  csrfHash: Buffer;
  session: {
    absoluteExpiresAt: string;
    id: string;
    idleExpiresAt: string;
  };
  user: {
    displayName: string;
    email: string;
    id: string;
    platformRole: 'user';
    rowVersion: number;
    status: 'active';
  };
}

interface ApiCommandSubmission {
  httpStatus: number;
  result: { rejectionCode?: string; status: string };
}

interface ApiCommandBusModule {
  WorldCommandBus: new (
    repository: object,
    ids: { next(): string },
  ) => {
    submit(
      actor: ApiActor,
      worldId: string,
      request: Record<string, unknown>,
      requestId: string,
      submittedAt: Date,
    ): Promise<ApiCommandSubmission>;
  };
}

interface ApiCommandRepositoryModule {
  PostgresCommandRepository: new (pool: Pool, ids: { next(): string }) => object;
}

type ScheduledActionType = GovernanceScheduledEffectCandidate['actionType'];

describe('M10 governance concurrency matrix under worldgraph_app', () => {
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
    owner = createDatabaseClient(container.getConnectionUri(), 'governance-concurrency-owner');
    await applyMigrations(owner, migrationRoot);
    await importStarterPrimitives(owner.pool);
    await seedApprovedCompilation(owner.pool);

    app = createDatabaseClient(applicationUrl(container.getConnectionUri()), 'governance-race-app');
    sharedAppPool = app.pool;
    tally = createDatabaseClient(tallyUrl(container.getConnectionUri()), 'governance-race-tally');
    const compilation = new WorldCompilationRunner(
      new PostgresWorldCompilationRepository(app.pool),
      logger,
      { maxEntities: 2_000, maxRelationships: 8_000 },
      { maximumRunsPerReconciliation: 1, metrics: noOpMetrics },
    );
    await expect(compilation.runOne()).resolves.toMatchObject({ outcome: 'succeeded' });
  }, 120_000);

  afterAll(async () => {
    await tally?.pool.end();
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
  });

  it('serializes boundary casts, duplicate workers, appointments, and stale enactment targets', async () => {
    await expect(
      app.pool.query<{ current_user: string }>('select current_user'),
    ).resolves.toMatchObject({ rows: [{ current_user: 'worldgraph_app' }] });
    await expect(
      tally.pool.query<{ current_user: string }>('select current_user'),
    ).resolves.toMatchObject({ rows: [{ current_user: 'worldgraph_governance_tally' }] });

    const publicIds = ids(100_000);
    const workerAIds = ids(200_000);
    const workerBIds = ids(300_000);
    const lifecycleIds = ids(400_000);
    const publicExecutor = new PostgresGovernanceCommandExecutor(app.pool, {
      ids: publicIds,
      secretHashKey: 'governance-concurrency-secret-key-32-characters',
    });
    const restrictedTally = new PostgresGovernanceRestrictedTallyRepository(tally.pool);
    await restrictedTally.assertRestrictedRole();
    const workerA = new PostgresGovernanceCommandExecutor(app.pool, {
      ids: workerAIds,
      restrictedTallyExecutor: restrictedTally,
      secretHashKey: 'governance-concurrency-secret-key-32-characters',
    });
    const workerB = new PostgresGovernanceCommandExecutor(app.pool, {
      ids: workerBIds,
      restrictedTallyExecutor: restrictedTally,
      secretHashKey: 'governance-concurrency-secret-key-32-characters',
    });
    const repository = new PostgresGovernanceScheduleRepository(app.pool, restrictedTally, worldId);

    await initializeGovernance(publicExecutor);
    const actors = await worldActors(app.pool);
    expect(actors.map((actor) => actor.userId)).toEqual([creatorId, playerId, thirdPlayerId]);
    const creator = actors[0]!;
    const voterA = actors[1]!;
    const voterB = actors[2]!;
    const institution = await proposalInstitution(app.pool, creator.userId);
    const commandBus = await createApiCommandBus(app.pool);

    const boundary = await createProposal(publicExecutor, creator, institution, lifecycleIds, {
      action: createLawAction('law:concurrency-boundary', '2'),
      key: 'proposal:concurrency-boundary',
      title: 'Boundary Ballot Proposal',
    });
    await advanceSimulation(
      commandBus,
      apiActor(creator),
      app.pool,
      BigInt(boundary.voting_opens_tick),
      lifecycleIds,
    );
    await executeScheduled(repository, workerA, boundary.id, 'OpenProposalVotingV1');
    const openedBoundary = await proposalById(app.pool, boundary.id);
    const boundarySnapshotId = await snapshotId(app.pool, openedBoundary.contest_id);

    await advanceSimulation(
      commandBus,
      apiActor(creator),
      app.pool,
      BigInt(boundary.voting_closes_tick),
      lifecycleIds,
    );
    const boundaryState = await runtimeState(app.pool);
    const boundaryCastInput = actorCommandInput(
      voterA,
      governanceCommand(
        boundaryState,
        'CastProposalBallotV1',
        {
          choice: 'yes',
          eligibilitySnapshotId: boundarySnapshotId,
          expectedProposalVersion: openedBoundary.aggregate_version,
          proposalId: boundary.id,
          replaceExisting: false,
        },
        openedBoundary.aggregate_version,
        'governance-concurrency-boundary-cast',
        lifecycleIds,
      ),
      'governance.vote',
      'proposal',
      boundary.id,
      lifecycleIds,
    );
    const boundaryClose = await scheduledInput(
      app.pool,
      repository,
      boundary.id,
      'CloseAndTallyProposalV1',
    );
    const [castRace, closeRace] = await Promise.allSettled([
      publicExecutor.executePublic(boundaryCastInput as never),
      workerA.executeInternal(boundaryClose.input),
    ]);
    expect(castRace.status).toBe('fulfilled');
    const castAccepted =
      castRace.status === 'fulfilled' && castRace.value.result.status === 'accepted';
    let closeAccepted =
      closeRace.status === 'fulfilled' && closeRace.value.result.status === 'accepted';
    expect(Number(castAccepted) + Number(closeAccepted)).toBe(1);
    if (!closeAccepted) {
      expect(closeRace).toMatchObject({
        reason: { code: 'REVISION_CONFLICT', safeFailure: false },
        status: 'rejected',
      });
      const retriedClose = await executeScheduled(
        repository,
        workerA,
        boundary.id,
        'CloseAndTallyProposalV1',
      );
      expect(retriedClose.result.status).toBe('accepted');
      closeAccepted = true;
    }
    expect(closeAccepted).toBe(true);
    const boundaryEvidence = await owner.pool.query<{
      ballot_count: number;
      proposal_status: string;
      turnout_count: number;
    }>(
      `select proposal.status as proposal_status,
              tally.participating_count as turnout_count,
              (select count(*)::integer from ballot_participation participation
                where participation.world_id=proposal.world_id
                  and participation.contest_id=contest.contest_id) as ballot_count
         from proposals proposal
         join proposal_contests contest
           on contest.world_id=proposal.world_id and contest.proposal_id=proposal.id
         join proposal_tallies tally
           on tally.world_id=proposal.world_id and tally.proposal_id=proposal.id
        where proposal.world_id=$1 and proposal.id=$2`,
      [worldId, boundary.id],
    );
    expect(boundaryEvidence.rows).toEqual([
      {
        ballot_count: castAccepted ? 1 : 0,
        proposal_status: 'tallied',
        turnout_count: castAccepted ? 1 : 0,
      },
    ]);

    const duplicateWorkerProposal = await createProposal(
      publicExecutor,
      creator,
      institution,
      lifecycleIds,
      {
        action: createLawAction('law:concurrency-worker-retry', '4'),
        key: 'proposal:concurrency-worker-retry',
        title: 'Duplicate Worker Proposal',
      },
    );
    await advanceSimulation(
      commandBus,
      apiActor(creator),
      app.pool,
      BigInt(duplicateWorkerProposal.voting_opens_tick),
      lifecycleIds,
    );
    await executeScheduled(repository, workerA, duplicateWorkerProposal.id, 'OpenProposalVotingV1');
    await castYes(
      publicExecutor,
      creator,
      duplicateWorkerProposal.id,
      'governance-concurrency-worker-vote-1',
      lifecycleIds,
    );
    await castYes(
      publicExecutor,
      voterB,
      duplicateWorkerProposal.id,
      'governance-concurrency-worker-vote-2',
      lifecycleIds,
    );
    await advanceSimulation(
      commandBus,
      apiActor(creator),
      app.pool,
      BigInt(duplicateWorkerProposal.voting_closes_tick),
      lifecycleIds,
    );
    const duplicateClose = await scheduledInput(
      app.pool,
      repository,
      duplicateWorkerProposal.id,
      'CloseAndTallyProposalV1',
    );
    const duplicateExecutions = await Promise.all([
      workerA.executeInternal(duplicateClose.input),
      workerB.executeInternal(duplicateClose.input),
    ]);
    expect(duplicateExecutions.map((execution) => execution.result.status)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(duplicateExecutions.map((execution) => execution.replayed).sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      owner.pool.query<{ count: number }>(
        `select count(*)::integer as count from proposal_tallies
          where world_id=$1 and proposal_id=$2`,
        [worldId, duplicateWorkerProposal.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const staleCertification = await scheduledInput(
      app.pool,
      repository,
      duplicateWorkerProposal.id,
      'CertifyAndEnactProposalV1',
    );
    await createProposal(publicExecutor, creator, institution, lifecycleIds, {
      action: createLawAction('law:concurrency-revision-bump', '101'),
      key: 'proposal:concurrency-revision-bump',
      title: 'Certification Revision Bump',
    });
    await expect(workerA.executeInternal(staleCertification.input)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      safeFailure: false,
    });
    const freshCertification = await scheduledInput(
      app.pool,
      repository,
      duplicateWorkerProposal.id,
      'CertifyAndEnactProposalV1',
    );
    const certified = await workerA.executeInternal(freshCertification.input);
    expect(certified).toMatchObject({ replayed: false, result: { status: 'accepted' } });
    const certificationReplay = await workerB.executeInternal(freshCertification.input);
    expect(certificationReplay).toEqual({ replayed: true, result: certified.result });
    await expect(proposalEffectCounts(owner.pool, duplicateWorkerProposal.id)).resolves.toEqual({
      actionEnactments: 1,
      enactments: 1,
      results: 1,
      status: 'enacted',
    });

    const office = await availableOffice(owner.pool);
    const appointmentState = await runtimeState(app.pool);
    const appointmentCommandIds = [lifecycleIds.next(), lifecycleIds.next()];
    const appointmentInputs = [voterA, voterB].map((holder, index) =>
      actorCommandInput(
        creator,
        governanceCommand(
          appointmentState,
          'AppointOfficeholderV1',
          {
            expectedOfficeVersion: office.office_version,
            holderEntityKey: holder.entityKey,
            officeId: office.id,
            reason: 'Exercise deterministic competing appointment serialization.',
            seatIndex: 0,
            termEndsAtTick: (BigInt(appointmentState.current_tick) + 20n).toString(),
            termStartsAtTick: appointmentState.current_tick,
          },
          office.office_version,
          `governance-concurrency-appointment-${index + 1}`,
          { next: () => appointmentCommandIds[index]! },
        ),
        'governance.office.appoint',
        'office',
        office.id,
        lifecycleIds,
      ),
    );
    const appointmentRace = await Promise.all(
      appointmentInputs.map((commandInput) => publicExecutor.executePublic(commandInput as never)),
    );
    expect(
      appointmentRace.filter((execution) => execution.result.status === 'accepted'),
    ).toHaveLength(1);
    const rejectedAppointment = appointmentRace.find(
      (execution) => execution.result.status === 'rejected',
    );
    expect(rejectedAppointment?.result).toMatchObject({
      rejectionCode: 'REVISION_CONFLICT',
      status: 'rejected',
    });
    const appointmentEvidence = await owner.pool.query<{
      authority_count: number;
      holder_count: number;
      term_count: number;
    }>(
      `select
         count(distinct term.id)::integer as term_count,
         count(distinct authority.id)::integer as authority_count,
         count(distinct term.holder_entity_id)::integer as holder_count
       from office_terms term
       join office_seat_authority_intervals authority
         on authority.world_id=term.world_id and authority.term_id=term.id
      where term.world_id=$1 and term.office_id=$2
        and term.created_command_id=any($3::uuid[])`,
      [worldId, office.id, appointmentCommandIds],
    );
    expect(appointmentEvidence.rows).toEqual([
      { authority_count: 1, holder_count: 1, term_count: 1 },
    ]);

    const targetLaw = await activeLaw(owner.pool);
    const amendmentOne = await createProposal(publicExecutor, creator, institution, lifecycleIds, {
      action: amendLawAction(targetLaw.id, targetLaw.law_version, '6', 'First amendment'),
      key: 'proposal:concurrency-amendment-one',
      title: 'First Concurrent Amendment',
    });
    const amendmentTwo = await createProposal(publicExecutor, creator, institution, lifecycleIds, {
      action: amendLawAction(targetLaw.id, targetLaw.law_version, '6', 'Second amendment'),
      key: 'proposal:concurrency-amendment-two',
      title: 'Second Concurrent Amendment',
    });
    expect(amendmentTwo.voting_opens_tick).toBe(amendmentOne.voting_opens_tick);
    expect(amendmentTwo.voting_closes_tick).toBe(amendmentOne.voting_closes_tick);
    await advanceSimulation(
      commandBus,
      apiActor(creator),
      app.pool,
      BigInt(amendmentOne.voting_opens_tick),
      lifecycleIds,
    );
    for (const proposal of [amendmentOne, amendmentTwo]) {
      await executeScheduled(repository, workerA, proposal.id, 'OpenProposalVotingV1');
      await castYes(
        publicExecutor,
        creator,
        proposal.id,
        `governance-concurrency-amend-vote-creator-${proposal.id}`,
        lifecycleIds,
      );
      await castYes(
        publicExecutor,
        voterA,
        proposal.id,
        `governance-concurrency-amend-vote-player-${proposal.id}`,
        lifecycleIds,
      );
    }
    await advanceSimulation(
      commandBus,
      apiActor(creator),
      app.pool,
      BigInt(amendmentOne.voting_closes_tick),
      lifecycleIds,
    );
    for (const proposal of [amendmentOne, amendmentTwo]) {
      await executeScheduled(repository, workerA, proposal.id, 'CloseAndTallyProposalV1');
    }
    const certificationOne = await scheduledInput(
      app.pool,
      repository,
      amendmentOne.id,
      'CertifyAndEnactProposalV1',
    );
    const certificationTwo = await scheduledInput(
      app.pool,
      repository,
      amendmentTwo.id,
      'CertifyAndEnactProposalV1',
    );
    const enactmentRace = await Promise.allSettled([
      workerA.executeInternal(certificationOne.input),
      workerB.executeInternal(certificationTwo.input),
    ]);
    const enactmentWinnerIndex = enactmentRace.findIndex(
      (attempt) => attempt.status === 'fulfilled' && attempt.value.result.status === 'accepted',
    );
    const enactmentLoserIndex = enactmentWinnerIndex === 0 ? 1 : 0;
    expect(enactmentWinnerIndex).toBeGreaterThanOrEqual(0);
    expect(enactmentRace[enactmentLoserIndex]).toMatchObject({
      reason: { code: 'REVISION_CONFLICT', safeFailure: false },
      status: 'rejected',
    });
    const enactmentLoser = [certificationOne, certificationTwo][enactmentLoserIndex]!;
    const refreshedLoser = await repository.findPendingEffect(
      enactmentLoser.candidate.scheduledActionId,
      ['CertifyAndEnactProposalV1'],
    );
    if (!refreshedLoser) throw new Error('ENACTMENT_RACE_LOSER_WAS_NOT_RETRYABLE');
    const loserRetry = await workerA.executeInternal(
      governanceScheduledCommandInput(refreshedLoser),
    );
    expect(loserRetry).toMatchObject({
      details: {
        enactmentFailure: 'LAW_VERSION_CONFLICT',
        status: 'passed_but_enactment_failed',
      },
      replayed: false,
      result: { status: 'accepted' },
    });

    const amendmentEvidence = await owner.pool.query<{
      action_effects: number;
      enactment_status: string;
      failure_code: string | null;
      proposal_status: string;
    }>(
      `select proposal.status as proposal_status,enactment.status as enactment_status,
              enactment.failure_code,
              count(effect.id)::integer as action_effects
         from proposals proposal
         join proposal_enactments enactment
           on enactment.world_id=proposal.world_id and enactment.proposal_id=proposal.id
         left join proposal_action_enactments effect
           on effect.world_id=enactment.world_id
          and effect.proposal_enactment_id=enactment.id
        where proposal.world_id=$1 and proposal.id=any($2::uuid[])
        group by proposal.id,proposal.status,enactment.id,enactment.status,enactment.failure_code
        order by proposal.status,enactment.status`,
      [worldId, [amendmentOne.id, amendmentTwo.id]],
    );
    expect(amendmentEvidence.rows).toEqual([
      {
        action_effects: 1,
        enactment_status: 'succeeded',
        failure_code: null,
        proposal_status: 'enacted',
      },
      {
        action_effects: 0,
        enactment_status: 'failed',
        failure_code: 'LAW_VERSION_CONFLICT',
        proposal_status: 'passed_but_enactment_failed',
      },
    ]);
    const finalLaw = await owner.pool.query<{
      active_authorities: number;
      maximum_version: number;
      version_count: number;
    }>(
      `select
         count(version.id)::integer as version_count,
         max(version.law_version)::integer as maximum_version,
         (select count(*)::integer from law_authority_intervals authority
           where authority.world_id=$1 and authority.law_id=$2
             and authority.effective_ticks @> $3::bigint) as active_authorities
       from law_versions version
      where version.world_id=$1 and version.law_id=$2`,
      [worldId, targetLaw.id, amendmentOne.voting_closes_tick],
    );
    expect(finalLaw.rows).toEqual([
      {
        active_authorities: 1,
        maximum_version: Number(targetLaw.law_version) + 1,
        version_count: targetLaw.version_count + 1,
      },
    ]);
  }, 120_000);
});

function id(value: number): string {
  return `098f0000-0000-7000-8000-${value.toString().padStart(12, '0')}`;
}

function ids(start: number): { next(): string } {
  let next = start;
  return { next: () => id(next++) };
}

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

function exactCompilerInput() {
  return createCompilerInputBundle({
    activeMembers: [
      { principalKey: memberPrincipalKey(worldId, creatorId), role: 'creator' },
      { principalKey: memberPrincipalKey(worldId, playerId), role: 'player' },
      { principalKey: memberPrincipalKey(worldId, thirdPlayerId), role: 'player' },
    ],
    compilerConfig: {
      adapterRegistryVersion: 1,
      deprecatedPrimitivePolicy: 'reject',
      maxEntities: 2_000,
      maxRelationships: 8_000,
    },
    manifest: fallback.envelope.manifest,
    primitives: [...STARTER_PRIMITIVES, ...HARBOR_CITY_ECONOMY_PRIMITIVES, ...GOVERNANCE_PRIMITIVES]
      .filter((primitive) => pinnedPrimitiveVersionIds.has(primitive.versionId))
      .map((primitive) => ({
        contentHash: primitive.contentHash,
        definition: primitive.input,
        lifecycle: 'published' as const,
        primitiveVersionId: primitive.versionId,
      })),
    seed,
  });
}

async function seedApprovedCompilation(pool: Pool): Promise<void> {
  const bundle = exactCompilerInput();
  expect(bundle.manifestCanonicalBytes).toBe(canonicalJson(fallback.envelope.manifest));
  expect(bundle.manifestContentHash).toBe(fallback.contentHash);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into users(id,email,password_hash,display_name) values
       ($1,'concurrency-creator@example.test',$4,'Concurrency Creator'),
       ($2,'concurrency-player@example.test',$4,'Concurrency Player'),
       ($3,'concurrency-third@example.test',$4,'Concurrency Third Player')`,
      [creatorId, playerId, thirdPlayerId, passwordHash],
    );
    await client.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'governance-concurrency','Governance Concurrency',$2)`,
      [worldId, creatorId],
    );
    await client.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'creator',$2),($1,$3,'player',$2),($1,$4,'player',$2)`,
      [worldId, creatorId, playerId, thirdPlayerId],
    );
    await client.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,manifest_schema_version,canonical_manifest,
         content_hash,source,created_by_user_id
       ) values ($1,$2,1,1,$3,decode($4,'hex'),'manual',$5)`,
      [revisionId, worldId, fallback.envelope.manifest, fallback.contentHash, creatorId],
    );
    await client.query(
      `insert into manifest_validation_reports(
         id,manifest_revision_id,validator_version,primitive_catalog_snapshot_hash,
         valid,diagnostics,report_hash
       ) values ($1,$2,1,decode(repeat('ab',32),'hex'),true,'[]'::jsonb,
         decode(repeat('cd',32),'hex'))`,
      [validationReportId, revisionId],
    );
    await client.query(
      `update manifest_revisions
          set approval_status='approved',approved_by_user_id=$2,
              approved_at=now(),row_version=row_version+1
        where id=$1`,
      [revisionId, creatorId],
    );
    await client.query(
      `update worlds
          set current_approved_manifest_revision_id=$2,manifest_schema_version=1,
              lifecycle='manifest_approved',row_version=row_version+1,updated_at=now()
        where id=$1`,
      [worldId, revisionId],
    );
    await client.query(
      `insert into world_compilation_runs(
         id,world_id,manifest_revision_id,manifest_content_hash,input_hash,
         compiler_version,compiler_config_version,seed,requested_by_user_id,idempotency_key
       ) values ($1,$2,$3,decode($4,'hex'),decode($5,'hex'),$6,1,$7,$8,$9)`,
      [
        compilationRunId,
        worldId,
        revisionId,
        bundle.manifestContentHash,
        bundle.inputHash,
        COMPILER_VERSION,
        seed,
        creatorId,
        'governance-concurrency-compilation-0001',
      ],
    );
    await client.query(
      `update worlds set lifecycle='compiling',row_version=row_version+1,updated_at=now()
        where id=$1`,
      [worldId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function initializeGovernance(executor: PostgresGovernanceCommandExecutor): Promise<void> {
  const compiled = await executorPoolQuery<{
    plan_hash: string;
  }>(
    `select encode(plan.plan_hash,'hex') as plan_hash
       from compiled_governance_seed_plans plan
       join world_runtime_heads runtime
         on runtime.world_id=plan.world_id and runtime.active_world_version_id=plan.world_version_id
      where plan.world_id=$1`,
    [worldId],
  );
  const state = await runtimeState(executorPool());
  const command: Extract<GovernanceCommandRequestV1, { type: 'InitializeWorldGovernanceV1' }> = {
    actorMode: 'creator',
    commandId: initializeCommandId,
    expectedAggregateVersion: '0',
    expectedStateRevision: state.state_revision,
    expectedTick: state.current_tick,
    expectedWorldVersion: state.design_version,
    idempotencyKey: 'governance-concurrency-initialize-0001',
    payload: {
      compiledWorldVersionId: state.active_world_version_id,
      seedPlanHash: compiled.rows[0]!.plan_hash,
    },
    schemaVersion: 1,
    type: 'InitializeWorldGovernanceV1',
  };
  const result = await executor.executePublic({
    actor: { actorEntityId: null, actorId: creatorId, actorType: 'user' },
    authorization: {
      actionCode: 'governance.initialize',
      allowed: true,
      context: { membershipRoles: ['creator'] },
      reasonCode: 'POLICY_ALLOWED',
      resourceId: worldId,
      resourceType: 'world_governance',
      ruleId: 'governance.concurrency.initializer.v1',
    },
    causationId: null,
    command,
    correlationId: initializeCorrelationId,
    worldId,
  });
  expect(result).toMatchObject({ replayed: false, result: { status: 'accepted' } });
}

let sharedAppPool: Pool | undefined;

function executorPool(): Pool {
  if (!sharedAppPool) throw new Error('GOVERNANCE_CONCURRENCY_APP_POOL_UNAVAILABLE');
  return sharedAppPool;
}

async function executorPoolQuery<TRow extends object>(text: string, values: unknown[]) {
  return executorPool().query<TRow>(text, values);
}

function createLawAction(lawKey: string, effectiveFromTick: string): LawProposalAction {
  return {
    actionSchemaVersion: 1,
    actionType: 'create_law',
    effectiveFromTick,
    effectiveUntilTick: null,
    lawKey,
    policy: { kind: 'membership_role', role: 'player' },
    summary: `Creates ${lawKey} for the concurrency acceptance matrix.`,
    targetCharterVersion: '1',
    title: lawKey.replaceAll(':', ' '),
  };
}

function amendLawAction(
  lawId: string,
  expectedLawVersion: string,
  effectiveFromTick: string,
  title: string,
): LawProposalAction {
  return {
    actionSchemaVersion: 1,
    actionType: 'amend_law',
    effectiveFromTick,
    effectiveUntilTick: null,
    expectedLawVersion,
    lawId,
    policy: { kind: 'membership_role', role: 'creator' },
    summary: `${title} proves current target versions are revalidated at enactment.`,
    title,
  };
}

async function createProposal(
  executor: PostgresGovernanceCommandExecutor,
  actor: WorldActor,
  institution: { id: string; jurisdictionKey: string },
  source: { next(): string },
  input: {
    action: LawProposalAction;
    key: string;
    title: string;
  },
): Promise<ProposalRecord> {
  const state = await runtimeState(executorPool());
  const currentTick = BigInt(state.current_tick);
  const sponsorshipEndsAtTick = currentTick + 2n;
  const votingOpensAtTick = sponsorshipEndsAtTick + 2n;
  const votingClosesAtTick = votingOpensAtTick + 5n;
  const action: LawProposalAction = {
    ...input.action,
    effectiveFromTick: votingClosesAtTick.toString(),
  };
  const commandId = source.next();
  const command = governanceCommand(
    state,
    'CreateProposalV1',
    {
      action,
      approvalThresholdBps: 5_001,
      ballotPolicy: {
        ballotMode: 'public',
        disclosure: 'choice_totals',
        replacementAllowed: true,
      },
      body: `${input.title} exercises a PostgreSQL concurrency boundary.`,
      debateEndsAtTick: votingOpensAtTick.toString(),
      institutionId: institution.id,
      jurisdictionEntityKey: institution.jurisdictionKey,
      minimumSponsors: 0,
      proposalKey: input.key,
      quorumBps: 5_000,
      sponsorshipEndsAtTick: sponsorshipEndsAtTick.toString(),
      targetCharterVersion: '1',
      title: input.title,
      votingClosesAtTick: votingClosesAtTick.toString(),
      votingOpensAtTick: votingOpensAtTick.toString(),
    },
    '0',
    `governance-concurrency-create-${input.key.split(':').at(-1)}`,
    { next: () => commandId },
  );
  const execution = await executor.executePublic(
    actorCommandInput(
      actor,
      command,
      'governance.proposal.create',
      'institution',
      institution.id,
      source,
    ) as never,
  );
  expectAccepted(execution, 'CreateProposalV1');
  return proposalByCommand(executorPool(), commandId);
}

async function castYes(
  executor: PostgresGovernanceCommandExecutor,
  actor: WorldActor,
  proposalId: string,
  idempotencyKey: string,
  source: { next(): string },
): Promise<void> {
  const proposal = await proposalById(executorPool(), proposalId);
  const state = await runtimeState(executorPool());
  const execution = await executor.executePublic(
    actorCommandInput(
      actor,
      governanceCommand(
        state,
        'CastProposalBallotV1',
        {
          choice: 'yes',
          eligibilitySnapshotId: await snapshotId(executorPool(), proposal.contest_id),
          expectedProposalVersion: proposal.aggregate_version,
          proposalId,
          replaceExisting: false,
        },
        proposal.aggregate_version,
        idempotencyKey,
        source,
      ),
      'governance.vote',
      'proposal',
      proposalId,
      source,
    ) as never,
  );
  expectAccepted(execution, 'CastProposalBallotV1');
}

function governanceCommand(
  state: RuntimeState,
  type: GovernanceCommandRequestV1['type'],
  payload: Record<string, unknown>,
  expectedAggregateVersion: string,
  idempotencyKey: string,
  source: { next(): string },
): GovernanceCommandRequestV1 {
  return {
    actorMode: 'in_world',
    commandId: source.next(),
    expectedAggregateVersion,
    expectedStateRevision: state.state_revision,
    expectedTick: state.current_tick,
    expectedWorldVersion: state.design_version,
    idempotencyKey,
    payload,
    schemaVersion: 1,
    type,
  } as GovernanceCommandRequestV1;
}

function actorCommandInput(
  actor: WorldActor,
  command: GovernanceCommandRequestV1,
  actionCode: string,
  resourceType: string,
  resourceId: string,
  source: { next(): string },
): GovernanceCommandExecutionInput {
  return {
    actor: { actorEntityId: actor.entityId, actorId: actor.userId, actorType: 'user' },
    authorization: {
      actionCode,
      allowed: true,
      context: {
        membershipRoles: [actor.role],
        ...(command.type === 'CreateProposalV1'
          ? { policyActionCode: 'governance.propose', policyResourceType: 'proposal' }
          : command.type === 'AppointOfficeholderV1' || command.type === 'RemoveOfficeholderV1'
            ? { policyActionCode: 'governance.appoint', policyResourceType: 'office' }
            : {}),
      },
      reasonCode: 'POLICY_ALLOWED',
      resourceId,
      resourceType,
      ruleId: 'governance.concurrency.compiled-policy.v1',
    },
    causationId: null,
    command,
    correlationId: source.next(),
    worldId,
  };
}

function expectAccepted(execution: GovernanceCommandExecutionResult, type: string): void {
  if (execution.result.status !== 'accepted') {
    throw new Error(`${type} rejected: ${JSON.stringify(execution.result)}`);
  }
  expect(execution.replayed).toBe(false);
}

async function scheduledInput(
  pool: Pool,
  repository: PostgresGovernanceScheduleRepository,
  proposalId: string,
  actionType: ScheduledActionType,
): Promise<{
  candidate: GovernanceScheduledEffectCandidate;
  input: InternalGovernanceCommandExecutionInput;
}> {
  const action = await pool.query<{ id: string }>(
    `select id::text from scheduled_actions
      where world_id=$1 and action_type=$2 and payload->>'proposalId'=$3`,
    [worldId, actionType, proposalId],
  );
  const actionId = action.rows[0]?.id;
  if (!actionId) throw new Error(`SCHEDULED_ACTION_NOT_FOUND:${actionType}`);
  const candidate = await repository.findPendingEffect(actionId, [actionType]);
  if (!candidate) throw new Error(`SCHEDULED_ACTION_NOT_PENDING:${actionType}:${actionId}`);
  return { candidate, input: governanceScheduledCommandInput(candidate) };
}

async function executeScheduled(
  repository: PostgresGovernanceScheduleRepository,
  executor: PostgresGovernanceCommandExecutor,
  proposalId: string,
  actionType: ScheduledActionType,
): Promise<GovernanceCommandExecutionResult> {
  const scheduled = await scheduledInput(executorPool(), repository, proposalId, actionType);
  const execution = await executor.executeInternal(scheduled.input);
  expectAccepted(execution, actionType);
  return execution;
}

async function worldActors(pool: Pool): Promise<WorldActor[]> {
  const result = await pool.query<{
    entity_id: string;
    entity_key: string;
    role: WorldActor['role'];
    user_id: string;
  }>(
    `select membership.user_id::text,membership.role::text,
            controller.entity_id::text,entity.logical_key::text as entity_key
       from world_memberships membership
       join world_entity_controllers controller
         on controller.world_id=membership.world_id
        and controller.user_id=membership.user_id
        and controller.control_scope='primary' and controller.revoked_at is null
       join world_entities entity
         on entity.world_id=controller.world_id and entity.id=controller.entity_id
        and entity.entity_type='player_character'
        and entity.retired_world_version_id is null
      where membership.world_id=$1 and membership.status='active'
      order by membership.user_id`,
    [worldId],
  );
  return result.rows.map((row) => ({
    entityId: row.entity_id,
    entityKey: row.entity_key,
    role: row.role,
    userId: row.user_id,
  }));
}

async function proposalInstitution(
  pool: Pool,
  userId: string,
): Promise<{ id: string; jurisdictionKey: string }> {
  const result = await pool.query<{ id: string; jurisdiction_key: string }>(
    `select institution.id::text,
            jurisdiction.logical_key::text as jurisdiction_key
       from world_entity_controllers controller
       join institutions institution on institution.world_id=controller.world_id
       join world_entities jurisdiction
         on jurisdiction.world_id=institution.world_id
        and jurisdiction.id=institution.jurisdiction_entity_id
      where controller.world_id=$1 and controller.user_id=$2
        and controller.revoked_at is null
      order by institution.stable_key limit 1`,
    [worldId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('PROPOSAL_INSTITUTION_NOT_FOUND');
  return { id: row.id, jurisdictionKey: row.jurisdiction_key };
}

async function proposalByCommand(pool: Pool, commandId: string): Promise<ProposalRecord> {
  const result = await pool.query<ProposalRecord>(
    `select proposal.id::text,proposal.aggregate_version::text,proposal.status,
            proposal.voting_opens_tick::text,proposal.voting_closes_tick::text,
            contest.contest_id::text
       from proposals proposal
       join proposal_contests contest
         on contest.world_id=proposal.world_id and contest.proposal_id=proposal.id
      where proposal.world_id=$1 and proposal.created_command_id=$2`,
    [worldId, commandId],
  );
  if (!result.rows[0]) throw new Error('PROPOSAL_NOT_FOUND');
  return result.rows[0];
}

async function proposalById(pool: Pool, proposalId: string): Promise<ProposalRecord> {
  const result = await pool.query<ProposalRecord>(
    `select proposal.id::text,proposal.aggregate_version::text,proposal.status,
            proposal.voting_opens_tick::text,proposal.voting_closes_tick::text,
            contest.contest_id::text
       from proposals proposal
       join proposal_contests contest
         on contest.world_id=proposal.world_id and contest.proposal_id=proposal.id
      where proposal.world_id=$1 and proposal.id=$2`,
    [worldId, proposalId],
  );
  if (!result.rows[0]) throw new Error('PROPOSAL_NOT_FOUND');
  return result.rows[0];
}

async function snapshotId(pool: Pool, contestId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `select id::text from eligibility_snapshots where world_id=$1 and contest_id=$2`,
    [worldId, contestId],
  );
  if (!result.rows[0]) throw new Error('ELIGIBILITY_SNAPSHOT_NOT_FOUND');
  return result.rows[0].id;
}

async function availableOffice(
  pool: Pool,
): Promise<{ id: string; office_version: string; seat_id: string }> {
  const result = await pool.query<{ id: string; office_version: string; seat_id: string }>(
    `select office.id::text,office.row_version::text as office_version,seat.id::text as seat_id
       from political_offices office
       join political_office_seats seat
         on seat.world_id=office.world_id and seat.office_id=office.id
        and seat.seat_ordinal=1 and seat.status='active'
      where office.world_id=$1
        and not exists (
          select 1 from office_seat_authority_intervals authority
           where authority.world_id=seat.world_id and authority.seat_id=seat.id
        )
      order by office.stable_key limit 1`,
    [worldId],
  );
  if (!result.rows[0]) throw new Error('AVAILABLE_OFFICE_NOT_FOUND');
  return result.rows[0];
}

async function activeLaw(
  pool: Pool,
): Promise<{ id: string; law_version: string; version_count: number }> {
  const result = await pool.query<{ id: string; law_version: string; version_count: number }>(
    `select law.id::text,latest.law_version::text,
            (select count(*)::integer from law_versions counted
              where counted.world_id=law.world_id and counted.law_id=law.id) as version_count
       from laws law
       join lateral (
         select version.law_version
           from law_versions version
          where version.world_id=law.world_id and version.law_id=law.id
          order by version.law_version desc limit 1
       ) latest on true
       join law_authority_intervals authority
         on authority.world_id=law.world_id and authority.law_id=law.id
        and authority.effective_ticks @> 4::bigint
      where law.world_id=$1
      order by law.stable_key limit 1`,
    [worldId],
  );
  if (!result.rows[0]) throw new Error('ACTIVE_LAW_NOT_FOUND');
  return result.rows[0];
}

async function proposalEffectCounts(
  pool: Pool,
  proposalId: string,
): Promise<{ actionEnactments: number; enactments: number; results: number; status: string }> {
  const result = await pool.query<{
    actionEnactments: number;
    enactments: number;
    results: number;
    status: string;
  }>(
    `select proposal.status,
       (select count(*)::integer from proposal_results result
         where result.world_id=proposal.world_id and result.proposal_id=proposal.id) as results,
       (select count(*)::integer from proposal_enactments enactment
         where enactment.world_id=proposal.world_id and enactment.proposal_id=proposal.id)
         as enactments,
       (select count(*)::integer
          from proposal_action_enactments effect
          join proposal_enactments enactment
            on enactment.world_id=effect.world_id and enactment.id=effect.proposal_enactment_id
         where enactment.world_id=proposal.world_id and enactment.proposal_id=proposal.id)
         as "actionEnactments"
      from proposals proposal where proposal.world_id=$1 and proposal.id=$2`,
    [worldId, proposalId],
  );
  if (!result.rows[0]) throw new Error('PROPOSAL_EFFECT_COUNTS_NOT_FOUND');
  return result.rows[0];
}

async function runtimeState(pool: Pool): Promise<RuntimeState> {
  const result = await pool.query<RuntimeState>(
    `select runtime.active_world_version_id,runtime.state_revision::text,
            version.version_number::text as design_version,clock.current_tick::text
       from world_runtime_heads runtime
       join world_versions version
         on version.world_id=runtime.world_id and version.id=runtime.active_world_version_id
       join world_simulation_clocks clock on clock.world_id=runtime.world_id
      where runtime.world_id=$1`,
    [worldId],
  );
  if (!result.rows[0]) throw new Error('WORLD_RUNTIME_NOT_FOUND');
  return result.rows[0];
}

function apiActor(actor: WorldActor): ApiActor {
  return {
    csrfHash: Buffer.alloc(32, 1),
    session: {
      absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
      id: id(901),
      idleExpiresAt: '2099-01-01T00:00:00.000Z',
    },
    user: {
      displayName: actor.role === 'creator' ? 'Concurrency Creator' : 'Concurrency Player',
      email: `${actor.userId}@example.test`,
      id: actor.userId,
      platformRole: 'user',
      rowVersion: 1,
      status: 'active',
    },
  };
}

async function createApiCommandBus(
  pool: Pool,
): Promise<InstanceType<ApiCommandBusModule['WorldCommandBus']>> {
  sharedAppPool = pool;
  const commandBusPath = new URL(
    ['..', '..', 'api', 'src', 'commands', 'command-bus.ts'].join('/'),
    import.meta.url,
  ).href;
  const repositoryPath = new URL(
    ['..', '..', 'api', 'src', 'commands', 'repository.ts'].join('/'),
    import.meta.url,
  ).href;
  const commandBusModule = (await import(commandBusPath)) as unknown as ApiCommandBusModule;
  const repositoryModule = (await import(repositoryPath)) as unknown as ApiCommandRepositoryModule;
  return new commandBusModule.WorldCommandBus(
    new repositoryModule.PostgresCommandRepository(pool, ids(500_000)),
    ids(510_000),
  );
}

async function advanceSimulation(
  commandBus: InstanceType<ApiCommandBusModule['WorldCommandBus']>,
  actor: ApiActor,
  pool: Pool,
  targetTick: bigint,
  source: { next(): string },
): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const context = await pool.query<{
      aggregate_version: string;
      current_tick: string;
      design_version: string;
      max_batch_ticks: number;
      state_revision: string;
    }>(
      `select stream.current_version::text as aggregate_version,
              clock.current_tick::text,clock.max_batch_ticks,
              runtime.state_revision::text,version.version_number::text as design_version
         from world_simulation_clocks clock
         join world_runtime_heads runtime on runtime.world_id=clock.world_id
         join world_versions version
           on version.world_id=runtime.world_id and version.id=runtime.active_world_version_id
         join aggregate_stream_heads stream
           on stream.world_id=clock.world_id
          and stream.aggregate_type='simulation_clock'
          and stream.aggregate_id=clock.world_id::text
        where clock.world_id=$1`,
      [worldId],
    );
    const row = context.rows[0]!;
    const currentTick = BigInt(row.current_tick);
    if (currentTick === targetTick) return;
    if (currentTick > targetTick) throw new Error('SIMULATION_TARGET_TICK_ALREADY_PASSED');
    const ticks = Number(targetTick - currentTick);
    const commandId = source.next();
    const result = await commandBus.submit(
      actor,
      worldId,
      {
        commandId,
        expectedAggregateVersion: row.aggregate_version,
        expectedStateRevision: row.state_revision,
        expectedTick: row.current_tick,
        expectedWorldVersion: row.design_version,
        idempotencyKey: `governance-concurrency-advance-${row.current_tick}-${ticks}`,
        payload: { ticks },
        schemaVersion: 1,
        type: 'AdvanceSimulationV1',
      },
      source.next(),
      new Date(),
    );
    if (result.httpStatus !== 200 || result.result.status !== 'accepted') {
      throw new Error(`Simulation advance failed: ${JSON.stringify(result)}`);
    }
  }
  throw new Error('SIMULATION_TARGET_TICK_ATTEMPTS_EXHAUSTED');
}
