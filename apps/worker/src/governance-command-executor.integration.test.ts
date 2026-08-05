import { createHash } from 'node:crypto';
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
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  COMPILER_VERSION,
  canonicalJson,
  type GovernanceCommandRequestV1,
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
  governanceTwoPersonApprovalBindingHashV1,
  type GovernanceCommandExecutionInput,
  type GovernanceRecentCredentialProof,
  type GovernanceTwoPersonCommand,
} from '@worldgraph/governance-command';
import {
  createDeterministicGovernedHarborCityFallback,
  governedHarborCityManifestCatalog,
} from '@worldgraph/manifests';
import { createLogger } from '@worldgraph/observability';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresGovernanceScheduleRepository } from './governance-schedule-repository.js';
import { GovernanceScheduleRunner } from './governance-schedule-worker.js';
import { PostgresGovernanceRestrictedTallyRepository } from './governance-tally-repository.js';
import { governanceBackupRestoreEvidence } from './governance-backup-restore.integration-support.js';
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
const playerId = id(2);
const thirdPlayerId = id(3);
const nonmemberId = id(4);
const worldId = id(101);
const revisionId = id(201);
const compilationRunId = id(301);
const validationReportId = id(401);
const initializeCommandId = id(501);
const initializeCorrelationId = id(502);
const createProposalCommandId = id(503);
const createProposalCorrelationId = id(504);
const creatorSessionId = id(911);
const playerSessionId = id(912);
const thirdPlayerSessionId = id(913);
const nonmemberSessionId = id(914);
const legacyUserId = id(9_001);
const legacyWorldId = id(9_002);
const reauthenticationPassword = 'WorldGraph integration password';
const authPepper = 'worldgraph-integration-auth-pepper-32-characters';
const seed = 'governance-command-postgres-integration-seed';
const fallback = createDeterministicGovernedHarborCityFallback({
  catalog: governedHarborCityManifestCatalog(),
  prompt:
    'A governed harbor city with guild workshops, public taxation, civic proposals, and elections.',
  seed,
});
const pinnedPrimitiveVersionIds = new Set(
  fallback.envelope.manifest.primitiveRefs.map((entry) => entry.primitiveVersionId),
);
const logger = createLogger({
  buildRevision: 'test',
  environment: 'test',
  level: 'fatal',
  service: 'governance-command-postgres-integration',
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
  last_event_sequence: string;
  last_ledger_sequence: string;
  next_event_sequence: string;
  next_ledger_sequence: string;
  state_revision: string;
}

interface PersistedEventRow {
  aggregate_id: string;
  aggregate_type: string;
  aggregate_version: string;
  event_ordinal: number;
  event_type: string;
  id: string;
  payload: Record<string, unknown>;
  recorded_at: Date;
  world_event_sequence: string;
}

interface PersistedScheduleRow {
  action_schema_version: number;
  action_type: string;
  created_at: Date;
  due_tick: string;
  id: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  priority: number;
  process_version: string;
  schedule_sequence: string;
  updated_at: Date;
}

interface BatchSnapshot {
  eventCount: number;
  historyCount: number;
  ledgerCount: number;
  outboxCount: number;
  scheduleCount: number;
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
    platformRole: 'platform_admin' | 'user';
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
    registry?: object,
    economyPolicy?: object,
    commercePolicy?: object,
    governanceGateway?: object,
  ) => {
    submit(
      actor: ApiActor,
      worldId: string,
      request: Record<string, unknown>,
      requestId: string,
      submittedAt: Date,
      recentCredential?: GovernanceRecentCredentialProof,
    ): Promise<ApiCommandSubmission>;
  };
}

interface ApiCommandRepositoryModule {
  PostgresCommandRepository: new (pool: Pool, ids: { next(): string }) => object;
  PostgresRepository: new (pool: Pool) => object;
}

interface ApiGovernanceGatewayModule {
  PostgresGovernanceCommandGateway: new (
    pool: Pool,
    options: {
      ids: { next(): string };
      policy: Record<string, unknown>;
      secretHashKey: string;
    },
  ) => {
    executePublic(input: unknown): Promise<unknown>;
    prepareAuthority(input: unknown): Promise<unknown>;
  };
}

interface ApiIdentityService {
  approveGovernanceOperation(
    actor: ApiActor,
    input: { command: Record<string, unknown>; password: string; worldId: string },
    requestId: string,
    idempotencyKey: string,
  ): Promise<{ approvalId: string; commandId: string; expiresAt: string }>;
  governanceRecentCredential(
    actor: ApiActor,
    proofToken: string | undefined,
    command: unknown,
  ): GovernanceRecentCredentialProof;
  reauthenticate(
    actor: ApiActor,
    input: { command: Record<string, unknown>; password: string; worldId: string },
    requestId: string,
  ): Promise<{ expiresAt: string; proofToken: string }>;
}

interface ApiIdentityServiceModule {
  IdentityService: new (
    repository: object,
    config: object,
    clock: { now(): Date },
    ids: { next(): string },
    passwordHasher: {
      hash(password: string): Promise<string>;
      verify(encodedHash: string, password: string): Promise<boolean>;
    },
    notifications: { publish(notification: unknown): Promise<void> },
  ) => ApiIdentityService;
}

interface ProposalRecord {
  aggregate_version: string;
  contest_id: string;
  id: string;
  status: string;
}

interface ElectionRecord {
  aggregate_version: string;
  contest_id: string;
  id: string;
  office_id: string;
  seat_id: string;
  status: string;
}

interface EconomyTargets {
  creator_wallet_id: string;
  creator_wallet_version: string;
  currency_id: string;
  project_key: string;
  treasury_balance_minor: string;
  treasury_wallet_id: string;
  treasury_wallet_version: string;
}

function id(value: number): string {
  return `068f0000-0000-7000-8000-${value.toString().padStart(12, '0')}`;
}

function safeError(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') return error === undefined ? null : { value: error };
  const candidate = error as Record<string, unknown>;
  return Object.fromEntries(
    ['code', 'constraint', 'detail', 'message', 'routine', 'schema', 'table', 'where']
      .filter((key) => typeof candidate[key] === 'string')
      .map((key) => [key, candidate[key]]),
  );
}

function ids(start = 100_000): { next(): string } {
  let next = start;
  return {
    next: () => `078f0000-0000-7000-8000-${String(next++).padStart(12, '0')}`,
  };
}

function applicationUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = 'worldgraph_app';
  url.password = 'worldgraph_app_local_only';
  return url.toString();
}

function decimalRange(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => (BigInt(first) + BigInt(index)).toString());
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

async function createExactM09MigrationRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worldgraph-governance-m09-origin-'));
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

async function seedPreM10Population(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into users(id,email,password_hash,display_name)
       values ($1,'pre-m10-lifecycle@example.test',$2,'Pre M10 Lifecycle Creator')`,
      [legacyUserId, passwordHash],
    );
    await client.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'pre-m10-lifecycle','Pre M10 Lifecycle',$2)`,
      [legacyWorldId, legacyUserId],
    );
    await client.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'creator',$2)`,
      [legacyWorldId, legacyUserId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expectPreservedPreM10Population(pool: Pool): Promise<void> {
  const result = await pool.query<{
    governance_rows: number;
    membership_count: number;
    user_count: number;
    world_count: number;
  }>(
    `select
       (select count(*)::integer from users where id=$1) as user_count,
       (select count(*)::integer from worlds where id=$2) as world_count,
       (select count(*)::integer from world_memberships
         where world_id=$2 and user_id=$1 and role='creator') as membership_count,
       (
         (select count(*) from world_governance_heads where world_id=$2) +
         (select count(*) from compiled_governance_seed_plans where world_id=$2) +
         (select count(*) from governing_charters where world_id=$2) +
         (select count(*) from institutions where world_id=$2) +
         (select count(*) from laws where world_id=$2) +
         (select count(*) from political_offices where world_id=$2) +
         (select count(*) from proposals where world_id=$2) +
         (select count(*) from elections where world_id=$2)
       )::integer as governance_rows`,
    [legacyUserId, legacyWorldId],
  );
  expect(result.rows).toEqual([
    { governance_rows: 0, membership_count: 1, user_count: 1, world_count: 1 },
  ]);
}

describe(`M10 governance command executor PostgreSQL lifecycle from ${databaseOrigin}`, () => {
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
    owner = createDatabaseClient(container.getConnectionUri(), 'governance-command-owner-test');
    if (databaseOrigin === 'upgrade') {
      m09MigrationRoot = await createExactM09MigrationRoot();
      await applyMigrations(owner, m09MigrationRoot);
      await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
        compiler: '1.2.0',
        compilerArtifactSchema: 3,
        contracts: 9,
        runtimeSchema: 9,
      });
      await seedPreM10Population(owner.pool);
    }
    await applyMigrations(owner, migrationRoot);
    await expect(readRuntimeVersions(owner.pool)).resolves.toMatchObject({
      compiler: COMPILER_VERSION,
      compilerArtifactSchema: COMPILED_ARTIFACT_SCHEMA_VERSION,
      contracts: 11,
      runtimeSchema: 11,
    });
    if (databaseOrigin === 'upgrade') await expectPreservedPreM10Population(owner.pool);
    await importStarterPrimitives(owner.pool);
    await seedApprovedCompilation(owner.pool);

    app = createDatabaseClient(
      applicationUrl(container.getConnectionUri()),
      'governance-command-app-test',
    );
    const tallyUrl = new URL(container.getConnectionUri());
    tallyUrl.username = 'worldgraph_governance_tally';
    tallyUrl.password = 'worldgraph_governance_tally_local_only';
    tally = createDatabaseClient(tallyUrl.toString(), 'governance-command-tally-test');
    const compilationRepository = new PostgresWorldCompilationRepository(app.pool);
    let activationError: unknown;
    const activate = compilationRepository.activate.bind(compilationRepository);
    compilationRepository.activate = async (...args: Parameters<typeof activate>) => {
      try {
        return await activate(...args);
      } catch (error) {
        activationError = error;
        throw error;
      }
    };
    const runner = new WorldCompilationRunner(
      compilationRepository,
      logger,
      { maxEntities: 2_000, maxRelationships: 8_000 },
      {
        // Persistence identities are part of this replay fixture's scheduled input.
        ids: ids(50_000),
        maximumRunsPerReconciliation: 1,
        metrics: noOpMetrics,
      },
    );
    const compilation = await runner.runOne();
    if (compilation.outcome !== 'succeeded') {
      const failure = await owner.pool.query<{
        diagnostics: unknown;
        stage: string;
        status: string;
      }>(`select status,stage,diagnostics from world_compilation_runs where id=$1`, [
        compilationRunId,
      ]);
      throw new Error(
        `GOVERNANCE_LIFECYCLE_COMPILATION_FAILED:${JSON.stringify({ activationError: safeError(activationError), compilation, failure: failure.rows[0] })}`,
      );
    }
    expect(compilation).toMatchObject({ outcome: 'succeeded' });
  }, 120_000);

  afterAll(async () => {
    await tally?.pool.end();
    await app?.pool.end();
    await owner?.pool.end();
    await container?.stop();
    if (m09MigrationRoot) await rm(m09MigrationRoot, { force: true, recursive: true });
  });

  it('commits initialization and proposal schedules as complete event batches and replays exactly', async () => {
    const compilerState = await owner.pool.query<{
      artifact_schema_version: number;
      compiler_version: string;
      plan: GovernanceSeedPlanV1;
      plan_hash: string;
      source_kind: string;
    }>(
      `select run.compiler_version,
              artifact.artifact_schema_version,
              plan.source_kind,
              plan.canonical_plan as plan,
              encode(plan.plan_hash,'hex') as plan_hash
         from worlds world
         join world_compilation_runs run on run.world_id=world.id and run.id=$2
         join world_versions version on version.compilation_run_id=run.id
         join compiled_world_artifacts artifact
           on artifact.compilation_run_id=run.id and artifact.artifact_kind='compiled_world'
         join compiled_governance_seed_plans plan
           on plan.world_id=world.id and plan.world_version_id=version.id
        where world.id=$1 and world.lifecycle='active'
          and world.active_world_version_id=version.id`,
      [worldId, compilationRunId],
    );
    expect(compilerState.rows[0]).toMatchObject({
      artifact_schema_version: COMPILED_ARTIFACT_SCHEMA_VERSION,
      compiler_version: COMPILER_VERSION,
      source_kind: 'compiler_1_3',
    });
    const compiled = compilerState.rows[0]!;
    const scheduleCount = compiled.plan.offices.reduce(
      (count, office) => count + office.seats * 3,
      0,
    );
    expect(scheduleCount).toBe(24);

    const executor = new PostgresGovernanceCommandExecutor(app.pool, {
      ids: ids(),
      secretHashKey: 'integration-governance-secret-hash-key-32-characters',
    });
    const beforeInitialize = await runtimeState(owner.pool);
    const initializeInput = input(
      {
        actorMode: 'creator',
        commandId: initializeCommandId,
        expectedAggregateVersion: '0',
        expectedStateRevision: beforeInitialize.state_revision,
        expectedTick: beforeInitialize.current_tick,
        expectedWorldVersion: beforeInitialize.design_version,
        idempotencyKey: 'governance-initialize-postgres-0001',
        payload: {
          compiledWorldVersionId: beforeInitialize.active_world_version_id,
          seedPlanHash: compiled.plan_hash,
        },
        schemaVersion: 1,
        type: 'InitializeWorldGovernanceV1',
      },
      initializeCorrelationId,
      {
        actionCode: 'governance.initialize',
        resourceId: worldId,
        resourceType: 'world_governance',
      },
    );

    const initialized = await executor.executePublic(initializeInput as never);
    expect(initialized.replayed).toBe(false);
    if (initialized.result.status !== 'accepted') {
      throw new Error(`Initialization was rejected: ${JSON.stringify(initialized.result)}`);
    }
    expect(initialized.result).toMatchObject({
      commandId: initializeCommandId,
      status: 'accepted',
    });
    expect(initialized.result.eventIds).toHaveLength(scheduleCount + 1);
    await expectCompleteBatch(
      owner.pool,
      initializeCommandId,
      beforeInitialize,
      initialized.result,
      scheduleCount,
    );

    const beforeReplay = await batchSnapshot(owner.pool, initializeCommandId);
    const runtimeBeforeReplay = await runtimeState(owner.pool);
    const replay = await executor.executePublic(initializeInput as never);
    expect(replay).toEqual({ replayed: true, result: initialized.result });
    await expect(batchSnapshot(owner.pool, initializeCommandId)).resolves.toEqual(beforeReplay);
    await expect(runtimeState(owner.pool)).resolves.toEqual(runtimeBeforeReplay);

    const proposalContext = await owner.pool.query<{
      actor_entity_id: string;
      institution_id: string;
      jurisdiction_key: string;
    }>(
      `select controller.entity_id::text as actor_entity_id,
              institution.id::text as institution_id,
              jurisdiction.logical_key as jurisdiction_key
         from world_entity_controllers controller
         join world_entities actor_entity
           on actor_entity.world_id=controller.world_id and actor_entity.id=controller.entity_id
         join institutions institution on institution.world_id=controller.world_id
         join world_entities jurisdiction
           on jurisdiction.world_id=institution.world_id
          and jurisdiction.id=institution.jurisdiction_entity_id
        where controller.world_id=$1 and controller.user_id=$2
          and controller.revoked_at is null
          and actor_entity.retired_world_version_id is null
        order by institution.stable_key
        limit 1`,
      [worldId, creatorId],
    );
    const proposalActor = proposalContext.rows[0]!;
    const beforeProposal = await runtimeState(owner.pool);
    const tick = BigInt(beforeProposal.current_tick);
    const proposalCommand: Extract<GovernanceCommandRequestV1, { type: 'CreateProposalV1' }> = {
      actorMode: 'in_world',
      commandId: createProposalCommandId,
      expectedAggregateVersion: '0',
      expectedStateRevision: beforeProposal.state_revision,
      expectedTick: beforeProposal.current_tick,
      expectedWorldVersion: beforeProposal.design_version,
      idempotencyKey: 'governance-create-proposal-postgres-0001',
      payload: {
        action: {
          actionSchemaVersion: 1,
          actionType: 'create_law',
          effectiveFromTick: (tick + 9n).toString(),
          effectiveUntilTick: null,
          lawKey: 'law:integration-harbor-safety',
          policy: { kind: 'membership_role', role: 'player' },
          summary: 'Establishes a deterministic integration-test harbor safety rule.',
          targetCharterVersion: '1',
          title: 'Integration Harbor Safety',
        },
        approvalThresholdBps: 5_001,
        ballotPolicy: {
          ballotMode: 'public',
          disclosure: 'choice_totals',
          replacementAllowed: true,
        },
        body: 'A proposal used to prove scheduled action event atomicity.',
        debateEndsAtTick: (tick + 4n).toString(),
        institutionId: proposalActor.institution_id,
        jurisdictionEntityKey: proposalActor.jurisdiction_key,
        minimumSponsors: 0,
        proposalKey: 'proposal:integration-harbor-safety',
        quorumBps: 5_000,
        sponsorshipEndsAtTick: (tick + 2n).toString(),
        targetCharterVersion: '1',
        title: 'Integration Harbor Safety Proposal',
        votingClosesAtTick: (tick + 9n).toString(),
        votingOpensAtTick: (tick + 4n).toString(),
      },
      schemaVersion: 1,
      type: 'CreateProposalV1',
    };
    const proposalInput: GovernanceCommandExecutionInput = {
      actor: {
        actorEntityId: proposalActor.actor_entity_id,
        actorId: creatorId,
        actorType: 'user',
      },
      authorization: {
        actionCode: 'governance.proposal.create',
        allowed: true,
        context: {
          membershipRoles: ['creator'],
          policyActionCode: 'governance.propose',
          policyResourceType: 'proposal',
        },
        reasonCode: 'POLICY_ALLOWED',
        resourceId: proposalActor.institution_id,
        resourceType: 'institution',
        ruleId: 'governance.compiled_policy.v1',
      },
      causationId: null,
      command: proposalCommand,
      correlationId: createProposalCorrelationId,
      worldId,
    };
    const proposal = await executor.executePublic(proposalInput as never);
    expect(proposal.replayed).toBe(false);
    expect(proposal.result.status).toBe('accepted');
    if (proposal.result.status !== 'accepted') throw new Error('Proposal was rejected.');
    expect(proposal.result.eventIds).toHaveLength(4);
    await expectCompleteBatch(
      owner.pool,
      createProposalCommandId,
      beforeProposal,
      proposal.result,
      3,
    );

    const actorRows = await app.pool.query<{
      entity_id: string;
      entity_key: string;
      role: WorldActor['role'];
      user_id: string;
    }>(
      `select membership.user_id::text, membership.role::text,
              controller.entity_id::text,
              entity.logical_key::text as entity_key
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
    const actors: WorldActor[] = actorRows.rows.map((row) => ({
      entityId: row.entity_id,
      entityKey: row.entity_key,
      role: row.role,
      userId: row.user_id,
    }));
    expect(actors.map((actor) => actor.userId)).toEqual([creatorId, playerId, thirdPlayerId]);
    expect(new Set(actors.map((actor) => actor.userId)).size).toBe(3);
    expect(new Set(actors.map((actor) => actor.entityId)).size).toBe(3);
    expect(new Set(actors.map((actor) => actor.entityKey)).size).toBe(3);

    const creator = actors[0]!;
    const voterA = actors[1]!;
    const voterB = actors[2]!;
    const lifecycleIds = ids(500_000);
    const restrictedTally = new PostgresGovernanceRestrictedTallyRepository(tally.pool);
    await restrictedTally.assertRestrictedRole();
    const scheduledExecutor = new PostgresGovernanceCommandExecutor(app.pool, {
      ids: ids(700_000),
      restrictedTallyExecutor: restrictedTally,
      secretHashKey: 'integration-governance-secret-hash-key-32-characters',
    });
    let latestScheduleError: unknown;
    const scheduledCommands = {
      executeInternal: async (input: Parameters<typeof scheduledExecutor.executeInternal>[0]) => {
        try {
          return await scheduledExecutor.executeInternal(input);
        } catch (error) {
          latestScheduleError = error;
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
    let latestGovernancePreparation: unknown;
    const commandBus = await createApiCommandBus(app.pool, {
      onPreparation: (_input, preparation) => {
        latestGovernancePreparation = preparation;
      },
    });
    const identityService = await createApiIdentityService(app.pool);
    expect(
      new Set([
        apiActor(creator).session.id,
        apiActor(voterA).session.id,
        apiActor(voterB).session.id,
        nonmemberApiActor().session.id,
      ]).size,
    ).toBe(4);
    await expect(
      owner.pool.query<{ count: number }>(
        `select count(*)::integer as count from sessions
          where id=any($1::uuid[]) and revoked_at is null
            and idle_expires_at>now() and absolute_expires_at>now()`,
        [[creatorSessionId, playerSessionId, thirdPlayerSessionId, nonmemberSessionId]],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 4 }] });
    await initializeEconomyAndCommerce(commandBus, apiActor(creator), app.pool, lifecycleIds);
    const economyBeforeFunding = await economyTargets(app.pool);
    expect(economyBeforeFunding.treasury_balance_minor).toBe('0');
    await fundTreasury(commandBus, apiActor(creator), app.pool, economyBeforeFunding, lifecycleIds);
    const economy = await economyTargets(app.pool);
    expect(BigInt(economy.treasury_balance_minor)).toBeGreaterThanOrEqual(1n);
    const publicProposal = await proposalByCommand(app.pool, createProposalCommandId);
    expect(publicProposal).toMatchObject({ aggregate_version: '1', status: 'debate' });

    await advanceSimulation(commandBus, apiActor(creator), app.pool, 4n, lifecycleIds);
    const publicOpen = await runGovernanceUntilIdle(scheduleRunner, app.pool);
    expect(publicOpen).toEqual([
      expect.objectContaining({ actionType: 'OpenProposalVotingV1', outcome: 'accepted' }),
    ]);
    const openedPublicProposal = await proposalByCommand(app.pool, createProposalCommandId);
    expect(openedPublicProposal).toMatchObject({ aggregate_version: '2', status: 'open' });
    const publicSnapshot = await eligibilitySnapshot(owner.pool, openedPublicProposal.contest_id);
    expect(publicSnapshot).toMatchObject({ eligible_count: 3, member_count: 3 });

    let firstPublicBallotInput: GovernanceCommandExecutionInput | undefined;
    let firstPublicBallotResult:
      Awaited<ReturnType<PostgresGovernanceCommandExecutor['executePublic']>> | undefined;
    for (const [index, ballot] of [
      { actor: creator, choice: 'yes' },
      { actor: voterA, choice: 'yes' },
      { actor: voterB, choice: 'no' },
    ].entries()) {
      const state = await runtimeState(app.pool);
      const command = governanceCommand(
        state,
        'in_world',
        'CastProposalBallotV1',
        {
          choice: ballot.choice,
          eligibilitySnapshotId: publicSnapshot.id,
          expectedProposalVersion: openedPublicProposal.aggregate_version,
          proposalId: openedPublicProposal.id,
          replaceExisting: false,
        },
        openedPublicProposal.aggregate_version,
        `governance-public-ballot-${index + 1}`,
        lifecycleIds,
      );
      const commandInput = actorCommandInput(
        ballot.actor,
        command,
        'governance.vote',
        'proposal',
        openedPublicProposal.id,
        lifecycleIds,
      );
      const cast = await executeAccepted(executor, commandInput);
      expect(cast.details).toMatchObject({ ballotMode: 'public', effectiveRevision: 1 });
      if (index === 0) {
        firstPublicBallotInput = commandInput;
        firstPublicBallotResult = cast;
      }
    }
    expect(firstPublicBallotInput).toBeDefined();
    expect(firstPublicBallotResult).toBeDefined();
    const publicReplay = await executor.executePublic(firstPublicBallotInput! as never);
    expect(publicReplay).toEqual({ replayed: true, result: firstPublicBallotResult!.result });

    const duplicatePublicState = await runtimeState(app.pool);
    const duplicatePublic = await executor.executePublic(
      actorCommandInput(
        creator,
        governanceCommand(
          duplicatePublicState,
          'in_world',
          'CastProposalBallotV1',
          {
            choice: 'no',
            eligibilitySnapshotId: publicSnapshot.id,
            expectedProposalVersion: openedPublicProposal.aggregate_version,
            proposalId: openedPublicProposal.id,
            replaceExisting: false,
          },
          openedPublicProposal.aggregate_version,
          'governance-public-ballot-duplicate-different-key',
          lifecycleIds,
        ),
        'governance.vote',
        'proposal',
        openedPublicProposal.id,
        lifecycleIds,
      ) as never,
    );
    expect(duplicatePublic.result).toMatchObject({
      rejectionCode: 'BALLOT_ALREADY_CAST',
      status: 'rejected',
    });
    await expect(publicChoiceSummary(owner.pool, openedPublicProposal.contest_id)).resolves.toEqual(
      [
        { choice: 'no', count: 1 },
        { choice: 'yes', count: 2 },
      ],
    );

    await advanceSimulation(commandBus, apiActor(creator), app.pool, 9n, lifecycleIds);
    const publicFinalization = await runGovernanceUntilIdle(scheduleRunner, app.pool);
    expect(publicFinalization.map((result) => result.actionType)).toEqual([
      'CloseAndTallyProposalV1',
      'CertifyAndEnactProposalV1',
    ]);
    expect(publicFinalization.every((result) => result.outcome === 'accepted')).toBe(true);
    const publicFinal = await proposalFinalSnapshot(app.pool, openedPublicProposal.id);
    expect(publicFinal).toEqual({
      action_enactments: 1,
      enactments: 1,
      laws: 1,
      outcome: 'passed',
      results: 1,
      status: 'enacted',
    });
    const publicEnactmentEvents = await expectDurableGovernanceEventBatch(
      owner.pool,
      await proposalCertificationCommandId(owner.pool, openedPublicProposal.id),
      ['GovernanceResultFinalizedV1', 'GovernanceLawVersionActivatedV1'],
      true,
    );
    expect(publicEnactmentEvents[1]).toMatchObject({
      aggregate_type: 'law_version',
      aggregate_version: '1',
      payload: {
        effectiveFromTick: '9',
        eventType: 'GovernanceLawVersionActivatedV1',
        lawVersion: '1',
        sourceProposalId: openedPublicProposal.id,
      },
    });
    await expect(scheduleRunner.reconcile()).resolves.toEqual([]);
    await expect(proposalFinalSnapshot(app.pool, openedPublicProposal.id)).resolves.toEqual(
      publicFinal,
    );

    const selectedElection = await selectedElectionRecord(app.pool);
    expect(selectedElection).toMatchObject({ aggregate_version: '1', status: 'nominations_open' });
    const candidateActors = [voterA, voterB];
    const candidacyIds: string[] = [];
    for (const [index, candidate] of candidateActors.entries()) {
      const nominationState = await runtimeState(app.pool);
      const nominationCommand = governanceCommand(
        nominationState,
        'in_world',
        'NominateCandidateV1',
        {
          candidateEntityKey: candidate.entityKey,
          electionId: selectedElection.id,
          expectedElectionVersion: selectedElection.aggregate_version,
          officeId: selectedElection.office_id,
          statement: `Candidate ${index + 1} integration statement.`,
        },
        selectedElection.aggregate_version,
        `governance-election-nominate-${index + 1}`,
        lifecycleIds,
      );
      const nomination = await executeAccepted(
        executor,
        actorCommandInput(
          creator,
          nominationCommand,
          'governance.nominate',
          'election',
          selectedElection.id,
          lifecycleIds,
        ),
      );
      expect(typeof nomination.details?.candidacyId).toBe('string');
      const candidacy = await app.pool.query<{ id: string }>(
        `select id::text from candidacies
          where world_id=$1 and nominated_command_id=$2`,
        [worldId, nominationCommand.commandId],
      );
      const candidacyId = candidacy.rows[0]!.id;
      candidacyIds.push(candidacyId);
      const acceptanceState = await runtimeState(app.pool);
      await executeAccepted(
        executor,
        actorCommandInput(
          candidate,
          governanceCommand(
            acceptanceState,
            'in_world',
            'AcceptNominationV1',
            {
              candidacyId,
              electionId: selectedElection.id,
              expectedCandidacyVersion: '1',
              expectedElectionVersion: selectedElection.aggregate_version,
            },
            '1',
            `governance-election-accept-${index + 1}`,
            lifecycleIds,
          ),
          'governance.nominate',
          'election',
          selectedElection.id,
          lifecycleIds,
        ),
      );
    }
    expect(new Set(candidacyIds).size).toBe(2);
    await expect(
      app.pool.query<{ count: number }>(
        `select count(*)::integer as count from candidacies
          where world_id=$1 and election_id=$2 and status='accepted'`,
        [worldId, selectedElection.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });

    const secretProposalState = await runtimeState(app.pool);
    const secretProposalCommand = governanceCommand(
      secretProposalState,
      'in_world',
      'CreateProposalV1',
      {
        action: {
          actionSchemaVersion: 1,
          actionType: 'create_law',
          effectiveFromTick: '18',
          effectiveUntilTick: null,
          lawKey: 'law:integration-secret-ballot',
          policy: { kind: 'membership_role', role: 'player' },
          summary: 'A law enacted from a fully tallied secret ballot.',
          targetCharterVersion: '1',
          title: 'Integration Secret Ballot Law',
        },
        approvalThresholdBps: 5_001,
        ballotPolicy: {
          ballotMode: 'public',
          disclosure: 'choice_totals',
          replacementAllowed: true,
        },
        body: 'Exercises a second charter-bound proposal tally path end to end.',
        debateEndsAtTick: '13',
        institutionId: proposalActor.institution_id,
        jurisdictionEntityKey: proposalActor.jurisdiction_key,
        minimumSponsors: 0,
        proposalKey: 'proposal:integration-secret-ballot',
        quorumBps: 5_000,
        sponsorshipEndsAtTick: '11',
        targetCharterVersion: '1',
        title: 'Integration Second Public Proposal',
        votingClosesAtTick: '18',
        votingOpensAtTick: '13',
      },
      '0',
      'governance-create-secret-proposal',
      lifecycleIds,
    );
    await executeAccepted(
      executor,
      actorCommandInput(
        creator,
        secretProposalCommand,
        'governance.proposal.create',
        'institution',
        proposalActor.institution_id,
        lifecycleIds,
      ),
    );
    const secretProposal = await proposalByCommand(app.pool, secretProposalCommand.commandId);
    expect(secretProposal).toMatchObject({ aggregate_version: '1', status: 'debate' });

    await advanceSimulation(commandBus, apiActor(creator), app.pool, 13n, lifecycleIds);
    const votingOpens = await runGovernanceUntilIdle(scheduleRunner, app.pool);
    expect(votingOpens).toHaveLength(9);
    expect(votingOpens.every((result) => result.outcome === 'accepted')).toBe(true);
    expect(
      votingOpens.filter((result) => result.actionType === 'OpenProposalVotingV1'),
    ).toHaveLength(1);
    expect(votingOpens.filter((result) => result.actionType === 'OpenElectionV1')).toHaveLength(8);
    const openedSecretProposal = await proposalByCommand(app.pool, secretProposalCommand.commandId);
    expect(openedSecretProposal).toMatchObject({ aggregate_version: '2', status: 'open' });
    const openedElection = await electionRecord(app.pool, selectedElection.id);
    expect(openedElection).toMatchObject({ aggregate_version: '2', status: 'open' });
    const cancelledElections = await app.pool.query<{ count: number }>(
      `select count(*)::integer as count from elections
        where world_id=$1 and status='cancelled'`,
      [worldId],
    );
    expect(cancelledElections.rows[0]?.count).toBe(7);
    const secretProposalSnapshot = await eligibilitySnapshot(
      owner.pool,
      openedSecretProposal.contest_id,
    );
    const electionSnapshot = await eligibilitySnapshot(owner.pool, openedElection.contest_id);
    expect(secretProposalSnapshot).toMatchObject({ eligible_count: 3, member_count: 3 });
    expect(electionSnapshot).toMatchObject({ eligible_count: 3, member_count: 3 });

    const secretBallotCommandIds: string[] = [];
    let firstSecretBallotInput: GovernanceCommandExecutionInput | undefined;
    let firstSecretBallotResult:
      Awaited<ReturnType<PostgresGovernanceCommandExecutor['executePublic']>> | undefined;
    for (const [index, ballot] of [
      { actor: creator, choice: 'yes' },
      { actor: voterA, choice: 'yes' },
      { actor: voterB, choice: 'abstain' },
    ].entries()) {
      const state = await runtimeState(app.pool);
      const command = governanceCommand(
        state,
        'in_world',
        'CastProposalBallotV1',
        {
          choice: ballot.choice,
          eligibilitySnapshotId: secretProposalSnapshot.id,
          expectedProposalVersion: openedSecretProposal.aggregate_version,
          proposalId: openedSecretProposal.id,
          replaceExisting: false,
        },
        openedSecretProposal.aggregate_version,
        `governance-secret-proposal-ballot-${index + 1}`,
        lifecycleIds,
      );
      const commandInput = actorCommandInput(
        ballot.actor,
        command,
        'governance.vote',
        'proposal',
        openedSecretProposal.id,
        lifecycleIds,
      );
      const cast = await executeAccepted(executor, commandInput);
      expect(cast.details).toMatchObject({ ballotMode: 'public', effectiveRevision: 1 });
      if (index === 0) {
        firstSecretBallotInput = commandInput;
        firstSecretBallotResult = cast;
      }
    }
    const secretReplay = await executor.executePublic(firstSecretBallotInput! as never);
    expect(secretReplay).toEqual({ replayed: true, result: firstSecretBallotResult!.result });
    const duplicateSecretState = await runtimeState(app.pool);
    const duplicateSecret = await executor.executePublic(
      actorCommandInput(
        creator,
        governanceCommand(
          duplicateSecretState,
          'in_world',
          'CastProposalBallotV1',
          {
            choice: 'no',
            eligibilitySnapshotId: secretProposalSnapshot.id,
            expectedProposalVersion: openedSecretProposal.aggregate_version,
            proposalId: openedSecretProposal.id,
            replaceExisting: false,
          },
          openedSecretProposal.aggregate_version,
          'governance-secret-ballot-duplicate-different-key',
          lifecycleIds,
        ),
        'governance.vote',
        'proposal',
        openedSecretProposal.id,
        lifecycleIds,
      ) as never,
    );
    expect(duplicateSecret.result).toMatchObject({
      rejectionCode: 'BALLOT_ALREADY_CAST',
      status: 'rejected',
    });

    for (const [index, ballot] of [
      { actor: creator, candidateKey: voterA.entityKey },
      { actor: voterA, candidateKey: voterA.entityKey },
      { actor: voterB, candidateKey: voterB.entityKey },
    ].entries()) {
      const state = await runtimeState(app.pool);
      const command = governanceCommand(
        state,
        'in_world',
        'CastElectionBallotV1',
        {
          choice: { candidateKey: ballot.candidateKey, choiceType: 'candidate' },
          electionId: openedElection.id,
          eligibilitySnapshotId: electionSnapshot.id,
          expectedElectionVersion: openedElection.aggregate_version,
          replaceExisting: false,
        },
        openedElection.aggregate_version,
        `governance-secret-election-ballot-${index + 1}`,
        lifecycleIds,
      );
      secretBallotCommandIds.push(command.commandId);
      const cast = await executeAccepted(
        executor,
        actorCommandInput(
          ballot.actor,
          command,
          'governance.vote',
          'election',
          openedElection.id,
          lifecycleIds,
        ),
      );
      expect(cast.details).toMatchObject({ ballotMode: 'secret', effectiveRevision: 1 });
    }
    const secretChoiceCounts = await owner.pool.query<{
      contest_id: string;
      count: number;
    }>(
      `select contest_id::text,count(*)::integer as count
         from secret_ballot_choices
        where world_id=$1 and contest_id=any($2::uuid[])
        group by contest_id order by contest_id`,
      [worldId, [openedSecretProposal.contest_id, openedElection.contest_id]],
    );
    expect(secretChoiceCounts.rows).toEqual([{ contest_id: openedElection.contest_id, count: 3 }]);
    await expect(
      app.pool.query('select * from secret_ballot_choices limit 1'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.pool.query('select * from ballot_choice_revisions limit 1'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.pool.query('select * from ballot_effective_revisions limit 1'),
    ).rejects.toMatchObject({ code: '42501' });
    const secretPublicSurfaces = await app.pool.query<{
      command_payload: Record<string, unknown>;
      event_payload: Record<string, unknown>;
    }>(
      `select command.payload as command_payload,event.payload as event_payload
         from command_records command
         join domain_events event
           on event.world_id=command.world_id and event.command_id=command.id
        where command.world_id=$1 and command.id=any($2::uuid[])
        order by command.id,event.event_ordinal`,
      [worldId, secretBallotCommandIds],
    );
    expect(secretPublicSurfaces.rows).toHaveLength(3);
    expect(JSON.stringify(secretPublicSurfaces.rows)).not.toMatch(
      /"(?:choice|candidateKey|voterEntityId|voterEntityKey)"/u,
    );

    await advanceSimulation(commandBus, apiActor(creator), app.pool, 18n, lifecycleIds);
    const secretFinalization = await runGovernanceUntilIdle(scheduleRunner, app.pool);
    expect(secretFinalization.map((result) => result.actionType)).toEqual([
      'CloseAndTallyProposalV1',
      'CertifyAndEnactProposalV1',
    ]);
    expect(secretFinalization.every((result) => result.outcome === 'accepted')).toBe(true);
    const secretFinal = await proposalFinalSnapshot(app.pool, openedSecretProposal.id);
    expect(secretFinal).toEqual({
      action_enactments: 1,
      enactments: 1,
      laws: 1,
      outcome: 'passed',
      results: 1,
      status: 'enacted',
    });
    const secretEnactmentEvents = await expectDurableGovernanceEventBatch(
      owner.pool,
      await proposalCertificationCommandId(owner.pool, openedSecretProposal.id),
      ['GovernanceResultFinalizedV1', 'GovernanceLawVersionActivatedV1'],
      true,
    );
    expect(secretEnactmentEvents[1]).toMatchObject({
      aggregate_type: 'law_version',
      aggregate_version: '1',
      payload: {
        effectiveFromTick: '18',
        eventType: 'GovernanceLawVersionActivatedV1',
        lawVersion: '1',
        sourceProposalId: openedSecretProposal.id,
      },
    });
    await expect(scheduleRunner.reconcile()).resolves.toEqual([]);
    await expect(proposalFinalSnapshot(app.pool, openedSecretProposal.id)).resolves.toEqual(
      secretFinal,
    );

    const priorOffice = await officeSeatContext(
      app.pool,
      openedElection.office_id,
      openedElection.seat_id,
    );
    const priorAppointmentState = await runtimeState(app.pool);
    const priorAppointmentCommand = gatewayGovernanceCommand(
      priorAppointmentState,
      'ExecuteCreatorOverrideV1',
      {
        approvalId: null,
        confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
        effect: {
          appointment: {
            expectedOfficeVersion: priorOffice.office_version,
            holderEntityKey: voterB.entityKey,
            officeId: openedElection.office_id,
            reason: 'Install a deterministic incumbent before the certified election transition.',
            seatIndex: priorOffice.seat_index,
            termEndsAtTick: '63',
            termStartsAtTick: priorAppointmentState.current_tick,
          },
          effectType: 'appoint_officeholder',
        },
        impact: 'Creates one explicit temporary incumbent that the certified election supersedes.',
        reason:
          'Prove election transition behavior without granting appointment power to citizens.',
      },
      '0',
      'governance-gateway-prior-officeholder-override-0001',
      lifecycleIds,
    );
    const priorAppointmentCredential = await issueRecentCredential(
      identityService,
      apiActor(creator),
      priorAppointmentCommand,
      lifecycleIds,
    );
    try {
      await submitGatewayAccepted(
        commandBus,
        apiActor(creator),
        priorAppointmentCommand,
        lifecycleIds,
        priorAppointmentCredential,
      );
    } catch (error) {
      const membership = await owner.pool.query(
        `select role::text,status::text,row_version::text,user_id::text,world_id::text
           from world_memberships where world_id=$1 and user_id=$2`,
        [worldId, creator.userId],
      );
      throw new Error(
        `PRIOR_APPOINTMENT_OVERRIDE_FAILED:${JSON.stringify({ error: safeError(error), latestGovernancePreparation, membership: membership.rows })}`,
        { cause: error },
      );
    }
    const priorTermId = await officeTermByCommand(
      owner.pool,
      String(priorAppointmentCommand['commandId']),
    );
    expect(priorTermId).toMatch(/^[0-9a-f-]{36}$/u);
    const priorAppointmentEvents = await expectDurableGovernanceEventBatch(
      owner.pool,
      String(priorAppointmentCommand['commandId']),
      ['GovernanceOverrideExecutedV1', 'GovernanceOfficeTermChangedV1'],
      false,
    );
    expect(priorAppointmentEvents).toEqual([
      expect.objectContaining({
        aggregate_type: 'governance_override',
        aggregate_version: '1',
      }),
      expect.objectContaining({
        aggregate_id: priorTermId,
        aggregate_type: 'office_term',
        aggregate_version: '1',
        payload: {
          eventType: 'GovernanceOfficeTermChangedV1',
          officeId: openedElection.office_id,
          seatIndex: priorOffice.seat_index,
          status: 'active',
          termId: priorTermId,
        },
      }),
    ]);

    await advanceSimulation(commandBus, apiActor(creator), app.pool, 24n, lifecycleIds);
    let electionFinalization: Awaited<ReturnType<GovernanceScheduleRunner['reconcile']>>;
    try {
      electionFinalization = await runGovernanceUntilIdle(scheduleRunner, app.pool);
    } catch (error) {
      throw new Error(
        `ELECTION_FINALIZATION_FAILED:${JSON.stringify({ scheduleError: safeError(latestScheduleError) })}`,
        { cause: error },
      );
    }
    expect(electionFinalization.map((result) => result.actionType)).toEqual([
      'CloseAndTallyElectionV1',
      'CertifyElectionV1',
    ]);
    expect(electionFinalization.every((result) => result.outcome === 'accepted')).toBe(true);
    const electionFinal = await electionFinalSnapshot(app.pool, openedElection.id);
    expect(electionFinal).toEqual({
      authority_intervals: 1,
      holder_entity_id: voterA.entityId,
      outcome: 'elected',
      results: 1,
      starts_tick: '24',
      status: 'certified',
      terms: 1,
    });
    const electionCertificationEvents = await expectDurableGovernanceEventBatch(
      owner.pool,
      await electionCertificationCommandId(owner.pool, openedElection.id),
      [
        'GovernanceResultFinalizedV1',
        'GovernanceOfficeTermChangedV1',
        'GovernanceOfficeTermChangedV1',
        'ScheduledActionCreatedV1',
        'ScheduledActionCreatedV1',
        'ScheduledActionCreatedV1',
      ],
      true,
    );
    const electedTermId = await electionTermId(owner.pool, openedElection.id);
    expect(
      electionCertificationEvents.slice(1, 3).map((event) => ({
        aggregateId: event.aggregate_id,
        aggregateVersion: event.aggregate_version,
        payload: event.payload,
      })),
    ).toEqual([
      {
        aggregateId: priorTermId,
        aggregateVersion: '2',
        payload: {
          eventType: 'GovernanceOfficeTermChangedV1',
          officeId: openedElection.office_id,
          seatIndex: priorOffice.seat_index,
          status: 'ended',
          termId: priorTermId,
        },
      },
      {
        aggregateId: electedTermId,
        aggregateVersion: '1',
        payload: {
          eventType: 'GovernanceOfficeTermChangedV1',
          officeId: openedElection.office_id,
          seatIndex: priorOffice.seat_index,
          status: 'active',
          termId: electedTermId,
        },
      },
    ]);
    await expect(scheduleRunner.reconcile()).resolves.toEqual([]);
    await expect(electionFinalSnapshot(app.pool, openedElection.id)).resolves.toEqual(
      electionFinal,
    );
    await expect(seatTermTransitionSnapshot(owner.pool, openedElection.seat_id)).resolves.toEqual([
      {
        authority_from_tick: '18',
        authority_until_tick: '24',
        holder_entity_id: voterB.entityId,
        latest_reason_code: 'OFFICE_TERM_SUPERSEDED',
        latest_status: 'ended',
        latest_transition_tick: '24',
        planned_ends_tick: '63',
        source_kind: 'appointment',
        starts_tick: '18',
        term_id: priorTermId,
      },
      {
        authority_from_tick: '24',
        authority_until_tick: '72',
        holder_entity_id: voterA.entityId,
        latest_reason_code: 'OFFICE_TERM_CREATED',
        latest_status: 'active',
        latest_transition_tick: '24',
        planned_ends_tick: '72',
        source_kind: 'election',
        starts_tick: '24',
        term_id: electedTermId,
      },
    ]);
    await expect(activeSeatAuthorityAt(owner.pool, openedElection.seat_id, '23')).resolves.toEqual([
      { holder_entity_id: voterB.entityId },
    ]);
    await expect(activeSeatAuthorityAt(owner.pool, openedElection.seat_id, '24')).resolves.toEqual([
      { holder_entity_id: voterA.entityId },
    ]);
    await expect(activeSeatAuthorityAt(owner.pool, openedElection.seat_id, '72')).resolves.toEqual(
      [],
    );

    const vacantSeat = await vacantOfficeSeatContext(
      owner.pool,
      openedElection.office_id,
      openedElection.seat_id,
    );
    const deniedAppointmentState = await runtimeState(app.pool);
    const deniedAppointmentCommand = gatewayGovernanceCommand(
      deniedAppointmentState,
      'AppointOfficeholderV1',
      {
        expectedOfficeVersion: vacantSeat.office_version,
        holderEntityKey: voterB.entityKey,
        officeId: openedElection.office_id,
        reason: 'This ordinary citizen must not possess appointment authority.',
        seatIndex: vacantSeat.seat_index,
        termEndsAtTick: '72',
        termStartsAtTick: deniedAppointmentState.current_tick,
      },
      vacantSeat.office_version,
      'governance-gateway-citizen-appointment-denied-0001',
      lifecycleIds,
    );
    const deniedAppointment = await commandBus.submit(
      apiActor(voterB),
      worldId,
      deniedAppointmentCommand,
      lifecycleIds.next(),
      new Date(),
    );
    expect(deniedAppointment).toMatchObject({
      httpStatus: 403,
      result: { rejectionCode: 'AUTHORIZATION_DENIED', status: 'rejected' },
    });

    const authorizedAppointmentState = await runtimeState(app.pool);
    const authorizedAppointmentCommand = gatewayGovernanceCommand(
      authorizedAppointmentState,
      'AppointOfficeholderV1',
      {
        expectedOfficeVersion: vacantSeat.office_version,
        holderEntityKey: voterB.entityKey,
        officeId: openedElection.office_id,
        reason: 'A certified councillor fills one bounded vacant council seat.',
        seatIndex: vacantSeat.seat_index,
        termEndsAtTick: '72',
        termStartsAtTick: authorizedAppointmentState.current_tick,
      },
      vacantSeat.office_version,
      'governance-gateway-officeholder-appointment-allowed-0001',
      lifecycleIds,
    );
    try {
      await submitGatewayAccepted(
        commandBus,
        apiActor(voterA),
        authorizedAppointmentCommand,
        lifecycleIds,
      );
    } catch (error) {
      throw new Error(
        `OFFICEHOLDER_APPOINTMENT_FAILED:${JSON.stringify({ latestGovernancePreparation })}`,
        { cause: error },
      );
    }
    await expect(lifecycleCounts(owner.pool)).resolves.toEqual({
      accepted_candidacies: 2,
      active_members: 3,
      ballot_participation: 9,
      ballot_receipts: 9,
      cancelled_elections: 7,
      certified_elections: 1,
      completed_schedules: 30,
      election_results: 1,
      elections: 16,
      eligibility_snapshot_members: 9,
      eligibility_snapshots: 3,
      office_authority_intervals: 3,
      office_terms: 3,
      primary_controllers: 3,
      proposal_action_enactments: 2,
      proposal_enactments: 2,
      proposal_laws: 2,
      proposal_results: 2,
      proposals: 2,
      public_choices: 6,
      schedule_occurrences: 16,
      secret_choices: 3,
    });

    const replacementProposalState = await runtimeState(app.pool);
    const replacementProposalCommand = gatewayGovernanceCommand(
      replacementProposalState,
      'CreateProposalV1',
      {
        action: {
          actionSchemaVersion: 1,
          actionType: 'create_law',
          effectiveFromTick: '33',
          effectiveUntilTick: null,
          lawKey: 'law:integration-gateway-replacement',
          policy: { kind: 'membership_role', role: 'player' },
          summary: 'A law enacted after a public ballot replacement through the real gateway.',
          targetCharterVersion: '1',
          title: 'Gateway Replacement Law',
        },
        approvalThresholdBps: 5_001,
        ballotPolicy: {
          ballotMode: 'public',
          disclosure: 'choice_totals',
          replacementAllowed: true,
        },
        body: 'Proves allowed replacement, effective revision, and exact durable replay.',
        debateEndsAtTick: '28',
        institutionId: proposalActor.institution_id,
        jurisdictionEntityKey: proposalActor.jurisdiction_key,
        minimumSponsors: 0,
        proposalKey: 'proposal:integration-gateway-replacement',
        quorumBps: 5_000,
        sponsorshipEndsAtTick: '26',
        targetCharterVersion: '1',
        title: 'Gateway Replacement Proposal',
        votingClosesAtTick: '33',
        votingOpensAtTick: '28',
      },
      '0',
      'governance-gateway-replacement-proposal-0001',
      lifecycleIds,
    );
    await submitGatewayAccepted(
      commandBus,
      apiActor(creator),
      replacementProposalCommand,
      lifecycleIds,
    );

    const compensationProposalState = await runtimeState(app.pool);
    const compensationProposalCommand = gatewayGovernanceCommand(
      compensationProposalState,
      'CreateProposalV1',
      {
        action: {
          actionSchemaVersion: 1,
          actionType: 'authorize_public_project',
          amountMinor: '1',
          budgetKey: 'budget:integration-gateway-compensation',
          currencyId: economy.currency_id,
          description: 'A funded project whose intentionally stale effect tick requires repair.',
          effectiveAtTick: '25',
          projectKey: economy.project_key,
          treasuryWalletId: economy.treasury_wallet_id,
        },
        approvalThresholdBps: 5_001,
        ballotPolicy: {
          ballotMode: 'public',
          disclosure: 'choice_totals',
          replacementAllowed: true,
        },
        body: 'Proves atomic passed-but-failed enactment and linked compensation recovery.',
        debateEndsAtTick: '28',
        institutionId: proposalActor.institution_id,
        jurisdictionEntityKey: proposalActor.jurisdiction_key,
        minimumSponsors: 0,
        proposalKey: 'proposal:integration-gateway-compensation',
        quorumBps: 5_000,
        sponsorshipEndsAtTick: '26',
        targetCharterVersion: '1',
        title: 'Gateway Compensation Proposal',
        votingClosesAtTick: '33',
        votingOpensAtTick: '28',
      },
      '0',
      'governance-gateway-compensation-proposal-0001',
      lifecycleIds,
    );
    await submitGatewayAccepted(
      commandBus,
      apiActor(creator),
      compensationProposalCommand,
      lifecycleIds,
    );

    const gatewayReplacementProposal = await proposalByCommand(
      app.pool,
      String(replacementProposalCommand['commandId']),
    );
    const gatewayCompensationProposal = await proposalByCommand(
      app.pool,
      String(compensationProposalCommand['commandId']),
    );
    await advanceSimulation(commandBus, apiActor(creator), app.pool, 28n, lifecycleIds);
    const gatewayOpens = await runGovernanceUntilIdle(scheduleRunner, app.pool);
    expect(gatewayOpens).toHaveLength(2);
    expect(
      gatewayOpens.every(
        (result) => result.actionType === 'OpenProposalVotingV1' && result.outcome === 'accepted',
      ),
    ).toBe(true);
    const openedGatewayReplacement = await proposalByCommand(
      app.pool,
      String(replacementProposalCommand['commandId']),
    );
    const openedGatewayCompensation = await proposalByCommand(
      app.pool,
      String(compensationProposalCommand['commandId']),
    );
    expect(openedGatewayReplacement).toMatchObject({ aggregate_version: '2', status: 'open' });
    expect(openedGatewayCompensation).toMatchObject({
      aggregate_version: '2',
      status: 'open',
    });
    const replacementSnapshot = await eligibilitySnapshot(
      owner.pool,
      openedGatewayReplacement.contest_id,
    );
    const compensationSnapshot = await eligibilitySnapshot(
      owner.pool,
      openedGatewayCompensation.contest_id,
    );

    const deniedState = await runtimeState(app.pool);
    const deniedCommand = gatewayGovernanceCommand(
      deniedState,
      'CastProposalBallotV1',
      {
        choice: 'yes',
        eligibilitySnapshotId: replacementSnapshot.id,
        expectedProposalVersion: openedGatewayReplacement.aggregate_version,
        proposalId: openedGatewayReplacement.id,
        replaceExisting: false,
      },
      openedGatewayReplacement.aggregate_version,
      'governance-gateway-nonmember-ballot-denied-0001',
      lifecycleIds,
    );
    const denied = await commandBus.submit(
      nonmemberApiActor(),
      worldId,
      deniedCommand,
      lifecycleIds.next(),
      new Date(),
    );
    expect(denied).toMatchObject({
      httpStatus: 404,
      result: { rejectionCode: 'AUTHORIZATION_DENIED', status: 'rejected' },
    });
    await expect(
      authorityDecision(owner.pool, String(deniedCommand['commandId'])),
    ).resolves.toEqual({
      actor_id: nonmemberId,
      actor_mode: 'in_world',
      decision: 'deny',
      reason_code: 'WORLD_NOT_VISIBLE',
    });
    await expect(
      ballotEvidence(owner.pool, openedGatewayReplacement.contest_id, voterA.entityId),
    ).resolves.toEqual({
      effective_choice: null,
      effective_revision: null,
      participation_count: 0,
      receipt_count: 0,
      revision_count: 0,
    });

    const voterAFirstState = await runtimeState(app.pool);
    const voterAFirstCommand = gatewayGovernanceCommand(
      voterAFirstState,
      'CastProposalBallotV1',
      {
        choice: 'yes',
        eligibilitySnapshotId: replacementSnapshot.id,
        expectedProposalVersion: openedGatewayReplacement.aggregate_version,
        proposalId: openedGatewayReplacement.id,
        replaceExisting: false,
      },
      openedGatewayReplacement.aggregate_version,
      'governance-gateway-replacement-first-0001',
      lifecycleIds,
    );
    await submitGatewayAccepted(commandBus, apiActor(voterA), voterAFirstCommand, lifecycleIds);
    const voterAReplacementState = await runtimeState(app.pool);
    const voterAReplacementCommand = gatewayGovernanceCommand(
      voterAReplacementState,
      'CastProposalBallotV1',
      {
        choice: 'no',
        eligibilitySnapshotId: replacementSnapshot.id,
        expectedProposalVersion: openedGatewayReplacement.aggregate_version,
        proposalId: openedGatewayReplacement.id,
        replaceExisting: true,
      },
      openedGatewayReplacement.aggregate_version,
      'governance-gateway-replacement-effective-0001',
      lifecycleIds,
    );
    const voterAReplacement = await submitGatewayAccepted(
      commandBus,
      apiActor(voterA),
      voterAReplacementCommand,
      lifecycleIds,
    );
    const replacementBeforeReplay = await ballotEvidence(
      owner.pool,
      openedGatewayReplacement.contest_id,
      voterA.entityId,
    );
    expect(replacementBeforeReplay).toEqual({
      effective_choice: 'no',
      effective_revision: 2,
      participation_count: 1,
      receipt_count: 2,
      revision_count: 2,
    });
    const voterAReplacementReplay = await commandBus.submit(
      apiActor(voterA),
      worldId,
      voterAReplacementCommand,
      lifecycleIds.next(),
      new Date(),
    );
    expect(voterAReplacementReplay).toEqual(voterAReplacement);
    await expect(
      ballotEvidence(owner.pool, openedGatewayReplacement.contest_id, voterA.entityId),
    ).resolves.toEqual(replacementBeforeReplay);

    let voterBGatewayCommandId = '';
    for (const [actor, key] of [
      [voterB, 'voter-b'],
      [creator, 'creator'],
    ] as const) {
      const state = await runtimeState(app.pool);
      const ballotCommand = gatewayGovernanceCommand(
        state,
        'CastProposalBallotV1',
        {
          choice: 'yes',
          eligibilitySnapshotId: replacementSnapshot.id,
          expectedProposalVersion: openedGatewayReplacement.aggregate_version,
          proposalId: openedGatewayReplacement.id,
          replaceExisting: false,
        },
        openedGatewayReplacement.aggregate_version,
        `governance-gateway-replacement-${key}-0001`,
        lifecycleIds,
      );
      if (actor.userId === voterB.userId) {
        voterBGatewayCommandId = String(ballotCommand['commandId']);
      }
      await submitGatewayAccepted(commandBus, apiActor(actor), ballotCommand, lifecycleIds);
    }
    expect(voterBGatewayCommandId).not.toBe('');
    await expect(
      effectivePublicChoiceSummary(owner.pool, openedGatewayReplacement.contest_id),
    ).resolves.toEqual([
      { choice: 'no', count: 1 },
      { choice: 'yes', count: 2 },
    ]);

    for (const [actor, key] of [
      [creator, 'creator'],
      [voterA, 'voter-a'],
      [voterB, 'voter-b'],
    ] as const) {
      const state = await runtimeState(app.pool);
      await submitGatewayAccepted(
        commandBus,
        apiActor(actor),
        gatewayGovernanceCommand(
          state,
          'CastProposalBallotV1',
          {
            choice: 'yes',
            eligibilitySnapshotId: compensationSnapshot.id,
            expectedProposalVersion: openedGatewayCompensation.aggregate_version,
            proposalId: openedGatewayCompensation.id,
            replaceExisting: false,
          },
          openedGatewayCompensation.aggregate_version,
          `governance-gateway-compensation-${key}-0001`,
          lifecycleIds,
        ),
        lifecycleIds,
      );
    }

    await advanceSimulation(commandBus, apiActor(creator), app.pool, 33n, lifecycleIds);
    const gatewayFinalization = await runGovernanceUntilIdle(scheduleRunner, app.pool);
    expect(gatewayFinalization).toHaveLength(4);
    expect(
      gatewayFinalization.filter((result) => result.actionType === 'CloseAndTallyProposalV1'),
    ).toHaveLength(2);
    expect(
      gatewayFinalization.filter((result) => result.actionType === 'CertifyAndEnactProposalV1'),
    ).toHaveLength(2);
    expect(gatewayFinalization.every((result) => result.outcome === 'accepted')).toBe(true);
    await expect(proposalFinalSnapshot(app.pool, gatewayReplacementProposal.id)).resolves.toEqual({
      action_enactments: 1,
      enactments: 1,
      laws: 1,
      outcome: 'passed',
      results: 1,
      status: 'enacted',
    });
    await expectDurableGovernanceEventBatch(
      owner.pool,
      await proposalCertificationCommandId(owner.pool, gatewayReplacementProposal.id),
      ['GovernanceResultFinalizedV1', 'GovernanceLawVersionActivatedV1'],
      true,
    );
    const failedBeforeRepair = await failedProjectEnactmentSnapshot(
      owner.pool,
      gatewayCompensationProposal.id,
      economy.treasury_wallet_id,
    );
    expect(failedBeforeRepair).toEqual({
      action_enactments: 0,
      encumbrances: 0,
      enactment_attempts: 1,
      failed_attempts: 1,
      project_authorizations: 0,
      spendable_minor: economy.treasury_balance_minor,
      status: 'passed_but_enactment_failed',
      succeeded_attempts: 0,
    });
    await expectDurableGovernanceEventBatch(
      owner.pool,
      await proposalCertificationCommandId(owner.pool, gatewayCompensationProposal.id),
      ['GovernanceResultFinalizedV1'],
      true,
    );
    await expect(scheduleRunner.reconcile()).resolves.toEqual([]);
    await expect(
      failedProjectEnactmentSnapshot(
        owner.pool,
        gatewayCompensationProposal.id,
        economy.treasury_wallet_id,
      ),
    ).resolves.toEqual(failedBeforeRepair);

    const compensation = await compensationRepairMaterial(
      owner.pool,
      gatewayCompensationProposal.id,
    );
    const repairState = await runtimeState(app.pool);
    const repairCommand = gatewayGovernanceCommand(
      repairState,
      'RepairGovernanceResultV1',
      {
        approvalId: null,
        confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
        expectedCurrentResultChecksum: compensation.sourceResultChecksum,
        reason: 'Apply the immutable compensation plan after the scheduled effect tick has passed.',
        repairKind: 'certification_compensation',
        replacementResultChecksum: compensation.compensationPlanChecksum,
        sourceResultId: compensation.sourceResultId,
      },
      compensation.proposalVersion,
      'governance-gateway-compensation-repair-0001',
      lifecycleIds,
    );
    const repairCredential = await issueRecentCredential(
      identityService,
      apiActor(creator),
      repairCommand,
      lifecycleIds,
    );
    const repair = await submitGatewayAccepted(
      commandBus,
      apiActor(creator),
      repairCommand,
      lifecycleIds,
      repairCredential,
    );
    const repairReplay = await commandBus.submit(
      apiActor(creator),
      worldId,
      repairCommand,
      lifecycleIds.next(),
      new Date(),
      repairCredential,
    );
    expect(repairReplay).toEqual(repair);
    await expectDurableGovernanceEventBatch(
      owner.pool,
      String(repairCommand['commandId']),
      ['GovernanceRepairAppendedV1'],
      false,
    );
    await expect(
      failedProjectEnactmentSnapshot(
        owner.pool,
        gatewayCompensationProposal.id,
        economy.treasury_wallet_id,
      ),
    ).resolves.toEqual({
      action_enactments: 1,
      encumbrances: 1,
      enactment_attempts: 2,
      failed_attempts: 1,
      project_authorizations: 1,
      spendable_minor: (BigInt(economy.treasury_balance_minor) - 1n).toString(),
      status: 'enacted',
      succeeded_attempts: 1,
    });

    const overrideState = await runtimeState(app.pool);
    const overrideCommand = gatewayGovernanceCommand(
      overrideState,
      'ExecuteCreatorOverrideV1',
      {
        approvalId: null,
        confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
        effect: {
          effectType: 'execute_proposal_action',
          proposalAction: {
            actionSchemaVersion: 1,
            actionType: 'create_law',
            effectiveFromTick: overrideState.current_tick,
            effectiveUntilTick: null,
            lawKey: 'law:integration-explicit-override',
            policy: { kind: 'membership_role', role: 'player' },
            summary: 'A separately authorized law that proves override provenance stays distinct.',
            targetCharterVersion: '1',
            title: 'Explicit Override Law',
          },
        },
        impact: 'Creates one bounded law version at the current deterministic simulation tick.',
        reason: 'Prove explicit override and linked repair are permanently distinct mechanisms.',
      },
      '0',
      'governance-gateway-explicit-override-0001',
      lifecycleIds,
    );
    let overrideCredential: GovernanceRecentCredentialProof;
    try {
      overrideCredential = await issueRecentCredential(
        identityService,
        apiActor(creator),
        overrideCommand,
        lifecycleIds,
      );
    } catch (error) {
      const credentialContext = await owner.pool.query(
        `select now() as database_now,session.id::text as session_id,
                session.revoked_at,session.idle_expires_at,session.absolute_expires_at,
                session.auth_version as session_auth_version,
                actor.auth_version as actor_auth_version,actor.status::text as actor_status,
                actor.platform_role::text as platform_role,
                membership.status::text as membership_status,
                world.archived_at
           from sessions session
           join users actor on actor.id=session.user_id
           join worlds world on world.id=$2
           left join world_memberships membership
             on membership.world_id=world.id and membership.user_id=actor.id
          where session.id=$1`,
        [creatorSessionId, worldId],
      );
      throw new Error(
        `OVERRIDE_CREDENTIAL_ISSUANCE_FAILED:${JSON.stringify({ credentialContext: credentialContext.rows, error: safeError(error) })}`,
        { cause: error },
      );
    }
    const override = await submitGatewayAccepted(
      commandBus,
      apiActor(creator),
      overrideCommand,
      lifecycleIds,
      overrideCredential,
    );
    const overrideReplay = await commandBus.submit(
      apiActor(creator),
      worldId,
      overrideCommand,
      lifecycleIds.next(),
      new Date(),
      overrideCredential,
    );
    expect(overrideReplay).toEqual(override);
    const overrideEvents = await expectDurableGovernanceEventBatch(
      owner.pool,
      String(overrideCommand['commandId']),
      ['GovernanceOverrideExecutedV1', 'GovernanceLawVersionActivatedV1'],
      false,
    );
    expect(overrideEvents[1]).toMatchObject({
      aggregate_type: 'law_version',
      aggregate_version: '1',
      payload: {
        effectiveFromTick: overrideState.current_tick,
        eventType: 'GovernanceLawVersionActivatedV1',
        lawVersion: '1',
        sourceProposalId: null,
      },
    });

    const approvalAuthorityBus = await createApiCommandBus(app.pool, {
      idOffset: 2_000_000,
      requireTwoPersonOverride: true,
      requireTwoPersonRepair: true,
    });
    const approvalActor = {
      ...apiActor(voterA),
      user: { ...apiActor(voterA).user, platformRole: 'platform_admin' as const },
    };
    const originalApprovalActor = await owner.pool.query<{
      auth_version: number;
      platform_role: string;
      status: string;
    }>(
      `select auth_version,platform_role::text,status::text
         from users where id=$1`,
      [voterA.userId],
    );
    const originalApprovalActorRow = originalApprovalActor.rows[0]!;
    const issuedApprovalIds: string[] = [];
    try {
      await owner.pool.query(
        `update users
            set platform_role='platform_admin',status='active',auth_version=$2
          where id=$1`,
        [voterA.userId, originalApprovalActorRow.auth_version],
      );
      const approvedState = await runtimeState(app.pool);
      const approvalReviewedCommand = gatewayGovernanceCommand(
        approvedState,
        'ExecuteCreatorOverrideV1',
        {
          approvalId: null,
          confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
          effect: {
            effectType: 'execute_proposal_action',
            proposalAction: {
              actionSchemaVersion: 1,
              actionType: 'create_law',
              effectiveFromTick: approvedState.current_tick,
              effectiveUntilTick: null,
              lawKey: 'law:two-person-control-success',
              policy: { kind: 'membership_role', role: 'player' },
              summary: 'A law created only after exact review by a distinct current administrator.',
              targetCharterVersion: '1',
              title: 'Two-person control success',
            },
          },
          impact: 'Creates one bounded law only after both privileged actors authorize it.',
          reason: 'Prove the real PostgreSQL two-person control succeeds and remains single-use.',
        },
        '0',
        'governance-two-person-control-success',
        lifecycleIds,
      );
      const approvalReviewPackage = {
        ...approvalReviewedCommand,
        actorMode: 'creator',
      } as GovernanceTwoPersonCommand;
      const issuedControlApproval = await identityService.approveGovernanceOperation(
        approvalActor,
        {
          command: approvalReviewPackage,
          password: reauthenticationPassword,
          worldId,
        },
        lifecycleIds.next(),
        'governance-two-person-control-approval',
      );
      const approvedControlCommandId = String(approvalReviewedCommand['commandId']);
      const approvedControlCommand = {
        ...approvalReviewedCommand,
        payload: {
          ...(approvalReviewedCommand['payload'] as Record<string, unknown>),
          approvalId: issuedControlApproval.approvalId,
        },
      };
      const approvedControlCredential = await issueRecentCredential(
        identityService,
        apiActor(creator),
        approvedControlCommand,
        lifecycleIds,
      );
      const approvedControl = await submitGatewayAccepted(
        approvalAuthorityBus,
        apiActor(creator),
        approvedControlCommand,
        lifecycleIds,
        approvedControlCredential,
      );
      const approvedControlReplay = await approvalAuthorityBus.submit(
        apiActor(creator),
        worldId,
        approvedControlCommand,
        lifecycleIds.next(),
        new Date(),
        approvedControlCredential,
      );
      expect(approvedControlReplay).toEqual(approvedControl);
      const controlApprovalEvidence = await owner.pool.query<{
        approval_count: number;
        approval_hash: string;
        approval_kind: string;
        approver_user_id: string;
        audit_action: string;
        audit_binding_hash: string;
        audit_reason_code: string;
        audit_record_id: string;
        audit_target_id: string;
        command_id: string;
      }>(
        `select count(*) over ()::integer as approval_count,
                encode(approval.approval_hash,'hex') as approval_hash,
                approval.approval_kind,approval.approver_user_id::text,
                approval.audit_record_id::text,override.command_id::text,
                audit.action as audit_action,audit.reason_code as audit_reason_code,
                audit.target_id::text as audit_target_id,
                audit.redacted_metadata->>'bindingHash' as audit_binding_hash
           from governance_override_approvals approval
           join governance_overrides override
             on override.world_id=approval.world_id and override.id=approval.override_id
           join security_audit_records audit
             on audit.id=approval.audit_record_id
          where approval.audit_record_id=$1`,
        [issuedControlApproval.approvalId],
      );
      expect(controlApprovalEvidence.rows).toHaveLength(1);
      expect(controlApprovalEvidence.rows[0]).toMatchObject({
        approval_count: 1,
        approval_kind: 'second_party',
        approver_user_id: voterA.userId,
        audit_action: 'governance.approve_override',
        audit_binding_hash: governanceTwoPersonApprovalBindingHashV1(approvalReviewPackage),
        audit_reason_code: 'GOVERNANCE_OVERRIDE_SECOND_APPROVAL',
        audit_record_id: issuedControlApproval.approvalId,
        audit_target_id: approvedControlCommandId,
        command_id: approvedControlCommandId,
      });
      expect(controlApprovalEvidence.rows[0]?.approval_hash).toMatch(/^[a-f0-9]{64}$/u);
      const exactReplayEvidence = await owner.pool.query<{ consumptions: number }>(
        `select count(*)::integer as consumptions
           from recent_credential_proof_consumptions consumption
           join recent_credential_proofs proof on proof.id=consumption.proof_id
          where proof.command_id=$1`,
        [approvedControlCommandId],
      );
      expect(exactReplayEvidence.rows).toEqual([{ consumptions: 1 }]);

      const reuseState = await runtimeState(app.pool);
      const reuseReviewedCommand = gatewayGovernanceCommand(
        reuseState,
        'ExecuteCreatorOverrideV1',
        {
          approvalId: issuedControlApproval.approvalId,
          confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
          effect: {
            effectType: 'execute_proposal_action',
            proposalAction: {
              actionSchemaVersion: 1,
              actionType: 'create_law',
              effectiveFromTick: reuseState.current_tick,
              effectiveUntilTick: null,
              lawKey: 'law:two-person-control-reuse-must-fail',
              policy: { kind: 'membership_role', role: 'player' },
              summary: 'This law must not exist because proof and approval reuse are forbidden.',
              targetCharterVersion: '1',
              title: 'Forbidden two-person reuse',
            },
          },
          impact: 'Would create a second law from already-consumed privileged evidence.',
          reason: 'Prove proof and approval evidence cannot authorize a distinct command.',
        },
        '0',
        'governance-two-person-control-reuse',
        lifecycleIds,
      );
      await expect(
        approvalAuthorityBus.submit(
          apiActor(creator),
          worldId,
          reuseReviewedCommand,
          lifecycleIds.next(),
          new Date(),
          approvedControlCredential,
        ),
      ).rejects.toMatchObject({ code: 'RECENT_CREDENTIAL_INVALID', statusCode: 403 });
      const reuseCredential = await issueRecentCredential(
        identityService,
        apiActor(creator),
        reuseReviewedCommand,
        lifecycleIds,
      );
      const rejectedReuse = await approvalAuthorityBus.submit(
        apiActor(creator),
        worldId,
        reuseReviewedCommand,
        lifecycleIds.next(),
        new Date(),
        reuseCredential,
      );
      expect(rejectedReuse.result).toMatchObject({
        rejectionCode: 'TWO_PERSON_APPROVAL_REQUIRED',
        status: 'rejected',
      });
      const reuseEffects = await owner.pool.query<{
        approval_rows: number;
        law_rows: number;
        override_rows: number;
      }>(
        `select
           (select count(*)::integer from governance_override_approvals
             where audit_record_id=$1) as approval_rows,
           (select count(*)::integer from laws
             where world_id=$2 and stable_key='law:two-person-control-reuse-must-fail') as law_rows,
           (select count(*)::integer from governance_overrides
             where world_id=$2 and command_id=$3) as override_rows`,
        [issuedControlApproval.approvalId, worldId, reuseReviewedCommand['commandId']],
      );
      expect(reuseEffects.rows).toEqual([{ approval_rows: 1, law_rows: 0, override_rows: 0 }]);

      for (const invalidation of ['demoted', 'disabled', 'auth_version_changed'] as const) {
        await owner.pool.query(
          `update users
              set platform_role='platform_admin',status='active',auth_version=$2
            where id=$1`,
          [voterA.userId, originalApprovalActorRow.auth_version],
        );
        const state = await runtimeState(app.pool);
        const reviewedCommand = gatewayGovernanceCommand(
          state,
          'ExecuteCreatorOverrideV1',
          {
            approvalId: null,
            confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
            effect: {
              effectType: 'execute_proposal_action',
              proposalAction: {
                actionSchemaVersion: 1,
                actionType: 'create_law',
                effectiveFromTick: state.current_tick,
                effectiveUntilTick: null,
                lawKey: `law:invalidated-approval-${invalidation}`,
                policy: { kind: 'membership_role', role: 'player' },
                summary: 'This effect must remain unapplied after second-party authority changes.',
                targetCharterVersion: '1',
                title: `Invalidated approval ${invalidation}`,
              },
            },
            impact: 'Would create a law only if the second reviewer still holds current authority.',
            reason: 'Prove approval authority is revalidated at the exact consumption boundary.',
          },
          '0',
          `governance-invalidated-approval-${invalidation}`,
          lifecycleIds,
        );
        const issuedApproval = await identityService.approveGovernanceOperation(
          approvalActor,
          {
            command: { ...reviewedCommand, actorMode: 'creator' },
            password: reauthenticationPassword,
            worldId,
          },
          lifecycleIds.next(),
          `governance-approval-authority-${invalidation}`,
        );
        issuedApprovalIds.push(issuedApproval.approvalId);
        const approvedCommand = {
          ...reviewedCommand,
          payload: {
            ...(reviewedCommand['payload'] as Record<string, unknown>),
            approvalId: issuedApproval.approvalId,
          },
        };
        let credential: GovernanceRecentCredentialProof;
        try {
          credential = await issueRecentCredential(
            identityService,
            apiActor(creator),
            approvedCommand,
            lifecycleIds,
          );
        } catch (error) {
          const credentialContext = await owner.pool.query(
            `select now() as database_now,session.id::text as session_id,
                    session.revoked_at,session.idle_expires_at,session.absolute_expires_at,
                    session.auth_version as session_auth_version,
                    actor.auth_version as actor_auth_version,actor.status::text as actor_status,
                    actor.platform_role::text as platform_role,
                    membership.status::text as membership_status,world.archived_at
               from sessions session
               join users actor on actor.id=session.user_id
               join worlds world on world.id=$2
               left join world_memberships membership
                 on membership.world_id=world.id and membership.user_id=actor.id
              where session.id=$1`,
            [creatorSessionId, worldId],
          );
          throw new Error(
            `APPROVAL_INVALIDATION_CREDENTIAL_FAILED:${JSON.stringify({ credentialContext: credentialContext.rows, error: safeError(error), invalidation })}`,
            { cause: error },
          );
        }
        if (invalidation === 'demoted') {
          await owner.pool.query("update users set platform_role='user' where id=$1", [
            voterA.userId,
          ]);
        } else if (invalidation === 'disabled') {
          await owner.pool.query("update users set status='disabled' where id=$1", [voterA.userId]);
        } else {
          await owner.pool.query('update users set auth_version=auth_version+1 where id=$1', [
            voterA.userId,
          ]);
        }

        const rejected = await approvalAuthorityBus.submit(
          apiActor(creator),
          worldId,
          approvedCommand,
          lifecycleIds.next(),
          new Date(),
          credential,
        );
        expect(rejected.result).toMatchObject({
          rejectionCode: 'TWO_PERSON_APPROVAL_REQUIRED',
          status: 'rejected',
        });
      }
    } finally {
      await owner.pool.query(
        `update users set platform_role=$2,status=$3,auth_version=$4 where id=$1`,
        [
          voterA.userId,
          originalApprovalActorRow.platform_role,
          originalApprovalActorRow.status,
          originalApprovalActorRow.auth_version,
        ],
      );
    }
    const invalidatedApprovalUsage = await owner.pool.query<{ used: number }>(
      `select (
         (select count(*) from governance_override_approvals where audit_record_id=any($1::uuid[]))
         + (select count(*) from governance_repair_approvals where audit_record_id=any($1::uuid[]))
       )::integer as used`,
      [issuedApprovalIds],
    );
    expect(invalidatedApprovalUsage.rows).toEqual([{ used: 0 }]);

    await expect(
      privilegedProvenanceSnapshot(
        owner.pool,
        String(repairCommand['commandId']),
        String(overrideCommand['commandId']),
      ),
    ).resolves.toEqual({
      override_audit_records: 1,
      override_events: 1,
      override_ledger_entries: 1,
      override_records: 1,
      repair_events: 1,
      repair_ledger_entries: 1,
      repair_records: 1,
      repair_rows_with_override_provenance: 0,
      override_rows_with_repair_provenance: 0,
    });
    await expect(
      recentCredentialEvidence(owner.pool, [
        String(priorAppointmentCommand['commandId']),
        String(repairCommand['commandId']),
        String(overrideCommand['commandId']),
      ]),
    ).resolves.toEqual({
      bound_commands: 3,
      distinct_command_hashes: 3,
      proof_consumptions: 3,
      proofs: 3,
      reauthentication_audits: 3,
      sessions: 1,
      users: 1,
    });
    await expect(
      gatewayActorEvidence(owner.pool, [
        String(priorAppointmentCommand['commandId']),
        String(deniedAppointmentCommand['commandId']),
        String(authorizedAppointmentCommand['commandId']),
        String(replacementProposalCommand['commandId']),
        String(voterAFirstCommand['commandId']),
        String(voterAReplacementCommand['commandId']),
        voterBGatewayCommandId,
        String(deniedCommand['commandId']),
        String(repairCommand['commandId']),
        String(overrideCommand['commandId']),
      ]),
    ).resolves.toEqual([
      { actor_id: creatorId, command_type: 'ExecuteCreatorOverrideV1', decision: 'allow' },
      { actor_id: voterB.userId, command_type: 'AppointOfficeholderV1', decision: 'deny' },
      { actor_id: voterA.userId, command_type: 'AppointOfficeholderV1', decision: 'allow' },
      { actor_id: creatorId, command_type: 'CreateProposalV1', decision: 'allow' },
      { actor_id: voterA.userId, command_type: 'CastProposalBallotV1', decision: 'allow' },
      { actor_id: voterA.userId, command_type: 'CastProposalBallotV1', decision: 'allow' },
      { actor_id: voterB.userId, command_type: 'CastProposalBallotV1', decision: 'allow' },
      { actor_id: nonmemberId, command_type: 'CastProposalBallotV1', decision: 'deny' },
      { actor_id: creatorId, command_type: 'RepairGovernanceResultV1', decision: 'allow' },
      { actor_id: creatorId, command_type: 'ExecuteCreatorOverrideV1', decision: 'allow' },
    ]);
    await expect(lifecycleCounts(owner.pool)).resolves.toEqual({
      accepted_candidacies: 2,
      active_members: 3,
      ballot_participation: 15,
      ballot_receipts: 16,
      cancelled_elections: 7,
      certified_elections: 1,
      completed_schedules: 36,
      election_results: 1,
      elections: 16,
      eligibility_snapshot_members: 15,
      eligibility_snapshots: 5,
      office_authority_intervals: 3,
      office_terms: 3,
      primary_controllers: 3,
      proposal_action_enactments: 4,
      proposal_enactments: 5,
      proposal_laws: 3,
      proposal_results: 4,
      proposals: 4,
      public_choices: 13,
      schedule_occurrences: 22,
      secret_choices: 3,
    });
    expect(await governanceReplayGolden(owner.pool, worldId)).toEqual({
      eventStreamChecksum: '443ea636bae5143a608803723dc84f52cd52d1c68b9d98aeee0fd798f07bcb46',
      governanceStateChecksum: 'e680c054dd0f1197c75f3714410135c0d9f266ca737590967c686015c4b08450',
      termScheduleChecksum: 'e126d7ece6f840b9874ca38a3f46ccf5c17f7cd07fd9e50bfbbe85ab787d99fd',
    });
    const restore = await governanceBackupRestoreEvidence(container, owner.pool, worldId);
    expect(restore.restoredAccess).toEqual({
      currentUsers: {
        app: 'worldgraph_app',
        tally: 'worldgraph_governance_tally',
      },
      directQueries: {
        appProposalsSelect: 'allowed',
        appSecretBallotChoicesSelect: '42501',
        tallyBallotParticipationSelect: '42501',
        tallySecretBallotChoicesSelect: 'allowed',
      },
      functionPrivileges: [
        {
          appCanExecute: true,
          publicCanExecute: false,
          signature:
            'public.worldgraph_cast_governance_ballot_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,jsonb,bigint,boolean,bigint,uuid,uuid,bigint)',
          tallyCanExecute: false,
        },
        {
          appCanExecute: true,
          publicCanExecute: false,
          signature:
            'public.worldgraph_persist_election_tally_v1(uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,bytea,bytea,bigint,uuid,jsonb,uuid)',
          tallyCanExecute: false,
        },
        {
          appCanExecute: true,
          publicCanExecute: false,
          signature:
            'public.worldgraph_persist_proposal_tally_v1(uuid,uuid,uuid,uuid,uuid,bigint,text,integer,integer,integer,integer,integer,integer,integer,bytea,bytea,bigint,uuid,uuid,uuid,uuid)',
          tallyCanExecute: false,
        },
        {
          appCanExecute: true,
          publicCanExecute: false,
          signature:
            'public.worldgraph_recount_election_result_v1(uuid,uuid,uuid,uuid,jsonb,uuid,bytea,bytea,uuid,uuid,bigint,bigint)',
          tallyCanExecute: false,
        },
        {
          appCanExecute: true,
          publicCanExecute: false,
          signature:
            'public.worldgraph_recount_proposal_result_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,uuid,uuid,bigint,bigint)',
          tallyCanExecute: false,
        },
      ],
      ownerPrivileges: {
        appBallotChoiceAssertionExecute: false,
        appBallotChoiceRevisionsSelect: false,
        appBallotEffectiveRevisionsSelect: false,
        appEffectiveRevisionAssertionExecute: false,
        appProposalsSelect: true,
        appSecretBallotChoicesSelect: false,
        tallyBallotParticipationSelect: false,
        tallyProposalTalliesMutation: false,
        tallySecretBallotChoicesSelect: true,
        tallyUsersSelect: false,
      },
    });
    expect(restore.restored).toEqual(restore.source);
  }, 180_000);
});

function input(
  command: Extract<GovernanceCommandRequestV1, { type: 'InitializeWorldGovernanceV1' }>,
  correlationId: string,
  resource: { actionCode: string; resourceId: string; resourceType: string },
): GovernanceCommandExecutionInput {
  return {
    actor: { actorEntityId: null, actorId: creatorId, actorType: 'user' },
    authorization: {
      actionCode: resource.actionCode,
      allowed: true,
      context: { membershipRoles: ['creator'] },
      reasonCode: 'POLICY_ALLOWED',
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
      ruleId: 'governance.creator.initializer.v1',
    },
    causationId: null,
    command,
    correlationId,
    worldId,
  };
}

function governanceCommand(
  state: RuntimeState,
  actorMode: 'in_world',
  type: GovernanceCommandRequestV1['type'],
  payload: Record<string, unknown>,
  expectedAggregateVersion: string,
  idempotencyKey: string,
  source: { next(): string },
): GovernanceCommandRequestV1 {
  return {
    actorMode,
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

function gatewayGovernanceCommand(
  state: RuntimeState,
  type: GovernanceCommandRequestV1['type'],
  payload: Record<string, unknown>,
  expectedAggregateVersion: string,
  idempotencyKey: string,
  source: { next(): string },
  commandId = source.next(),
): Record<string, unknown> {
  return {
    commandId,
    expectedAggregateVersion,
    expectedStateRevision: state.state_revision,
    expectedTick: state.current_tick,
    expectedWorldVersion: state.design_version,
    idempotencyKey,
    payload,
    schemaVersion: 1,
    type,
  };
}

async function submitGatewayAccepted(
  commandBus: InstanceType<ApiCommandBusModule['WorldCommandBus']>,
  actor: ApiActor,
  command: Record<string, unknown>,
  source: { next(): string },
  recentCredential?: GovernanceRecentCredentialProof,
): Promise<ApiCommandSubmission> {
  const submission = await commandBus.submit(
    actor,
    worldId,
    command,
    source.next(),
    new Date(),
    recentCredential,
  );
  if (submission.httpStatus !== 200 || submission.result.status !== 'accepted') {
    throw new Error(
      `Gateway governance command ${String(command['type'])} was rejected: ${JSON.stringify(submission)}`,
    );
  }
  return submission;
}

async function issueRecentCredential(
  identityService: ApiIdentityService,
  actor: ApiActor,
  command: Record<string, unknown>,
  source: { next(): string },
): Promise<GovernanceRecentCredentialProof> {
  const issued = await identityService.reauthenticate(
    actor,
    { command, password: reauthenticationPassword, worldId },
    source.next(),
  );
  expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());
  return identityService.governanceRecentCredential(actor, issued.proofToken, command);
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
  commandInput: GovernanceCommandExecutionInput,
): Promise<Awaited<ReturnType<PostgresGovernanceCommandExecutor['executePublic']>>> {
  const execution = await executor.executePublic(commandInput as never);
  expect(execution.replayed).toBe(false);
  if (execution.result.status !== 'accepted') {
    throw new Error(
      `Governance command ${commandInput.command.type} was rejected: ${JSON.stringify(execution.result)}`,
    );
  }
  return execution;
}

function apiActor(actor: WorldActor): ApiActor {
  return apiActorForUser(actor.userId);
}

function nonmemberApiActor(): ApiActor {
  return apiActorForUser(nonmemberId);
}

function apiActorForUser(userId: string): ApiActor {
  const identities = new Map<
    string,
    { csrfByte: number; displayName: string; email: string; sessionId: string }
  >([
    [
      creatorId,
      {
        csrfByte: 0x21,
        displayName: 'Governance Creator',
        email: 'governance-creator@example.test',
        sessionId: creatorSessionId,
      },
    ],
    [
      playerId,
      {
        csrfByte: 0x22,
        displayName: 'Governance Player',
        email: 'governance-player@example.test',
        sessionId: playerSessionId,
      },
    ],
    [
      thirdPlayerId,
      {
        csrfByte: 0x23,
        displayName: 'Governance Third Player',
        email: 'governance-third@example.test',
        sessionId: thirdPlayerSessionId,
      },
    ],
    [
      nonmemberId,
      {
        csrfByte: 0x24,
        displayName: 'Governance Outsider',
        email: 'governance-outsider@example.test',
        sessionId: nonmemberSessionId,
      },
    ],
  ]);
  const identity = identities.get(userId);
  if (!identity) throw new Error('API_ACTOR_IDENTITY_NOT_FOUND');
  return {
    csrfHash: Buffer.alloc(32, identity.csrfByte),
    session: {
      absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
      id: identity.sessionId,
      idleExpiresAt: '2098-12-31T00:00:00.000Z',
    },
    user: {
      displayName: identity.displayName,
      email: identity.email,
      id: userId,
      platformRole: 'user',
      rowVersion: 1,
      status: 'active',
    },
  };
}

async function createApiCommandBus(
  pool: Pool,
  options: {
    idOffset?: number;
    onPreparation?: (input: unknown, preparation: unknown) => void;
    requireTwoPersonOverride?: boolean;
    requireTwoPersonRepair?: boolean;
  } = {},
): Promise<InstanceType<ApiCommandBusModule['WorldCommandBus']>> {
  const commandBusPath = new URL(
    ['..', '..', 'api', 'src', 'commands', 'command-bus.ts'].join('/'),
    import.meta.url,
  ).href;
  const repositoryPath = new URL(
    ['..', '..', 'api', 'src', 'commands', 'repository.ts'].join('/'),
    import.meta.url,
  ).href;
  const gatewayPath = new URL(
    ['..', '..', 'api', 'src', 'governance', 'command-gateway.ts'].join('/'),
    import.meta.url,
  ).href;
  const commandBusModule = (await import(commandBusPath)) as unknown as ApiCommandBusModule;
  const repositoryModule = (await import(repositoryPath)) as unknown as ApiCommandRepositoryModule;
  const gatewayModule = (await import(gatewayPath)) as unknown as ApiGovernanceGatewayModule;
  const idOffset = options.idOffset ?? 0;
  const governanceGateway = new gatewayModule.PostgresGovernanceCommandGateway(pool, {
    ids: ids(320_000 + idOffset),
    policy: {
      contestRateLimitPerHour: 1_000,
      nominationRateLimitPerMinute: 1_000,
      requireTwoPersonOverride: options.requireTwoPersonOverride ?? false,
      requireTwoPersonRepair: options.requireTwoPersonRepair ?? false,
      sponsorRateLimitPerMinute: 1_000,
      voteRateLimitPerMinute: 1_000,
    },
    secretHashKey: 'integration-governance-secret-hash-key-32-characters',
  });
  const observedGovernanceGateway = options.onPreparation
    ? {
        executePublic: (input: unknown) => governanceGateway.executePublic(input),
        prepareAuthority: async (input: unknown) => {
          const preparation = await governanceGateway.prepareAuthority(input);
          options.onPreparation?.(input, preparation);
          return preparation;
        },
      }
    : governanceGateway;
  return new commandBusModule.WorldCommandBus(
    new repositoryModule.PostgresCommandRepository(pool, ids(300_000 + idOffset)),
    ids(310_000 + idOffset),
    undefined,
    undefined,
    undefined,
    observedGovernanceGateway,
  );
}

async function createApiIdentityService(pool: Pool): Promise<ApiIdentityService> {
  const identityPath = new URL(
    ['..', '..', 'api', 'src', 'identity', 'service.ts'].join('/'),
    import.meta.url,
  ).href;
  const repositoryPath = new URL(
    ['..', '..', 'api', 'src', 'repositories', 'postgres-repository.ts'].join('/'),
    import.meta.url,
  ).href;
  const identityModule = (await import(identityPath)) as unknown as ApiIdentityServiceModule;
  const repositoryModule = (await import(repositoryPath)) as unknown as ApiCommandRepositoryModule;
  return new identityModule.IdentityService(
    new repositoryModule.PostgresRepository(pool),
    {
      authPepper,
      governanceStepUpTtlSeconds: 300,
      sessionAbsoluteTtlSeconds: 3_600,
      sessionIdleTtlSeconds: 1_800,
    },
    { now: () => new Date() },
    ids(900_000),
    {
      hash: async () => passwordHash,
      verify: async (_encodedHash, password) => password === reauthenticationPassword,
    },
    { publish: async () => undefined },
  );
}

async function initializeEconomyAndCommerce(
  commandBus: InstanceType<ApiCommandBusModule['WorldCommandBus']>,
  actor: ApiActor,
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

  let state = await runtimeState(pool);
  let result = await commandBus.submit(
    actor,
    worldId,
    {
      commandId: source.next(),
      expectedAggregateVersion: '0',
      expectedStateRevision: state.state_revision,
      expectedWorldVersion: state.design_version,
      idempotencyKey: `governance-lifecycle-initialize-economy-${source.next()}`,
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

  state = await runtimeState(pool);
  result = await commandBus.submit(
    actor,
    worldId,
    {
      commandId: source.next(),
      expectedAggregateVersion: '0',
      expectedStateRevision: state.state_revision,
      expectedTick: state.current_tick,
      expectedWorldVersion: state.design_version,
      idempotencyKey: `governance-lifecycle-initialize-commerce-${source.next()}`,
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

async function economyTargets(pool: Pool): Promise<EconomyTargets> {
  const result = await pool.query<EconomyTargets>(
    `select treasury.id::text as treasury_wallet_id,
            treasury.currency_id::text as currency_id,
            treasury_balance.available_minor::text as treasury_balance_minor,
            treasury_balance.row_version::text as treasury_wallet_version,
            creator_wallet.id::text as creator_wallet_id,
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
         on project.world_id=policy.world_id and project.logical_key='district:civic-platform'
      where policy.world_id=$1 and policy.tax_type='sales' and policy.status='active'
      order by policy.policy_version desc limit 1`,
    [worldId, creatorId],
  );
  if (result.rows.length !== 1) throw new Error('ECONOMY_TARGETS_NOT_FOUND');
  return result.rows[0]!;
}

async function fundTreasury(
  commandBus: InstanceType<ApiCommandBusModule['WorldCommandBus']>,
  actor: ApiActor,
  pool: Pool,
  targets: EconomyTargets,
  source: { next(): string },
): Promise<void> {
  const state = await runtimeState(pool);
  const economy = await pool.query<{ economy_version: string }>(
    `select row_version::text as economy_version from world_economy_heads where world_id=$1`,
    [worldId],
  );
  if (!economy.rows[0]) throw new Error('ECONOMY_STREAM_NOT_FOUND');
  const result = await commandBus.submit(
    actor,
    worldId,
    {
      commandId: source.next(),
      expectedAggregateVersion: economy.rows[0].economy_version,
      expectedStateRevision: state.state_revision,
      expectedWorldVersion: state.design_version,
      idempotencyKey: `governance-lifecycle-fund-treasury-${source.next()}`,
      payload: {
        amount: '1.00',
        destinationWalletId: targets.treasury_wallet_id,
        expectedDestinationVersion: targets.treasury_wallet_version,
        expectedSourceVersion: targets.creator_wallet_version,
        memo: 'Fund deterministic governance compensation lifecycle evidence.',
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
        idempotencyKey: `governance-lifecycle-advance-${row.current_tick}-${ticks}`,
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
  pool: Pool,
): Promise<Awaited<ReturnType<GovernanceScheduleRunner['reconcile']>>> {
  const applied: Awaited<ReturnType<GovernanceScheduleRunner['reconcile']>> = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const results = await runner.reconcile();
    if (results.length === 0) return applied;
    const failure = results.find((result) => result.outcome !== 'accepted');
    if (failure) {
      const command = await pool.query<{ response_summary: Record<string, unknown> }>(
        `select command.response_summary
           from scheduled_actions action
           join command_records command
             on command.world_id=action.world_id
            and command.causation_id=action.completed_event_id
          where action.world_id=$1 and action.id=$2
          order by command.requested_at desc,command.id desc limit 1`,
        [worldId, failure.scheduledActionId],
      );
      throw new Error(
        `Governance schedule failed: ${JSON.stringify({ ...failure, command: command.rows[0]?.response_summary })}`,
      );
    }
    applied.push(...results);
  }
  throw new Error('GOVERNANCE_SCHEDULE_DID_NOT_REACH_IDLE');
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

async function selectedElectionRecord(pool: Pool): Promise<ElectionRecord> {
  const result = await pool.query<ElectionRecord>(
    `select election.id::text,election.office_id::text,election.seat_id::text,
            election.aggregate_version::text,election.status,contest.contest_id::text
       from elections election
       join political_offices office
         on office.world_id=election.world_id and office.id=election.office_id
       join political_office_seats seat
         on seat.world_id=election.world_id and seat.id=election.seat_id
       join election_contests contest
         on contest.world_id=election.world_id and contest.election_id=election.id
      where election.world_id=$1
      order by office.stable_key collate "C",seat.seat_ordinal,election.id
      limit 1`,
    [worldId],
  );
  if (result.rows.length !== 1) throw new Error('ELECTION_NOT_FOUND');
  return result.rows[0]!;
}

async function electionRecord(pool: Pool, electionId: string): Promise<ElectionRecord> {
  const result = await pool.query<ElectionRecord>(
    `select election.id::text,election.office_id::text,election.seat_id::text,
            election.aggregate_version::text,election.status,contest.contest_id::text
       from elections election
       join election_contests contest
         on contest.world_id=election.world_id and contest.election_id=election.id
      where election.world_id=$1 and election.id=$2`,
    [worldId, electionId],
  );
  if (result.rows.length !== 1) throw new Error('ELECTION_NOT_FOUND');
  return result.rows[0]!;
}

async function officeSeatContext(
  pool: Pool,
  officeId: string,
  seatId: string,
): Promise<{ office_version: string; seat_index: number }> {
  const result = await pool.query<{ office_version: string; seat_index: number }>(
    `select office.row_version::text as office_version,
            (seat.seat_ordinal-1)::integer as seat_index
       from political_offices office
       join political_office_seats seat
         on seat.world_id=office.world_id and seat.office_id=office.id
      where office.world_id=$1 and office.id=$2 and seat.id=$3`,
    [worldId, officeId, seatId],
  );
  if (result.rows.length !== 1) throw new Error('OFFICE_SEAT_CONTEXT_NOT_FOUND');
  return result.rows[0]!;
}

async function vacantOfficeSeatContext(
  pool: Pool,
  officeId: string,
  excludedSeatId: string,
): Promise<{ office_version: string; seat_id: string; seat_index: number }> {
  const result = await pool.query<{
    office_version: string;
    seat_id: string;
    seat_index: number;
  }>(
    `select office.row_version::text as office_version,seat.id::text as seat_id,
            (seat.seat_ordinal-1)::integer as seat_index
       from political_offices office
       join political_office_seats seat
         on seat.world_id=office.world_id and seat.office_id=office.id
      where office.world_id=$1 and office.id=$2 and seat.id<>$3
        and seat.status='active'
        and not exists (
          select 1 from office_seat_authority_intervals authority
           where authority.world_id=seat.world_id and authority.seat_id=seat.id
             and authority.effective_ticks @> (
               select current_tick from world_simulation_clocks where world_id=$1
             )
        )
      order by seat.seat_ordinal
      limit 1`,
    [worldId, officeId, excludedSeatId],
  );
  if (result.rows.length !== 1) throw new Error('VACANT_OFFICE_SEAT_NOT_FOUND');
  return result.rows[0]!;
}

async function officeTermByCommand(pool: Pool, commandId: string): Promise<string> {
  const result = await pool.query<{ term_id: string }>(
    `select id::text as term_id from office_terms
      where world_id=$1 and created_command_id=$2`,
    [worldId, commandId],
  );
  if (result.rows.length !== 1) throw new Error('OFFICE_TERM_NOT_FOUND');
  return result.rows[0]!.term_id;
}

async function electionTermId(pool: Pool, electionId: string): Promise<string> {
  const result = await pool.query<{ term_id: string }>(
    `select term.id::text as term_id
       from office_terms term
       join election_results result
         on result.world_id=term.world_id and result.id=term.source_election_result_id
      where result.world_id=$1 and result.election_id=$2`,
    [worldId, electionId],
  );
  if (result.rows.length !== 1) throw new Error('ELECTION_TERM_NOT_FOUND');
  return result.rows[0]!.term_id;
}

async function seatTermTransitionSnapshot(
  pool: Pool,
  seatId: string,
): Promise<
  Array<{
    authority_from_tick: string;
    authority_until_tick: string;
    holder_entity_id: string;
    latest_reason_code: string;
    latest_status: string;
    latest_transition_tick: string;
    planned_ends_tick: string;
    source_kind: string;
    starts_tick: string;
    term_id: string;
  }>
> {
  const result = await pool.query<{
    authority_from_tick: string;
    authority_until_tick: string;
    holder_entity_id: string;
    latest_reason_code: string;
    latest_status: string;
    latest_transition_tick: string;
    planned_ends_tick: string;
    source_kind: string;
    starts_tick: string;
    term_id: string;
  }>(
    `select term.id::text as term_id,term.holder_entity_id::text,
            term.source_kind::text,term.starts_tick::text,term.planned_ends_tick::text,
            lower(authority.effective_ticks)::text as authority_from_tick,
            upper(authority.effective_ticks)::text as authority_until_tick,
            latest.to_status::text as latest_status,
            latest.effective_tick::text as latest_transition_tick,
            latest.reason_code::text as latest_reason_code
       from office_terms term
       join office_seat_authority_intervals authority
         on authority.world_id=term.world_id and authority.term_id=term.id
       join lateral (
         select transition.to_status,transition.effective_tick,transition.reason_code
           from office_term_transitions transition
          where transition.world_id=term.world_id and transition.term_id=term.id
          order by transition.created_at desc,transition.id desc limit 1
       ) latest on true
      where term.world_id=$1 and term.seat_id=$2
      order by term.starts_tick,term.term_number`,
    [worldId, seatId],
  );
  return result.rows;
}

async function activeSeatAuthorityAt(
  pool: Pool,
  seatId: string,
  tick: string,
): Promise<Array<{ holder_entity_id: string }>> {
  const result = await pool.query<{ holder_entity_id: string }>(
    `select holder_entity_id::text
       from office_seat_authority_intervals
      where world_id=$1 and seat_id=$2 and effective_ticks @> $3::bigint
      order by holder_entity_id`,
    [worldId, seatId, tick],
  );
  return result.rows;
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

async function publicChoiceSummary(
  pool: Pool,
  contestId: string,
): Promise<Array<{ choice: string; count: number }>> {
  const result = await pool.query<{ choice: string; count: number }>(
    `select choice_payload ->> 'choice' as choice,count(*)::integer as count
       from public_ballot_choices
      where world_id=$1 and contest_id=$2
      group by choice_payload ->> 'choice'
      order by choice`,
    [worldId, contestId],
  );
  return result.rows;
}

async function authorityDecision(
  pool: Pool,
  commandId: string,
): Promise<{
  actor_id: string;
  actor_mode: string;
  decision: string;
  reason_code: string;
}> {
  const result = await pool.query<{
    actor_id: string;
    actor_mode: string;
    decision: string;
    reason_code: string;
  }>(
    `select actor_id,actor_mode,decision,reason_code
       from governance_authority_decisions
      where world_id=$1 and command_id=$2`,
    [worldId, commandId],
  );
  if (result.rows.length !== 1) throw new Error('AUTHORITY_DECISION_NOT_FOUND');
  return result.rows[0]!;
}

async function ballotEvidence(
  pool: Pool,
  contestId: string,
  voterEntityId: string,
): Promise<{
  effective_choice: string | null;
  effective_revision: number | null;
  participation_count: number;
  receipt_count: number;
  revision_count: number;
}> {
  const result = await pool.query<{
    effective_choice: string | null;
    effective_revision: number | null;
    participation_count: number;
    receipt_count: number;
    revision_count: number;
  }>(
    `select count(distinct participation.id)::integer as participation_count,
            count(distinct receipt.id)::integer as receipt_count,
            count(distinct revision.id)::integer as revision_count,
            max(effective.effective_revision)::integer as effective_revision,
            max(choice.choice_payload->>'choice') as effective_choice
       from (select 1) singleton
       left join ballot_participation participation
         on participation.world_id=$1 and participation.contest_id=$2
        and participation.voter_entity_id=$3
       left join ballot_receipts receipt
         on receipt.world_id=participation.world_id
        and receipt.participation_id=participation.id
       left join ballot_choice_revisions revision
         on revision.world_id=participation.world_id
        and revision.participation_id=participation.id
       left join ballot_effective_revisions effective
         on effective.world_id=participation.world_id
        and effective.participation_id=participation.id
       left join public_ballot_choices choice
         on choice.world_id=effective.world_id
        and choice.choice_revision_id=effective.choice_revision_id`,
    [worldId, contestId, voterEntityId],
  );
  return result.rows[0]!;
}

async function effectivePublicChoiceSummary(
  pool: Pool,
  contestId: string,
): Promise<Array<{ choice: string; count: number }>> {
  const result = await pool.query<{ choice: string; count: number }>(
    `select choice.choice_payload->>'choice' as choice,count(*)::integer as count
       from ballot_effective_revisions effective
       join public_ballot_choices choice
         on choice.world_id=effective.world_id
        and choice.choice_revision_id=effective.choice_revision_id
      where effective.world_id=$1 and effective.contest_id=$2
      group by choice.choice_payload->>'choice'
      order by choice.choice_payload->>'choice'`,
    [worldId, contestId],
  );
  return result.rows;
}

async function failedProjectEnactmentSnapshot(
  pool: Pool,
  proposalId: string,
  treasuryWalletId: string,
): Promise<{
  action_enactments: number;
  encumbrances: number;
  enactment_attempts: number;
  failed_attempts: number;
  project_authorizations: number;
  spendable_minor: string;
  status: string;
  succeeded_attempts: number;
}> {
  const result = await pool.query<{
    action_enactments: number;
    encumbrances: number;
    enactment_attempts: number;
    failed_attempts: number;
    project_authorizations: number;
    spendable_minor: string;
    status: string;
    succeeded_attempts: number;
  }>(
    `select proposal.status,
            (select count(*)::integer from proposal_enactments enactment
              where enactment.world_id=proposal.world_id
                and enactment.proposal_id=proposal.id) as enactment_attempts,
            (select count(*)::integer from proposal_enactments enactment
              where enactment.world_id=proposal.world_id
                and enactment.proposal_id=proposal.id
                and enactment.status='failed') as failed_attempts,
            (select count(*)::integer from proposal_enactments enactment
              where enactment.world_id=proposal.world_id
                and enactment.proposal_id=proposal.id
                and enactment.status='succeeded') as succeeded_attempts,
            (select count(*)::integer
               from proposal_action_enactments effect
               join proposal_enactments enactment
                 on enactment.world_id=effect.world_id
                and enactment.id=effect.proposal_enactment_id
              where enactment.world_id=proposal.world_id
                and enactment.proposal_id=proposal.id) as action_enactments,
            (select count(*)::integer
               from public_project_authorizations project_authorization
               join proposal_actions action
                 on action.world_id=project_authorization.world_id
                and action.id=project_authorization.proposal_action_id
              where action.world_id=proposal.world_id
                and action.proposal_id=proposal.id) as project_authorizations,
            (select count(*)::integer
               from treasury_encumbrances encumbrance
               join public_project_authorizations project_authorization
                 on project_authorization.world_id=encumbrance.world_id
                and project_authorization.id=encumbrance.project_authorization_id
               join proposal_actions action
                 on action.world_id=project_authorization.world_id
                and action.id=project_authorization.proposal_action_id
              where action.world_id=proposal.world_id
                and action.proposal_id=proposal.id) as encumbrances,
            public.worldgraph_wallet_spendable_minor_v1($1,$3)::text as spendable_minor
       from proposals proposal
      where proposal.world_id=$1 and proposal.id=$2`,
    [worldId, proposalId, treasuryWalletId],
  );
  if (result.rows.length !== 1) throw new Error('FAILED_PROJECT_SNAPSHOT_NOT_FOUND');
  return result.rows[0]!;
}

async function compensationRepairMaterial(
  pool: Pool,
  proposalId: string,
): Promise<{
  compensationPlanChecksum: string;
  proposalVersion: string;
  sourceResultChecksum: string;
  sourceResultId: string;
}> {
  const source = await pool.query<{
    proposal_version: string;
    result_checksum: string;
    result_id: string;
  }>(
    `select proposal.aggregate_version::text as proposal_version,
            result.id::text as result_id,encode(result.result_checksum,'hex') as result_checksum
       from proposals proposal
       join proposal_results result
         on result.world_id=proposal.world_id and result.proposal_id=proposal.id
        and result.repair_of_result_id is null
      where proposal.world_id=$1 and proposal.id=$2`,
    [worldId, proposalId],
  );
  if (source.rows.length !== 1) throw new Error('COMPENSATION_SOURCE_RESULT_NOT_FOUND');
  const result = source.rows[0]!;
  const actions = await pool.query<{
    action_checksum: string;
    action_id: string;
    action_ordinal: number;
    action_payload: Record<string, unknown>;
  }>(
    `select id::text as action_id,action_ordinal,action_payload,
            encode(checksum,'hex') as action_checksum
       from proposal_actions
      where world_id=$1 and proposal_id=$2
      order by action_ordinal`,
    [worldId, proposalId],
  );
  if (actions.rows.length < 1) throw new Error('COMPENSATION_ACTIONS_NOT_FOUND');
  const compensationPlanChecksum = createHash('sha256')
    .update(
      canonicalJson({
        actions: actions.rows.map((action) => ({
          actionChecksum: action.action_checksum,
          actionId: action.action_id,
          actionOrdinal: action.action_ordinal,
          actionPayload: action.action_payload,
        })),
        algorithmVersion: 'governance_certification_compensation_v1',
        proposalId,
        sourceResultChecksum: result.result_checksum,
        sourceResultId: result.result_id,
      }),
      'utf8',
    )
    .digest('hex');
  return {
    compensationPlanChecksum,
    proposalVersion: result.proposal_version,
    sourceResultChecksum: result.result_checksum,
    sourceResultId: result.result_id,
  };
}

async function privilegedProvenanceSnapshot(
  pool: Pool,
  repairCommandId: string,
  overrideCommandId: string,
): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, number>>(
    `select
       (select count(*)::integer from governance_repairs
         where world_id=$1 and command_id=$2) as repair_records,
       (select count(*)::integer from governance_overrides
         where world_id=$1 and command_id=$3) as override_records,
       (select count(*)::integer from creator_override_records
         where world_id=$1 and command_id=$3) as override_audit_records,
       (select count(*)::integer from domain_events
         where world_id=$1 and command_id=$2
           and event_type='GovernanceRepairAppendedV1') as repair_events,
       (select count(*)::integer from domain_events
         where world_id=$1 and command_id=$3
           and event_type='GovernanceOverrideExecutedV1') as override_events,
       (select count(*)::integer from ledger_entries
         where world_id=$1 and command_id=$2 and entry_kind='repair_anchor')
         as repair_ledger_entries,
       (select count(*)::integer from ledger_entries
         where world_id=$1 and command_id=$3 and entry_kind='override')
         as override_ledger_entries,
       (select count(*)::integer from governance_repairs
         where world_id=$1 and command_id=$3) as repair_rows_with_override_provenance,
       (select count(*)::integer from governance_overrides
         where world_id=$1 and command_id=$2) as override_rows_with_repair_provenance`,
    [worldId, repairCommandId, overrideCommandId],
  );
  return result.rows[0]!;
}

async function recentCredentialEvidence(
  pool: Pool,
  commandIds: string[],
): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, number>>(
    `select
       count(distinct proof.id)::integer as proofs,
       count(distinct consumption.proof_id)::integer as proof_consumptions,
       count(distinct proof.command_id)::integer as bound_commands,
       count(distinct encode(proof.command_request_hash,'hex'))::integer
         as distinct_command_hashes,
       count(distinct proof.session_id)::integer as sessions,
       count(distinct proof.user_id)::integer as users,
       count(distinct audit.id)::integer as reauthentication_audits
       from recent_credential_proofs proof
       join recent_credential_proof_consumptions consumption
         on consumption.proof_id=proof.id
        and consumption.command_id=proof.command_id
        and consumption.command_request_hash=proof.command_request_hash
       join security_audit_records audit
         on audit.id=proof.audit_record_id
        and audit.category='identity'
        and audit.action='identity.reauthenticate'
        and audit.outcome='allowed'
      where proof.world_id=$1 and proof.command_id=any($2::uuid[])`,
    [worldId, commandIds],
  );
  return result.rows[0]!;
}

async function gatewayActorEvidence(
  pool: Pool,
  commandIds: string[],
): Promise<Array<{ actor_id: string; command_type: string; decision: string }>> {
  const result = await pool.query<{
    actor_id: string;
    command_type: string;
    decision: string;
  }>(
    `select decision.actor_id,command.command_type,decision.decision
       from unnest($2::uuid[]) with ordinality requested(command_id,ordinal)
       join governance_authority_decisions decision
         on decision.world_id=$1 and decision.command_id=requested.command_id
       join command_records command
         on command.world_id=decision.world_id and command.id=decision.command_id
      order by requested.ordinal`,
    [worldId, commandIds],
  );
  return result.rows;
}

async function proposalFinalSnapshot(
  pool: Pool,
  proposalId: string,
): Promise<{
  action_enactments: number;
  enactments: number;
  laws: number;
  outcome: string | null;
  results: number;
  status: string;
}> {
  const result = await pool.query<{
    action_enactments: number;
    enactments: number;
    laws: number;
    outcome: string | null;
    results: number;
    status: string;
  }>(
    `select proposal.status,
            (select result.outcome from proposal_results result
              where result.world_id=proposal.world_id and result.proposal_id=proposal.id
                and result.repair_of_result_id is null) as outcome,
            (select count(*)::integer from proposal_results result
              where result.world_id=proposal.world_id and result.proposal_id=proposal.id)
              as results,
            (select count(*)::integer from proposal_enactments enactment
              where enactment.world_id=proposal.world_id and enactment.proposal_id=proposal.id)
              as enactments,
            (select count(*)::integer
               from proposal_action_enactments action_enactment
               join proposal_enactments enactment
                 on enactment.world_id=action_enactment.world_id
                and enactment.id=action_enactment.proposal_enactment_id
              where enactment.world_id=proposal.world_id and enactment.proposal_id=proposal.id)
              as action_enactments,
            (select count(*)::integer from law_versions law_version
              where law_version.world_id=proposal.world_id
                and law_version.source_proposal_result_id in (
                  select result.id from proposal_results result
                   where result.world_id=proposal.world_id and result.proposal_id=proposal.id
                )) as laws
       from proposals proposal
      where proposal.world_id=$1 and proposal.id=$2`,
    [worldId, proposalId],
  );
  if (result.rows.length !== 1) throw new Error('PROPOSAL_FINAL_STATE_NOT_FOUND');
  return result.rows[0]!;
}

async function proposalCertificationCommandId(pool: Pool, proposalId: string): Promise<string> {
  const result = await pool.query<{ command_id: string }>(
    `select certified_command_id::text as command_id
       from proposal_results where world_id=$1 and proposal_id=$2`,
    [worldId, proposalId],
  );
  if (result.rows.length !== 1) throw new Error('PROPOSAL_CERTIFICATION_COMMAND_MISSING');
  return result.rows[0]!.command_id;
}

async function electionFinalSnapshot(
  pool: Pool,
  electionId: string,
): Promise<{
  authority_intervals: number;
  holder_entity_id: string | null;
  outcome: string | null;
  results: number;
  starts_tick: string | null;
  status: string;
  terms: number;
}> {
  const result = await pool.query<{
    authority_intervals: number;
    holder_entity_id: string | null;
    outcome: string | null;
    results: number;
    starts_tick: string | null;
    status: string;
    terms: number;
  }>(
    `select election.status,
            (select result.outcome from election_results result
              where result.world_id=election.world_id and result.election_id=election.id
                and result.repair_of_result_id is null) as outcome,
            (select count(*)::integer from election_results result
              where result.world_id=election.world_id and result.election_id=election.id)
              as results,
            (select count(*)::integer from office_terms term
              where term.world_id=election.world_id and term.source_election_result_id in (
                select result.id from election_results result
                 where result.world_id=election.world_id and result.election_id=election.id
              )) as terms,
            (select term.holder_entity_id::text from office_terms term
              where term.world_id=election.world_id and term.source_election_result_id in (
                select result.id from election_results result
                 where result.world_id=election.world_id and result.election_id=election.id
              ) order by term.id limit 1) as holder_entity_id,
            (select term.starts_tick::text from office_terms term
              where term.world_id=election.world_id and term.source_election_result_id in (
                select result.id from election_results result
                 where result.world_id=election.world_id and result.election_id=election.id
              ) order by term.id limit 1) as starts_tick,
            (select count(*)::integer
               from office_seat_authority_intervals authority
               join office_terms term
                 on term.world_id=authority.world_id and term.id=authority.term_id
              where term.world_id=election.world_id and term.source_election_result_id in (
                select result.id from election_results result
                 where result.world_id=election.world_id and result.election_id=election.id
              )) as authority_intervals
       from elections election
      where election.world_id=$1 and election.id=$2`,
    [worldId, electionId],
  );
  if (result.rows.length !== 1) throw new Error('ELECTION_FINAL_STATE_NOT_FOUND');
  return result.rows[0]!;
}

async function electionCertificationCommandId(pool: Pool, electionId: string): Promise<string> {
  const result = await pool.query<{ command_id: string }>(
    `select certified_command_id::text as command_id
       from election_results where world_id=$1 and election_id=$2`,
    [worldId, electionId],
  );
  if (result.rows.length !== 1) throw new Error('ELECTION_CERTIFICATION_COMMAND_MISSING');
  return result.rows[0]!.command_id;
}

async function lifecycleCounts(pool: Pool): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, number>>(
    `select
       (select count(*)::integer from world_memberships
         where world_id=$1 and status='active') as active_members,
       (select count(*)::integer from world_entity_controllers
         where world_id=$1 and control_scope='primary' and revoked_at is null)
         as primary_controllers,
       (select count(*)::integer from proposals where world_id=$1) as proposals,
       (select count(*)::integer from proposal_results where world_id=$1)
         as proposal_results,
       (select count(*)::integer from proposal_enactments where world_id=$1)
         as proposal_enactments,
       (select count(*)::integer from proposal_action_enactments where world_id=$1)
         as proposal_action_enactments,
       (select count(*)::integer from law_versions
         where world_id=$1 and source_proposal_result_id is not null) as proposal_laws,
       (select count(*)::integer from elections where world_id=$1) as elections,
       (select count(*)::integer from elections
         where world_id=$1 and status='cancelled') as cancelled_elections,
       (select count(*)::integer from elections
         where world_id=$1 and status='certified') as certified_elections,
       (select count(*)::integer from election_results where world_id=$1)
         as election_results,
       (select count(*)::integer from candidacies
         where world_id=$1 and status='accepted') as accepted_candidacies,
       (select count(*)::integer from eligibility_snapshots where world_id=$1)
         as eligibility_snapshots,
       (select count(*)::integer from eligibility_snapshot_members where world_id=$1)
         as eligibility_snapshot_members,
       (select count(*)::integer from ballot_participation where world_id=$1)
         as ballot_participation,
       (select count(*)::integer from ballot_receipts where world_id=$1)
         as ballot_receipts,
       (select count(*)::integer from public_ballot_choices where world_id=$1)
         as public_choices,
       (select count(*)::integer from secret_ballot_choices where world_id=$1)
         as secret_choices,
       (select count(*)::integer from office_terms where world_id=$1) as office_terms,
       (select count(*)::integer from office_seat_authority_intervals where world_id=$1)
         as office_authority_intervals,
       (select count(*)::integer from scheduled_actions
         where world_id=$1 and status='completed'
           and action_type in (
             'OpenProposalVotingV1','CloseAndTallyProposalV1',
             'CertifyAndEnactProposalV1','OpenElectionV1',
             'CloseAndTallyElectionV1','CertifyElectionV1'
           )) as completed_schedules,
       (select count(*)::integer from governance_schedule_occurrences where world_id=$1)
         as schedule_occurrences`,
    [worldId],
  );
  return result.rows[0]!;
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
       ($1,'governance-creator@example.test',$5,'Governance Creator'),
       ($2,'governance-player@example.test',$5,'Governance Player'),
       ($3,'governance-third@example.test',$5,'Governance Third Player'),
       ($4,'governance-outsider@example.test',$5,'Governance Outsider')`,
      [creatorId, playerId, thirdPlayerId, nonmemberId, passwordHash],
    );
    await client.query(
      `insert into worlds(id,slug,name,created_by_user_id)
       values ($1,'governance-command-postgres','Governance Command PostgreSQL',$2)`,
      [worldId, creatorId],
    );
    await client.query(
      `insert into world_memberships(world_id,user_id,role,granted_by_user_id)
       values ($1,$2,'creator',$2),($1,$3,'player',$2),($1,$4,'player',$2)`,
      [worldId, creatorId, playerId, thirdPlayerId],
    );
    await client.query(
      `insert into sessions(
         id,user_id,token_hash,csrf_hash,auth_version,idle_expires_at,absolute_expires_at
       ) values
       ($1,$2,decode(repeat('11',32),'hex'),decode(repeat('21',32),'hex'),1,
         '2098-12-31T00:00:00Z','2099-01-01T00:00:00Z'),
       ($3,$4,decode(repeat('12',32),'hex'),decode(repeat('22',32),'hex'),1,
         '2098-12-31T00:00:00Z','2099-01-01T00:00:00Z'),
       ($5,$6,decode(repeat('13',32),'hex'),decode(repeat('23',32),'hex'),1,
         '2098-12-31T00:00:00Z','2099-01-01T00:00:00Z'),
       ($7,$8,decode(repeat('14',32),'hex'),decode(repeat('24',32),'hex'),1,
         '2098-12-31T00:00:00Z','2099-01-01T00:00:00Z')`,
      [
        creatorSessionId,
        creatorId,
        playerSessionId,
        playerId,
        thirdPlayerSessionId,
        thirdPlayerId,
        nonmemberSessionId,
        nonmemberId,
      ],
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
        COMPILER_VERSION,
        seed,
        creatorId,
        'governance-command-compilation-0001',
      ],
    );
    await client.query(
      `update worlds
          set lifecycle='compiling',row_version=row_version+1,updated_at=now()
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
            runtime.last_event_sequence::text,
            runtime.last_ledger_sequence::text,
            ledger.next_event_sequence::text,
            ledger.next_ledger_sequence::text
       from world_runtime_heads runtime
       join world_versions version
         on version.world_id=runtime.world_id and version.id=runtime.active_world_version_id
       join world_simulation_clocks clock on clock.world_id=runtime.world_id
       join world_ledger_heads ledger on ledger.world_id=runtime.world_id
      where runtime.world_id=$1`,
    [worldId],
  );
  return result.rows[0]!;
}

async function governanceReplayGolden(
  pool: Pool,
  targetWorldId: string,
): Promise<{
  eventStreamChecksum: string;
  governanceStateChecksum: string;
  termScheduleChecksum: string;
}> {
  const result = await pool.query<{
    event_stream: unknown;
    term_schedule: unknown;
  }>(
    `select coalesce((
         select jsonb_agg(jsonb_build_object(
           'aggregateId',event.aggregate_id::text,
           'aggregateType',event.aggregate_type,
           'aggregateVersion',event.aggregate_version::text,
           'eventOrdinal',event.event_ordinal,
           'eventType',event.event_type,
           'payload',event.payload,
           'resultingStateRevision',event.resulting_state_revision::text,
           'worldEventSequence',event.world_event_sequence::text
         ) order by event.world_event_sequence)
           from domain_events event
          where event.world_id=$1 and event.event_type=any($2::text[])
       ),'[]'::jsonb) as event_stream,
       jsonb_build_object(
         'elections',coalesce((
           select jsonb_agg(jsonb_build_object(
             'certificationTick',election.certification_tick::text,
             'electionId',election.id::text,
             'kind',election.election_kind,
             'nominationClosesTick',election.nomination_closes_tick::text,
             'nominationOpensTick',election.nomination_opens_tick::text,
             'officeKey',office.stable_key::text,
             'seatIndex',seat.seat_ordinal-1,
             'status',election.status,
             'termStartsTick',election.term_starts_tick::text,
             'votingClosesTick',election.voting_closes_tick::text,
             'votingOpensTick',election.voting_opens_tick::text
           ) order by office.stable_key::text,seat.seat_ordinal,election.term_starts_tick,election.id)
             from elections election
             join political_offices office
               on office.world_id=election.world_id and office.id=election.office_id
             join political_office_seats seat
               on seat.world_id=election.world_id and seat.id=election.seat_id
            where election.world_id=$1
         ),'[]'::jsonb),
         'terms',coalesce((
           select jsonb_agg(jsonb_build_object(
             'checksum',encode(term.checksum,'hex'),
             'endsTick',term.planned_ends_tick::text,
             'holderEntityId',term.holder_entity_id::text,
             'officeKey',office.stable_key::text,
             'seatIndex',seat.seat_ordinal-1,
             'sourceElectionResultId',term.source_election_result_id::text,
             'sourceKind',term.source_kind,
             'sourceProposalResultId',term.source_proposal_result_id::text,
             'startsTick',term.starts_tick::text,
             'status',term.status,
             'termId',term.id::text,
             'termNumber',term.term_number
           ) order by office.stable_key::text,seat.seat_ordinal,term.starts_tick,term.id)
             from office_terms term
             join political_offices office
               on office.world_id=term.world_id and office.id=term.office_id
             join political_office_seats seat
               on seat.world_id=term.world_id and seat.id=term.seat_id
            where term.world_id=$1
         ),'[]'::jsonb)
       ) as term_schedule
      from world_governance_heads head where head.world_id=$1`,
    [
      targetWorldId,
      [
        'ElectionBallotRecordedPublicV1',
        'ElectionBallotRecordedSecretV1',
        'GovernanceCandidacyChangedV1',
        'GovernanceLawVersionActivatedV1',
        'GovernanceLifecycleChangedV1',
        'GovernanceOfficeTermChangedV1',
        'GovernanceOverrideExecutedV1',
        'GovernanceRepairAppendedV1',
        'GovernanceResultFinalizedV1',
        'GovernanceSeedPlanAdoptedV1',
        'ProposalBallotRecordedPublicV1',
        'ProposalBallotRecordedSecretV1',
        'WorldGovernanceInitializedV1',
      ],
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('GOVERNANCE_REPLAY_GOLDEN_WORLD_MISSING');
  const projectionState = await canonicalGovernanceProjectionState(pool, targetWorldId);
  const hash = (domain: string, value: unknown) =>
    createHash('sha256').update(canonicalJson({ domain, value }), 'utf8').digest('hex');
  return {
    eventStreamChecksum: hash('worldgraph.governance-event-stream-golden.v1', row.event_stream),
    governanceStateChecksum: hash(
      'worldgraph.governance-semantic-projection-golden.v1',
      projectionState,
    ),
    termScheduleChecksum: hash('worldgraph.governance-term-schedule-golden.v1', row.term_schedule),
  };
}

const governanceSemanticProjectionTables = [
  'ballot_choice_revisions',
  'ballot_effective_revisions',
  'ballot_participation',
  'ballot_receipts',
  'candidacies',
  'candidacy_transitions',
  'charter_authority_intervals',
  'election_contests',
  'election_results',
  'election_tallies',
  'election_tally_counts',
  'elections',
  'eligibility_snapshot_members',
  'eligibility_snapshots',
  'governance_contests',
  'governance_overrides',
  'governance_repairs',
  'governance_schedule_occurrences',
  'governance_tax_policy_lineage',
  'governing_charter_versions',
  'governing_charters',
  'institution_powers',
  'institutions',
  'law_authority_intervals',
  'law_effectivity_transitions',
  'law_versions',
  'laws',
  'office_power_delegations',
  'office_powers',
  'office_seat_authority_intervals',
  'office_term_transitions',
  'office_terms',
  'political_office_seats',
  'political_offices',
  'proposal_action_enactments',
  'proposal_actions',
  'proposal_contests',
  'proposal_enactments',
  'proposal_results',
  'proposal_sponsors',
  'proposal_tallies',
  'proposal_tally_counts',
  'proposal_transitions',
  'proposals',
  'public_project_authorizations',
  'tax_policy_authority_intervals',
  'treasury_encumbrance_facts',
  'treasury_encumbrance_projections',
  'treasury_encumbrances',
  'world_governance_heads',
] as const;

const governanceProjectionSurrogateColumns: Partial<
  Record<(typeof governanceSemanticProjectionTables)[number], readonly string[]>
> = {
  // M09 created these tax-policy identities before deterministic governance IDs existed.
  // Their stable type, scope, currency, tick range, version, and provenance remain hashed.
  governance_tax_policy_lineage: ['id', 'new_tax_policy_id', 'previous_tax_policy_id'],
  tax_policy_authority_intervals: ['id', 'tax_policy_id'],
};

const governanceProjectionWallClockColumns = [
  'approved_at',
  'certified_at',
  'consumed_at',
  'created_at',
  'expires_at',
  'generated_at',
  'issued_at',
  'tallied_at',
  'updated_at',
  'verified_at',
] as const;

async function canonicalGovernanceProjectionState(
  pool: Pool,
  targetWorldId: string,
): Promise<Record<string, readonly unknown[]>> {
  const entries = await Promise.all(
    governanceSemanticProjectionTables.map(async (tableName) => {
      const excludedColumns = [
        ...governanceProjectionWallClockColumns,
        ...(governanceProjectionSurrogateColumns[tableName] ?? []),
        // This integrity checkpoint chains timestamped audit-event hashes; the semantic
        // event stream and projection rows are independently canonicalized by this golden.
        ...(tableName === 'world_governance_heads' ? ['checksum'] : []),
      ];
      const result = await pool.query<{ value: unknown }>(
        `select to_jsonb(source) - $2::text[] as value
           from ${tableName} source
          where source.world_id=$1
          order by public.worldgraph_canonical_jsonb(
            to_jsonb(source) - $2::text[]
          ) collate "C"`,
        [targetWorldId, excludedColumns],
      );
      return [tableName, result.rows.map((row) => row.value)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function batchSnapshot(pool: Pool, commandId: string): Promise<BatchSnapshot> {
  const result = await pool.query<BatchSnapshot>(
    `select
       (select count(*)::integer from domain_events where command_id=$2) as "eventCount",
       (select count(*)::integer from ledger_entries where command_id=$2) as "ledgerCount",
       (select count(*)::integer from world_history_entries where command_id=$2) as "historyCount",
       (select count(*)::integer from outbox_messages outbox
         join domain_events event on event.id=outbox.event_id
        where event.command_id=$2) as "outboxCount",
       (select count(*)::integer from scheduled_actions
         where world_id=$1 and created_command_id=$2) as "scheduleCount"`,
    [worldId, commandId],
  );
  return result.rows[0]!;
}

async function expectDurableGovernanceEventBatch(
  pool: Pool,
  commandId: string,
  expectedEventTypes: readonly string[],
  scheduled: boolean,
): Promise<PersistedEventRow[]> {
  const events = await pool.query<PersistedEventRow>(
    `select id::text,event_ordinal,aggregate_type,aggregate_id::text,
            aggregate_version::text,event_type,payload,
            world_event_sequence::text,recorded_at
       from domain_events
      where world_id=$1 and command_id=$2
      order by event_ordinal`,
    [worldId, commandId],
  );
  expect(events.rows.map((event) => event.event_type)).toEqual(expectedEventTypes);
  expect(events.rows.map((event) => event.event_ordinal)).toEqual(
    expectedEventTypes.map((_, ordinal) => ordinal),
  );
  expect(new Set(events.rows.map((event) => event.id)).size).toBe(events.rows.length);

  const surfaces = await pool.query<{
    event_ids: string[];
    history_event_ids: string[];
    ledger_event_ids: string[];
    ledger_ids: string[];
    occurrence_event_ids: string[];
    outbox_event_ids: string[];
    response_event_ids: string[];
  }>(
    `select
       (select array_agg(event.id::text order by event.event_ordinal)
          from domain_events event where event.world_id=command.world_id
            and event.command_id=command.id) as event_ids,
       (select array_agg(entry.id::text order by entry.ledger_sequence)
          from ledger_entries entry where entry.world_id=command.world_id
            and entry.command_id=command.id and entry.event_id is not null) as ledger_ids,
       (select array_agg(entry.event_id::text order by entry.ledger_sequence)
          from ledger_entries entry where entry.world_id=command.world_id
            and entry.command_id=command.id and entry.event_id is not null) as ledger_event_ids,
       (select array_agg(history.event_id::text order by history.ledger_sequence)
          from world_history_entries history where history.world_id=command.world_id
            and history.command_id=command.id) as history_event_ids,
       (select array_agg(outbox.event_id::text order by event.event_ordinal)
          from outbox_messages outbox
          join domain_events event on event.world_id=outbox.world_id and event.id=outbox.event_id
         where event.command_id=command.id) as outbox_event_ids,
       (select coalesce(array_agg(occurrence.event_id::text order by occurrence.created_at),array[]::text[])
          from governance_schedule_occurrences occurrence
         where occurrence.world_id=command.world_id and occurrence.command_id=command.id)
         as occurrence_event_ids,
       array(select jsonb_array_elements_text(command.response_summary->'eventIds'))
         as response_event_ids
      from command_records command where command.world_id=$1 and command.id=$2`,
    [worldId, commandId],
  );
  const eventIds = events.rows.map((event) => event.id);
  expect(surfaces.rows[0]).toMatchObject({
    event_ids: eventIds,
    history_event_ids: eventIds,
    ledger_event_ids: eventIds,
    occurrence_event_ids: scheduled ? [eventIds[0]] : [],
    outbox_event_ids: eventIds,
    response_event_ids: eventIds,
  });
  expect(new Set(surfaces.rows[0]!.ledger_ids).size).toBe(events.rows.length);
  await expect(batchSnapshot(pool, commandId)).resolves.toEqual({
    eventCount: events.rows.length,
    historyCount: events.rows.length,
    ledgerCount: events.rows.length + 1,
    outboxCount: events.rows.length,
    scheduleCount: expectedEventTypes.filter(
      (eventType) => eventType === 'ScheduledActionCreatedV1',
    ).length,
  });

  const heads = await pool.query<{ current_version: string }>(
    `select head.current_version::text
       from unnest($2::text[],$3::text[],$4::bigint[]) with ordinality
         as expected(aggregate_type,aggregate_id,aggregate_version,ordinal)
       join aggregate_stream_heads head on head.world_id=$1
        and head.aggregate_type=expected.aggregate_type
        and head.aggregate_id=expected.aggregate_id
        and head.current_version=expected.aggregate_version
      order by expected.ordinal`,
    [
      worldId,
      events.rows.map((event) => event.aggregate_type),
      events.rows.map((event) => event.aggregate_id),
      events.rows.map((event) => event.aggregate_version),
    ],
  );
  expect(heads.rows).toHaveLength(events.rows.length);

  for (const event of events.rows) {
    if (event.event_type === 'GovernanceLawVersionActivatedV1') {
      const provenance = await pool.query<{
        law_created_event_id: string | null;
        version_created_event_id: string;
        transition_event_id: string;
      }>(
        `select case when version.version_kind='create' then law.created_event_id::text end
                  as law_created_event_id,
                version.created_event_id::text as version_created_event_id,
                transition.event_id::text as transition_event_id
           from law_versions version
           join laws law on law.world_id=version.world_id and law.id=version.law_id
           join law_effectivity_transitions transition
             on transition.world_id=version.world_id
            and transition.law_version_id=version.id
          where version.world_id=$1 and version.id=$2`,
        [worldId, event.aggregate_id],
      );
      expect(provenance.rows).toHaveLength(1);
      expect(provenance.rows[0]).toMatchObject({
        version_created_event_id: event.id,
        transition_event_id: event.id,
      });
      if (provenance.rows[0]!.law_created_event_id !== null) {
        expect(provenance.rows[0]!.law_created_event_id).toBe(event.id);
      }
    }

    if (event.event_type === 'GovernanceOfficeTermChangedV1') {
      const status = event.payload.status;
      expect(['active', 'ended', 'removed']).toContain(status);
      const provenance = await pool.query<{
        created_event_id: string;
        transition_event_id: string;
      }>(
        `select term.created_event_id::text,
                transition.event_id::text as transition_event_id
           from office_terms term
           join office_term_transitions transition
             on transition.world_id=term.world_id and transition.term_id=term.id
          where term.world_id=$1 and term.id=$2 and transition.to_status=$3`,
        [worldId, event.aggregate_id, status],
      );
      expect(provenance.rows).toHaveLength(1);
      expect(provenance.rows[0]!.transition_event_id).toBe(event.id);
      if (status === 'active') {
        expect(provenance.rows[0]!.created_event_id).toBe(event.id);
      }
    }
  }
  return events.rows;
}

async function expectCompleteBatch(
  pool: Pool,
  commandId: string,
  before: RuntimeState,
  result: Extract<
    Awaited<ReturnType<PostgresGovernanceCommandExecutor['execute']>>['result'],
    { status: 'accepted' }
  >,
  expectedScheduleCount: number,
): Promise<void> {
  const events = await pool.query<PersistedEventRow>(
    `select id::text,event_ordinal,aggregate_type,aggregate_id::text,
            aggregate_version::text,event_type,payload,
            world_event_sequence::text,recorded_at
       from domain_events
      where world_id=$1 and command_id=$2
      order by event_ordinal`,
    [worldId, commandId],
  );
  const schedules = await pool.query<PersistedScheduleRow>(
    `select id::text,schedule_sequence::text,due_tick::text,priority,action_type,
            action_schema_version,payload,encode(payload_hash,'hex') as payload_hash,
            process_version,created_at,updated_at
       from scheduled_actions
      where world_id=$1 and created_command_id=$2
      order by scheduled_actions.schedule_sequence`,
    [worldId, commandId],
  );
  const eventCount = expectedScheduleCount + 1;
  expect(events.rows).toHaveLength(eventCount);
  expect(schedules.rows).toHaveLength(expectedScheduleCount);
  expect(events.rows.map((event) => event.event_ordinal)).toEqual(
    Array.from({ length: eventCount }, (_, ordinal) => ordinal),
  );
  expect(events.rows.map((event) => event.id)).toEqual(result.eventIds);
  expect(events.rows.map((event) => event.world_event_sequence)).toEqual(
    decimalRange(before.next_event_sequence, eventCount),
  );
  expect(result.eventSequenceRange).toEqual({
    from: before.next_event_sequence,
    to: (BigInt(before.next_event_sequence) + BigInt(eventCount - 1)).toString(),
  });
  expect(result.ledgerSequenceRange).toEqual({
    from: before.next_ledger_sequence,
    to: (BigInt(before.next_ledger_sequence) + BigInt(eventCount)).toString(),
  });

  const scheduleEvents = events.rows.slice(1);
  expect(scheduleEvents).toHaveLength(schedules.rows.length);
  expect(
    scheduleEvents.map((event) => ({
      aggregateId: event.aggregate_id,
      aggregateType: event.aggregate_type,
      aggregateVersion: event.aggregate_version,
      eventType: event.event_type,
      payload: event.payload,
    })),
  ).toEqual(
    schedules.rows.map((schedule) => ({
      aggregateId: schedule.id,
      aggregateType: 'scheduled_action',
      aggregateVersion: '1',
      eventType: 'ScheduledActionCreatedV1',
      payload: {
        actionSchemaVersion: schedule.action_schema_version,
        actionType: schedule.action_type,
        dueTick: schedule.due_tick,
        payload: schedule.payload,
        payloadHash: schedule.payload_hash,
        priority: schedule.priority,
        processVersion: schedule.process_version,
        scheduleId: schedule.id,
        scheduleSequence: schedule.schedule_sequence,
      },
    })),
  );
  expect(
    schedules.rows.every(
      (schedule) => schedule.created_at.getTime() === schedule.updated_at.getTime(),
    ),
  ).toBe(true);
  expect(
    schedules.rows.every(
      (schedule, index) =>
        schedule.created_at.getTime() === scheduleEvents[index]!.recorded_at.getTime(),
    ),
  ).toBe(true);

  const ledger = await pool.query<{
    entry_kind: string;
    event_id: string | null;
    ledger_sequence: string;
  }>(
    `select ledger_sequence::text,entry_kind,event_id::text
       from ledger_entries where world_id=$1 and command_id=$2
      order by ledger_entries.ledger_sequence`,
    [worldId, commandId],
  );
  expect(ledger.rows.map((entry) => entry.ledger_sequence)).toEqual(
    decimalRange(before.next_ledger_sequence, eventCount + 1),
  );
  expect(ledger.rows[0]).toMatchObject({ entry_kind: 'command_accepted', event_id: null });
  expect(ledger.rows.slice(1).map((entry) => entry.event_id)).toEqual(result.eventIds);

  const atomicSurfaces = await pool.query<{
    history_event_ids: string[];
    outbox_event_ids: string[];
    outbox_payloads: Array<Record<string, unknown>>;
    outbox_statuses: string[];
    response_summary: Record<string, unknown>;
    resulting_state_revision: string;
    status: string;
  }>(
    `select command.status,command.resulting_state_revision::text,
            command.response_summary,
            array(select history.event_id::text from world_history_entries history
                   where history.command_id=command.id order by history.ledger_sequence)
              as history_event_ids,
            array(select outbox.event_id::text
                    from outbox_messages outbox
                    join domain_events event on event.id=outbox.event_id
                   where event.command_id=command.id order by event.event_ordinal)
              as outbox_event_ids,
            (select jsonb_agg(outbox.status::text order by event.event_ordinal)
               from outbox_messages outbox
               join domain_events event on event.id=outbox.event_id
              where event.command_id=command.id)
              as outbox_statuses,
            (select jsonb_agg(outbox.payload order by event.event_ordinal)
               from outbox_messages outbox
               join domain_events event on event.id=outbox.event_id
              where event.command_id=command.id)
              as outbox_payloads
       from command_records command
      where command.world_id=$1 and command.id=$2`,
    [worldId, commandId],
  );
  expect(atomicSurfaces.rows[0]).toMatchObject({
    history_event_ids: result.eventIds,
    outbox_event_ids: result.eventIds,
    outbox_statuses: Array.from({ length: eventCount }, () => 'pending'),
    response_summary: result,
    resulting_state_revision: result.resultingStateRevision,
    status: 'accepted',
  });
  expect(atomicSurfaces.rows[0]!.outbox_payloads).toEqual(
    events.rows.map((event) => ({
      eventId: event.id,
      eventType: event.event_type,
      worldEventSequence: event.world_event_sequence,
      worldId,
    })),
  );
  await expect(batchSnapshot(pool, commandId)).resolves.toEqual({
    eventCount,
    historyCount: eventCount,
    ledgerCount: eventCount + 1,
    outboxCount: eventCount,
    scheduleCount: expectedScheduleCount,
  });

  const after = await runtimeState(pool);
  expect(after).toMatchObject({
    last_event_sequence: (BigInt(before.next_event_sequence) + BigInt(eventCount - 1)).toString(),
    last_ledger_sequence: (BigInt(before.next_ledger_sequence) + BigInt(eventCount)).toString(),
    next_event_sequence: (BigInt(before.next_event_sequence) + BigInt(eventCount)).toString(),
    next_ledger_sequence: (BigInt(before.next_ledger_sequence) + BigInt(eventCount + 1)).toString(),
    state_revision: (BigInt(before.state_revision) + 1n).toString(),
  });
}
