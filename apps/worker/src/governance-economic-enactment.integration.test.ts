import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GOVERNANCE_PRIMITIVES,
  HARBOR_CITY_ECONOMY_PRIMITIVES,
  STARTER_PRIMITIVES,
} from '@worldgraph/catalog';
import { createCompilerInputBundle, memberPrincipalKey } from '@worldgraph/compiler';
import {
  canonicalJson,
  type GovernanceCommandRequestV1,
  type GovernanceProposalActionV1,
  type GovernanceSeedPlanV1,
} from '@worldgraph/contracts';
import {
  applyMigrations,
  createDatabaseClient,
  importStarterPrimitives,
  readRuntimeVersions,
} from '@worldgraph/db';
import {
  PostgresGovernanceCommandExecutor,
  type GovernanceCommandExecutionInput,
} from '@worldgraph/governance-command';
import {
  createDeterministicGovernedHarborCityFallback,
  governedHarborCityManifestCatalog,
} from '@worldgraph/manifests';
import { createLogger } from '@worldgraph/observability';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresGovernanceScheduleRepository } from './governance-schedule-repository.js';
import {
  GovernanceScheduleRunner,
  type GovernanceInternalCommandPort,
} from './governance-schedule-worker.js';
import { PostgresGovernanceRestrictedTallyRepository } from './governance-tally-repository.js';
import { PostgresWorldCompilationRepository } from './world-compilation-repository.js';
import {
  WorldCompilationRunner,
  type WorldCompilationMetrics,
} from './world-compilation-worker.js';

const migrationRoot = resolve('packages/db/drizzle');
const databaseOrigin =
  process.env['WORLDGRAPH_M10_DATABASE_ORIGIN'] === 'upgrade' ? 'upgrade' : 'clean';
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$test-salt$test-hash-value';
const creatorId = id(1);
const playerAId = id(2);
const playerBId = id(3);
const worldId = id(101);
const revisionId = id(201);
const compilationRunId = id(301);
const validationReportId = id(401);
const initializeCommandId = id(501);
const seed = 'governance-economic-enactment-integration-seed';
const fallback = createDeterministicGovernedHarborCityFallback({
  catalog: governedHarborCityManifestCatalog(),
  prompt:
    'A governed harbor city with typed tax policy updates and treasury-backed public projects.',
  seed,
});
const pinnedPrimitiveVersionIds = new Set(
  fallback.envelope.manifest.primitiveRefs.map((entry) => entry.primitiveVersionId),
);
const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'error',
  service: 'governance-economic-enactment-integration',
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
  economy_version: string;
  state_revision: string;
}

interface WorldActor {
  entityId: string;
  entityKey: string;
  role: 'creator' | 'player';
  userId: string;
}

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
  result: {
    eventIds: string[];
    rejectionCode?: string;
    status: string;
  };
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

interface ProposalRecord {
  aggregate_version: string;
  contest_id: string;
  id: string;
  status: string;
}

interface EconomyTargets {
  creator_balance_minor: string;
  creator_wallet_id: string;
  creator_wallet_version: string;
  currency_id: string;
  project_key: string;
  tax_policy_id: string;
  tax_policy_rate_bps: number;
  tax_policy_version: string;
  treasury_balance_minor: string;
  treasury_wallet_id: string;
  treasury_wallet_version: string;
}

function id(value: number): string {
  return `069f0000-0000-7000-8000-${value.toString().padStart(12, '0')}`;
}

function ids(start = 100_000): { next(): string } {
  let next = start;
  return {
    next: () => `079f0000-0000-7000-8000-${String(next++).padStart(12, '0')}`,
  };
}

function applicationUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = 'worldgraph_app';
  url.password = 'worldgraph_app_local_only';
  return url.toString();
}

async function createExactM09MigrationRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-governance-economy-m09-origin-'));
  await mkdir(join(root, 'meta'));
  const journal = JSON.parse(await readFile(join(migrationRoot, 'meta/_journal.json'), 'utf8')) as {
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
    version: string;
  };
  const entries = journal.entries.filter((entry) => entry.idx < 12);
  await Promise.all(
    entries.map((entry) =>
      cp(join(migrationRoot, `${entry.tag}.sql`), join(root, `${entry.tag}.sql`)),
    ),
  );
  await writeFile(join(root, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return root;
}

function exactCompilerInput() {
  return createCompilerInputBundle({
    activeMembers: [
      { principalKey: memberPrincipalKey(worldId, creatorId), role: 'creator' },
      { principalKey: memberPrincipalKey(worldId, playerAId), role: 'player' },
      { principalKey: memberPrincipalKey(worldId, playerBId), role: 'player' },
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

describe(`M10 governed economy enactment PostgreSQL integration from ${databaseOrigin}`, () => {
  let app: ReturnType<typeof createDatabaseClient>;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let m09MigrationRoot: string | undefined;
  let owner: ReturnType<typeof createDatabaseClient>;
  let tally: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    owner = createDatabaseClient(container.getConnectionUri(), 'governance-economy-owner-test');
    if (databaseOrigin === 'upgrade') {
      m09MigrationRoot = await createExactM09MigrationRoot();
      await applyMigrations(owner, m09MigrationRoot);
      await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
        contracts: 9,
        runtimeSchema: 9,
      });
    }
    await applyMigrations(owner, migrationRoot);
    await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
      contracts: 10,
      governanceSchema: 1,
      runtimeSchema: 10,
    });
    await importStarterPrimitives(owner.pool);
    await seedApprovedCompilation(owner.pool);

    app = createDatabaseClient(
      applicationUrl(container.getConnectionUri()),
      'governance-economy-app-test',
    );
    const tallyUrl = new URL(container.getConnectionUri());
    tallyUrl.username = 'worldgraph_governance_tally';
    tallyUrl.password = 'worldgraph_governance_tally_local_only';
    tally = createDatabaseClient(tallyUrl.toString(), 'governance-economy-tally-test');

    const runner = new WorldCompilationRunner(
      new PostgresWorldCompilationRepository(app.pool),
      logger,
      { maxEntities: 2_000, maxRelationships: 8_000 },
      { maximumRunsPerReconciliation: 1, metrics: noOpMetrics },
    );
    await expect(runner.runOne()).resolves.toMatchObject({ outcome: 'succeeded' });
    const [creator] = await worldActors(app.pool);
    if (!creator) throw new Error('COMPILED_CREATOR_NOT_FOUND');
    await initializeEconomyAndCommerce(
      await createApiCommandBus(app.pool),
      creator,
      app.pool,
      ids(90_000),
    );
    await initializeGovernance(app.pool, owner.pool);
  }, 120_000);

  afterAll(async () => {
    await tally?.pool.end();
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
    if (m09MigrationRoot) await rm(m09MigrationRoot, { force: true, recursive: true });
  });

  it('enacts typed tax and project actions while rolling a failed treasury action back atomically', async () => {
    const actors = await worldActors(app.pool);
    expect(actors.map((actor) => actor.userId)).toEqual([creatorId, playerAId, playerBId]);
    const creator = actors[0]!;
    const commandBus = await createApiCommandBus(app.pool, 700_000);
    const targetsBeforeFunding = await economyTargets(app.pool);
    expect(targetsBeforeFunding.treasury_balance_minor).toBe('0');
    expect(BigInt(targetsBeforeFunding.creator_balance_minor)).toBeGreaterThan(1_000n);

    await fundTreasury(commandBus, creator, app.pool, targetsBeforeFunding, ids(200_000));
    const targets = await economyTargets(app.pool);
    expect(targets.treasury_balance_minor).toBe('1000');
    await expectEconomyIntegrity(owner.pool);

    const institution = await proposalInstitution(app.pool, creator.userId);
    const lifecycleIds = ids(300_000);
    const executor = new PostgresGovernanceCommandExecutor(app.pool, {
      ids: ids(400_000),
      secretHashKey: 'governance-economy-secret-hash-key-32-characters',
    });
    const actions: Array<{
      action: GovernanceProposalActionV1;
      commandId: string;
      proposalKey: string;
      title: string;
    }> = [
      {
        action: {
          actionSchemaVersion: 1,
          actionType: 'update_tax',
          effectiveFromTick: '9',
          expectedTaxPolicyVersion: targets.tax_policy_version,
          newRateBps: targets.tax_policy_rate_bps === 333 ? targets.tax_policy_rate_bps + 1 : 333,
          taxPolicyId: targets.tax_policy_id,
        },
        commandId: lifecycleIds.next(),
        proposalKey: 'proposal:integration-update-tax-policy',
        title: 'Update Harbor Sales Tax',
      },
      {
        action: {
          actionSchemaVersion: 1,
          actionType: 'authorize_public_project',
          amountMinor: '250',
          budgetKey: 'budget:integration-harbor-repair',
          currencyId: targets.currency_id,
          description: 'Authorizes a bounded repair of the public harbor platform.',
          effectiveAtTick: '9',
          projectKey: targets.project_key,
          treasuryWalletId: targets.treasury_wallet_id,
        },
        commandId: lifecycleIds.next(),
        proposalKey: 'proposal:integration-authorize-public-project',
        title: 'Authorize Harbor Platform Repair',
      },
      {
        action: {
          actionSchemaVersion: 1,
          actionType: 'authorize_public_project',
          amountMinor: '1001',
          budgetKey: 'budget:integration-unfunded-project',
          currencyId: targets.currency_id,
          description: 'Exercises safe passed-but-unenacted treasury failure handling.',
          effectiveAtTick: '9',
          projectKey: targets.project_key,
          treasuryWalletId: targets.treasury_wallet_id,
        },
        commandId: lifecycleIds.next(),
        proposalKey: 'proposal:integration-unfunded-project',
        title: 'Unfunded Harbor Expansion',
      },
    ];

    for (const proposal of actions) {
      const state = await runtimeState(app.pool);
      await executeAccepted(
        executor,
        actorCommandInput(
          creator,
          governanceCommand(
            state,
            'CreateProposalV1',
            {
              action: proposal.action,
              approvalThresholdBps: 5_001,
              ballotPolicy: {
                ballotMode: 'public',
                disclosure: 'choice_totals',
                replacementAllowed: true,
              },
              body: `${proposal.title} integration lifecycle evidence.`,
              debateEndsAtTick: '4',
              institutionId: institution.institutionId,
              jurisdictionEntityKey: institution.jurisdictionKey,
              minimumSponsors: 0,
              proposalKey: proposal.proposalKey,
              quorumBps: 5_000,
              sponsorshipEndsAtTick: '2',
              targetCharterVersion: '1',
              title: proposal.title,
              votingClosesAtTick: '9',
              votingOpensAtTick: '4',
            },
            '0',
            `governance-economic-create-${proposal.proposalKey.split(':').at(-1)}`,
            lifecycleIds,
            proposal.commandId,
          ),
          'governance.proposal.create',
          'institution',
          institution.institutionId,
          lifecycleIds,
        ),
      );
    }

    const restrictedTally = new PostgresGovernanceRestrictedTallyRepository(tally.pool);
    await restrictedTally.assertRestrictedRole();
    const scheduledExecutor = new PostgresGovernanceCommandExecutor(app.pool, {
      ids: ids(500_000),
      restrictedTallyExecutor: restrictedTally,
      secretHashKey: 'governance-economy-secret-hash-key-32-characters',
    });
    let scheduleError: unknown;
    const scheduledCommands: GovernanceInternalCommandPort = {
      executeInternal: async (input) => {
        try {
          return await scheduledExecutor.executeInternal(input);
        } catch (error) {
          scheduleError = error;
          throw error;
        }
      },
    };
    const scheduleRunner = new GovernanceScheduleRunner(
      new PostgresGovernanceScheduleRepository(app.pool, restrictedTally, worldId),
      scheduledCommands,
      logger,
      { batchSize: 25 },
    );

    await advanceSimulation(commandBus, apiActor(creator), app.pool, 4n, lifecycleIds);
    const opened = await runGovernanceUntilIdle(scheduleRunner);
    expect(opened.filter((result) => result.actionType === 'OpenProposalVotingV1')).toHaveLength(3);

    for (const proposal of actions) {
      const persisted = await proposalByCommand(app.pool, proposal.commandId);
      expect(persisted).toMatchObject({ aggregate_version: '2', status: 'open' });
      const snapshot = await eligibilitySnapshot(owner.pool, persisted.contest_id);
      expect(snapshot).toMatchObject({ eligible_count: 3, member_count: 3 });
      for (const [index, actor] of actors.entries()) {
        const state = await runtimeState(app.pool);
        await executeAccepted(
          executor,
          actorCommandInput(
            actor,
            governanceCommand(
              state,
              'CastProposalBallotV1',
              {
                choice: 'yes',
                eligibilitySnapshotId: snapshot.id,
                expectedProposalVersion: persisted.aggregate_version,
                proposalId: persisted.id,
                replaceExisting: false,
              },
              persisted.aggregate_version,
              `governance-economic-vote-${proposal.proposalKey.split(':').at(-1)}-${index + 1}`,
              lifecycleIds,
            ),
            'governance.vote',
            'proposal',
            persisted.id,
            lifecycleIds,
          ),
        );
      }
    }

    await advanceSimulation(commandBus, apiActor(creator), app.pool, 9n, lifecycleIds);
    const finalized = await runGovernanceUntilIdle(scheduleRunner);
    if (finalized.some((result) => result.outcome === 'failed')) throw scheduleError;
    expect(
      finalized.filter((result) => result.actionType === 'CloseAndTallyProposalV1'),
    ).toHaveLength(3);
    expect(
      finalized.filter((result) => result.actionType === 'CertifyAndEnactProposalV1'),
    ).toHaveLength(3);
    expect(finalized.every((result) => result.outcome === 'accepted')).toBe(true);

    const taxProposal = await proposalByCommand(app.pool, actions[0]!.commandId);
    const projectProposal = await proposalByCommand(app.pool, actions[1]!.commandId);
    const failedProposal = await proposalByCommand(app.pool, actions[2]!.commandId);
    const enactmentStatuses = await app.pool.query<{
      failure_code: string | null;
      proposal_id: string;
      status: string;
    }>(
      `select proposal.id::text as proposal_id,proposal.status,
              enactment.failure_code
         from proposals proposal
         left join proposal_enactments enactment
           on enactment.world_id=proposal.world_id and enactment.proposal_id=proposal.id
        where proposal.world_id=$1 and proposal.id=any($2::uuid[])
        order by proposal.id`,
      [worldId, [taxProposal.id, projectProposal.id, failedProposal.id]],
    );
    if (taxProposal.status !== 'enacted' || projectProposal.status !== 'enacted') {
      throw new Error(`Unexpected enactment statuses: ${JSON.stringify(enactmentStatuses.rows)}`);
    }
    expect(taxProposal.status).toBe('enacted');
    expect(projectProposal.status).toBe('enacted');
    expect(failedProposal.status).toBe('passed_but_enactment_failed');

    const taxEvidence = await app.pool.query<{
      current_rate_bps: number;
      current_version: number;
      effect_count: number;
      lineage_count: number;
      old_authority_end: string;
      old_policy_count: number;
      result_outcome: string;
    }>(
      `select
         current_policy.policy_version as current_version,
         current_policy.rate_basis_points as current_rate_bps,
         (select count(*)::integer from tax_policies old_policy
           where old_policy.world_id=$1 and old_policy.id=$2) as old_policy_count,
         (select upper(authority.effective_ticks)::text
            from tax_policy_authority_intervals authority
           where authority.world_id=$1 and authority.tax_policy_id=$2) as old_authority_end,
         (select count(*)::integer from governance_tax_policy_lineage lineage
           where lineage.world_id=$1 and lineage.previous_tax_policy_id=$2) as lineage_count,
         (select count(*)::integer
            from proposal_action_enactments effect
            join proposal_enactments enactment
              on enactment.world_id=effect.world_id
             and enactment.id=effect.proposal_enactment_id
           where enactment.world_id=$1 and enactment.proposal_id=$3
             and effect.effect_kind='tax_policy') as effect_count,
         (select result.outcome from proposal_results result
           where result.world_id=$1 and result.proposal_id=$3) as result_outcome
       from governance_tax_policy_lineage lineage
       join tax_policies current_policy
         on current_policy.world_id=lineage.world_id
        and current_policy.id=lineage.new_tax_policy_id
      where lineage.world_id=$1 and lineage.previous_tax_policy_id=$2`,
      [worldId, targets.tax_policy_id, taxProposal.id],
    );
    expect(taxEvidence.rows).toEqual([
      {
        current_rate_bps:
          targets.tax_policy_rate_bps === 333 ? targets.tax_policy_rate_bps + 1 : 333,
        current_version: Number(targets.tax_policy_version) + 1,
        effect_count: 1,
        lineage_count: 1,
        old_authority_end: '9',
        old_policy_count: 1,
        result_outcome: 'passed',
      },
    ]);

    const projectEvidence = await app.pool.query<{
      active_minor: string;
      authorized_minor: string;
      available_minor: string;
      budget_key: string;
      effect_count: number;
      fact_count: number;
      fact_total: string;
      project_count: number;
      purpose_code: string;
      spendable_minor: string;
    }>(
      `select
         count(distinct project_authorization.id)::integer as project_count,
         count(distinct effect.id)::integer as effect_count,
         count(distinct fact.id)::integer as fact_count,
         max(project_authorization.authorized_minor)::text as authorized_minor,
         max(project_authorization.purpose_code) as purpose_code,
         max(project_authorization.terms ->> 'budgetKey') as budget_key,
         max(projection.active_minor)::text as active_minor,
         sum(distinct fact.amount_minor)::text as fact_total,
         max(balance.available_minor)::text as available_minor,
         worldgraph_wallet_spendable_minor_v1($1,$3)::text as spendable_minor
       from public_project_authorizations project_authorization
       join proposal_actions action
         on action.world_id=project_authorization.world_id
        and action.id=project_authorization.proposal_action_id
       join treasury_encumbrances encumbrance
         on encumbrance.world_id=project_authorization.world_id
        and encumbrance.project_authorization_id=project_authorization.id
       join treasury_encumbrance_facts fact
         on fact.world_id=encumbrance.world_id and fact.encumbrance_id=encumbrance.id
       join treasury_encumbrance_projections projection
         on projection.world_id=encumbrance.world_id
        and projection.encumbrance_id=encumbrance.id
       join proposal_action_enactments effect
         on effect.world_id=action.world_id and effect.proposal_action_id=action.id
       join wallet_balances balance
         on balance.world_id=project_authorization.world_id
        and balance.wallet_id=project_authorization.treasury_wallet_id
      where project_authorization.world_id=$1 and action.proposal_id=$2`,
      [worldId, projectProposal.id, targets.treasury_wallet_id],
    );
    expect(projectEvidence.rows).toHaveLength(1);
    expect(projectEvidence.rows[0]).toMatchObject({
      active_minor: '250',
      authorized_minor: '250',
      available_minor: '1000',
      budget_key: 'budget:integration-harbor-repair',
      effect_count: 1,
      fact_count: 1,
      fact_total: '250',
      project_count: 1,
      spendable_minor: '750',
    });
    expect(projectEvidence.rows[0]!.purpose_code).toMatch(/^budget\.[a-f0-9]{64}$/u);

    const failedEvidence = await app.pool.query<{
      action_effects: number;
      encumbrances: number;
      enactment_failure_code: string;
      enactment_status: string;
      project_authorizations: number;
      result_outcome: string;
    }>(
      `select
         result.outcome as result_outcome,
         enactment.status as enactment_status,
         enactment.failure_code as enactment_failure_code,
         (select count(*)::integer from public_project_authorizations project_authorization
           join proposal_actions action
             on action.world_id=project_authorization.world_id
            and action.id=project_authorization.proposal_action_id
          where action.world_id=proposal.world_id and action.proposal_id=proposal.id)
           as project_authorizations,
         (select count(*)::integer from treasury_encumbrances encumbrance
           join public_project_authorizations project_authorization
             on project_authorization.world_id=encumbrance.world_id
            and project_authorization.id=encumbrance.project_authorization_id
           join proposal_actions action
             on action.world_id=project_authorization.world_id
            and action.id=project_authorization.proposal_action_id
          where action.world_id=proposal.world_id and action.proposal_id=proposal.id)
           as encumbrances,
         (select count(*)::integer from proposal_action_enactments effect
           join proposal_actions action
             on action.world_id=effect.world_id and action.id=effect.proposal_action_id
          where action.world_id=proposal.world_id and action.proposal_id=proposal.id)
           as action_effects
       from proposals proposal
       join proposal_results result
         on result.world_id=proposal.world_id and result.proposal_id=proposal.id
       join proposal_enactments enactment
         on enactment.world_id=proposal.world_id and enactment.proposal_id=proposal.id
      where proposal.world_id=$1 and proposal.id=$2`,
      [worldId, failedProposal.id],
    );
    expect(failedEvidence.rows).toEqual([
      {
        action_effects: 0,
        encumbrances: 0,
        enactment_failure_code: 'ENACTMENT_FAILED',
        enactment_status: 'failed',
        project_authorizations: 0,
        result_outcome: 'passed',
      },
    ]);

    await expectEconomyIntegrity(owner.pool);
    await expect(
      owner.pool.query(
        `select worldgraph_assert_economy_projection_current($1),
                worldgraph_assert_economy_expansion_projection_current($1)`,
        [worldId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  }, 120_000);
});

async function initializeGovernance(appPool: Pool, ownerPool: Pool): Promise<void> {
  const compiled = await ownerPool.query<{
    plan: GovernanceSeedPlanV1;
    plan_hash: string;
  }>(
    `select plan.canonical_plan as plan,encode(plan.plan_hash,'hex') as plan_hash
       from compiled_governance_seed_plans plan
      where plan.world_id=$1`,
    [worldId],
  );
  expect(compiled.rows).toHaveLength(1);
  const state = await runtimeState(ownerPool);
  const executor = new PostgresGovernanceCommandExecutor(appPool, {
    ids: ids(100_000),
    secretHashKey: 'governance-economy-secret-hash-key-32-characters',
  });
  const execution = await executor.executePublic({
    actor: { actorEntityId: null, actorId: creatorId, actorType: 'user' },
    authorization: {
      actionCode: 'governance.initialize',
      allowed: true,
      context: { membershipRoles: ['creator'] },
      reasonCode: 'POLICY_ALLOWED',
      resourceId: worldId,
      resourceType: 'world_governance',
      ruleId: 'governance.creator.initializer.v1',
    },
    causationId: null,
    command: {
      actorMode: 'creator',
      commandId: initializeCommandId,
      expectedAggregateVersion: '0',
      expectedStateRevision: state.state_revision,
      expectedTick: state.current_tick,
      expectedWorldVersion: state.design_version,
      idempotencyKey: 'governance-economic-initialize-0001',
      payload: {
        compiledWorldVersionId: state.active_world_version_id,
        seedPlanHash: compiled.rows[0]!.plan_hash,
      },
      schemaVersion: 1,
      type: 'InitializeWorldGovernanceV1',
    },
    correlationId: id(502),
    worldId,
  } as never);
  expect(execution.result.status).toBe('accepted');
}

async function initializeEconomyAndCommerce(
  commandBus: InstanceType<ApiCommandBusModule['WorldCommandBus']>,
  creator: WorldActor,
  pool: Pool,
  source: { next(): string },
): Promise<void> {
  const plan = await pool.query<{ plan_hash: string; world_version_id: string }>(
    `select encode(plan.plan_hash,'hex') as plan_hash,plan.world_version_id::text
       from compiled_economy_seed_plans plan
       join world_runtime_heads runtime
         on runtime.world_id=plan.world_id and runtime.active_world_version_id=plan.world_version_id
      where plan.world_id=$1 and plan.seed_plan_schema_version=2`,
    [worldId],
  );
  if (plan.rows.length !== 1) throw new Error('COMPILED_ECONOMY_PLAN_NOT_FOUND');

  let state = await baseRuntimeState(pool);
  let result = await commandBus.submit(
    apiActor(creator),
    worldId,
    {
      commandId: source.next(),
      expectedAggregateVersion: '0',
      expectedStateRevision: state.state_revision,
      expectedWorldVersion: state.design_version,
      idempotencyKey: `governance-economic-initialize-core-${source.next()}`,
      payload: {
        compiledWorldVersionId: plan.rows[0]!.world_version_id,
        seedPlanHash: plan.rows[0]!.plan_hash,
      },
      schemaVersion: 1,
      type: 'InitializeWorldEconomyV1',
    },
    source.next(),
    new Date(),
  );
  if (result.httpStatus !== 200 || result.result.status !== 'accepted') {
    throw new Error(`Economy initialization failed: ${JSON.stringify(result)}`);
  }

  state = await baseRuntimeState(pool);
  result = await commandBus.submit(
    apiActor(creator),
    worldId,
    {
      commandId: source.next(),
      expectedAggregateVersion: '0',
      expectedStateRevision: state.state_revision,
      expectedTick: state.current_tick,
      expectedWorldVersion: state.design_version,
      idempotencyKey: `governance-economic-initialize-commerce-${source.next()}`,
      payload: {
        compiledWorldVersionId: plan.rows[0]!.world_version_id,
        seedPlanHash: plan.rows[0]!.plan_hash,
      },
      schemaVersion: 1,
      type: 'InitializeWorldCommerceV1',
    },
    source.next(),
    new Date(),
  );
  if (result.httpStatus !== 200 || result.result.status !== 'accepted') {
    throw new Error(`Commerce initialization failed: ${JSON.stringify(result)}`);
  }
}

function governanceCommand(
  state: RuntimeState,
  type: GovernanceCommandRequestV1['type'],
  payload: Record<string, unknown>,
  expectedAggregateVersion: string,
  idempotencyKey: string,
  source: { next(): string },
  commandId = source.next(),
): GovernanceCommandRequestV1 {
  return {
    actorMode: 'in_world',
    commandId,
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
      ruleId: 'governance.integration.compiled_policy.v1',
    },
    causationId: null,
    command,
    correlationId: source.next(),
    worldId,
  };
}

async function executeAccepted(
  executor: PostgresGovernanceCommandExecutor,
  input: GovernanceCommandExecutionInput,
): Promise<void> {
  const execution = await executor.executePublic(input as never);
  expect(execution.replayed).toBe(false);
  if (execution.result.status !== 'accepted') {
    throw new Error(
      `Governance command ${input.command.type} was rejected: ${JSON.stringify(execution.result)}`,
    );
  }
}

async function fundTreasury(
  commandBus: InstanceType<ApiCommandBusModule['WorldCommandBus']>,
  actor: WorldActor,
  pool: Pool,
  targets: EconomyTargets,
  source: { next(): string },
): Promise<string> {
  const state = await runtimeState(pool);
  const commandId = source.next();
  const result = await commandBus.submit(
    apiActor(actor),
    worldId,
    {
      commandId,
      expectedAggregateVersion: state.economy_version,
      expectedStateRevision: state.state_revision,
      expectedWorldVersion: state.design_version,
      idempotencyKey: `governance-economic-fund-${source.next()}`,
      payload: {
        amount: '10.00',
        destinationWalletId: targets.treasury_wallet_id,
        expectedDestinationVersion: targets.treasury_wallet_version,
        expectedSourceVersion: targets.creator_wallet_version,
        memo: 'Fund deterministic governance public-project integration evidence.',
        sourceWalletId: targets.creator_wallet_id,
      },
      schemaVersion: 1,
      type: 'TransferCurrencyV1',
    },
    source.next(),
    new Date(),
  );
  if (result.httpStatus !== 200 || result.result.status !== 'accepted') {
    throw new Error(`Treasury funding failed: ${JSON.stringify(result)}`);
  }
  return commandId;
}

async function advanceSimulation(
  commandBus: InstanceType<ApiCommandBusModule['WorldCommandBus']>,
  actor: ApiActor,
  pool: Pool,
  targetTick: bigint,
  source: { next(): string },
): Promise<void> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
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
    const ticks = Number(
      targetTick - currentTick > BigInt(row.max_batch_ticks)
        ? BigInt(row.max_batch_ticks)
        : targetTick - currentTick,
    );
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
        idempotencyKey: `governance-economic-advance-${row.current_tick}-${ticks}`,
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

async function runGovernanceUntilIdle(
  runner: GovernanceScheduleRunner,
): Promise<Awaited<ReturnType<GovernanceScheduleRunner['reconcile']>>> {
  const applied: Awaited<ReturnType<GovernanceScheduleRunner['reconcile']>> = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const results = await runner.reconcile();
    if (results.length === 0) return applied;
    applied.push(...results);
    if (results.some((result) => result.outcome !== 'accepted')) return applied;
  }
  throw new Error('GOVERNANCE_SCHEDULE_DID_NOT_REACH_IDLE');
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
      displayName: actor.role === 'creator' ? 'Governance Creator' : 'Governance Player',
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
  start = 600_000,
): Promise<InstanceType<ApiCommandBusModule['WorldCommandBus']>> {
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
    new repositoryModule.PostgresCommandRepository(pool, ids(start)),
    ids(start + 10_000),
  );
}

async function proposalByCommand(pool: Pool, commandId: string): Promise<ProposalRecord> {
  const result = await pool.query<ProposalRecord>(
    `select proposal.id::text,proposal.aggregate_version::text,proposal.status,
            contest.contest_id::text
       from proposals proposal
       join proposal_contests contest
         on contest.world_id=proposal.world_id and contest.proposal_id=proposal.id
      where proposal.world_id=$1 and proposal.created_command_id=$2`,
    [worldId, commandId],
  );
  if (result.rows.length !== 1) throw new Error('PROPOSAL_NOT_FOUND');
  return result.rows[0]!;
}

async function eligibilitySnapshot(
  pool: Pool,
  contestId: string,
): Promise<{ eligible_count: number; id: string; member_count: number }> {
  const result = await pool.query<{
    eligible_count: number;
    id: string;
    member_count: number;
  }>(
    `select snapshot.id::text,snapshot.eligible_count,
            (select count(*)::integer from eligibility_snapshot_members member
              where member.world_id=snapshot.world_id and member.snapshot_id=snapshot.id)
              as member_count
       from eligibility_snapshots snapshot
      where snapshot.world_id=$1 and snapshot.contest_id=$2`,
    [worldId, contestId],
  );
  if (result.rows.length !== 1) throw new Error('ELIGIBILITY_SNAPSHOT_NOT_FOUND');
  return result.rows[0]!;
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
        and controller.control_scope='primary'
        and controller.revoked_at is null
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
): Promise<{ institutionId: string; jurisdictionKey: string }> {
  const result = await pool.query<{
    institution_id: string;
    jurisdiction_key: string;
  }>(
    `select institution.id::text as institution_id,
            jurisdiction.logical_key::text as jurisdiction_key
       from world_entity_controllers controller
       join institutions institution on institution.world_id=controller.world_id
       join world_entities jurisdiction
         on jurisdiction.world_id=institution.world_id
        and jurisdiction.id=institution.jurisdiction_entity_id
      where controller.world_id=$1 and controller.user_id=$2
        and controller.revoked_at is null
      order by institution.stable_key
      limit 1`,
    [worldId, userId],
  );
  if (result.rows.length !== 1) throw new Error('PROPOSAL_INSTITUTION_NOT_FOUND');
  return {
    institutionId: result.rows[0]!.institution_id,
    jurisdictionKey: result.rows[0]!.jurisdiction_key,
  };
}

async function economyTargets(pool: Pool): Promise<EconomyTargets> {
  const result = await pool.query<EconomyTargets>(
    `select policy.id::text as tax_policy_id,
            policy.policy_version::text as tax_policy_version,
            policy.rate_basis_points as tax_policy_rate_bps,
            treasury.id::text as treasury_wallet_id,
            treasury.currency_id::text as currency_id,
            treasury_balance.available_minor::text as treasury_balance_minor,
            treasury_balance.row_version::text as treasury_wallet_version,
            creator_wallet.id::text as creator_wallet_id,
            creator_balance.available_minor::text as creator_balance_minor,
            creator_balance.row_version::text as creator_wallet_version,
            project.logical_key::text as project_key
       from tax_policies policy
       join wallets treasury
         on treasury.world_id=policy.world_id
        and treasury.id=policy.treasury_wallet_id
        and treasury.wallet_kind='treasury'
       join wallet_balances treasury_balance
         on treasury_balance.world_id=treasury.world_id
        and treasury_balance.wallet_id=treasury.id
       join world_entity_controllers controller
         on controller.world_id=policy.world_id
        and controller.user_id=$2 and controller.revoked_at is null
       join wallets creator_wallet
         on creator_wallet.world_id=controller.world_id
        and creator_wallet.owner_entity_id=controller.entity_id
        and creator_wallet.currency_id=treasury.currency_id
       join wallet_balances creator_balance
         on creator_balance.world_id=creator_wallet.world_id
        and creator_balance.wallet_id=creator_wallet.id
       join world_entities project
         on project.world_id=policy.world_id
        and project.logical_key='district:civic-platform'
      where policy.world_id=$1 and policy.tax_type='sales' and policy.status='active'
      order by policy.policy_version desc
      limit 1`,
    [worldId, creatorId],
  );
  if (result.rows.length !== 1) throw new Error('ECONOMY_TARGETS_NOT_FOUND');
  return result.rows[0]!;
}

async function expectEconomyIntegrity(pool: Pool): Promise<void> {
  const result = await pool.query<{
    core_matched: boolean;
    core_mismatch_count: number;
    inventory_matched: boolean;
    reservation_matched: boolean;
  }>(
    `select
       (core.value ->> 'matched')::boolean as core_matched,
       (core.value ->> 'mismatchCount')::integer as core_mismatch_count,
       worldgraph_economy_inventory_live_document($1)
         = worldgraph_economy_inventory_rebuilt_document($1) as inventory_matched,
       worldgraph_economy_reservation_live_document($1)
         = worldgraph_economy_reservation_rebuilt_document($1) as reservation_matched
     from (select worldgraph_economy_reconciliation_snapshot($1) value) core`,
    [worldId],
  );
  expect(result.rows).toEqual([
    {
      core_matched: true,
      core_mismatch_count: 0,
      inventory_matched: true,
      reservation_matched: true,
    },
  ]);
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
       ($1,'governance-economy-creator@example.test',$4,'Governance Economy Creator'),
       ($2,'governance-economy-player-a@example.test',$4,'Governance Economy Player A'),
       ($3,'governance-economy-player-b@example.test',$4,'Governance Economy Player B')`,
      [creatorId, playerAId, playerBId, passwordHash],
    );
    await client.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'governance-economic-enactment','Governance Economic Enactment',$2)`,
      [worldId, creatorId],
    );
    await client.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'creator',$2),($1,$3,'player',$2),($1,$4,'player',$2)`,
      [worldId, creatorId, playerAId, playerBId],
    );
    await client.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,manifest_schema_version,canonical_manifest,
         content_hash,source,created_by_user_id
       ) values ($1,$2,1,1,$3,decode($4,'hex'),'manual',$5)`,
      [
        revisionId,
        worldId,
        JSON.stringify(fallback.envelope.manifest),
        fallback.contentHash,
        creatorId,
      ],
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
        '1.3.0',
        seed,
        creatorId,
        'governance-economic-compilation-0001',
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

async function runtimeState(pool: Pool): Promise<RuntimeState> {
  const result = await pool.query<RuntimeState>(
    `select runtime.active_world_version_id,
            runtime.state_revision::text,
            version.version_number::text as design_version,
            clock.current_tick::text,
            economy.row_version::text as economy_version
       from world_runtime_heads runtime
       join world_versions version
         on version.world_id=runtime.world_id and version.id=runtime.active_world_version_id
       join world_simulation_clocks clock on clock.world_id=runtime.world_id
       join world_economy_heads economy on economy.world_id=runtime.world_id
      where runtime.world_id=$1`,
    [worldId],
  );
  if (result.rows.length !== 1) throw new Error('RUNTIME_STATE_NOT_FOUND');
  return result.rows[0]!;
}

async function baseRuntimeState(pool: Pool): Promise<Omit<RuntimeState, 'economy_version'>> {
  const result = await pool.query<Omit<RuntimeState, 'economy_version'>>(
    `select runtime.active_world_version_id,
            runtime.state_revision::text,
            version.version_number::text as design_version,
            clock.current_tick::text
       from world_runtime_heads runtime
       join world_versions version
         on version.world_id=runtime.world_id and version.id=runtime.active_world_version_id
       join world_simulation_clocks clock on clock.world_id=runtime.world_id
      where runtime.world_id=$1`,
    [worldId],
  );
  if (result.rows.length !== 1) throw new Error('BASE_RUNTIME_STATE_NOT_FOUND');
  return result.rows[0]!;
}
