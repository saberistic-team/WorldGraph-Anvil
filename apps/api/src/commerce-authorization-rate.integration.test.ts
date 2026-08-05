import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { RuntimeConfig } from '@worldgraph/config';
import { SystemClock, UuidV7Generator, type ApplicationNotification } from '@worldgraph/contracts';
import {
  applyMigrations,
  createDatabaseClient,
  importStarterPrimitives,
  type DatabaseClient,
} from '@worldgraph/db';
import {
  createDeterministicHarborCityFallback,
  harborCityManifestCatalog,
} from '@worldgraph/manifests';
import { createLogger } from '@worldgraph/observability';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { CompilationRepository } from './compilation/repository.js';
import { CompilationService } from './compilation/service.js';
import type { SimulationClockViewTransport, SubmitWorldCommand } from './commands/api-contracts.js';
import { WorldCommandBus } from './commands/command-bus.js';
import { PostgresCommandRepository } from './commands/repository.js';
import { WorldCommandService } from './commands/service.js';
import type { CommerceCommandPolicy } from './commands/types.js';
import { PostgresCommerceReadRepository } from './economy/commerce-read-repository.js';
import { CommerceReadService } from './economy/commerce-read-service.js';
import { PostgresEconomyQueryRepository } from './economy/repository.js';
import { EconomyQueryService } from './economy/service.js';
import { Argon2idPasswordHasher, TEST_PASSWORD_HASH_OPTIONS } from './identity/security.js';
import type { AuthenticatedActor } from './identity/service.js';
import { IdentityService } from './identity/service.js';
import { PostgresRepository } from './repositories/postgres-repository.js';
import { WorldService } from './worlds/service.js';

const origin = 'http://localhost:3000';
const password = 'Correct horse battery staple';
const cursorSecret = 'm09-authorization-rate-cursor-secret-32-chars';

interface BrowserSession {
  cookie: string;
  csrf: string;
  email: string;
  userId: string;
}

interface ApprovedWorld {
  contentHash: string;
  revisionId: string;
  worldId: string;
}

interface CommerceCommandContext {
  designVersion: string;
  expansionVersion: string;
  stateRevision: string;
  tick: string;
}

interface BusinessFixture {
  backingOrganizationEntityId: string;
  businessId: string;
  businessRowVersion: string;
  businessWalletId: string;
  facilityAssetId: string;
  facilityId: string;
  facilityRowVersion: string;
  manager: BrowserSession;
  organizationKey: string;
  recipeInputIds: string[];
  recipeVersionId: string;
  worker: BrowserSession;
  workerEntityKey: string;
  workerWalletId: string;
}

interface WorkerRepositoryModule {
  PostgresWorldCompilationRepository: new (pool: Pool) => object;
}

interface WorkerRunnerModule {
  WorldCompilationRunner: new (
    repository: object,
    logger: ReturnType<typeof createLogger>,
    limits: { maxEntities: number; maxRelationships: number },
    options?: { maximumRunsPerReconciliation?: number },
  ) => {
    runOne(): Promise<{ code?: string; outcome: string; worldVersionId?: string }>;
  };
}

describe.sequential('M09 commerce authorization and durable target rate limits', () => {
  let administrator: BrowserSession;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let appClient: DatabaseClient;
  let client: DatabaseClient;
  let compilationService: CompilationService;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let creator: BrowserSession;
  let fixture: BusinessFixture;
  let memberA: BrowserSession;
  let memberB: BrowserSession;
  let nonmember: BrowserSession;
  let rateMember: BrowserSession;
  let world: ApprovedWorld;
  const ids = new UuidV7Generator();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    client = createDatabaseClient(
      container.getConnectionUri(),
      'm09-commerce-authority-owner-test',
    );
    await applyMigrations(client, resolve('packages/db/drizzle'));
    await importStarterPrimitives(client.pool);

    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    appClient = createDatabaseClient(
      appUrl.toString(),
      'm09-commerce-authority-application-role-test',
    );
    appClient.pool.options.connectionTimeoutMillis = 60_000;

    const config = runtimeConfig();
    const clock = new SystemClock();
    const repository = new PostgresRepository(appClient.pool);
    const sink = { publish: async (_notification: ApplicationNotification) => undefined };
    const identity = new IdentityService(
      repository,
      { ...config, authPepper: config.authPepper! },
      clock,
      ids,
      new Argon2idPasswordHasher(config.authPepper!, TEST_PASSWORD_HASH_OPTIONS),
      sink,
    );
    const worlds = new WorldService(
      repository,
      clock,
      ids,
      (id) => identity.invitationToken(id),
      (token) => identity.tokenHash(token, 'invitation'),
      sink,
    );
    compilationService = new CompilationService(
      new CompilationRepository(appClient.pool),
      config,
      clock,
      ids,
      sink,
      cursorSecret,
    );
    const commandRepository = new PostgresCommandRepository(appClient.pool, ids);
    const commandService = new WorldCommandService(
      new WorldCommandBus(
        commandRepository,
        ids,
        undefined,
        {
          debitsFrozen: false,
          issuanceEnabled: true,
          issuanceRateLimitPerHour: 100,
          offerRateLimitPerMinute: 1_000,
          offersEnabled: true,
          transferRateLimitPerMinute: 1_000,
          transfersEnabled: true,
        },
        commercePolicy(100),
      ),
      commandRepository,
      clock,
      cursorSecret,
    );
    const economy = new EconomyQueryService(
      new PostgresEconomyQueryRepository(appClient.pool),
      cursorSecret,
      {
        debitsFrozen: false,
        issuanceEnabled: true,
        offersEnabled: true,
        transfersEnabled: true,
      },
    );
    const commerceReads = new CommerceReadService(
      new PostgresCommerceReadRepository(appClient.pool),
      cursorSecret,
    );
    app = await buildApp({
      clock,
      config,
      domain: {
        commands: commandService,
        commerceReads,
        compilation: compilationService,
        economy,
        identity,
        worlds,
      },
      idGenerator: ids,
      logger: createLogger({
        buildRevision: 'test',
        environment: 'test',
        level: 'fatal',
        service: 'm09-commerce-authority-api-test',
      }),
      pool: appClient.pool,
      redis: {
        get: async () =>
          JSON.stringify({ at: new Date().toISOString(), buildRevision: 'test', schemaVersion: 1 }),
        ping: async () => 'PONG',
      },
      smokeQueue: {
        add: async () => ({ getState: async () => 'waiting' }),
        getJob: async () => undefined,
      },
    });

    creator = await register('m09-authority-creator@example.test', 'Authority Creator');
    memberA = await register('m09-authority-member-a@example.test', 'Authority Member A');
    memberB = await register('m09-authority-member-b@example.test', 'Authority Member B');
    administrator = await register(
      'm09-authority-administrator@example.test',
      'Authority Administrator',
    );
    nonmember = await register('m09-authority-nonmember@example.test', 'Authority Nonmember');
    rateMember = await register('m09-authority-rate@example.test', 'Authority Rate Member');

    world = await createCompiledCommerceWorld();
    await inviteAndAcceptMember(administrator, 'administrator');
    await inviteAndAcceptMember(rateMember, 'player');
    await initializeEconomy();
    await initializeCommerce();
    fixture = await loadBusinessFixture();
    expect(
      new Set([
        nonmember.userId,
        rateMember.userId,
        fixture.worker.userId,
        fixture.manager.userId,
        creator.userId,
        administrator.userId,
      ]).size,
    ).toBe(6);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await appClient?.pool.end();
    await client?.pool.end();
    await container?.stop();
  });

  it('proves nonmember, unrelated member, worker, manager, creator, and administrator powers', async () => {
    const unbackedOrganization = await client.pool.query<{
      logical_key: string;
      wallet_id: string;
    }>(
      `select organization.logical_key::text,wallet.id::text as wallet_id
         from world_entities organization
         join wallets wallet
           on wallet.world_id=organization.world_id
          and wallet.owner_entity_id=organization.id
          and wallet.wallet_kind='organization'
          and wallet.status='active'
         left join businesses business
           on business.world_id=organization.world_id
          and business.backing_organization_entity_id=organization.id
        where organization.world_id=$1 and organization.entity_type='organization'
          and organization.retired_world_version_id is null and business.id is null
        order by organization.logical_key
        limit 1`,
      [world.worldId],
    );
    expect(unbackedOrganization.rows).toHaveLength(1);
    const adminBusiness = commerceCommand(
      await commerceContext(administrator),
      'CreateBusinessV1',
      {
        backingOrganizationEntityKey: unbackedOrganization.rows[0]!.logical_key,
        walletId: unbackedOrganization.rows[0]!.wallet_id,
      },
      'administrator-create-business',
    );
    const adminBusinessResponse = await submit(administrator, adminBusiness);
    expect(adminBusinessResponse.statusCode, adminBusinessResponse.body).toBe(200);

    const stateBeforeNonmember = await expansionVersion();
    const nonmemberCommand = commerceCommand(
      await commerceContext(creator),
      'ReconcileWorldCommerceV1',
      { expectedExpansionVersion: stateBeforeNonmember },
      'nonmember-reconcile',
    );
    const nonmemberResponse = await submit(nonmember, nonmemberCommand);
    expect(nonmemberResponse.statusCode, nonmemberResponse.body).toBe(404);
    expect(nonmemberResponse.json()).toMatchObject({
      rejectionCode: 'AUTHORIZATION_DENIED',
      status: 'rejected',
    });
    expect(await expansionVersion()).toBe(stateBeforeNonmember);
    await expect(
      client.pool.query(
        `select command.status::text,
                (select count(*)::integer from domain_events event
                  where event.command_id=command.id) as event_count
           from command_records command where command.id=$1`,
        [nonmemberCommand.commandId],
      ),
    ).resolves.toMatchObject({ rows: [{ event_count: 0, status: 'rejected' }] });

    const createContract = commerceCommand(
      await commerceContext(fixture.manager),
      'CreateEmploymentContractV1',
      {
        businessId: fixture.businessId,
        cooldownTicks: '1',
        effectiveFromTick: '0',
        effectiveToTick: '100',
        employerWalletId: fixture.businessWalletId,
        expectedBusinessVersion: fixture.businessRowVersion,
        maxPerformancesPerPeriod: 10,
        periodTicks: '12',
        rewardCapMinor: '1000',
        roleCode: 'metalworker',
        wageMinor: '100',
        wageRuleKind: 'per_shift',
        workerEntityKey: fixture.workerEntityKey,
        workerWalletId: fixture.workerWalletId,
      },
      'manager-create-contract',
    );
    expect((await submit(fixture.manager, createContract)).statusCode).toBe(200);
    const contractId = await eventAggregateId(
      createContract.commandId,
      'EmploymentContractCreatedV1',
    );
    const acceptContract = commerceCommand(
      await commerceContext(fixture.worker),
      'AcceptEmploymentContractV1',
      { contractId, expectedContractVersion: '1' },
      'worker-accept-contract',
    );
    expect((await submit(fixture.worker, acceptContract)).statusCode).toBe(200);

    for (const [label, session] of [
      ['unrelated', rateMember],
      ['manager', fixture.manager],
      ['administrator', administrator],
    ] as const) {
      const deniedJob = commerceCommand(
        await commerceContext(session),
        'PerformJobV1',
        { contractId, expectedContractVersion: '2' },
        `${label}-perform-worker-job`,
      );
      const response = await submit(session, deniedJob);
      expect(response.statusCode, `${label}: ${response.body}`).toBe(403);
      expect(response.json()).toMatchObject({
        rejectionCode: 'AUTHORIZATION_DENIED',
        status: 'rejected',
      });
    }
    const performJob = commerceCommand(
      await commerceContext(fixture.worker),
      'PerformJobV1',
      { contractId, expectedContractVersion: '2' },
      'worker-perform-job',
    );
    expect((await submit(fixture.worker, performJob)).statusCode).toBe(200);

    const productionInputs = await productionInventories();
    const productionPayload = {
      businessId: fixture.businessId,
      expectedBusinessVersion: fixture.businessRowVersion,
      expectedFacilityVersion: fixture.facilityRowVersion,
      expectedInventories: productionInputs.map((inventory) => ({
        inventoryId: inventory.id,
        rowVersion: inventory.row_version,
      })),
      facilityId: fixture.facilityId,
      recipeVersionId: fixture.recipeVersionId,
      runQuantity: '1',
    };
    for (const [label, session] of [
      ['unrelated', rateMember],
      ['administrator', administrator],
    ] as const) {
      const deniedProduction = commerceCommand(
        await commerceContext(session),
        'StartProductionRunV1',
        productionPayload,
        `${label}-start-production`,
      );
      const response = await submit(session, deniedProduction);
      expect(response.statusCode, `${label}: ${response.body}`).toBe(403);
    }
    const startProduction = commerceCommand(
      await commerceContext(fixture.manager),
      'StartProductionRunV1',
      productionPayload,
      'manager-start-production',
    );
    expect((await submit(fixture.manager, startProduction)).statusCode).toBe(200);

    const listingInventory = await availableBusinessInventory();
    const listingPayload = {
      expiresAtTick: '100',
      expectedInventoryVersion: listingInventory.row_version,
      quantity: '5',
      sellerInventoryId: listingInventory.id,
      sellerWalletId: fixture.businessWalletId,
      unitPriceMinor: '100',
    };
    const deniedListing = commerceCommand(
      await commerceContext(rateMember),
      'CreateMarketListingV1',
      listingPayload,
      'unrelated-create-listing',
    );
    expect((await submit(rateMember, deniedListing)).statusCode).toBe(403);
    const createListing = commerceCommand(
      await commerceContext(fixture.manager),
      'CreateMarketListingV1',
      listingPayload,
      'manager-create-listing',
    );
    expect((await submit(fixture.manager, createListing)).statusCode).toBe(200);
    const listingId = await eventAggregateId(createListing.commandId, 'MarketListingCreatedV1');

    const workerWalletVersion = await walletVersion(fixture.workerWalletId);
    const purchase = commerceCommand(
      await commerceContext(fixture.worker),
      'PurchaseMarketListingV1',
      {
        buyerInventoryId: null,
        buyerWalletId: fixture.workerWalletId,
        expectedBuyerInventoryVersion: null,
        expectedBuyerWalletVersion: workerWalletVersion,
        expectedListingVersion: '1',
        listingId,
        quantity: '1',
      },
      'worker-purchase-listing',
    );
    expect((await submit(fixture.worker, purchase)).statusCode).toBe(200);

    for (const [label, session] of [
      ['administrator', administrator],
      ['creator', creator],
    ] as const) {
      const context = await commerceContext(session);
      const reconcile = commerceCommand(
        context,
        'ReconcileWorldCommerceV1',
        { expectedExpansionVersion: context.expansionVersion },
        `${label}-reconcile`,
      );
      const response = await submit(session, reconcile);
      expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
      await expect(
        client.pool.query(
          `select status::text,mismatch_count
             from economy_expansion_reconciliation_runs where command_id=$1`,
          [reconcile.commandId],
        ),
      ).resolves.toMatchObject({ rows: [{ mismatch_count: 0, status: 'matched' }] });
    }

    await expect(
      client.pool.query(
        `select
           count(*) filter (where command_type='InitializeWorldEconomyV1'
             and actor_id=$2 and status='accepted')::integer as creator_economy_initializations,
           count(*) filter (where command_type='InitializeWorldCommerceV1'
             and actor_id=$2 and status='accepted')::integer as creator_commerce_initializations,
           count(*) filter (where command_type='CreateBusinessV1'
             and actor_id=$3 and status='accepted')::integer as administrator_businesses,
           count(*) filter (where command_type='PerformJobV1'
             and actor_id=$4 and status='accepted')::integer as worker_jobs,
           count(*) filter (where command_type='StartProductionRunV1'
             and actor_id=$5 and status='accepted')::integer as manager_runs
         from command_records where world_id=$1`,
        [
          world.worldId,
          creator.userId,
          administrator.userId,
          fixture.worker.userId,
          fixture.manager.userId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          administrator_businesses: 1,
          creator_commerce_initializations: 1,
          creator_economy_initializations: 1,
          manager_runs: 1,
          worker_jobs: 1,
        },
      ],
    });
  }, 120_000);

  it('persists malformed limited commands as validation failures without entering rate policy', async () => {
    const malformed = commerceCommand(
      await commerceContext(rateMember),
      'PurchaseMarketListingV1',
      {},
      'malformed-rate-scoped-purchase',
    );
    const response = await submit(rateMember, malformed);
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      rejectionCode: 'VALIDATION_FAILED',
      status: 'rejected',
    });
    await expect(
      client.pool.query(
        `select status::text,rejection_code,octet_length(rate_limit_scope_hash) as scope_bytes,
                (select count(*)::integer from domain_events event
                  where event.command_id=command.id) as event_count
           from command_records command where command.id=$1`,
        [malformed.commandId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          event_count: 0,
          rejection_code: 'VALIDATION_FAILED',
          scope_bytes: 32,
          status: 'rejected',
        },
      ],
    });
  });

  it('counts an accepted purchase before throttling the same account, world, and listing', async () => {
    const listingId = await rateTarget('PurchaseMarketListingV1');
    const decidedAt = await isolatedRateInstant();
    const rateBus = commandBusWithCommerceLimit(1);
    const purchase = async (key: string) => {
      const context = await commerceContext(fixture.worker);
      return commerceCommand(
        context,
        'PurchaseMarketListingV1',
        {
          buyerInventoryId: null,
          buyerWalletId: fixture.workerWalletId,
          expectedBuyerInventoryVersion: null,
          expectedBuyerWalletVersion: await walletVersion(fixture.workerWalletId),
          expectedListingVersion: await listingVersion(listingId),
          listingId,
          quantity: '1',
        },
        key,
      );
    };
    const first = await purchase('accepted-before-rate-limit');
    await expect(
      rateBus.submit(actor(fixture.worker), world.worldId, first, ids.next(), decidedAt),
    ).resolves.toMatchObject({ result: { status: 'accepted' } });

    const second = await purchase('same-listing-rate-limited');
    await expect(
      rateBus.submit(actor(fixture.worker), world.worldId, second, ids.next(), decidedAt),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
  });

  it.each([
    'PerformJobV1',
    'StartProductionRunV1',
    'CreateMarketListingV1',
    'PurchaseMarketListingV1',
  ] as const)('durably rate-limits %s by account and target within one world', async (type) => {
    const context = await commerceContext(rateMember);
    const validTarget = await rateTarget(type);
    const first = commerceCommand(
      context,
      type,
      await ratePayload(type, validTarget),
      `rate-first-${type}`,
    );
    const lowRateBus = commandBusWithCommerceLimit(1);
    const actor = {
      user: { id: rateMember.userId, platformRole: 'user' },
    } as AuthenticatedActor;
    const decidedAt = await isolatedRateInstant();

    await expect(
      lowRateBus.submit(actor, world.worldId, first, ids.next(), decidedAt),
    ).resolves.toMatchObject({ result: { status: 'rejected' } });
    const second = commerceCommand(
      context,
      type,
      await ratePayload(type, validTarget),
      `rate-second-${type}`,
    );
    await expect(
      lowRateBus.submit(actor, world.worldId, second, ids.next(), decidedAt),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });

    const administratorContext = await commerceContext(administrator);
    const otherAccount = commerceCommand(
      administratorContext,
      type,
      await ratePayload(type, validTarget),
      `rate-other-account-${type}`,
    );
    await expect(
      lowRateBus.submit(
        {
          user: { id: administrator.userId, platformRole: 'user' },
        } as AuthenticatedActor,
        world.worldId,
        otherAccount,
        ids.next(),
        decidedAt,
      ),
    ).resolves.toMatchObject({ result: { status: 'rejected' } });

    const independentTarget = ids.next();
    const independent = commerceCommand(
      context,
      type,
      await ratePayload(type, independentTarget),
      `rate-independent-${type}`,
    );
    await expect(
      lowRateBus.submit(actor, world.worldId, independent, ids.next(), decidedAt),
    ).resolves.toMatchObject({ result: { status: 'rejected' } });

    await expect(
      client.pool.query(
        `select count(*)::integer as command_count,
                count(distinct rate_limit_scope_hash)::integer as scope_count,
                bool_and(octet_length(rate_limit_scope_hash)=32) as valid_hashes,
                bool_and(payload is null) as payload_private
           from command_records
          where world_id=$1 and actor_type='user' and actor_id=$2 and command_type=$3
            and requested_at=$4`,
        [world.worldId, rateMember.userId, type, decidedAt],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          command_count: 2,
          payload_private: true,
          scope_count: 2,
          valid_hashes: true,
        },
      ],
    });
  });

  async function register(email: string, displayName: string): Promise<BrowserSession> {
    const response = await app.inject({
      headers: { origin },
      method: 'POST',
      payload: { displayName, email, password },
      url: '/api/v1/auth/register',
    });
    expect(response.statusCode, response.body).toBe(201);
    const rawCookies = response.headers['set-cookie'];
    const cookies = Array.isArray(rawCookies)
      ? rawCookies
      : typeof rawCookies === 'string'
        ? [rawCookies]
        : [];
    const pairs = cookies.map((cookie) => cookie.split(';')[0]!);
    const csrf = pairs.find((cookie) => cookie.startsWith('wg_csrf='))!;
    return {
      cookie: pairs.join('; '),
      csrf: decodeURIComponent(csrf.slice('wg_csrf='.length)),
      email,
      userId: response.json<{ user: { id: string } }>().user.id,
    };
  }

  async function inviteAndAcceptMember(
    invitee: BrowserSession,
    role: 'administrator' | 'player',
  ): Promise<void> {
    const invitationResponse = await app.inject({
      headers: mutationHeaders(creator, `invite-${invitee.userId}`),
      method: 'POST',
      payload: { email: invitee.email, expiresIn: 3_600, role: 'player' },
      url: `/api/v1/worlds/${world.worldId}/invitations`,
    });
    expect(invitationResponse.statusCode, invitationResponse.body).toBe(201);
    const { rawToken } = invitationResponse.json<{ rawToken: string }>();
    const acceptanceResponse = await app.inject({
      headers: mutationHeaders(invitee, `accept-${invitee.userId}`),
      method: 'POST',
      payload: { rawToken },
      url: '/api/v1/invitations/accept',
    });
    expect(acceptanceResponse.statusCode, acceptanceResponse.body).toBe(200);

    if (role === 'administrator') {
      const membershipsResponse = await app.inject({
        headers: { cookie: creator.cookie },
        method: 'GET',
        url: `/api/v1/worlds/${world.worldId}/memberships`,
      });
      expect(membershipsResponse.statusCode, membershipsResponse.body).toBe(200);
      const membership = membershipsResponse
        .json<{ items: Array<{ rowVersion: number; user: { id: string } }> }>()
        .items.find((candidate) => candidate.user.id === invitee.userId);
      expect(membership).toBeDefined();
      const promotionResponse = await app.inject({
        headers: mutationHeaders(creator, `promote-${invitee.userId}`),
        method: 'PATCH',
        payload: { expectedRowVersion: membership!.rowVersion, role },
        url: `/api/v1/worlds/${world.worldId}/memberships/${invitee.userId}`,
      });
      expect(promotionResponse.statusCode, promotionResponse.body).toBe(200);
    }
  }

  async function createCompiledCommerceWorld(): Promise<ApprovedWorld> {
    const response = await app.inject({
      headers: mutationHeaders(creator, 'create-m09-authorization-world'),
      method: 'POST',
      payload: { name: 'M09 Authorization Harbor' },
      url: '/api/v1/worlds',
    });
    expect(response.statusCode, response.body).toBe(201);
    const worldId = response.json<{ world: { id: string } }>().world.id;
    const revisionId = ids.next();
    const validationReportId = ids.next();
    const fallback = createDeterministicHarborCityFallback({
      catalog: harborCityManifestCatalog(),
      prompt: 'A harbor city with production, employment, a fixed-price market, and tax.',
      seed: 'm09-authorization-harbor-manifest',
    });
    await client.pool.query(
      `insert into world_memberships(world_id,user_id,role,status,granted_by_user_id)
       values ($1,$2,'player','active',$4),($1,$3,'player','active',$4)`,
      [worldId, memberA.userId, memberB.userId, creator.userId],
    );
    await client.pool.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,manifest_schema_version,canonical_manifest,
         content_hash,source,created_by_user_id
       ) values ($1,$2,1,1,$3,decode($4,'hex'),'manual',$5)`,
      [
        revisionId,
        worldId,
        JSON.stringify(fallback.envelope.manifest),
        fallback.contentHash,
        creator.userId,
      ],
    );
    await client.pool.query(
      `insert into manifest_validation_reports(
         id,manifest_revision_id,validator_version,primitive_catalog_snapshot_hash,
         valid,diagnostics,report_hash
       ) values ($1,$2,1,decode($3,'hex'),true,'[]'::jsonb,decode($4,'hex'))`,
      [validationReportId, revisionId, 'a'.repeat(64), 'b'.repeat(64)],
    );
    const connection = await client.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(
        `update manifest_revisions
            set approval_status='approved',approved_by_user_id=$2,
                approved_at=now(),row_version=row_version+1
          where id=$1`,
        [revisionId, creator.userId],
      );
      await connection.query(
        `update worlds
            set current_approved_manifest_revision_id=$2,manifest_schema_version=1,
                lifecycle='manifest_approved',row_version=row_version+1,updated_at=now()
          where id=$1`,
        [worldId, revisionId],
      );
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    const compilation = await compilationService.start(
      actor(creator),
      worldId,
      {
        expectedManifestHash: fallback.contentHash,
        manifestRevisionId: revisionId,
        seed: 'm09-authorization-harbor-compile-seed',
      },
      { idempotencyKey: 'm09-authorization-harbor-compile', requestId: ids.next() },
    );
    expect(compilation).toMatchObject({ status: 'queued' });
    const workerResult = await runWorkerOnce(client.pool);
    expect(workerResult, JSON.stringify(workerResult)).toMatchObject({ outcome: 'succeeded' });
    return { contentHash: fallback.contentHash, revisionId, worldId };
  }

  async function initializeEconomy(): Promise<void> {
    const source = await compiledPlan();
    const response = await submit(creator, {
      commandId: ids.next(),
      expectedAggregateVersion: '0',
      expectedStateRevision: (await economySummary(creator)).stateRevision,
      expectedWorldVersion: await designVersion(),
      idempotencyKey: `initialize-economy-${ids.next()}`,
      payload: {
        compiledWorldVersionId: source.world_version_id,
        seedPlanHash: source.plan_hash,
      },
      schemaVersion: 1,
      type: 'InitializeWorldEconomyV1',
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function initializeCommerce(): Promise<void> {
    const source = await compiledPlan();
    const context = await commerceContext(creator);
    const response = await submit(
      creator,
      commerceCommand(
        context,
        'InitializeWorldCommerceV1',
        {
          compiledWorldVersionId: source.world_version_id,
          seedPlanHash: source.plan_hash,
        },
        'initialize-commerce',
      ),
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  async function compiledPlan(): Promise<{ plan_hash: string; world_version_id: string }> {
    const source = await client.pool.query<{
      plan_hash: string;
      world_version_id: string;
    }>(
      `select encode(plan.plan_hash,'hex') as plan_hash,plan.world_version_id::text
         from compiled_economy_seed_plans plan
         join world_runtime_heads runtime
           on runtime.world_id=plan.world_id and runtime.active_world_version_id=plan.world_version_id
        where plan.world_id=$1 and plan.seed_plan_schema_version=2
          and plan.source_kind='compiler_1_2'`,
      [world.worldId],
    );
    expect(source.rows).toHaveLength(1);
    return source.rows[0]!;
  }

  async function loadBusinessFixture(): Promise<BusinessFixture> {
    const business = await client.pool.query<{
      backing_organization_entity_id: string;
      business_id: string;
      business_row_version: string;
      business_wallet_id: string;
      facility_asset_id: string;
      facility_id: string;
      facility_row_version: string;
      organization_key: string;
      recipe_inputs: Array<{ resourceTypeId: string }>;
      recipe_version_id: string;
    }>(
      `select business.id::text as business_id,business.row_version::text
                as business_row_version,business.wallet_id::text as business_wallet_id,
              business.backing_organization_entity_id::text,
              organization.logical_key::text as organization_key,
              facility.id::text as facility_id,facility.row_version::text
                as facility_row_version,facility.facility_asset_id::text,
              recipe.id::text as recipe_version_id,recipe.canonical_inputs as recipe_inputs
         from businesses business
         join world_entities organization
           on organization.world_id=business.world_id
          and organization.id=business.backing_organization_entity_id
         join business_facilities facility
           on facility.world_id=business.world_id and facility.business_id=business.id
         join business_facility_recipe_versions capability
           on capability.world_id=facility.world_id and capability.facility_id=facility.id
         join production_recipe_versions recipe
           on recipe.world_id=capability.world_id and recipe.id=capability.recipe_version_id
        where business.world_id=$1
        order by business.stable_key,facility.stable_key
        limit 1`,
      [world.worldId],
    );
    expect(business.rows).toHaveLength(1);
    const row = business.rows[0]!;
    const people = await client.pool.query<{
      entity_key: string;
      organization_key: string | null;
      user_id: string;
      wallet_id: string;
    }>(
      `select controller.user_id::text,character.logical_key::text as entity_key,
              character.state ->> 'organizationLogicalKey' as organization_key,
              wallet.id::text as wallet_id
         from world_entity_controllers controller
         join world_entities character
           on character.world_id=controller.world_id and character.id=controller.entity_id
          and character.entity_type='player_character'
          and character.retired_world_version_id is null
         join wallets wallet
           on wallet.world_id=character.world_id and wallet.owner_entity_id=character.id
          and wallet.wallet_kind='player'
        where controller.world_id=$1 and controller.revoked_at is null
        order by controller.user_id`,
      [world.worldId],
    );
    const sessions = new Map([
      [creator.userId, creator],
      [memberA.userId, memberA],
      [memberB.userId, memberB],
    ]);
    const managerPerson = people.rows.find(
      (person) =>
        person.organization_key === row.organization_key && person.user_id !== creator.userId,
    );
    const workerPerson =
      people.rows.find(
        (person) => person.user_id !== managerPerson?.user_id && person.user_id !== creator.userId,
      ) ?? people.rows.find((person) => person.user_id !== managerPerson?.user_id);
    const manager = managerPerson ? sessions.get(managerPerson.user_id) : undefined;
    const worker = workerPerson ? sessions.get(workerPerson.user_id) : undefined;
    expect(manager).toBeDefined();
    expect(worker).toBeDefined();
    expect(manager?.userId).not.toBe(creator.userId);
    expect(worker?.userId).not.toBe(creator.userId);
    expect(worker?.userId).not.toBe(manager?.userId);
    return {
      backingOrganizationEntityId: row.backing_organization_entity_id,
      businessId: row.business_id,
      businessRowVersion: row.business_row_version,
      businessWalletId: row.business_wallet_id,
      facilityAssetId: row.facility_asset_id,
      facilityId: row.facility_id,
      facilityRowVersion: row.facility_row_version,
      manager: manager!,
      organizationKey: row.organization_key,
      recipeInputIds: row.recipe_inputs.map((input) => input.resourceTypeId),
      recipeVersionId: row.recipe_version_id,
      worker: worker!,
      workerEntityKey: workerPerson!.entity_key,
      workerWalletId: workerPerson!.wallet_id,
    };
  }

  async function economySummary(session: BrowserSession) {
    const response = await app.inject({
      headers: { cookie: session.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.worldId}/economy/summary`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      designVersion: string;
      economyHeadVersion: string | null;
      stateRevision: string;
    }>();
  }

  async function commerceContext(session: BrowserSession): Promise<CommerceCommandContext> {
    const [summary, clock, expansion] = await Promise.all([
      economySummary(session),
      readClock(),
      expansionVersion(),
    ]);
    return {
      designVersion: summary.designVersion,
      expansionVersion: expansion,
      stateRevision: summary.stateRevision,
      tick: clock.clock.currentTick,
    };
  }

  function commerceCommand(
    context: CommerceCommandContext,
    type: string,
    payload: Record<string, unknown>,
    key: string,
  ): SubmitWorldCommand {
    return {
      commandId: ids.next(),
      expectedAggregateVersion: context.expansionVersion,
      expectedStateRevision: context.stateRevision,
      expectedTick: context.tick,
      expectedWorldVersion: context.designVersion,
      idempotencyKey: `${key}-${ids.next()}`,
      payload,
      schemaVersion: 1,
      type,
    };
  }

  async function submit(session: BrowserSession, body: SubmitWorldCommand) {
    return app.inject({
      headers: mutationHeaders(session, body.idempotencyKey),
      method: 'POST',
      payload: body,
      url: `/api/v1/worlds/${world.worldId}/commands`,
    });
  }

  async function readClock(): Promise<SimulationClockViewTransport> {
    const response = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${world.worldId}/simulation/clock`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<SimulationClockViewTransport>();
  }

  async function designVersion(): Promise<string> {
    return (await readClock()).designVersion;
  }

  async function expansionVersion(): Promise<string> {
    const result = await client.pool.query<{ row_version: string }>(
      `select row_version::text from world_economy_expansion_heads where world_id=$1`,
      [world.worldId],
    );
    return result.rows[0]?.row_version ?? '0';
  }

  async function eventAggregateId(commandId: string, eventType: string): Promise<string> {
    const result = await client.pool.query<{ aggregate_id: string }>(
      `select aggregate_id::text from domain_events
        where command_id=$1 and event_type=$2 order by event_ordinal`,
      [commandId, eventType],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!.aggregate_id;
  }

  async function productionInventories(): Promise<Array<{ id: string; row_version: string }>> {
    const result = await client.pool.query<{ id: string; row_version: string }>(
      `select inventory.id::text,inventory.row_version::text
         from inventories inventory
        where inventory.world_id=$1 and inventory.owner_entity_id=$2
          and inventory.container_asset_id=$3
          and inventory.resource_type_id=any($4::uuid[])
        order by inventory.resource_type_id`,
      [
        world.worldId,
        fixture.backingOrganizationEntityId,
        fixture.facilityAssetId,
        fixture.recipeInputIds,
      ],
    );
    expect(result.rows).toHaveLength(fixture.recipeInputIds.length);
    return result.rows;
  }

  async function availableBusinessInventory(): Promise<{ id: string; row_version: string }> {
    const result = await client.pool.query<{ id: string; row_version: string }>(
      `select inventory.id::text,inventory.row_version::text
         from inventories inventory
        where inventory.world_id=$1 and inventory.owner_entity_id=$2
          and inventory.container_asset_id=$3
          and inventory.quantity-inventory.reserved_quantity >= 5
        order by inventory.stable_key
        limit 1`,
      [world.worldId, fixture.backingOrganizationEntityId, fixture.facilityAssetId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!;
  }

  async function walletVersion(walletId: string): Promise<string> {
    const result = await client.pool.query<{ row_version: string }>(
      `select row_version::text from wallet_balances where wallet_id=$1`,
      [walletId],
    );
    return result.rows[0]!.row_version;
  }

  async function listingVersion(listingId: string): Promise<string> {
    const result = await client.pool.query<{ row_version: string }>(
      `select row_version::text from market_listings where world_id=$1 and id=$2`,
      [world.worldId, listingId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!.row_version;
  }

  function commandBusWithCommerceLimit(limit: number): WorldCommandBus {
    return new WorldCommandBus(
      new PostgresCommandRepository(appClient.pool, ids),
      ids,
      undefined,
      {
        debitsFrozen: false,
        issuanceEnabled: true,
        issuanceRateLimitPerHour: 100,
        offerRateLimitPerMinute: 1_000,
        offersEnabled: true,
        transferRateLimitPerMinute: 1_000,
        transfersEnabled: true,
      },
      commercePolicy(limit),
    );
  }

  async function isolatedRateInstant(): Promise<Date> {
    const result = await client.pool.query<{ decided_at: Date }>(
      `select coalesce(max(requested_at),timestamptz '2000-01-01T00:00:00Z')
                + interval '2 minutes' as decided_at
         from command_records where world_id=$1`,
      [world.worldId],
    );
    return result.rows[0]!.decided_at;
  }

  async function rateTarget(
    type:
      'CreateMarketListingV1' | 'PerformJobV1' | 'PurchaseMarketListingV1' | 'StartProductionRunV1',
  ): Promise<string> {
    if (type === 'PerformJobV1') {
      const result = await client.pool.query<{ id: string }>(
        `select id::text from employment_contracts where world_id=$1 order by created_at limit 1`,
        [world.worldId],
      );
      return result.rows[0]!.id;
    }
    if (type === 'StartProductionRunV1') return fixture.facilityId;
    if (type === 'CreateMarketListingV1') return (await availableBusinessInventory()).id;
    const result = await client.pool.query<{ id: string }>(
      `select id::text from market_listings
        where world_id=$1 and status='open' order by created_at limit 1`,
      [world.worldId],
    );
    return result.rows[0]!.id;
  }

  async function ratePayload(
    type:
      'CreateMarketListingV1' | 'PerformJobV1' | 'PurchaseMarketListingV1' | 'StartProductionRunV1',
    targetId: string,
  ): Promise<Record<string, unknown>> {
    if (type === 'PerformJobV1') {
      return { contractId: targetId, expectedContractVersion: '2' };
    }
    if (type === 'StartProductionRunV1') {
      return {
        businessId: fixture.businessId,
        expectedBusinessVersion: fixture.businessRowVersion,
        expectedFacilityVersion: fixture.facilityRowVersion,
        expectedInventories: (await productionInventories()).map((inventory) => ({
          inventoryId: inventory.id,
          rowVersion: inventory.row_version,
        })),
        facilityId: targetId,
        recipeVersionId: fixture.recipeVersionId,
        runQuantity: '1',
      };
    }
    if (type === 'CreateMarketListingV1') {
      const inventory = await availableBusinessInventory();
      return {
        expiresAtTick: '100',
        expectedInventoryVersion: inventory.row_version,
        quantity: '1',
        sellerInventoryId: targetId,
        sellerWalletId: fixture.businessWalletId,
        unitPriceMinor: '100',
      };
    }
    return {
      buyerInventoryId: null,
      buyerWalletId: fixture.businessWalletId,
      expectedBuyerInventoryVersion: null,
      expectedBuyerWalletVersion: await walletVersion(fixture.businessWalletId),
      expectedListingVersion: '2',
      listingId: targetId,
      quantity: '1',
    };
  }
});

async function runWorkerOnce(pool: Pool) {
  const repositoryPath = new URL(
    ['..', '..', 'worker', 'src', 'world-compilation-repository.ts'].join('/'),
    import.meta.url,
  ).href;
  const runnerPath = new URL(
    ['..', '..', 'worker', 'src', 'world-compilation-worker.ts'].join('/'),
    import.meta.url,
  ).href;
  const repositoryModule = (await import(repositoryPath)) as unknown as WorkerRepositoryModule;
  const runnerModule = (await import(runnerPath)) as unknown as WorkerRunnerModule;
  const runner = new runnerModule.WorldCompilationRunner(
    new repositoryModule.PostgresWorldCompilationRepository(pool),
    createLogger({
      buildRevision: 'test',
      environment: 'test',
      level: 'error',
      service: 'm09-commerce-authority-worker-test',
    }),
    { maxEntities: 2_000, maxRelationships: 8_000 },
    { maximumRunsPerReconciliation: 1 },
  );
  return runner.runOne();
}

function actor(session: BrowserSession): AuthenticatedActor {
  return {
    user: { id: session.userId, platformRole: 'user' },
  } as AuthenticatedActor;
}

function mutationHeaders(session: BrowserSession, key: string) {
  return {
    cookie: session.cookie,
    'idempotency-key': key,
    origin,
    'x-csrf-token': session.csrf,
  };
}

function commercePolicy(limit: number): CommerceCommandPolicy {
  return {
    disabledTaxPolicyIds: [],
    jobsEnabled: true,
    listingRateLimitPerMinute: limit,
    listingsEnabled: true,
    productionEnabled: true,
    productionRateLimitPerMinute: limit,
    purchaseRateLimitPerMinute: limit,
    purchasesEnabled: true,
    workRateLimitPerMinute: limit,
  };
}

function runtimeConfig(): RuntimeConfig {
  return {
    allowedOrigins: [origin],
    apiHost: '127.0.0.1',
    apiPort: 4000,
    authPepper: 'test-only-auth-pepper-32-characters-long',
    buildRevision: 'test',
    compilerEnabled: true,
    compilerMaxEntities: 2_000,
    compilerMaxRelationships: 8_000,
    databaseUrl: 'postgres://unused',
    dependencyTimeoutMs: 1_000,
    economyDebitsFrozen: false,
    economyIssuanceEnabled: true,
    economyIssuanceRateLimitPerHour: 100,
    economyOfferRateLimitPerMinute: 1_000,
    economyOfferReconciliationBatchSize: 25,
    economyOfferReconciliationIntervalMs: 1_000,
    economyOffersEnabled: true,
    economyTransferRateLimitPerMinute: 1_000,
    economyTransfersEnabled: true,
    enableLocalRegistration: true,
    enableOperationalSmoke: false,
    environment: 'test',
    logLevel: 'fatal',
    manifestGenerationDailyBudgetMicrounits: 0,
    manifestGenerationEnabled: true,
    manifestGenerationMaxConcurrentPerUser: 2,
    manifestGenerationMaxConcurrentPerWorld: 1,
    manifestGenerationOutputTokenLimit: 4_096,
    manifestGenerationProvider: 'disabled',
    manifestGenerationProviderTimeoutMs: 8_000,
    manifestGenerationReconciliationIntervalMs: 2_000,
    manifestPromptRetentionDays: 30,
    primitiveEmbeddingCostBudgetMicrounits: 0,
    primitiveEmbeddingProviderTimeoutMs: 3_000,
    primitiveIndexMaxJobsPerReconciliation: 25,
    primitiveIndexReconciliationIntervalMs: 5_000,
    primitiveSemanticContributionEnabled: false,
    primitiveSemanticProfile: 'disabled',
    redisUrl: 'redis://unused',
    requestTimeoutMs: 30_000,
    simulationContinuousEnabled: false,
    simulationLeaseMs: 30_000,
    simulationMaximumAttempts: 3,
    simulationMaximumBackoffMs: 5_000,
    simulationMaximumWorldsPerRun: 25,
    simulationReconciliationIntervalMs: 1_000,
    simulationRetryBaseMs: 250,
    sessionAbsoluteTtlSeconds: 86_400,
    sessionIdleTtlSeconds: 3_600,
    workerHeartbeatIntervalMs: 1_000,
    workerHeartbeatTtlMs: 5_000,
    workerHealthHost: '127.0.0.1',
    workerHealthPort: 4001,
    worldCompilationReconciliationIntervalMs: 2_000,
  };
}
