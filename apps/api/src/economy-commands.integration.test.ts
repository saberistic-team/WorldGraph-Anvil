import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { RuntimeConfig } from '@worldgraph/config';
import {
  SystemClock,
  UuidV7Generator,
  canonicalJson,
  type ApplicationNotification,
  type CommerceProjectionRepairPlanV1,
  type EconomySeedPlanV1,
} from '@worldgraph/contracts';
import {
  applyMigrations,
  createDatabaseClient,
  importStarterPrimitives,
  type DatabaseClient,
} from '@worldgraph/db';
import { economySeedPlanHash } from '@worldgraph/economy';
import {
  createDeterministicFallback,
  createDeterministicHarborCityFallback,
  harborCityManifestCatalog,
  starterManifestCatalog,
} from '@worldgraph/manifests';
import { createLogger, telemetry } from '@worldgraph/observability';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';
import { CompilationRepository } from './compilation/repository.js';
import { CompilationService } from './compilation/service.js';
import type {
  SimulationClockViewTransport,
  SubmitWorldCommand,
  WorldCommandResultTransport,
} from './commands/api-contracts.js';
import { WorldCommandBus } from './commands/command-bus.js';
import { PostgresCommandRepository } from './commands/repository.js';
import { WorldCommandService } from './commands/service.js';
import type {
  AssetViewTransport,
  ControlledWalletViewTransport,
  EconomySummaryTransport,
  OfferViewTransport,
} from './economy/api-contracts.js';
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
const cursorSecret = 'm08-economy-cursor-secret-at-least-32-characters';
const ASSET_KEY = 'asset:founding-seal';
const MARKET_RACE_BUYER_COUNT = 50;
const MARKET_RACE_CANDIDATE_COUNT = MARKET_RACE_BUYER_COUNT + 3;

interface BrowserSession {
  cookie: string;
  csrf: string;
  userId: string;
}

interface ApprovedWorld {
  contentHash: string;
  revisionId: string;
  worldId: string;
}

interface WorldActors {
  creator: ControlledWalletViewTransport;
  memberA: ControlledWalletViewTransport;
  memberB: ControlledWalletViewTransport;
}

interface CommerceCommandContext {
  designVersion: string;
  expansionVersion: string;
  stateRevision: string;
  tick: string;
}

interface DeterministicHarborEvidence {
  effectCounts: {
    expiredListings: number;
    paidPayrolls: number;
    periodicTaxes: number;
    productionMovements: number;
    productionRuns: number;
  };
  eventChecksum: string;
  eventHashIntegrity: boolean;
  ledgerChecksum: string;
  ledgerHashIntegrity: boolean;
  nativeIntegrity: {
    commerce: boolean;
    economy: boolean;
    graph: boolean;
    ledger: boolean;
    simulation: boolean;
  };
  projectionChecksum: string;
  seedChecksum: string;
  seedPlanHash: string;
  sourceArtifactHash: string;
}

type AcceptedCommandResult = Extract<WorldCommandResultTransport, { status: 'accepted' }>;

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

interface ExpiryCommandModule {
  PostgresEconomyOfferExpiryCommand: new (
    pool: Pool,
    options: {
      ids: { next(): string };
      maximumSerializationAttempts?: number;
      retryDelay?: () => Promise<void>;
    },
  ) => {
    expire(request: {
      commandId: string;
      eventId: string;
      expectedOfferVersion: string;
      expectedStateRevision: string;
      expectedTick: string;
      expectedWorldVersion: string;
      idempotencyKey: string;
      offerId: string;
      worldId: string;
    }): Promise<{ resultingStateRevision?: string; status: string }>;
  };
}

interface CommerceScheduleRepositoryModule {
  PostgresCommerceScheduleRepository: new (pool: Pool) => object;
}

interface CommerceScheduledPayrollRequest {
  actionType: 'SettlePayrollV1';
  commandId: string;
  completedEventId: string;
  dueTick: string;
  idempotencyKey: string;
  payload: { payrollRecordId: string };
  scheduleSequence: string;
  scheduledActionId: string;
  worldId: string;
}

interface CommerceScheduledCommandResult {
  resultingStateRevision?: string;
  status: 'already_terminal' | 'applied' | 'conflict' | 'not_ready';
}

interface CommerceScheduleCommandModule {
  PostgresCommerceScheduledCommand: new (
    pool: Pool,
    options: {
      ids: { next(): string };
      maximumSerializationAttempts?: number;
      retryDelay?: (attempt: number) => Promise<void>;
    },
  ) => {
    execute(request: CommerceScheduledPayrollRequest): Promise<CommerceScheduledCommandResult>;
  };
}

interface CommerceScheduleWorkerModule {
  CommerceScheduleRunner: new (
    repository: object,
    commands: object,
    logger: ReturnType<typeof createLogger>,
    options: { batchSize: number; ids: { next(): string } },
  ) => {
    reconcile(): Promise<Array<{ actionType: string; outcome: string; scheduledActionId: string }>>;
  };
}

describe.sequential('M08 economy commands with real PostgreSQL and the application role', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let appClient: DatabaseClient;
  let client: DatabaseClient;
  let compilationService: CompilationService;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let creator: BrowserSession;
  let memberA: BrowserSession;
  let memberB: BrowserSession;
  let marketRaceBuyers: BrowserSession[];
  let observer: BrowserSession;
  let commerceWorld: ApprovedWorld;
  let stressWorld: ApprovedWorld;
  let offerWorld: ApprovedWorld;
  let issuanceWorld: ApprovedWorld;
  let legacyWorld: ApprovedWorld;
  const ids = new UuidV7Generator();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('worldgraph-postgres:test')
      .withDatabase('worldgraph')
      .withUsername('worldgraph_owner')
      .withPassword('worldgraph_owner_local_only')
      .start();
    client = createDatabaseClient(container.getConnectionUri(), 'm08-api-economy-test');
    await applyMigrations(client, resolve('packages/db/drizzle'));
    await importStarterPrimitives(client.pool);
    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = 'worldgraph_app';
    appUrl.password = 'worldgraph_app_local_only';
    appClient = createDatabaseClient(appUrl.toString(), 'm08-api-economy-app-role-test');
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
        {
          disabledTaxPolicyIds: [],
          jobsEnabled: true,
          listingRateLimitPerMinute: 100,
          listingsEnabled: true,
          productionEnabled: true,
          productionRateLimitPerMinute: 100,
          purchaseRateLimitPerMinute: 100,
          purchasesEnabled: true,
          workRateLimitPerMinute: 100,
        },
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
        service: 'm08-api-economy-test',
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

    creator = await register('m08-creator@example.test', 'M08 Creator');
    memberA = await register('m08-member-a@example.test', 'M08 Member A');
    memberB = await register('m08-member-b@example.test', 'M08 Member B');
    observer = await register('m08-observer@example.test', 'M08 Observer');
    stressWorld = await createCompiledWorld('M08 Stress Economy', 'm08-stress');
    offerWorld = await createCompiledWorld('M08 Direct Offers', 'm08-offers');
    issuanceWorld = await createCompiledWorld('M08 Issuance', 'm08-issuance');
    legacyWorld = await createCompiledWorld('M08 Legacy Adoption', 'm08-legacy');
    marketRaceBuyers = [];
    for (let index = 0; index < MARKET_RACE_CANDIDATE_COUNT; index += 1) {
      const sequence = (index + 1).toString().padStart(2, '0');
      marketRaceBuyers.push(
        await register(
          `m09-market-buyer-${sequence}@example.test`,
          `M09 Market Buyer ${sequence}`,
          `198.18.${index + 1}.1`,
        ),
      );
    }
    commerceWorld = await createCompiledCommerceWorld(
      'M09 Harbor Commerce',
      'm09-harbor',
      'm09-harbor',
      false,
      false,
      marketRaceBuyers,
    );
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await appClient?.pool.end();
    await client?.pool.end();
    await container?.stop();
  });

  it('initializes exactly, enforces participant privacy, and serializes 100 overspends plus opposite transfers', async () => {
    await initialize(stressWorld);
    const creatorSummary = await summary(creator, stressWorld.worldId);
    expect(creatorSummary).toMatchObject({
      capabilities: { canIssue: true },
      issuanceTarget: {
        currencyCode: 'GCR',
        currentSupplyMinor: '30000',
        minorUnitScale: 2,
        treasuryBalanceMinor: '0',
      },
      status: 'reconciling',
      virtualValueBoundary: { cashOutAllowed: false, noCashValue: true },
    });
    expect((await summary(memberA, stressWorld.worldId)).issuanceTarget).toBeNull();
    const observerWallets = await app.inject({
      headers: { cookie: observer.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${stressWorld.worldId}/economy/wallets`,
    });
    expect(observerWallets.statusCode, observerWallets.body).toBe(200);
    expect(observerWallets.json()).toEqual({ items: [], nextCursor: null });

    let actors = await wallets(stressWorld.worldId);
    const privateTransfer = economyCommand(
      await summary(memberA, stressWorld.worldId),
      'TransferCurrencyV1',
      {
        amount: '5.00',
        destinationWalletId: actors.memberB.wallet.id,
        expectedDestinationVersion: actors.memberB.balance.rowVersion,
        expectedSourceVersion: actors.memberA.balance.rowVersion,
        memo: 'Private member settlement.',
        sourceWalletId: actors.memberA.wallet.id,
      },
      'm08-private-transfer',
    );
    const privateResponse = await submit(memberA, stressWorld.worldId, privateTransfer);
    expect(privateResponse.statusCode, privateResponse.body).toBe(200);
    const participantRead = await app.inject({
      headers: { cookie: memberA.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${stressWorld.worldId}/economy/wallets/${actors.memberA.wallet.id}/transactions`,
    });
    expect(participantRead.statusCode, participantRead.body).toBe(200);
    const participantTransactions = participantRead.json<{
      items: Array<{
        memo: string | null;
        transaction: { commandId: string; postings: unknown[] };
      }>;
    }>().items;
    const privateTransaction = participantTransactions.find(
      (item) => item.transaction.commandId === privateTransfer.commandId,
    );
    expect(privateTransaction?.memo).toBe('Private member settlement.');
    expect(Array.isArray(privateTransaction?.transaction.postings)).toBe(true);
    const creatorPrivateRead = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${stressWorld.worldId}/economy/wallets/${actors.memberA.wallet.id}/transactions`,
    });
    expect(creatorPrivateRead.statusCode, creatorPrivateRead.body).toBe(404);

    actors = await wallets(stressWorld.worldId);
    const overspendContext = await summary(creator, stressWorld.worldId);
    const overspends = Array.from({ length: 100 }, (_, index) =>
      economyCommand(
        overspendContext,
        'TransferCurrencyV1',
        {
          amount: '60.00',
          destinationWalletId: actors.memberB.wallet.id,
          expectedDestinationVersion: actors.memberB.balance.rowVersion,
          expectedSourceVersion: actors.creator.balance.rowVersion,
          sourceWalletId: actors.creator.wallet.id,
        },
        `m08-overspend-${index}`,
      ),
    );
    const overspendResponses = await Promise.all(
      overspends.map((body, index) =>
        submit(creator, stressWorld.worldId, body, `198.18.0.${index + 1}`),
      ),
    );
    const acceptedOverspends = overspendResponses
      .map((response, index) => ({ body: overspends[index]!, response }))
      .filter(({ response }) => response.json<WorldCommandResultTransport>().status === 'accepted');
    expect(
      acceptedOverspends,
      JSON.stringify(overspendResponses.map((response) => response.statusCode)),
    ).toHaveLength(1);
    expect(
      overspendResponses.filter(
        (response) => response.json<WorldCommandResultTransport>().status === 'rejected',
      ),
    ).toHaveLength(99);
    const acceptedReplay = await submit(creator, stressWorld.worldId, acceptedOverspends[0]!.body);
    expect(acceptedReplay.statusCode, acceptedReplay.body).toBe(200);
    expect(acceptedReplay.json()).toEqual(acceptedOverspends[0]!.response.json());
    await expect(
      client.pool.query(
        `select count(distinct transaction_record.id)::integer as transaction_count,
                coalesce(sum(posting.signed_amount_minor),0)::text as posting_sum
           from financial_transactions transaction_record
           join wallet_postings posting on posting.transaction_id=transaction_record.id
          where transaction_record.command_id=$1`,
        [acceptedOverspends[0]!.body.commandId],
      ),
    ).resolves.toMatchObject({ rows: [{ posting_sum: '0', transaction_count: 1 }] });

    actors = await wallets(stressWorld.worldId);
    expect(actors.creator.balance.availableMinor).toBe('4000');
    expect(actors.memberA.balance.availableMinor).toBe('9500');
    expect(actors.memberB.balance.availableMinor).toBe('16500');
    const beforeOpposite = await balanceSnapshot(stressWorld.worldId);
    const oppositeContext = await summary(memberA, stressWorld.worldId);
    const forward = economyCommand(
      oppositeContext,
      'TransferCurrencyV1',
      {
        amount: '1.00',
        destinationWalletId: actors.memberB.wallet.id,
        expectedDestinationVersion: actors.memberB.balance.rowVersion,
        expectedSourceVersion: actors.memberA.balance.rowVersion,
        sourceWalletId: actors.memberA.wallet.id,
      },
      'm08-opposite-forward',
    );
    const reverse = economyCommand(
      oppositeContext,
      'TransferCurrencyV1',
      {
        amount: '1.00',
        destinationWalletId: actors.memberA.wallet.id,
        expectedDestinationVersion: actors.memberA.balance.rowVersion,
        expectedSourceVersion: actors.memberB.balance.rowVersion,
        sourceWalletId: actors.memberB.wallet.id,
      },
      'm08-opposite-reverse',
    );
    const oppositeResponses = await Promise.all([
      submit(memberA, stressWorld.worldId, forward),
      submit(memberB, stressWorld.worldId, reverse),
    ]);
    expect(
      oppositeResponses.filter(
        (response) => response.json<WorldCommandResultTransport>().status === 'accepted',
      ),
    ).toHaveLength(1);
    const afterOpposite = await balanceSnapshot(stressWorld.worldId);
    expect(afterOpposite.reduce((sum, row) => sum + BigInt(row.available_minor), 0n)).toBe(
      beforeOpposite.reduce((sum, row) => sum + BigInt(row.available_minor), 0n),
    );
    expect(afterOpposite.every((row) => BigInt(row.available_minor) >= 0n)).toBe(true);

    actors = await wallets(stressWorld.worldId);
    const lowRateBus = new WorldCommandBus(
      new PostgresCommandRepository(appClient.pool, ids),
      ids,
      undefined,
      {
        debitsFrozen: false,
        issuanceEnabled: true,
        issuanceRateLimitPerHour: 3,
        offerRateLimitPerMinute: 10,
        offersEnabled: true,
        transferRateLimitPerMinute: 3,
        transfersEnabled: true,
      },
    );
    const memberBActor = {
      user: { id: memberB.userId, platformRole: 'user' },
    } as AuthenticatedActor;
    const invalidContext = await summary(memberB, stressWorld.worldId);
    const invalidAttempts = Array.from({ length: 3 }, (_, index) =>
      economyCommand(
        invalidContext,
        'TransferCurrencyV1',
        {
          amount: '1.00',
          destinationWalletId: actors.memberB.wallet.id,
          expectedDestinationVersion: actors.memberB.balance.rowVersion,
          expectedSourceVersion: actors.memberA.balance.rowVersion,
          sourceWalletId: actors.memberA.wallet.id,
        },
        `m08-rate-invalid-${index}`,
      ),
    );
    for (const request of invalidAttempts.slice(0, 2)) {
      await expect(
        lowRateBus.submit(memberBActor, stressWorld.worldId, request, ids.next(), new Date()),
      ).resolves.toMatchObject({
        result: { rejectionCode: 'WALLET_NOT_CONTROLLED', status: 'rejected' },
      });
    }
    await expect(
      lowRateBus.submit(
        memberBActor,
        stressWorld.worldId,
        invalidAttempts[2]!,
        ids.next(),
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });

    const reconcileContext = await summary(creator, stressWorld.worldId);
    const reconcile = economyCommand(
      reconcileContext,
      'ReconcileWorldEconomyV1',
      { expectedEconomyHeadVersion: reconcileContext.economyHeadVersion },
      'm08-stress-reconcile',
    );
    const reconciled = await submit(creator, stressWorld.worldId, reconcile);
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    await expect(
      client.pool.query(
        `select status::text,mismatch_count from economy_reconciliation_runs
          where command_id=$1`,
        [reconcile.commandId],
      ),
    ).resolves.toMatchObject({ rows: [{ mismatch_count: 0, status: 'matched' }] });

    const membership = await client.pool.query<{ row_version: number }>(
      `select row_version from world_memberships where world_id=$1 and user_id=$2`,
      [stressWorld.worldId, memberA.userId],
    );
    const removal = await app.inject({
      headers: mutationHeaders(creator, `m08-remove-member-${ids.next()}`),
      method: 'DELETE',
      payload: { expectedRowVersion: membership.rows[0]!.row_version },
      url: `/api/v1/worlds/${stressWorld.worldId}/memberships/${memberA.userId}`,
    });
    expect(removal.statusCode, removal.body).toBe(200);
    const revokedRead = await app.inject({
      headers: { cookie: memberA.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${stressWorld.worldId}/economy/wallets/${actors.memberA.wallet.id}/transactions`,
    });
    expect(revokedRead.statusCode, revokedRead.body).toBe(404);
    await expect(
      client.pool.query(
        `select count(*)::integer as count from command_records
          where world_id=$1 and payload is not null and command_type = any($2::text[])`,
        [
          stressWorld.worldId,
          [
            'InitializeWorldEconomyV1',
            'TransferCurrencyV1',
            'IssueCurrencyV1',
            'TransferAssetV1',
            'CreateAssetTransferOfferV1',
            'CancelAssetTransferOfferV1',
            'AcceptAssetTransferOfferV1',
            'ReconcileWorldEconomyV1',
          ],
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 180_000);

  it('keeps untargeted offers invitation-only and rolls back after payment and title failure boundaries', async () => {
    await initialize(offerWorld);
    let actors = await wallets(offerWorld.worldId);
    await transferAsset(creator, offerWorld.worldId, actors.memberA.wallet.ownerEntityLogicalKey);
    actors = await wallets(offerWorld.worldId);
    let invitation = await createOffer(memberA, offerWorld.worldId, actors.memberA, null);
    const hiddenList = await app.inject({
      headers: { cookie: memberB.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${offerWorld.worldId}/asset-transfer-offers`,
    });
    expect(hiddenList.statusCode, hiddenList.body).toBe(200);
    expect(hiddenList.json()).toEqual({ items: [], nextCursor: null });
    const invited = await offer(memberB, offerWorld.worldId, invitation.offer.id);
    expect(invited).toMatchObject({
      canAccept: true,
      controlledBuyer: false,
      controlledSeller: false,
      eligibleBuyerWallet: {
        ownerEntityLogicalKey: actors.memberB.wallet.ownerEntityLogicalKey,
        walletId: actors.memberB.wallet.id,
        walletVersion: actors.memberB.balance.rowVersion,
      },
      offer: { buyerEntityLogicalKey: null, status: 'open' },
    });
    const observerInvitation = await offer(observer, offerWorld.worldId, invitation.offer.id);
    expect(observerInvitation).toMatchObject({
      canAccept: false,
      eligibleBuyerWallet: null,
      offer: { id: invitation.offer.id },
    });

    for (const boundary of ['ownership', 'offer'] as const) {
      const currentInvitation = await offer(memberB, offerWorld.worldId, invitation.offer.id);
      actors = await wallets(offerWorld.worldId);
      const before = await economyFootprint(offerWorld.worldId, invitation.offer.id);
      const body = acceptCommand(
        await summary(memberB, offerWorld.worldId),
        currentInvitation,
        actors.memberB,
        (await asset(memberB, offerWorld.worldId)).ownership.ownershipVersion,
        `m08-failure-${boundary}`,
      );
      await installDropUpdateTrigger(boundary);
      try {
        const response = await submit(memberB, offerWorld.worldId, body);
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({
          commandId: body.commandId,
          rejectionCode: 'AGGREGATE_VERSION_CONFLICT',
          status: 'rejected',
        });
      } finally {
        await removeDropUpdateTrigger(boundary);
      }
      await expect(economyFootprint(offerWorld.worldId, invitation.offer.id)).resolves.toEqual(
        before,
      );
      await expect(
        client.pool.query(`select status::text,payload from command_records where id=$1`, [
          body.commandId,
        ]),
      ).resolves.toMatchObject({ rows: [{ payload: null, status: 'rejected' }] });
      await cancelOffer(
        memberA,
        offerWorld.worldId,
        await offer(memberA, offerWorld.worldId, invitation.offer.id),
      );
      if (boundary === 'ownership') {
        actors = await wallets(offerWorld.worldId);
        invitation = await createOffer(memberA, offerWorld.worldId, actors.memberA, null);
      }
    }
    expect((await asset(memberA, offerWorld.worldId)).ownership.ownerEntityLogicalKey).toBe(
      actors.memberA.wallet.ownerEntityLogicalKey,
    );
  }, 180_000);

  it('serializes gift/purchase, double-accept, cancel/accept, and expiry/accept races then reconciles', async () => {
    let actors = await wallets(offerWorld.worldId);

    let contested = await createOffer(
      memberA,
      offerWorld.worldId,
      actors.memberA,
      actors.creator.wallet.ownerEntityLogicalKey,
    );
    let raceContext = await summary(memberA, offerWorld.worldId);
    let currentAsset = await asset(memberA, offerWorld.worldId);
    const purchase = acceptCommand(
      raceContext,
      await offer(creator, offerWorld.worldId, contested.offer.id),
      actors.creator,
      currentAsset.ownership.ownershipVersion,
      'm08-gift-purchase-accept',
    );
    const competingGift = economyCommand(
      raceContext,
      'TransferAssetV1',
      {
        assetKey: ASSET_KEY,
        expectedOwnershipVersion: currentAsset.ownership.ownershipVersion,
        toOwnerEntityKey: actors.creator.wallet.ownerEntityLogicalKey,
      },
      'm08-gift-purchase-gift',
    );
    const beforeGiftPurchase = await economyFootprint(offerWorld.worldId, contested.offer.id);
    const giftPurchaseResponses = await Promise.all([
      submit(creator, offerWorld.worldId, purchase),
      submit(memberA, offerWorld.worldId, competingGift),
    ]);
    const giftPurchaseAccepted = giftPurchaseResponses
      .map((response, index) => ({ command: [purchase, competingGift][index]!, response }))
      .filter(({ response }) => response.json<WorldCommandResultTransport>().status === 'accepted');
    expect(giftPurchaseAccepted).toHaveLength(1);
    expect((await asset(creator, offerWorld.worldId)).ownership.ownerEntityLogicalKey).toBe(
      actors.creator.wallet.ownerEntityLogicalKey,
    );
    const afterGiftPurchase = await economyFootprint(offerWorld.worldId, contested.offer.id);
    if (giftPurchaseAccepted[0]!.command.type === 'AcceptAssetTransferOfferV1') {
      expect(BigInt(afterGiftPurchase.state.transactions)).toBe(
        BigInt(beforeGiftPurchase.state.transactions) + 1n,
      );
      expect(afterGiftPurchase.state.offer_status).toBe('accepted');
    } else {
      expect(afterGiftPurchase.state.transactions).toBe(beforeGiftPurchase.state.transactions);
      expect(afterGiftPurchase.balances).toEqual(beforeGiftPurchase.balances);
      expect(afterGiftPurchase.state.offer_status).toBe('open');
      await cancelOffer(
        memberA,
        offerWorld.worldId,
        await offer(memberA, offerWorld.worldId, contested.offer.id),
      );
    }
    await transferAsset(creator, offerWorld.worldId, actors.memberA.wallet.ownerEntityLogicalKey);

    actors = await wallets(offerWorld.worldId);
    contested = await createOffer(
      memberA,
      offerWorld.worldId,
      actors.memberA,
      actors.creator.wallet.ownerEntityLogicalKey,
    );
    raceContext = await summary(creator, offerWorld.worldId);
    currentAsset = await asset(creator, offerWorld.worldId);
    const buyerView = await offer(creator, offerWorld.worldId, contested.offer.id);
    const firstAccept = acceptCommand(
      raceContext,
      buyerView,
      actors.creator,
      currentAsset.ownership.ownershipVersion,
      'm08-double-accept-a',
    );
    const secondAccept = acceptCommand(
      raceContext,
      buyerView,
      actors.creator,
      currentAsset.ownership.ownershipVersion,
      'm08-double-accept-b',
    );
    const beforeDouble = await economyFootprint(offerWorld.worldId, contested.offer.id);
    const doubleResponses = await Promise.all([
      submit(creator, offerWorld.worldId, firstAccept),
      submit(creator, offerWorld.worldId, secondAccept),
    ]);
    const doubleAccepted = doubleResponses
      .map((response, index) => ({ command: [firstAccept, secondAccept][index]!, response }))
      .filter(({ response }) => response.json<WorldCommandResultTransport>().status === 'accepted');
    expect(doubleAccepted).toHaveLength(1);
    const afterDouble = await economyFootprint(offerWorld.worldId, contested.offer.id);
    expect(BigInt(afterDouble.state.transactions)).toBe(
      BigInt(beforeDouble.state.transactions) + 1n,
    );
    expect(afterDouble.state.offer_status).toBe('accepted');
    const purchaseEvents = await client.pool.query<{ event_ordinal: number; event_type: string }>(
      `select event_ordinal,event_type from domain_events
        where command_id=$1 order by event_ordinal`,
      [doubleAccepted[0]!.command.commandId],
    );
    expect(purchaseEvents.rows).toEqual([
      { event_ordinal: 0, event_type: 'CurrencyTransferredV1' },
      { event_ordinal: 1, event_type: 'AssetOwnershipTransferredV1' },
      { event_ordinal: 2, event_type: 'AssetTransferOfferAcceptedV1' },
      { event_ordinal: 3, event_type: 'AssetPurchasedV1' },
    ]);
    await transferAsset(creator, offerWorld.worldId, actors.memberA.wallet.ownerEntityLogicalKey);

    actors = await wallets(offerWorld.worldId);
    contested = await createOffer(
      memberA,
      offerWorld.worldId,
      actors.memberA,
      actors.creator.wallet.ownerEntityLogicalKey,
    );
    raceContext = await summary(memberA, offerWorld.worldId);
    currentAsset = await asset(memberA, offerWorld.worldId);
    const acceptAgainstCancel = acceptCommand(
      raceContext,
      await offer(creator, offerWorld.worldId, contested.offer.id),
      actors.creator,
      currentAsset.ownership.ownershipVersion,
      'm08-cancel-accept-accept',
    );
    const cancelAgainstAccept = economyCommand(
      raceContext,
      'CancelAssetTransferOfferV1',
      { expectedOfferVersion: contested.offer.rowVersion, offerId: contested.offer.id },
      'm08-cancel-accept-cancel',
    );
    const beforeCancelAccept = await economyFootprint(offerWorld.worldId, contested.offer.id);
    const cancelAcceptResponses = await Promise.all([
      submit(creator, offerWorld.worldId, acceptAgainstCancel),
      submit(memberA, offerWorld.worldId, cancelAgainstAccept),
    ]);
    const cancelAcceptAccepted = cancelAcceptResponses
      .map((response, index) => ({
        command: [acceptAgainstCancel, cancelAgainstAccept][index]!,
        response,
      }))
      .filter(({ response }) => response.json<WorldCommandResultTransport>().status === 'accepted');
    expect(cancelAcceptAccepted).toHaveLength(1);
    const afterCancelAccept = await economyFootprint(offerWorld.worldId, contested.offer.id);
    if (cancelAcceptAccepted[0]!.command.type === 'AcceptAssetTransferOfferV1') {
      expect(afterCancelAccept.state.offer_status).toBe('accepted');
      expect(BigInt(afterCancelAccept.state.transactions)).toBe(
        BigInt(beforeCancelAccept.state.transactions) + 1n,
      );
      await transferAsset(creator, offerWorld.worldId, actors.memberA.wallet.ownerEntityLogicalKey);
    } else {
      expect(afterCancelAccept.state.offer_status).toBe('cancelled');
      expect(afterCancelAccept.state.transactions).toBe(beforeCancelAccept.state.transactions);
      expect(afterCancelAccept.balances).toEqual(beforeCancelAccept.balances);
      expect((await asset(memberA, offerWorld.worldId)).ownership.ownerEntityLogicalKey).toBe(
        actors.memberA.wallet.ownerEntityLogicalKey,
      );
    }

    actors = await wallets(offerWorld.worldId);
    const beforeExpiryClock = await readClock(offerWorld.worldId);
    contested = await createOffer(
      memberA,
      offerWorld.worldId,
      actors.memberA,
      actors.creator.wallet.ownerEntityLogicalKey,
      (BigInt(beforeExpiryClock.clock.currentTick) + 1n).toString(),
    );
    const currentClock = await readClock(offerWorld.worldId);
    const advance: SubmitWorldCommand = {
      commandId: ids.next(),
      expectedAggregateVersion: currentClock.aggregateVersion,
      expectedStateRevision: currentClock.stateRevision,
      expectedTick: currentClock.clock.currentTick,
      expectedWorldVersion: currentClock.designVersion,
      idempotencyKey: `m08-expiry-advance-${ids.next()}`,
      payload: { ticks: 1 },
      schemaVersion: 1,
      type: 'AdvanceSimulationV1',
    };
    const advanced = await submit(creator, offerWorld.worldId, advance);
    expect(advanced.statusCode, advanced.body).toBe(200);
    const dueClock = await readClock(offerWorld.worldId);
    const dueView = await offer(creator, offerWorld.worldId, contested.offer.id);
    expect(dueView.canAccept).toBe(false);
    actors = await wallets(offerWorld.worldId);
    currentAsset = await asset(creator, offerWorld.worldId);
    const dueContext = await summary(creator, offerWorld.worldId);
    const lateAccept = acceptCommand(
      dueContext,
      dueView,
      actors.creator,
      currentAsset.ownership.ownershipVersion,
      'm08-expiry-late-accept',
    );
    const expiryModule = (await import(
      new URL(
        ['..', '..', '..', 'packages', 'economy-command', 'src', 'postgres.ts'].join('/'),
        import.meta.url,
      ).href
    )) as unknown as ExpiryCommandModule;
    const expiry = new expiryModule.PostgresEconomyOfferExpiryCommand(appClient.pool, {
      ids,
      maximumSerializationAttempts: 3,
      retryDelay: async () => undefined,
    });
    const expiryCommandId = ids.next();
    const expiryEventId = ids.next();
    const beforeExpiry = await economyFootprint(offerWorld.worldId, contested.offer.id);
    const [expiryResult, lateAcceptResponse] = await Promise.all([
      expiry.expire({
        commandId: expiryCommandId,
        eventId: expiryEventId,
        expectedOfferVersion: dueView.offer.rowVersion,
        expectedStateRevision: dueContext.stateRevision,
        expectedTick: dueClock.clock.currentTick,
        expectedWorldVersion: dueContext.designVersion,
        idempotencyKey: `economy-offer-expiry-v1:${dueView.offer.id}:${dueView.offer.expiresAtTick}`,
        offerId: dueView.offer.id,
        worldId: offerWorld.worldId,
      }),
      submit(creator, offerWorld.worldId, lateAccept),
    ]);
    expect(expiryResult).toMatchObject({ status: 'expired' });
    expect(lateAcceptResponse.json<WorldCommandResultTransport>().status).toBe('rejected');
    const afterExpiry = await economyFootprint(offerWorld.worldId, contested.offer.id);
    expect(afterExpiry.balances).toEqual(beforeExpiry.balances);
    expect(afterExpiry.state).toMatchObject({
      owner_entity_id: beforeExpiry.state.owner_entity_id,
      offer_status: 'expired',
      transactions: beforeExpiry.state.transactions,
      transfers: beforeExpiry.state.transfers,
    });
    const expiryParticipants = await client.pool.query<{
      counterparty_entity_id: string;
      participant_entity_id: string;
      user_id: string;
    }>(
      `select user_id::text,participant_entity_id::text,counterparty_entity_id::text
         from economy_participant_history where command_id=$1 order by user_id`,
      [expiryCommandId],
    );
    expect(expiryParticipants.rows).toHaveLength(2);
    expect(expiryParticipants.rows.map((row) => row.user_id).sort()).toEqual(
      [creator.userId, memberA.userId].sort(),
    );
    expect(
      expiryParticipants.rows.every(
        (row) =>
          typeof row.counterparty_entity_id === 'string' &&
          typeof row.participant_entity_id === 'string',
      ),
    ).toBe(true);
    expect(expiryParticipants.rows[0]!.participant_entity_id).toBe(
      expiryParticipants.rows[1]!.counterparty_entity_id,
    );
    expect(expiryParticipants.rows[1]!.participant_entity_id).toBe(
      expiryParticipants.rows[0]!.counterparty_entity_id,
    );

    const reconcileContext = await summary(creator, offerWorld.worldId);
    const reconcile = economyCommand(
      reconcileContext,
      'ReconcileWorldEconomyV1',
      { expectedEconomyHeadVersion: reconcileContext.economyHeadVersion },
      'm08-reconcile',
    );
    const reconciliation = await submit(creator, offerWorld.worldId, reconcile);
    expect(reconciliation.statusCode, reconciliation.body).toBe(200);
    const reconciledEvent = await client.pool.query<{ payload: { status: string } }>(
      `select payload from domain_events where command_id=$1 and event_type='WorldEconomyReconciledV1'`,
      [reconcile.commandId],
    );
    expect(reconciledEvent.rows).toMatchObject([{ payload: { status: 'matched' } }]);
    const reconciledSummary = await summary(creator, offerWorld.worldId);
    expect(reconciledSummary.status).toBe('ready');
    expect(reconciledSummary.reconciliation.status).toBe('current');
    expect(reconciledSummary.reconciliation.lastReconciledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(typeof reconciledSummary.reconciliation.lastReconciledStateRevision).toBe('string');
  }, 180_000);

  it('exposes only the creator issuance target and admits one capped issuance in a race', async () => {
    await initialize(issuanceWorld);
    const context = await summary(creator, issuanceWorld.worldId);
    const target = context.issuanceTarget;
    expect(target).not.toBeNull();
    expect((await summary(memberA, issuanceWorld.worldId)).issuanceTarget).toBeNull();
    if (!target?.maxSupplyMinor)
      throw new Error('The issuance fixture requires a capped currency.');
    const deltaMinor = BigInt(target.maxSupplyMinor) - BigInt(target.currentSupplyMinor);
    expect(deltaMinor).toBeGreaterThan(0n);
    const amount = canonicalAmount(deltaMinor, target.minorUnitScale);
    const issueA = economyCommand(
      context,
      'IssueCurrencyV1',
      {
        amount,
        confirmation: 'ISSUE VIRTUAL CURRENCY',
        expectedSupplyVersion: target.supplyVersion,
        reason: 'M08 concurrent cap boundary verification A.',
        treasuryWalletId: target.treasuryWalletId,
      },
      'm08-cap-issuance-a',
    );
    const issueB = economyCommand(
      context,
      'IssueCurrencyV1',
      {
        amount,
        confirmation: 'ISSUE VIRTUAL CURRENCY',
        expectedSupplyVersion: target.supplyVersion,
        reason: 'M08 concurrent cap boundary verification B.',
        treasuryWalletId: target.treasuryWalletId,
      },
      'm08-cap-issuance-b',
    );
    const responses = await Promise.all([
      submit(creator, issuanceWorld.worldId, issueA),
      submit(creator, issuanceWorld.worldId, issueB),
    ]);
    const accepted = responses
      .map((response, index) => ({ command: [issueA, issueB][index]!, response }))
      .filter(({ response }) => response.json<WorldCommandResultTransport>().status === 'accepted');
    expect(accepted).toHaveLength(1);
    expect(
      responses.filter(
        (response) => response.json<WorldCommandResultTransport>().status === 'rejected',
      ),
    ).toHaveLength(1);
    const state = await client.pool.query<{
      available_minor: string;
      current_supply_minor: string;
      max_supply_minor: string;
      override_count: string;
      transaction_count: string;
    }>(
      `select supply.current_supply_minor::text,currency.max_supply_minor::text,
              balance.available_minor::text,
              (select count(*)::text from creator_override_records record
                where record.command_id=any($2::uuid[])) as override_count,
              (select count(*)::text from financial_transactions transaction_record
                where transaction_record.command_id=any($2::uuid[])) as transaction_count
         from currencies currency
         join currency_supply supply on supply.currency_id=currency.id
         join wallets wallet on wallet.currency_id=currency.id and wallet.wallet_kind='treasury'
         join wallet_balances balance on balance.wallet_id=wallet.id
        where currency.world_id=$1`,
      [issuanceWorld.worldId, [issueA.commandId, issueB.commandId]],
    );
    expect(state.rows).toEqual([
      {
        available_minor: deltaMinor.toString(),
        current_supply_minor: target.maxSupplyMinor,
        max_supply_minor: target.maxSupplyMinor,
        override_count: '1',
        transaction_count: '1',
      },
    ]);
    const replay = await submit(creator, issuanceWorld.worldId, accepted[0]!.command);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(accepted[0]!.response.json());
    await expect(
      client.pool.query(
        `select count(*)::integer as count from security_audit_records
          where action='economy.currency.issue' and target_id=$1`,
        [target.currencyId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  }, 180_000);

  it('rejects a self-consistent tampered legacy plan and adopts only the artifact-derived plan', async () => {
    const legacy = await convertToLegacy(legacyWorld.worldId);
    expect(await summary(creator, legacyWorld.worldId)).toMatchObject({
      capabilities: { canAdoptLegacySeed: true, canInitialize: false },
      economyHeadVersion: null,
      seedPlan: { available: false, sourceKind: null },
      status: 'not_initialized',
    });
    const tampered = structuredClone(legacy.plan);
    const playerIndex = tampered.wallets.findIndex((wallet) => wallet.walletKind === 'player');
    expect(playerIndex).toBeGreaterThanOrEqual(0);
    const originalBalance = BigInt(tampered.wallets[playerIndex]!.initialBalanceMinor);
    tampered.wallets[playerIndex]!.initialBalanceMinor = (originalBalance - 1n).toString();
    tampered.initialSupplyMinor = (BigInt(tampered.initialSupplyMinor) - 1n).toString();
    const tamperedHash = economySeedPlanHash(tampered);
    const tamperedCommand = economyCommand(
      await summary(creator, legacyWorld.worldId),
      'AdoptLegacyEconomySeedPlanV1',
      {
        adapterId: 'LegacyEconomySeedAdapterV1',
        adapterVersion: '1.0.0',
        compiledWorldVersionId: legacy.worldVersionId,
        legacyArtifactHash: legacy.artifactHash,
        legacyArtifactSchemaVersion: 1,
        legacyCompilerVersion: '1.0.0',
        seedPlan: tampered,
        seedPlanHash: tamperedHash,
      },
      'm08-legacy-tamper',
    );
    const rejected = await submit(creator, legacyWorld.worldId, tamperedCommand);
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json()).toMatchObject({
      commandId: tamperedCommand.commandId,
      rejectionCode: 'SEED_PLAN_INCOMPATIBLE',
      status: 'rejected',
    });
    await expect(
      client.pool.query(
        `select count(*)::integer as count from compiled_economy_seed_plans where world_id=$1`,
        [legacyWorld.worldId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const adoption = economyCommand(
      await summary(creator, legacyWorld.worldId),
      'AdoptLegacyEconomySeedPlanV1',
      {
        adapterId: 'LegacyEconomySeedAdapterV1',
        adapterVersion: '1.0.0',
        compiledWorldVersionId: legacy.worldVersionId,
        legacyArtifactHash: legacy.artifactHash,
        legacyArtifactSchemaVersion: 1,
        legacyCompilerVersion: '1.0.0',
        seedPlan: legacy.plan,
        seedPlanHash: legacy.planHash,
      },
      'm08-legacy-adoption',
    );
    const adopted = await submit(creator, legacyWorld.worldId, adoption);
    expect(adopted.statusCode, adopted.body).toBe(200);
    await expect(
      client.pool.query(
        `select source_kind::text,encode(plan_hash,'hex') as plan_hash,
                adopted_command_id::text,canonical_plan
           from compiled_economy_seed_plans where world_id=$1`,
        [legacyWorld.worldId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          adopted_command_id: adoption.commandId,
          canonical_plan: legacy.plan,
          plan_hash: legacy.planHash,
          source_kind: 'legacy_1_0_adapter',
        },
      ],
    });
    await initialize(legacyWorld);
    expect(await summary(creator, legacyWorld.worldId)).toMatchObject({
      capabilities: { canAdoptLegacySeed: false, canInitialize: false },
      seedPlan: { available: true, hash: legacy.planHash, sourceKind: 'legacy_adapter' },
      status: 'reconciling',
    });
    await expect(
      client.pool.query(
        `select count(*)::integer as count from command_records
          where world_id=$1 and command_type in (
            'AdoptLegacyEconomySeedPlanV1','InitializeWorldEconomyV1'
          ) and payload is not null`,
        [legacyWorld.worldId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 180_000);

  it('runs Harbor commerce with access boundaries, terminal races, atomic rollback, and reconciliation end to end', async () => {
    await initialize(commerceWorld);
    await initializeCommerce(commerceWorld);

    const seeded = await client.pool.query<{
      backing_organization_entity_id: string;
      business_id: string;
      business_row_version: string;
      business_wallet_id: string;
      facility_asset_id: string;
      facility_id: string;
      facility_row_version: string;
      organization_key: string;
      recipe_inputs: Array<{ quantity: string; resourceTypeId: string }>;
      recipe_version_id: string;
    }>(
      `select business.id::text as business_id,business.row_version::text as business_row_version,
              business.wallet_id::text as business_wallet_id,
              business.backing_organization_entity_id::text,
              organization.logical_key::text as organization_key,
              facility.id::text as facility_id,facility.row_version::text as facility_row_version,
              facility.facility_asset_id::text,version.id::text as recipe_version_id,
              version.canonical_inputs as recipe_inputs
         from businesses business
         join world_entities organization
           on organization.world_id=business.world_id
          and organization.id=business.backing_organization_entity_id
         join business_facilities facility
           on facility.world_id=business.world_id and facility.business_id=business.id
         join business_facility_recipe_versions capability
           on capability.world_id=facility.world_id and capability.facility_id=facility.id
         join production_recipe_versions version
           on version.world_id=capability.world_id and version.id=capability.recipe_version_id
        where business.world_id=$1`,
      [commerceWorld.worldId],
    );
    expect(seeded.rows).toHaveLength(1);
    const business = seeded.rows[0]!;
    const people = await client.pool.query<{
      available_minor: string;
      entity_id: string;
      entity_key: string;
      organization_key: string | null;
      user_id: string;
      wallet_id: string;
      wallet_version: string;
    }>(
      `select controller.user_id::text,character.id::text as entity_id,
              character.logical_key::text as entity_key,
              character.state ->> 'organizationLogicalKey' as organization_key,
              wallet.id::text as wallet_id,balance.available_minor::text,
              balance.row_version::text as wallet_version
         from world_entity_controllers controller
         join world_entities character
           on character.world_id=controller.world_id and character.id=controller.entity_id
          and character.entity_type='player_character'
          and character.retired_world_version_id is null
         join wallets wallet
           on wallet.world_id=character.world_id and wallet.owner_entity_id=character.id
          and wallet.wallet_kind='player'
        join wallet_balances balance on balance.wallet_id=wallet.id
        where controller.world_id=$1 and controller.revoked_at is null
        order by character.state ->> 'organizationLogicalKey',controller.user_id`,
      [commerceWorld.worldId],
    );
    const sessions = new Map<string, BrowserSession>(
      [creator, memberA, memberB, ...marketRaceBuyers].map((session) => [
        session.userId,
        session,
      ]),
    );
    expect(people.rows).toHaveLength(sessions.size);
    const managerPerson = people.rows.find(
      (person) => person.organization_key === business.organization_key,
    );
    expect(managerPerson).toBeDefined();
    const artisanManagerPerson =
      people.rows.find(
        (person) =>
          person.organization_key === 'organization:artisan-guild' &&
          person.user_id !== managerPerson?.user_id &&
          person.user_id !== creator.userId,
      ) ??
      people.rows.find(
        (person) =>
          person.organization_key === 'organization:artisan-guild' &&
          person.user_id !== managerPerson?.user_id,
      );
    expect(artisanManagerPerson).toBeDefined();
    const workerPerson = people.rows.find(
      (person) =>
        person.user_id !== managerPerson?.user_id &&
        person.user_id !== artisanManagerPerson?.user_id &&
        person.organization_key !== business.organization_key,
    );
    expect(workerPerson).toBeDefined();
    const unrelatedPerson = people.rows.find(
      (person) =>
        person.user_id !== managerPerson?.user_id &&
        person.user_id !== workerPerson?.user_id &&
        person.user_id !== artisanManagerPerson?.user_id,
    );
    expect(unrelatedPerson).toBeDefined();
    const manager = sessions.get(managerPerson!.user_id);
    const worker = sessions.get(workerPerson!.user_id);
    const unrelated = sessions.get(unrelatedPerson!.user_id);
    expect(manager).toBeDefined();
    expect(worker).toBeDefined();
    expect(unrelated).toBeDefined();

    const artisanManager = sessions.get(artisanManagerPerson!.user_id);
    expect(artisanManager).toBeDefined();
    const artisanPrerequisites = await client.pool.query<{
      organization_entity_key: string;
      wallet_id: string;
    }>(
      `select organization.logical_key::text as organization_entity_key,wallet.id::text as wallet_id
         from world_entities organization
         join wallets wallet
           on wallet.world_id=organization.world_id and wallet.owner_entity_id=organization.id
          and wallet.wallet_kind='organization' and wallet.status='active'
        where organization.world_id=$1
          and organization.logical_key='organization:artisan-guild'
          and organization.retired_world_version_id is null`,
      [commerceWorld.worldId],
    );
    expect(artisanPrerequisites.rows).toHaveLength(1);
    const createArtisanBusiness = commerceCommandFromContext(
      await commerceContext(artisanManager!, commerceWorld.worldId),
      'CreateBusinessV1',
      {
        backingOrganizationEntityKey: artisanPrerequisites.rows[0]!.organization_entity_key,
        walletId: artisanPrerequisites.rows[0]!.wallet_id,
      },
      'm09-create-artisan-business',
    );
    const artisanBusinessCreated = await submit(
      artisanManager!,
      commerceWorld.worldId,
      createArtisanBusiness,
    );
    expect(artisanBusinessCreated.statusCode, artisanBusinessCreated.body).toBe(200);
    const artisanBusinessId = await eventAggregateId(
      createArtisanBusiness.commandId,
      'BusinessCreatedV1',
    );
    await expect(
      client.pool.query(
        `select stable_key::text,status::text,wallet_id::text,row_version::text
           from businesses where world_id=$1 and id=$2`,
        [commerceWorld.worldId, artisanBusinessId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          row_version: '1',
          stable_key: 'business:artisan-guild',
          status: 'active',
          wallet_id: artisanPrerequisites.rows[0]!.wallet_id,
        },
      ],
    });
    const artisanBusinessRead = await app.inject({
      headers: { cookie: artisanManager!.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${commerceWorld.worldId}/economy/businesses`,
    });
    expect(artisanBusinessRead.statusCode, artisanBusinessRead.body).toBe(200);
    expect(
      artisanBusinessRead
        .json<{ items: Array<{ canManage: boolean; id: string }> }>()
        .items.find((item) => item.id === artisanBusinessId),
    ).toMatchObject({ canManage: true, id: artisanBusinessId });

    const annexBeforeConfiguration = await asset(
      manager!,
      commerceWorld.worldId,
      'asset:facility:energy-harbor-annex',
    );
    expect(annexBeforeConfiguration).toMatchObject({
      asset: {
        assetType: 'workshop',
        stableKey: 'asset:facility:energy-harbor-annex',
      },
      ownership: {
        ownerEntityLogicalKey: business.organization_key,
        ownershipVersion: '1',
      },
    });
    const configureAnnexPayload = {
      businessId: business.business_id,
      expectedBusinessVersion: business.business_row_version,
      expectedOwnershipVersion: annexBeforeConfiguration.ownership.ownershipVersion,
      facilityAssetId: annexBeforeConfiguration.asset.id,
      recipeVersionIds: [business.recipe_version_id],
    };
    const deniedAnnexConfiguration = commerceCommandFromContext(
      await commerceContext(artisanManager!, commerceWorld.worldId),
      'ConfigureBusinessFacilityV1',
      configureAnnexPayload,
      'm09-configure-annex-denied',
    );
    const deniedAnnexResponse = await submit(
      artisanManager!,
      commerceWorld.worldId,
      deniedAnnexConfiguration,
    );
    expect(deniedAnnexResponse.statusCode, deniedAnnexResponse.body).toBe(403);
    expect(deniedAnnexResponse.json()).toMatchObject({
      rejectionCode: 'AUTHORIZATION_DENIED',
      status: 'rejected',
    });
    const configureAnnex = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'ConfigureBusinessFacilityV1',
      configureAnnexPayload,
      'm09-configure-annex',
    );
    const annexConfigured = await submit(manager!, commerceWorld.worldId, configureAnnex);
    expect(annexConfigured.statusCode, annexConfigured.body).toBe(200);
    const annexFacilityId = await eventAggregateId(
      configureAnnex.commandId,
      'BusinessFacilityConfiguredV1',
    );
    await expect(
      client.pool.query(
        `select business_id::text,facility_asset_id::text,status::text,row_version::text
           from business_facilities where world_id=$1 and id=$2`,
        [commerceWorld.worldId, annexFacilityId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          business_id: business.business_id,
          facility_asset_id: annexBeforeConfiguration.asset.id,
          row_version: '1',
          status: 'active',
        },
      ],
    });

    const transferConfiguredAnnex = economyCommand(
      await summary(manager!, commerceWorld.worldId),
      'TransferAssetV1',
      {
        assetKey: annexBeforeConfiguration.asset.stableKey,
        expectedOwnershipVersion: annexBeforeConfiguration.ownership.ownershipVersion,
        toOwnerEntityKey: workerPerson!.entity_key,
      },
      'm09-transfer-configured-annex-denied',
    );
    const transferConfiguredAnnexResponse = await submit(
      manager!,
      commerceWorld.worldId,
      transferConfiguredAnnex,
    );
    expect(transferConfiguredAnnexResponse.statusCode, transferConfiguredAnnexResponse.body).toBe(
      409,
    );
    expect(transferConfiguredAnnexResponse.json()).toMatchObject({
      rejectionCode: 'ASSET_NOT_TRANSFERABLE',
      status: 'rejected',
    });
    const annexAfterRejectedTransfer = await asset(
      manager!,
      commerceWorld.worldId,
      annexBeforeConfiguration.asset.stableKey,
    );
    expect(annexAfterRejectedTransfer.ownership).toEqual(annexBeforeConfiguration.ownership);

    const businessBalance = await client.pool.query<{
      available_minor: string;
      row_version: string;
    }>(`select available_minor::text,row_version::text from wallet_balances where wallet_id=$1`, [
      business.business_wallet_id,
    ]);
    const funding = economyCommand(
      await summary(manager!, commerceWorld.worldId),
      'TransferCurrencyV1',
      {
        amount: '50.00',
        destinationWalletId: business.business_wallet_id,
        expectedDestinationVersion: businessBalance.rows[0]!.row_version,
        expectedSourceVersion: managerPerson!.wallet_version,
        sourceWalletId: managerPerson!.wallet_id,
      },
      'm09-fund-business',
    );
    const funded = await submit(manager!, commerceWorld.worldId, funding);
    expect(funded.statusCode, funded.body).toBe(200);

    const contractCommand = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'CreateEmploymentContractV1',
      {
        businessId: business.business_id,
        cooldownTicks: '1',
        effectiveFromTick: '0',
        effectiveToTick: '100',
        employerWalletId: business.business_wallet_id,
        expectedBusinessVersion: business.business_row_version,
        maxPerformancesPerPeriod: 1,
        periodTicks: '12',
        rewardCapMinor: '100',
        roleCode: 'metalworker',
        wageMinor: '100',
        wageRuleKind: 'per_shift',
        workerEntityKey: workerPerson!.entity_key,
        workerWalletId: workerPerson!.wallet_id,
      },
      'm09-create-contract',
    );
    const contractCreated = await submit(manager!, commerceWorld.worldId, contractCommand);
    expect(contractCreated.statusCode, contractCreated.body).toBe(200);
    const contractId = await eventAggregateId(
      contractCommand.commandId,
      'EmploymentContractCreatedV1',
    );

    const acceptContract = commerceCommandFromContext(
      await commerceContext(worker!, commerceWorld.worldId),
      'AcceptEmploymentContractV1',
      { contractId, expectedContractVersion: '1' },
      'm09-accept-contract',
    );
    const acceptedContract = await submit(worker!, commerceWorld.worldId, acceptContract);
    expect(acceptedContract.statusCode, acceptedContract.body).toBe(200);

    const performJob = commerceCommandFromContext(
      await commerceContext(worker!, commerceWorld.worldId),
      'PerformJobV1',
      { contractId, expectedContractVersion: '2' },
      'm09-perform-job',
    );
    const jobPerformed = await submit(worker!, commerceWorld.worldId, performJob);
    expect(jobPerformed.statusCode, jobPerformed.body).toBe(200);
    const jobReplay = await submit(worker!, commerceWorld.worldId, performJob);
    expect(jobReplay.statusCode, jobReplay.body).toBe(200);
    expect(jobReplay.json()).toEqual(jobPerformed.json());
    await expect(
      client.pool.query(
        `select
           (select count(*)::integer from work_records
             where world_id=$1 and command_id=$2) as work_count,
           (select count(*)::integer from payroll_records
             where world_id=$1 and created_command_id=$2) as payroll_count,
           (select count(*)::integer from scheduled_actions
             where world_id=$1 and created_command_id=$2
               and action_type='SettlePayrollV1') as schedule_count`,
        [commerceWorld.worldId, performJob.commandId],
      ),
    ).resolves.toMatchObject({
      rows: [{ payroll_count: 1, schedule_count: 1, work_count: 1 }],
    });

    const inventories = await client.pool.query<{
      id: string;
      quantity: string;
      resource_type_id: string;
      row_version: string;
      stable_key: string;
    }>(
      `select inventory.id::text,inventory.resource_type_id::text,inventory.quantity::text,
              inventory.row_version::text,resource.stable_key::text
         from inventories inventory
         join resource_types resource
           on resource.world_id=inventory.world_id and resource.id=inventory.resource_type_id
        where inventory.world_id=$1
          and inventory.owner_entity_id=$2 and inventory.container_asset_id=$3
        order by resource.stable_key`,
      [commerceWorld.worldId, business.backing_organization_entity_id, business.facility_asset_id],
    );
    const inputIds = new Set(business.recipe_inputs.map((item) => item.resourceTypeId));
    const productionInputs = inventories.rows.filter((inventory) =>
      inputIds.has(inventory.resource_type_id),
    );
    expect(productionInputs).toHaveLength(2);
    const productionContext = await commerceContext(manager!, commerceWorld.worldId);
    const productionPayload = {
      businessId: business.business_id,
      expectedBusinessVersion: business.business_row_version,
      expectedFacilityVersion: business.facility_row_version,
      expectedInventories: productionInputs.map((inventory) => ({
        inventoryId: inventory.id,
        rowVersion: inventory.row_version,
      })),
      facilityId: business.facility_id,
      recipeVersionId: business.recipe_version_id,
      runQuantity: '40',
    };
    const productionCommands = ['a', 'b'].map((suffix) =>
      commerceCommandFromContext(
        productionContext,
        'StartProductionRunV1',
        productionPayload,
        `m09-start-production-${suffix}`,
      ),
    );
    const productionResponses = await Promise.all(
      productionCommands.map((command) => submit(manager!, commerceWorld.worldId, command)),
    );
    expect(
      productionResponses.filter(
        (response) => response.json<WorldCommandResultTransport>().status === 'accepted',
      ),
    ).toHaveLength(1);
    expect(
      productionResponses.filter(
        (response) => response.json<WorldCommandResultTransport>().status === 'rejected',
      ),
    ).toHaveLength(1);
    await expect(
      client.pool.query(
        `select
           count(*) filter (
             where reservation.status='active'
               and reservation.purpose_type='production_input'
           )::integer as active_reservations,
           bool_and(inventory.reserved_quantity <= inventory.quantity) as within_stock
           from inventory_reservations reservation
           join inventories inventory
             on inventory.world_id=reservation.world_id
            and inventory.id=reservation.inventory_id
          where reservation.world_id=$1
            and reservation.purpose_type='production_input'`,
        [commerceWorld.worldId],
      ),
    ).resolves.toMatchObject({
      rows: [{ active_reservations: 2, within_stock: true }],
    });

    const payrollResults = await advanceCommerceTo(commerceWorld.worldId, 1n);
    expect(payrollResults).toEqual([
      expect.objectContaining({ actionType: 'SettlePayrollV1', outcome: 'applied' }),
    ]);
    expect(await runCommerceScheduleOnce(appClient.pool, ids)).toEqual([]);
    const firstTaxResults = await advanceCommerceTo(commerceWorld.worldId, 5n);
    expect(firstTaxResults).toEqual([
      expect.objectContaining({ actionType: 'AssessPeriodicTaxV1', outcome: 'applied' }),
    ]);
    const secondTaxResults = await advanceCommerceTo(commerceWorld.worldId, 10n);
    expect(secondTaxResults).toEqual([
      expect.objectContaining({ actionType: 'AssessPeriodicTaxV1', outcome: 'applied' }),
    ]);
    const productionResults = await advanceCommerceTo(commerceWorld.worldId, 12n);
    expect(productionResults).toEqual([
      expect.objectContaining({ actionType: 'CompleteProductionRunV1', outcome: 'applied' }),
    ]);
    const endContract = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'EndEmploymentContractV1',
      {
        contractId,
        expectedContractVersion: '2',
        reason: 'Harbor integration shift completed.',
      },
      'm09-end-contract',
    );
    const contractEnded = await submit(manager!, commerceWorld.worldId, endContract);
    expect(contractEnded.statusCode, contractEnded.body).toBe(200);
    await expect(
      client.pool.query(
        `select status::text,row_version::text,terminal_reason
           from employment_contracts where world_id=$1 and id=$2`,
        [commerceWorld.worldId, contractId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          row_version: '3',
          status: 'ended',
          terminal_reason: 'Harbor integration shift completed.',
        },
      ],
    });

    await expect(
      client.pool.query(
        `select status::text,gross_minor::text,tax_minor::text,net_minor::text,
                (financial_transaction_id is not null) as transferred
           from payroll_records where world_id=$1`,
        [commerceWorld.worldId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          gross_minor: '100',
          net_minor: '100',
          status: 'paid',
          tax_minor: '0',
          transferred: true,
        },
      ],
    });
    await expect(
      client.pool.query(
        `select status::text,count(*)::integer as count from production_runs
          where world_id=$1 group by status`,
        [commerceWorld.worldId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1, status: 'completed' }] });
    const produced = await client.pool.query<{
      quantity: string;
      reserved_quantity: string;
      row_version: string;
      stable_key: string;
    }>(
      `select resource.stable_key::text,inventory.quantity::text,
              inventory.reserved_quantity::text,inventory.row_version::text
         from inventories inventory
         join resource_types resource
           on resource.world_id=inventory.world_id and resource.id=inventory.resource_type_id
        where inventory.world_id=$1 and inventory.owner_entity_id=$2
          and inventory.container_asset_id=$3 order by resource.stable_key`,
      [commerceWorld.worldId, business.backing_organization_entity_id, business.facility_asset_id],
    );
    expect(produced.rows).toMatchObject([
      { quantity: '60.000000000000', reserved_quantity: '0.000000000000' },
      { quantity: '20.000000000000', reserved_quantity: '0.000000000000' },
      { quantity: '40.000000000000', reserved_quantity: '0.000000000000' },
    ]);
    await expect(
      client.pool.query(
        `select count(*)::integer as count,coalesce(sum(amount_minor),0)::text as amount
           from tax_assessments where world_id=$1 and source_type='periodic_tax'`,
        [commerceWorld.worldId],
      ),
    ).resolves.toMatchObject({ rows: [{ amount: '20', count: 2 }] });
    await expect(
      client.pool.query(
        `select due_tick::text,status::text from scheduled_actions
          where world_id=$1 and action_type='AssessPeriodicTaxV1' and status='scheduled'`,
        [commerceWorld.worldId],
      ),
    ).resolves.toMatchObject({ rows: [{ due_tick: '15', status: 'scheduled' }] });

    const output = produced.rows.find((inventory) => inventory.quantity.startsWith('40.'))!;
    const outputIdentity = await client.pool.query<{ id: string }>(
      `select inventory.id::text from inventories inventory
       join resource_types resource
         on resource.world_id=inventory.world_id and resource.id=inventory.resource_type_id
       where inventory.world_id=$1 and inventory.owner_entity_id=$2
         and inventory.container_asset_id=$3 and resource.stable_key='resource:metal-part'`,
      [commerceWorld.worldId, business.backing_organization_entity_id, business.facility_asset_id],
    );
    const outputInventoryId = outputIdentity.rows[0]!.id;
    const listingCommand = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'CreateMarketListingV1',
      {
        expiresAtTick: '30',
        expectedInventoryVersion: output.row_version,
        quantity: '10',
        sellerInventoryId: outputInventoryId,
        sellerWalletId: business.business_wallet_id,
        unitPriceMinor: '100',
      },
      'm09-list-ten',
    );
    const listed = await submit(manager!, commerceWorld.worldId, listingCommand);
    expect(listed.statusCode, listed.body).toBe(200);
    const listingId = await eventAggregateId(listingCommand.commandId, 'MarketListingCreatedV1');
    const buyerWallet = await client.pool.query<{
      row_version: string;
    }>(`select row_version::text from wallet_balances where wallet_id=$1`, [
      workerPerson!.wallet_id,
    ]);
    const partialPurchase = commerceCommandFromContext(
      await commerceContext(worker!, commerceWorld.worldId),
      'PurchaseMarketListingV1',
      {
        buyerInventoryId: null,
        buyerWalletId: workerPerson!.wallet_id,
        expectedBuyerInventoryVersion: null,
        expectedBuyerWalletVersion: buyerWallet.rows[0]!.row_version,
        expectedListingVersion: '1',
        listingId,
        quantity: '3',
      },
      'm09-buy-three',
    );
    const partiallyPurchased = await submit(worker!, commerceWorld.worldId, partialPurchase);
    expect(partiallyPurchased.statusCode, partiallyPurchased.body).toBe(200);
    const partialReplay = await submit(worker!, commerceWorld.worldId, partialPurchase);
    expect(partialReplay.statusCode, partialReplay.body).toBe(200);
    expect(partialReplay.json()).toEqual(partiallyPurchased.json());
    const changedReplay = await submit(worker!, commerceWorld.worldId, {
      ...partialPurchase,
      commandId: ids.next(),
      payload: { ...partialPurchase.payload, quantity: '2' },
    });
    expect(changedReplay.statusCode, changedReplay.body).toBe(409);
    expect(changedReplay.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });

    const partialState = await client.pool.query<{
      buyer_inventory_id: string;
      buyer_inventory_version: string;
      buyer_wallet_version: string;
      listing_version: string;
      remaining_quantity: string;
    }>(
      `select trade.buyer_inventory_id::text,
              buyer_inventory.row_version::text as buyer_inventory_version,
              buyer_balance.row_version::text as buyer_wallet_version,
              listing.row_version::text as listing_version,
              listing.remaining_quantity::text
         from market_trades trade
         join market_listings listing
           on listing.world_id=trade.world_id and listing.id=trade.listing_id
         join inventories buyer_inventory
           on buyer_inventory.world_id=trade.world_id and buyer_inventory.id=trade.buyer_inventory_id
         join wallet_balances buyer_balance on buyer_balance.wallet_id=$3
        where trade.world_id=$1 and trade.listing_id=$2`,
      [commerceWorld.worldId, listingId, workerPerson!.wallet_id],
    );
    expect(partialState.rows).toHaveLength(1);
    expect(partialState.rows[0]!.remaining_quantity).toBe('7.000000000000');
    await expect(
      client.pool.query(
        `select amount_minor::text from tax_assessments
          where world_id=$1 and source_type='market_trade'`,
        [commerceWorld.worldId],
      ),
    ).resolves.toMatchObject({ rows: [{ amount_minor: '7' }] });

    const cancelPartialListingCommand = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'CancelMarketListingV1',
      {
        expectedListingVersion: partialState.rows[0]!.listing_version,
        listingId,
      },
      'm09-cancel-partial-listing',
    );
    const cancelledPartialListing = await submit(
      manager!,
      commerceWorld.worldId,
      cancelPartialListingCommand,
    );
    expect(cancelledPartialListing.statusCode, cancelledPartialListing.body).toBe(200);

    const sellerAfterPartial = await client.pool.query<{ row_version: string }>(
      `select row_version::text from inventories where world_id=$1 and id=$2`,
      [commerceWorld.worldId, outputInventoryId],
    );
    const finalListingCommand = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'CreateMarketListingV1',
      {
        expiresAtTick: '30',
        expectedInventoryVersion: sellerAfterPartial.rows[0]!.row_version,
        quantity: '1',
        sellerInventoryId: outputInventoryId,
        sellerWalletId: business.business_wallet_id,
        unitPriceMinor: '100',
      },
      'm09-list-final-unit',
    );
    const finalListed = await submit(manager!, commerceWorld.worldId, finalListingCommand);
    expect(finalListed.statusCode, finalListed.body).toBe(200);
    const finalListingId = await eventAggregateId(
      finalListingCommand.commandId,
      'MarketListingCreatedV1',
    );
    const raceState = partialState.rows[0]!;
    const selectedRaceBuyerSessions = marketRaceBuyers
      .filter(
        (candidate) =>
          candidate.userId !== managerPerson!.user_id &&
          candidate.userId !== workerPerson!.user_id &&
          candidate.userId !== artisanManagerPerson!.user_id,
      )
      .slice(0, MARKET_RACE_BUYER_COUNT);
    expect(selectedRaceBuyerSessions).toHaveLength(MARKET_RACE_BUYER_COUNT);
    const raceBuyerState = await client.pool.query<{
      available_minor: string;
      buyer_inventory_id: string | null;
      buyer_inventory_version: string | null;
      entity_id: string;
      user_id: string;
      wallet_id: string;
      wallet_version: string;
    }>(
      `select controller.user_id::text,character.id::text as entity_id,
              wallet.id::text as wallet_id,balance.available_minor::text,
              balance.row_version::text as wallet_version,
              buyer_inventory.id::text as buyer_inventory_id,
              buyer_inventory.row_version::text as buyer_inventory_version
         from world_entity_controllers controller
         join world_entities character
           on character.world_id=controller.world_id and character.id=controller.entity_id
          and character.entity_type='player_character'
          and character.retired_world_version_id is null
         join wallets wallet
           on wallet.world_id=character.world_id and wallet.owner_entity_id=character.id
          and wallet.wallet_kind='player' and wallet.status='active'
         join wallet_balances balance
           on balance.world_id=wallet.world_id and balance.wallet_id=wallet.id
         join market_listings listing
           on listing.world_id=controller.world_id and listing.id=$2
         left join inventories buyer_inventory
           on buyer_inventory.world_id=character.world_id
          and buyer_inventory.owner_entity_id=character.id
          and buyer_inventory.resource_type_id=listing.resource_type_id
          and buyer_inventory.container_asset_id is null
        where controller.world_id=$1 and controller.revoked_at is null
          and controller.user_id=any($3::uuid[])
        order by controller.user_id`,
      [
        commerceWorld.worldId,
        finalListingId,
        selectedRaceBuyerSessions.map((buyer) => buyer.userId),
      ],
    );
    expect(raceBuyerState.rows).toHaveLength(MARKET_RACE_BUYER_COUNT);
    expect(new Set(raceBuyerState.rows.map((buyer) => buyer.user_id)).size).toBe(
      MARKET_RACE_BUYER_COUNT,
    );
    expect(new Set(raceBuyerState.rows.map((buyer) => buyer.entity_id)).size).toBe(
      MARKET_RACE_BUYER_COUNT,
    );
    expect(new Set(raceBuyerState.rows.map((buyer) => buyer.wallet_id)).size).toBe(
      MARKET_RACE_BUYER_COUNT,
    );
    expect(raceBuyerState.rows.every((buyer) => BigInt(buyer.available_minor) >= 102n)).toBe(true);
    const raceSessions = new Map(
      selectedRaceBuyerSessions.map((session) => [session.userId, session] as const),
    );
    const raceContext = await commerceContext(
      selectedRaceBuyerSessions[0]!,
      commerceWorld.worldId,
    );
    const raceAttempts = raceBuyerState.rows.map((buyer, index) => {
      const session = raceSessions.get(buyer.user_id);
      if (!session) throw new Error('M09_MARKET_RACE_SESSION_MISSING');
      return {
        body: commerceCommandFromContext(
          raceContext,
          'PurchaseMarketListingV1',
          {
            buyerInventoryId: buyer.buyer_inventory_id,
            buyerWalletId: buyer.wallet_id,
            expectedBuyerInventoryVersion: buyer.buyer_inventory_version,
            expectedBuyerWalletVersion: buyer.wallet_version,
            expectedListingVersion: '1',
            listingId: finalListingId,
            quantity: '1',
          },
          `m09-final-unit-${index}`,
        ),
        session,
      };
    });
    const raceResponses = await Promise.all(
      raceAttempts.map((attempt, index) =>
        submit(attempt.session, commerceWorld.worldId, attempt.body, `198.19.${index + 1}.1`),
      ),
    );
    const raceOutcomes = raceResponses.map((response, index) => ({
      attempt: raceAttempts[index]!,
      response,
      result: response.json<WorldCommandResultTransport>(),
    }));
    const acceptedRaceOutcomes = raceOutcomes.filter(
      (outcome) => outcome.result.status === 'accepted',
    );
    const rejectedRaceOutcomes = raceOutcomes.filter(
      (outcome) => outcome.result.status === 'rejected',
    );
    expect(acceptedRaceOutcomes).toHaveLength(1);
    expect(rejectedRaceOutcomes).toHaveLength(MARKET_RACE_BUYER_COUNT - 1);
    const acceptedRace = acceptedRaceOutcomes[0];
    expect(acceptedRace).toBeDefined();
    expect(acceptedRace!.response.statusCode).toBe(200);
    expect(acceptedRace!.result.commandId).toBe(acceptedRace!.attempt.body.commandId);
    expect(
      rejectedRaceOutcomes.every(
        (outcome) =>
          outcome.response.statusCode === 409 &&
          outcome.result.status === 'rejected' &&
          outcome.result.rejectionCode === 'REVISION_CONFLICT',
      ),
    ).toBe(true);
    await expect(
      client.pool.query<{
        accepted_count: number;
        actor_count: number;
        attempt_count: number;
        payloads_private: boolean;
        rejected_count: number;
        rejected_for_revision_conflict: boolean;
      }>(
        `select count(*)::integer as attempt_count,
                count(distinct actor_id)::integer as actor_count,
                count(*) filter (where status='accepted')::integer as accepted_count,
                count(*) filter (where status='rejected')::integer as rejected_count,
                bool_and(status <> 'rejected' or rejection_code='REVISION_CONFLICT')
                  as rejected_for_revision_conflict,
                bool_and(payload is null) as payloads_private
           from command_records
          where world_id=$1 and id=any($2::uuid[])`,
        [commerceWorld.worldId, raceAttempts.map((attempt) => attempt.body.commandId)],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          accepted_count: 1,
          actor_count: MARKET_RACE_BUYER_COUNT,
          attempt_count: MARKET_RACE_BUYER_COUNT,
          payloads_private: true,
          rejected_count: MARKET_RACE_BUYER_COUNT - 1,
          rejected_for_revision_conflict: true,
        },
      ],
    });
    await expect(
      client.pool.query(
        `select
           (select count(*)::integer from market_trades
             where world_id=$1 and listing_id=$2) as trades,
           (select count(*)::integer from inventory_movements movement
             join market_trades trade
               on trade.world_id=movement.world_id and trade.id=movement.source_id
            where trade.world_id=$1 and trade.listing_id=$2
              and movement.source_type='market_trade') as movements,
           (select count(*)::integer from tax_assessments assessment
             join market_trades trade
               on trade.world_id=assessment.world_id and trade.id=assessment.source_id
            where trade.world_id=$1 and trade.listing_id=$2
              and assessment.source_type='market_trade') as assessments,
           (select coalesce(sum(posting.signed_amount_minor),0)::text
              from wallet_postings posting
              join financial_transactions transaction_record
                on transaction_record.id=posting.transaction_id
              join market_trades trade
                on trade.wallet_transaction_id=transaction_record.id
             where trade.world_id=$1 and trade.listing_id=$2) as posting_sum,
           (select count(distinct transaction_record.id)::integer
              from financial_transactions transaction_record
              join market_trades trade
                on trade.wallet_transaction_id=transaction_record.id
             where trade.world_id=$1 and trade.listing_id=$2) as transactions,
           (select command_id::text from market_trades
             where world_id=$1 and listing_id=$2) as winning_command_id`,
        [commerceWorld.worldId, finalListingId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          assessments: 1,
          movements: 1,
          posting_sum: '0',
          trades: 1,
          transactions: 1,
          winning_command_id: acceptedRace!.result.commandId,
        },
      ],
    });

    const sellerBeforeExpensive = await client.pool.query<{ row_version: string }>(
      `select row_version::text from inventories where world_id=$1 and id=$2`,
      [commerceWorld.worldId, outputInventoryId],
    );
    const expensiveListingCommand = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'CreateMarketListingV1',
      {
        expiresAtTick: '30',
        expectedInventoryVersion: sellerBeforeExpensive.rows[0]!.row_version,
        quantity: '1',
        sellerInventoryId: outputInventoryId,
        sellerWalletId: business.business_wallet_id,
        unitPriceMinor: '1000000000',
      },
      'm09-list-insufficient-funds',
    );
    const expensiveListed = await submit(manager!, commerceWorld.worldId, expensiveListingCommand);
    expect(expensiveListed.statusCode, expensiveListed.body).toBe(200);
    const expensiveListingId = await eventAggregateId(
      expensiveListingCommand.commandId,
      'MarketListingCreatedV1',
    );
    const buyerBeforeFailure = await client.pool.query<{
      inventory_version: string;
      wallet_version: string;
    }>(
      `select inventory.row_version::text as inventory_version,
              balance.row_version::text as wallet_version
         from inventories inventory
         join wallet_balances balance on balance.wallet_id=$3
        where inventory.world_id=$1 and inventory.id=$2`,
      [commerceWorld.worldId, raceState.buyer_inventory_id, workerPerson!.wallet_id],
    );
    const insufficient = commerceCommandFromContext(
      await commerceContext(worker!, commerceWorld.worldId),
      'PurchaseMarketListingV1',
      {
        buyerInventoryId: raceState.buyer_inventory_id,
        buyerWalletId: workerPerson!.wallet_id,
        expectedBuyerInventoryVersion: buyerBeforeFailure.rows[0]!.inventory_version,
        expectedBuyerWalletVersion: buyerBeforeFailure.rows[0]!.wallet_version,
        expectedListingVersion: '1',
        listingId: expensiveListingId,
        quantity: '1',
      },
      'm09-insufficient-funds',
    );
    const insufficientResponse = await submit(worker!, commerceWorld.worldId, insufficient);
    expect(insufficientResponse.statusCode, insufficientResponse.body).toBe(409);
    expect(insufficientResponse.json()).toMatchObject({
      rejectionCode: 'INSUFFICIENT_FUNDS',
      status: 'rejected',
    });
    await expect(
      client.pool.query(
        `select count(*)::integer as count from market_trades
          where world_id=$1 and listing_id=$2`,
        [commerceWorld.worldId, expensiveListingId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const sellerBeforeRollback = await client.pool.query<{ row_version: string }>(
      `select row_version::text from inventories where world_id=$1 and id=$2`,
      [commerceWorld.worldId, outputInventoryId],
    );
    const rollbackListingCommand = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'CreateMarketListingV1',
      {
        expiresAtTick: '30',
        expectedInventoryVersion: sellerBeforeRollback.rows[0]!.row_version,
        quantity: '1',
        sellerInventoryId: outputInventoryId,
        sellerWalletId: business.business_wallet_id,
        unitPriceMinor: '100',
      },
      'm09-list-for-atomic-rollback',
    );
    const rollbackListed = await submit(manager!, commerceWorld.worldId, rollbackListingCommand);
    expect(rollbackListed.statusCode, rollbackListed.body).toBe(200);
    const rollbackListingId = await eventAggregateId(
      rollbackListingCommand.commandId,
      'MarketListingCreatedV1',
    );
    const crossWorldWallet = await client.pool.query<{
      row_version: string;
      wallet_id: string;
    }>(
      `select wallet.id::text as wallet_id,balance.row_version::text
         from wallets wallet
         join wallet_balances balance
           on balance.world_id=wallet.world_id and balance.wallet_id=wallet.id
        where wallet.world_id=$1 order by wallet.id limit 1`,
      [stressWorld.worldId],
    );
    const buyerBeforeRollback = await client.pool.query<{
      inventory_version: string;
      wallet_version: string;
    }>(
      `select inventory.row_version::text as inventory_version,
              balance.row_version::text as wallet_version
         from inventories inventory
         join wallet_balances balance on balance.wallet_id=$3
        where inventory.world_id=$1 and inventory.id=$2`,
      [commerceWorld.worldId, raceState.buyer_inventory_id, workerPerson!.wallet_id],
    );
    const marketAccessCases: Array<{
      expectedHttpStatus: number;
      expectedRejectionCode: string;
      key: string;
      payload: Record<string, unknown>;
      session: BrowserSession;
      type: string;
    }> = [
      {
        expectedHttpStatus: 403,
        expectedRejectionCode: 'AUTHORIZATION_DENIED',
        key: 'm09-deny-cancel-by-nonseller',
        payload: {
          expectedListingVersion: '1',
          listingId: rollbackListingId,
        },
        session: worker!,
        type: 'CancelMarketListingV1',
      },
      {
        expectedHttpStatus: 422,
        expectedRejectionCode: 'VALIDATION_FAILED',
        key: 'm09-deny-cross-world-buyer-wallet',
        payload: {
          buyerInventoryId: raceState.buyer_inventory_id,
          buyerWalletId: crossWorldWallet.rows[0]!.wallet_id,
          expectedBuyerInventoryVersion: buyerBeforeRollback.rows[0]!.inventory_version,
          expectedBuyerWalletVersion: crossWorldWallet.rows[0]!.row_version,
          expectedListingVersion: '1',
          listingId: rollbackListingId,
          quantity: '1',
        },
        session: worker!,
        type: 'PurchaseMarketListingV1',
      },
    ];
    for (const accessCase of marketAccessCases) {
      const command = commerceCommandFromContext(
        await commerceContext(accessCase.session, commerceWorld.worldId),
        accessCase.type,
        accessCase.payload,
        accessCase.key,
      );
      const response = await submit(accessCase.session, commerceWorld.worldId, command);
      expect(response.statusCode, `${accessCase.key}: ${response.body}`).toBe(
        accessCase.expectedHttpStatus,
      );
      expect(response.json()).toMatchObject({
        rejectionCode: accessCase.expectedRejectionCode,
        status: 'rejected',
      });
    }
    await expect(
      client.pool.query(
        `select listing.status::text,listing.row_version::text,
                listing.remaining_quantity::text,listing.reserved_quantity::text,
                reservation.status::text as reservation_status,
                (select count(*)::integer from market_trades trade
                  where trade.world_id=listing.world_id and trade.listing_id=listing.id) as trades
           from market_listings listing
           join inventory_reservations reservation
             on reservation.world_id=listing.world_id
            and reservation.purpose_type='market_listing'
            and reservation.purpose_id=listing.id
          where listing.world_id=$1 and listing.id=$2`,
        [commerceWorld.worldId, rollbackListingId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          remaining_quantity: '1.000000000000',
          reservation_status: 'active',
          reserved_quantity: '1.000000000000',
          row_version: '1',
          status: 'open',
          trades: 0,
        },
      ],
    });
    const rollbackPurchase = commerceCommandFromContext(
      await commerceContext(worker!, commerceWorld.worldId),
      'PurchaseMarketListingV1',
      {
        buyerInventoryId: raceState.buyer_inventory_id,
        buyerWalletId: workerPerson!.wallet_id,
        expectedBuyerInventoryVersion: buyerBeforeRollback.rows[0]!.inventory_version,
        expectedBuyerWalletVersion: buyerBeforeRollback.rows[0]!.wallet_version,
        expectedListingVersion: '1',
        listingId: rollbackListingId,
        quantity: '1',
      },
      'm09-purchase-injected-publication-failure',
    );
    const beforeRollback = await commerceAtomicFootprint(commerceWorld.worldId, rollbackListingId);
    await installRuntimeHeadFailureTrigger();
    const rollbackResponse = await (async () => {
      try {
        return await submit(worker!, commerceWorld.worldId, rollbackPurchase);
      } finally {
        await removeRuntimeHeadFailureTrigger();
      }
    })();
    expect(rollbackResponse.statusCode, rollbackResponse.body).toBe(500);
    expect(await commerceAtomicFootprint(commerceWorld.worldId, rollbackListingId)).toEqual(
      beforeRollback,
    );

    const cancelRollbackListing = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'CancelMarketListingV1',
      {
        expectedListingVersion: '1',
        listingId: rollbackListingId,
      },
      'm09-cancel-rollback-listing',
    );
    const rollbackListingCancelled = await submit(
      manager!,
      commerceWorld.worldId,
      cancelRollbackListing,
    );
    expect(rollbackListingCancelled.statusCode, rollbackListingCancelled.body).toBe(200);

    const sellerBeforeTerminalRace = await client.pool.query<{ row_version: string }>(
      `select row_version::text from inventories where world_id=$1 and id=$2`,
      [commerceWorld.worldId, outputInventoryId],
    );
    const terminalRaceListingCommand = commerceCommandFromContext(
      await commerceContext(manager!, commerceWorld.worldId),
      'CreateMarketListingV1',
      {
        expiresAtTick: '30',
        expectedInventoryVersion: sellerBeforeTerminalRace.rows[0]!.row_version,
        quantity: '1',
        sellerInventoryId: outputInventoryId,
        sellerWalletId: business.business_wallet_id,
        unitPriceMinor: '100',
      },
      'm09-list-for-purchase-cancel-race',
    );
    const terminalRaceListed = await submit(
      manager!,
      commerceWorld.worldId,
      terminalRaceListingCommand,
    );
    expect(terminalRaceListed.statusCode, terminalRaceListed.body).toBe(200);
    const terminalRaceListingId = await eventAggregateId(
      terminalRaceListingCommand.commandId,
      'MarketListingCreatedV1',
    );
    const buyerBeforeTerminalRace = await client.pool.query<{
      inventory_version: string;
      wallet_version: string;
    }>(
      `select inventory.row_version::text as inventory_version,
              balance.row_version::text as wallet_version
         from inventories inventory
         join wallet_balances balance on balance.wallet_id=$3
        where inventory.world_id=$1 and inventory.id=$2`,
      [commerceWorld.worldId, raceState.buyer_inventory_id, workerPerson!.wallet_id],
    );
    const terminalRaceContext = await commerceContext(worker!, commerceWorld.worldId);
    const purchaseTerminalListing = commerceCommandFromContext(
      terminalRaceContext,
      'PurchaseMarketListingV1',
      {
        buyerInventoryId: raceState.buyer_inventory_id,
        buyerWalletId: workerPerson!.wallet_id,
        expectedBuyerInventoryVersion: buyerBeforeTerminalRace.rows[0]!.inventory_version,
        expectedBuyerWalletVersion: buyerBeforeTerminalRace.rows[0]!.wallet_version,
        expectedListingVersion: '1',
        listingId: terminalRaceListingId,
        quantity: '1',
      },
      'm09-purchase-terminal-race',
    );
    const cancelTerminalListing = commerceCommandFromContext(
      terminalRaceContext,
      'CancelMarketListingV1',
      {
        expectedListingVersion: '1',
        listingId: terminalRaceListingId,
      },
      'm09-cancel-terminal-race',
    );
    const terminalRaceResponses = await Promise.all([
      submit(worker!, commerceWorld.worldId, purchaseTerminalListing),
      submit(manager!, commerceWorld.worldId, cancelTerminalListing),
    ]);
    expect(
      terminalRaceResponses.filter(
        (response) => response.json<WorldCommandResultTransport>().status === 'accepted',
      ),
    ).toHaveLength(1);
    expect(
      terminalRaceResponses.filter(
        (response) => response.json<WorldCommandResultTransport>().status === 'rejected',
      ),
    ).toHaveLength(1);
    const terminalRaceResult = await client.pool.query<{
      active_reservations: number;
      assessments: number;
      financial_transactions: number;
      listing_reserved_quantity: string;
      listing_version: string;
      movements: number;
      posting_sum: string;
      remaining_quantity: string;
      reservation_status: string;
      status: string;
      trades: number;
      valid_inventory_bounds: boolean;
    }>(
      `select listing.status::text,listing.row_version::text as listing_version,
              listing.remaining_quantity::text,listing.reserved_quantity::text
                as listing_reserved_quantity,
              reservation.status::text as reservation_status,
              (select count(*)::integer from inventory_reservations active
                where active.world_id=listing.world_id
                  and active.purpose_type='market_listing'
                  and active.purpose_id=listing.id and active.status='active')
                as active_reservations,
              (select count(*)::integer from market_trades trade
                where trade.world_id=listing.world_id and trade.listing_id=listing.id) as trades,
              (select count(*)::integer from inventory_movements movement
                join market_trades trade
                  on trade.world_id=movement.world_id and trade.id=movement.source_id
                where trade.world_id=listing.world_id and trade.listing_id=listing.id
                  and movement.source_type='market_trade') as movements,
              (select count(*)::integer from tax_assessments assessment
                join market_trades trade
                  on trade.world_id=assessment.world_id and trade.id=assessment.source_id
                where trade.world_id=listing.world_id and trade.listing_id=listing.id
                  and assessment.source_type='market_trade') as assessments,
              (select count(distinct transaction_record.id)::integer
                 from financial_transactions transaction_record
                 join market_trades trade
                   on trade.world_id=transaction_record.world_id
                  and trade.wallet_transaction_id=transaction_record.id
                where trade.world_id=listing.world_id and trade.listing_id=listing.id)
                as financial_transactions,
              (select coalesce(sum(posting.signed_amount_minor),0)::text
                 from wallet_postings posting
                 join market_trades trade
                   on trade.world_id=posting.world_id
                  and trade.wallet_transaction_id=posting.transaction_id
                where trade.world_id=listing.world_id and trade.listing_id=listing.id)
                as posting_sum,
              (select bool_and(
                 inventory.quantity >= 0
                 and inventory.reserved_quantity >= 0
                 and inventory.reserved_quantity <= inventory.quantity
               ) from inventories inventory where inventory.world_id=listing.world_id)
                as valid_inventory_bounds
         from market_listings listing
         join inventory_reservations reservation
           on reservation.world_id=listing.world_id
          and reservation.purpose_type='market_listing'
          and reservation.purpose_id=listing.id
        where listing.world_id=$1 and listing.id=$2`,
      [commerceWorld.worldId, terminalRaceListingId],
    );
    expect(terminalRaceResult.rows).toHaveLength(1);
    const terminalRaceState = terminalRaceResult.rows[0]!;
    expect(terminalRaceState).toMatchObject({
      active_reservations: 0,
      listing_reserved_quantity: '0.000000000000',
      listing_version: '2',
      posting_sum: '0',
      valid_inventory_bounds: true,
    });
    if (terminalRaceState.status === 'filled') {
      expect(terminalRaceState).toMatchObject({
        assessments: 1,
        financial_transactions: 1,
        movements: 1,
        remaining_quantity: '0.000000000000',
        reservation_status: 'consumed',
        trades: 1,
      });
    } else {
      expect(terminalRaceState).toMatchObject({
        assessments: 0,
        financial_transactions: 0,
        movements: 0,
        remaining_quantity: '1.000000000000',
        reservation_status: 'released',
        status: 'cancelled',
        trades: 0,
      });
    }

    const reconciliationContext = await commerceContext(creator, commerceWorld.worldId);
    const reconcile = commerceCommandFromContext(
      reconciliationContext,
      'ReconcileWorldCommerceV1',
      { expectedExpansionVersion: reconciliationContext.expansionVersion },
      'm09-reconcile-commerce',
    );
    const reconciled = await submit(creator, commerceWorld.worldId, reconcile);
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    const commerceReconciliation = await client.pool.query<{
      inventory_matches: boolean;
      journal_matches: boolean;
      mismatch_count: number;
      payroll_matches: boolean;
      reservation_matches: boolean;
      status: string;
      tax_matches: boolean;
      trade_matches: boolean;
    }>(
      `select status::text,mismatch_count,
              live_inventory_checksum=rebuilt_inventory_checksum as inventory_matches,
              live_reservation_checksum=rebuilt_reservation_checksum as reservation_matches,
              live_trade_checksum=rebuilt_trade_checksum as trade_matches,
              live_payroll_checksum=rebuilt_payroll_checksum as payroll_matches,
              live_tax_checksum=rebuilt_tax_checksum as tax_matches,
              live_projection_checksum=rebuilt_journal_checksum as journal_matches
         from economy_expansion_reconciliation_runs
        where world_id=$1 and command_id=$2`,
      [commerceWorld.worldId, reconcile.commandId],
    );
    expect(commerceReconciliation.rows).toMatchObject([
      {
        inventory_matches: true,
        journal_matches: true,
        mismatch_count: 0,
        payroll_matches: true,
        reservation_matches: true,
        status: 'matched',
        tax_matches: true,
        trade_matches: true,
      },
    ]);
    const conserved = await client.pool.query<{
      reconciliation_status: string;
      supply: string;
      wallet_total: string;
    }>(
      `select head.reconciliation_status::text,
              (select sum(balance.available_minor)::text
                 from wallets wallet join wallet_balances balance on balance.wallet_id=wallet.id
                where wallet.world_id=$1) as wallet_total,
              (select current_supply_minor::text from currency_supply where world_id=$1) as supply
         from world_economy_expansion_heads head where head.world_id=$1`,
      [commerceWorld.worldId],
    );
    expect(conserved.rows).toHaveLength(1);
    expect(conserved.rows[0]!.reconciliation_status).toBe('current');
    expect(conserved.rows[0]!.wallet_total).toBe(conserved.rows[0]!.supply);
    const resourcesRead = await app.inject({
      headers: { cookie: observer.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${commerceWorld.worldId}/economy/resources`,
    });
    expect(resourcesRead.statusCode, resourcesRead.body).toBe(200);
    expect(resourcesRead.json<{ items: unknown[] }>().items).toHaveLength(3);
    const managerBusinesses = await app.inject({
      headers: { cookie: manager!.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${commerceWorld.worldId}/economy/businesses`,
    });
    expect(managerBusinesses.statusCode, managerBusinesses.body).toBe(200);
    const managerBusinessItems = managerBusinesses.json<{
      items: Array<{ canManage: boolean; id: string }>;
    }>().items;
    expect(managerBusinessItems).toHaveLength(2);
    expect(managerBusinessItems.find((item) => item.id === business.business_id)).toMatchObject({
      canManage: true,
    });
    for (const participant of [manager!, worker!]) {
      const contracts = await app.inject({
        headers: { cookie: participant.cookie },
        method: 'GET',
        url: `/api/v1/worlds/${commerceWorld.worldId}/economy/employment/contracts`,
      });
      expect(contracts.statusCode, contracts.body).toBe(200);
      expect(contracts.json<{ items: unknown[] }>().items).toHaveLength(1);
    }
    for (const nonParticipant of [unrelated!, observer]) {
      const contracts = await app.inject({
        headers: { cookie: nonParticipant.cookie },
        method: 'GET',
        url: `/api/v1/worlds/${commerceWorld.worldId}/economy/employment/contracts`,
      });
      expect(contracts.statusCode, contracts.body).toBe(200);
      expect(contracts.json<{ items: unknown[] }>().items).toEqual([]);
    }
    for (const path of ['production-runs', 'market/listings', 'market/trades', 'tax-assessments']) {
      const response = await app.inject({
        headers: { cookie: observer.cookie },
        method: 'GET',
        url: `/api/v1/worlds/${commerceWorld.worldId}/economy/${path}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);
    }
    const treasuryRead = await app.inject({
      headers: { cookie: observer.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${commerceWorld.worldId}/economy/treasury`,
    });
    expect(treasuryRead.statusCode, treasuryRead.body).toBe(200);
    expect(treasuryRead.json()).toMatchObject({ treasury: { revenueMinor: '29' } });
    const preview = await app.inject({
      headers: { cookie: worker!.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${commerceWorld.worldId}/economy/market/listings/${expensiveListingId}/purchase-preview?quantity=1`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      preview: {
        buyerTotalMinor: '1025000000',
        grossMinor: '1000000000',
        taxMinor: '25000000',
      },
    });
    const reconciliationRead = await app.inject({
      headers: { cookie: observer.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${commerceWorld.worldId}/economy/reconciliation`,
    });
    expect(reconciliationRead.statusCode, reconciliationRead.body).toBe(200);
    expect(reconciliationRead.json()).toMatchObject({
      lastRun: { mismatchCount: 0, status: 'matched' },
      projection: { status: 'current' },
    });
    await expect(
      client.pool.query(
        `select count(*)::integer as invalid_count from inventories
          where world_id=$1 and (quantity < 0 or reserved_quantity < 0
            or reserved_quantity > quantity)`,
        [commerceWorld.worldId],
      ),
    ).resolves.toMatchObject({ rows: [{ invalid_count: 0 }] });
  }, 240_000);

  it('emits bounded self-trade and rapid circular-transfer signals from authoritative PostgreSQL state', async () => {
    const world = await createCompiledCommerceWorld(
      'M09 Abuse Signal Evidence',
      'm09-abuse-signal-evidence',
    );
    await initialize(world);
    await initializeCommerce(world);

    const people = await client.pool.query<{
      entity_id: string;
      organization_key: string | null;
      user_id: string;
      wallet_id: string;
    }>(
      `select controller.user_id::text,character.id::text as entity_id,
              character.state ->> 'organizationLogicalKey' as organization_key,
              wallet.id::text as wallet_id
         from world_entity_controllers controller
         join world_entities character
           on character.world_id=controller.world_id and character.id=controller.entity_id
          and character.entity_type='player_character'
          and character.retired_world_version_id is null
         join wallets wallet
           on wallet.world_id=character.world_id and wallet.owner_entity_id=character.id
          and wallet.wallet_kind='player' and wallet.status='active'
        where controller.world_id=$1
          and controller.user_id=any($2::uuid[])
          and controller.control_scope='primary' and controller.revoked_at is null
        order by controller.user_id`,
      [world.worldId, [creator.userId, memberA.userId, memberB.userId]],
    );
    expect(people.rows).toHaveLength(3);
    const sessions = new Map([
      [creator.userId, creator],
      [memberA.userId, memberA],
      [memberB.userId, memberB],
    ]);
    const participants = people.rows.map((person) => ({
      ...person,
      session: sessions.get(person.user_id)!,
    }));
    expect(participants.every((participant) => participant.session !== undefined)).toBe(true);

    const abuseSignal = vi.spyOn(telemetry.economyAbuseSignals, 'add');
    abuseSignal.mockClear();
    try {
      const transfer = async (
        source: (typeof participants)[number],
        destination: (typeof participants)[number],
        key: string,
      ): Promise<SubmitWorldCommand> => {
        const balances = await client.pool.query<{
          row_version: string;
          wallet_id: string;
        }>(
          `select wallet_id::text,row_version::text
             from wallet_balances
            where world_id=$1 and wallet_id=any($2::uuid[])`,
          [world.worldId, [source.wallet_id, destination.wallet_id]],
        );
        const versions = new Map(
          balances.rows.map((balance) => [balance.wallet_id, balance.row_version]),
        );
        const command = economyCommand(
          await summary(source.session, world.worldId),
          'TransferCurrencyV1',
          {
            amount: '1.00',
            destinationWalletId: destination.wallet_id,
            expectedDestinationVersion: versions.get(destination.wallet_id)!,
            expectedSourceVersion: versions.get(source.wallet_id)!,
            sourceWalletId: source.wallet_id,
          },
          key,
        );
        const response = await submit(source.session, world.worldId, command);
        expect(response.statusCode, response.body).toBe(200);
        return command;
      };

      const firstTransfer = await transfer(
        participants[0]!,
        participants[1]!,
        'm09-abuse-cycle-a-b',
      );
      const secondTransfer = await transfer(
        participants[1]!,
        participants[2]!,
        'm09-abuse-cycle-b-c',
      );
      expect(
        abuseSignal.mock.calls.filter(
          ([, attributes]) => attributes?.signal === 'rapid_circular_transfer',
        ),
      ).toEqual([]);
      const closingTransfer = await transfer(
        participants[2]!,
        participants[0]!,
        'm09-abuse-cycle-c-a',
      );
      await expect(
        client.pool.query(
          `select count(distinct transaction_record.id)::integer as transaction_count,
                  coalesce(sum(posting.signed_amount_minor),0)::text as posting_sum
             from financial_transactions transaction_record
             join wallet_postings posting
               on posting.world_id=transaction_record.world_id
              and posting.transaction_id=transaction_record.id
            where transaction_record.world_id=$1
              and transaction_record.command_id=any($2::uuid[])`,
          [
            world.worldId,
            [firstTransfer.commandId, secondTransfer.commandId, closingTransfer.commandId],
          ],
        ),
      ).resolves.toMatchObject({
        rows: [{ posting_sum: '0', transaction_count: 3 }],
      });

      const business = await client.pool.query<{
        business_id: string;
        organization_entity_id: string;
        organization_key: string;
        seller_inventory_id: string;
        seller_inventory_version: string;
        seller_wallet_id: string;
      }>(
        `select business.id::text as business_id,
                business.backing_organization_entity_id::text as organization_entity_id,
                organization.logical_key::text as organization_key,
                business.wallet_id::text as seller_wallet_id,
                inventory.id::text as seller_inventory_id,
                inventory.row_version::text as seller_inventory_version
           from businesses business
           join world_entities organization
             on organization.world_id=business.world_id
            and organization.id=business.backing_organization_entity_id
           join inventories inventory
             on inventory.world_id=business.world_id
            and inventory.owner_entity_id=business.backing_organization_entity_id
           join resource_types resource
             on resource.world_id=inventory.world_id
            and resource.id=inventory.resource_type_id
          where business.world_id=$1 and business.status='active'
            and resource.stable_key='resource:energy'
            and inventory.quantity-inventory.reserved_quantity >= 2`,
        [world.worldId],
      );
      expect(business.rows).toHaveLength(1);
      const seller = business.rows[0]!;
      const manager = participants.find(
        (participant) => participant.organization_key === seller.organization_key,
      );
      expect(manager).toBeDefined();

      const createListing = commerceCommandFromContext(
        await commerceContext(manager!.session, world.worldId),
        'CreateMarketListingV1',
        {
          expiresAtTick: '10',
          expectedInventoryVersion: seller.seller_inventory_version,
          quantity: '2',
          sellerInventoryId: seller.seller_inventory_id,
          sellerWalletId: seller.seller_wallet_id,
          unitPriceMinor: '1',
        },
        'm09-abuse-create-listing',
      );
      const listingCreated = await submit(manager!.session, world.worldId, createListing);
      expect(listingCreated.statusCode, listingCreated.body).toBe(200);
      const listingId = await eventAggregateId(createListing.commandId, 'MarketListingCreatedV1');
      const selfTradeState = await client.pool.query<{
        inventory_version: string;
        wallet_version: string;
      }>(
        `select inventory.row_version::text as inventory_version,
                balance.row_version::text as wallet_version
           from inventories inventory
           join wallet_balances balance
             on balance.world_id=inventory.world_id and balance.wallet_id=$3
          where inventory.world_id=$1 and inventory.id=$2`,
        [world.worldId, seller.seller_inventory_id, seller.seller_wallet_id],
      );
      expect(selfTradeState.rows).toHaveLength(1);
      const selfPurchase = commerceCommandFromContext(
        await commerceContext(manager!.session, world.worldId),
        'PurchaseMarketListingV1',
        {
          buyerInventoryId: seller.seller_inventory_id,
          buyerWalletId: seller.seller_wallet_id,
          expectedBuyerInventoryVersion: selfTradeState.rows[0]!.inventory_version,
          expectedBuyerWalletVersion: selfTradeState.rows[0]!.wallet_version,
          expectedListingVersion: '1',
          listingId,
          quantity: '1',
        },
        'm09-abuse-reject-same-entity-purchase',
      );
      const selfPurchaseResponse = await submit(manager!.session, world.worldId, selfPurchase);
      expect(selfPurchaseResponse.statusCode, selfPurchaseResponse.body).toBe(422);
      expect(selfPurchaseResponse.json()).toMatchObject({
        rejectionCode: 'VALIDATION_FAILED',
        status: 'rejected',
      });
      await expect(
        client.pool.query(
          `select listing.status::text,listing.row_version::text,
                  listing.remaining_quantity::text,
                  (select count(*)::integer from market_trades trade
                    where trade.world_id=listing.world_id
                      and trade.listing_id=listing.id) as trade_count
             from market_listings listing
            where listing.world_id=$1 and listing.id=$2`,
          [world.worldId, listingId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            remaining_quantity: '2.000000000000',
            row_version: '1',
            status: 'open',
            trade_count: 0,
          },
        ],
      });

      const managerBalance = await client.pool.query<{ row_version: string }>(
        `select row_version::text from wallet_balances
          where world_id=$1 and wallet_id=$2`,
        [world.worldId, manager!.wallet_id],
      );
      const controlledCrossEntityPurchase = commerceCommandFromContext(
        await commerceContext(manager!.session, world.worldId),
        'PurchaseMarketListingV1',
        {
          buyerInventoryId: null,
          buyerWalletId: manager!.wallet_id,
          expectedBuyerInventoryVersion: null,
          expectedBuyerWalletVersion: managerBalance.rows[0]!.row_version,
          expectedListingVersion: '1',
          listingId,
          quantity: '1',
        },
        'm09-abuse-controlled-cross-entity-purchase',
      );
      const crossEntityResponse = await submit(
        manager!.session,
        world.worldId,
        controlledCrossEntityPurchase,
      );
      expect(crossEntityResponse.statusCode, crossEntityResponse.body).toBe(200);
      await expect(
        client.pool.query(
          `select trade.buyer_entity_id::text,trade.seller_entity_id::text,
                  listing.status::text,listing.row_version::text,
                  listing.remaining_quantity::text
             from market_trades trade
             join market_listings listing
               on listing.world_id=trade.world_id and listing.id=trade.listing_id
            where trade.world_id=$1 and trade.command_id=$2`,
          [world.worldId, controlledCrossEntityPurchase.commandId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            buyer_entity_id: manager!.entity_id,
            remaining_quantity: '1.000000000000',
            row_version: '2',
            seller_entity_id: seller.organization_entity_id,
            status: 'open',
          },
        ],
      });
      expect(manager!.entity_id).not.toBe(seller.organization_entity_id);

      const cancelListing = commerceCommandFromContext(
        await commerceContext(manager!.session, world.worldId),
        'CancelMarketListingV1',
        { expectedListingVersion: '2', listingId },
        'm09-abuse-cancel-listing',
      );
      const listingCancelled = await submit(manager!.session, world.worldId, cancelListing);
      expect(listingCancelled.statusCode, listingCancelled.body).toBe(200);
      await expect(
        client.pool.query(
          `select listing.status::text,reservation.status::text as reservation_status,
                  listing.reserved_quantity::text,
                  (select count(*)::integer from market_trades trade
                    where trade.world_id=listing.world_id
                      and trade.listing_id=listing.id) as trade_count
             from market_listings listing
             join inventory_reservations reservation
               on reservation.world_id=listing.world_id
              and reservation.purpose_type='market_listing'
              and reservation.purpose_id=listing.id
            where listing.world_id=$1 and listing.id=$2`,
          [world.worldId, listingId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            reservation_status: 'released',
            reserved_quantity: '0.000000000000',
            status: 'cancelled',
            trade_count: 1,
          },
        ],
      });

      expect(abuseSignal.mock.calls).toEqual([
        [1, { signal: 'rapid_circular_transfer' }],
        [1, { signal: 'self_trade_attempt' }],
        [1, { signal: 'self_trade_attempt' }],
      ]);
      expect(
        abuseSignal.mock.calls.every(
          ([, attributes]) =>
            attributes !== undefined &&
            Object.keys(attributes).length === 1 &&
            typeof attributes.signal === 'string',
        ),
      ).toBe(true);

      const reconciliationContext = await commerceContext(creator, world.worldId);
      const reconcile = commerceCommandFromContext(
        reconciliationContext,
        'ReconcileWorldCommerceV1',
        { expectedExpansionVersion: reconciliationContext.expansionVersion },
        'm09-abuse-reconcile-commerce',
      );
      const reconciled = await submit(creator, world.worldId, reconcile);
      expect(reconciled.statusCode, reconciled.body).toBe(200);
      await expect(
        client.pool.query(
          `select status::text,mismatch_count
             from economy_expansion_reconciliation_runs
            where world_id=$1 and command_id=$2`,
          [world.worldId, reconcile.commandId],
        ),
      ).resolves.toMatchObject({
        rows: [{ mismatch_count: 0, status: 'matched' }],
      });
    } finally {
      abuseSignal.mockRestore();
    }
  }, 300_000);

  it('settles taxed payroll exactly once across duplicate delivery, response loss, and rollback retry', async () => {
    const world = await createCompiledCommerceWorld(
      'M09 Payroll Delivery Recovery',
      'm09-payroll-delivery-recovery',
      'm09-payroll-delivery-recovery',
      true,
    );
    await initialize(world);
    await initializeCommerce(world);

    const businessResult = await client.pool.query<{
      business_id: string;
      business_row_version: string;
      business_wallet_id: string;
      organization_key: string;
    }>(
      `select business.id::text as business_id,business.row_version::text
                as business_row_version,business.wallet_id::text as business_wallet_id,
              organization.logical_key::text as organization_key
         from businesses business
         join world_entities organization
           on organization.world_id=business.world_id
          and organization.id=business.backing_organization_entity_id
        where business.world_id=$1`,
      [world.worldId],
    );
    expect(businessResult.rows).toHaveLength(1);
    const business = businessResult.rows[0]!;
    const people = await client.pool.query<{
      entity_key: string;
      organization_key: string | null;
      user_id: string;
      wallet_id: string;
      wallet_version: string;
    }>(
      `select controller.user_id::text,character.logical_key::text as entity_key,
              character.state ->> 'organizationLogicalKey' as organization_key,
              wallet.id::text as wallet_id,balance.row_version::text as wallet_version
         from world_entity_controllers controller
         join world_entities character
           on character.world_id=controller.world_id and character.id=controller.entity_id
          and character.entity_type='player_character'
          and character.retired_world_version_id is null
         join wallets wallet
           on wallet.world_id=character.world_id and wallet.owner_entity_id=character.id
          and wallet.wallet_kind='player'
         join wallet_balances balance on balance.wallet_id=wallet.id
        where controller.world_id=$1 and controller.revoked_at is null
        order by controller.user_id`,
      [world.worldId],
    );
    const managerPerson = people.rows.find(
      (person) => person.organization_key === business.organization_key,
    );
    const workerPerson = people.rows.find((person) => person.user_id !== managerPerson?.user_id);
    expect(managerPerson).toBeDefined();
    expect(workerPerson).toBeDefined();
    const sessions = new Map([
      [creator.userId, creator],
      [memberA.userId, memberA],
      [memberB.userId, memberB],
    ]);
    const manager = sessions.get(managerPerson!.user_id);
    const worker = sessions.get(workerPerson!.user_id);
    expect(manager).toBeDefined();
    expect(worker).toBeDefined();

    await expect(
      client.pool.query(
        `select tax_type::text,collection_mode::text,rate_basis_points,
                status::text
           from tax_policies where world_id=$1 and tax_type='payroll'`,
        [world.worldId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          collection_mode: 'withheld_from_recipient',
          rate_basis_points: 250,
          status: 'active',
          tax_type: 'payroll',
        },
      ],
    });

    const businessBalance = await client.pool.query<{
      row_version: string;
    }>(`select row_version::text from wallet_balances where wallet_id=$1`, [
      business.business_wallet_id,
    ]);
    const funding = economyCommand(
      await summary(manager!, world.worldId),
      'TransferCurrencyV1',
      {
        amount: '50.00',
        destinationWalletId: business.business_wallet_id,
        expectedDestinationVersion: businessBalance.rows[0]!.row_version,
        expectedSourceVersion: managerPerson!.wallet_version,
        sourceWalletId: managerPerson!.wallet_id,
      },
      'm09-payroll-recovery-funding',
    );
    const funded = await submit(manager!, world.worldId, funding);
    expect(funded.statusCode, funded.body).toBe(200);

    const createContract = commerceCommandFromContext(
      await commerceContext(manager!, world.worldId),
      'CreateEmploymentContractV1',
      {
        businessId: business.business_id,
        cooldownTicks: '1',
        effectiveFromTick: '0',
        effectiveToTick: '100',
        employerWalletId: business.business_wallet_id,
        expectedBusinessVersion: business.business_row_version,
        maxPerformancesPerPeriod: 3,
        periodTicks: '12',
        rewardCapMinor: '300',
        roleCode: 'payroll-recovery-tester',
        wageMinor: '100',
        wageRuleKind: 'per_shift',
        workerEntityKey: workerPerson!.entity_key,
        workerWalletId: workerPerson!.wallet_id,
      },
      'm09-payroll-recovery-contract',
    );
    const createdContract = await submit(manager!, world.worldId, createContract);
    expect(createdContract.statusCode, createdContract.body).toBe(200);
    const contractId = await eventAggregateId(
      createContract.commandId,
      'EmploymentContractCreatedV1',
    );
    const acceptContract = commerceCommandFromContext(
      await commerceContext(worker!, world.worldId),
      'AcceptEmploymentContractV1',
      { contractId, expectedContractVersion: '1' },
      'm09-payroll-recovery-accept',
    );
    const acceptedContract = await submit(worker!, world.worldId, acceptContract);
    expect(acceptedContract.statusCode, acceptedContract.body).toBe(200);

    const scheduled = await createPayrollScheduledCommand(appClient.pool, ids);
    const performJob = async (key: string) => {
      const command = commerceCommandFromContext(
        await commerceContext(worker!, world.worldId),
        'PerformJobV1',
        { contractId, expectedContractVersion: '2' },
        key,
      );
      const response = await submit(worker!, world.worldId, command);
      expect(response.statusCode, response.body).toBe(200);
      return command;
    };

    const concurrentJob = await performJob('m09-payroll-concurrent-job');
    await advanceClockTo(world.worldId, 1n);
    const concurrentTarget = await payrollScheduleRequest(world.worldId, concurrentJob.commandId);
    const concurrentResults = await Promise.all([
      scheduled.execute(concurrentTarget.request),
      scheduled.execute(concurrentTarget.request),
    ]);
    expect(concurrentResults[0]).toEqual(concurrentResults[1]);
    expect(concurrentResults[0]).toMatchObject({ status: 'applied' });
    const concurrentFootprint = await payrollSettlementFootprint(
      world.worldId,
      concurrentTarget.payrollRecordId,
      concurrentTarget.request.commandId,
    );
    expectSettledPayrollExactlyOnce(concurrentFootprint, concurrentTarget.request);

    const responseLossJob = await performJob('m09-payroll-response-loss-job');
    await advanceClockTo(world.worldId, 2n);
    const responseLossTarget = await payrollScheduleRequest(
      world.worldId,
      responseLossJob.commandId,
    );
    // The command commits, but its return value is deliberately discarded to
    // model a transport failure after PostgreSQL made the effect durable.
    await scheduled.execute(responseLossTarget.request);
    const committedWithoutResponse = await payrollSettlementFootprint(
      world.worldId,
      responseLossTarget.payrollRecordId,
      responseLossTarget.request.commandId,
    );
    expectSettledPayrollExactlyOnce(committedWithoutResponse, responseLossTarget.request);
    const recoveredResponse = await scheduled.execute(responseLossTarget.request);
    expect(recoveredResponse).toMatchObject({ status: 'applied' });
    expect(
      await payrollSettlementFootprint(
        world.worldId,
        responseLossTarget.payrollRecordId,
        responseLossTarget.request.commandId,
      ),
    ).toEqual(committedWithoutResponse);

    const rollbackJob = await performJob('m09-payroll-before-commit-rollback-job');
    await advanceClockTo(world.worldId, 3n);
    const rollbackTarget = await payrollScheduleRequest(world.worldId, rollbackJob.commandId);
    const beforeRollback = await payrollSettlementFootprint(
      world.worldId,
      rollbackTarget.payrollRecordId,
      rollbackTarget.request.commandId,
    );
    await installRuntimeHeadFailureTrigger();
    try {
      await expect(scheduled.execute(rollbackTarget.request)).rejects.toThrow(
        'injected M09 publication failure',
      );
    } finally {
      await removeRuntimeHeadFailureTrigger();
    }
    expect(
      await payrollSettlementFootprint(
        world.worldId,
        rollbackTarget.payrollRecordId,
        rollbackTarget.request.commandId,
      ),
    ).toEqual(beforeRollback);
    const rollbackRetry = await scheduled.execute(rollbackTarget.request);
    expect(rollbackRetry).toMatchObject({ status: 'applied' });
    expectSettledPayrollExactlyOnce(
      await payrollSettlementFootprint(
        world.worldId,
        rollbackTarget.payrollRecordId,
        rollbackTarget.request.commandId,
      ),
      rollbackTarget.request,
    );
    expect(await runCommerceScheduleOnce(appClient.pool, ids)).toEqual([]);
  }, 240_000);

  it('fails production without movements when its frozen output inventory is unavailable, then reconciles exactly', async () => {
    const world = await createCompiledCommerceWorld(
      'M09 Failed Production Reconciliation',
      'm09-failed-production',
      'm09-failed-production',
      false,
      true,
    );
    await initialize(world);
    await initializeCommerce(world);

    const seeded = await client.pool.query<{
      backing_organization_entity_id: string;
      business_id: string;
      business_row_version: string;
      facility_asset_id: string;
      facility_id: string;
      facility_row_version: string;
      organization_key: string;
      recipe_inputs: Array<{ quantity: string; resourceTypeId: string }>;
      recipe_version_id: string;
    }>(
      `select business.id::text as business_id,business.row_version::text
                as business_row_version,business.backing_organization_entity_id::text,
              organization.logical_key::text as organization_key,
              facility.id::text as facility_id,facility.row_version::text
                as facility_row_version,facility.facility_asset_id::text,
              version.id::text as recipe_version_id,version.canonical_inputs as recipe_inputs
         from businesses business
         join world_entities organization
           on organization.world_id=business.world_id
          and organization.id=business.backing_organization_entity_id
         join business_facilities facility
           on facility.world_id=business.world_id and facility.business_id=business.id
          and facility.stable_key='facility:energy-harbor-workshop'
         join business_facility_recipe_versions capability
           on capability.world_id=facility.world_id and capability.facility_id=facility.id
         join production_recipe_versions version
           on version.world_id=capability.world_id and version.id=capability.recipe_version_id
        where business.world_id=$1`,
      [world.worldId],
    );
    expect(seeded.rows).toHaveLength(1);
    const business = seeded.rows[0]!;
    await expect(
      client.pool.query(
        `select inventory.stable_key::text,inventory.quantity::text,
                resource.stable_key::text as resource_key,
                asset.stable_key::text as container_asset_key
           from inventories inventory
           join resource_types resource
             on resource.world_id=inventory.world_id
            and resource.id=inventory.resource_type_id
           join assets asset
             on asset.world_id=inventory.world_id and asset.id=inventory.container_asset_id
          where inventory.world_id=$1 and resource.stable_key='resource:metal-part'`,
        [world.worldId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          container_asset_key: 'asset:facility:energy-harbor-output-warehouse',
          quantity: '0.000000000000',
          resource_key: 'resource:metal-part',
          stable_key: 'inventory:energy-harbor-output-warehouse:metal-part',
        },
      ],
    });

    const people = await client.pool.query<{
      organization_key: string | null;
      user_id: string;
    }>(
      `select controller.user_id::text,
              character.state ->> 'organizationLogicalKey' as organization_key
         from world_entity_controllers controller
         join world_entities character
           on character.world_id=controller.world_id and character.id=controller.entity_id
          and character.entity_type='player_character'
          and character.retired_world_version_id is null
        where controller.world_id=$1 and controller.revoked_at is null
        order by controller.user_id`,
      [world.worldId],
    );
    const managerPerson = people.rows.find(
      (person) => person.organization_key === business.organization_key,
    );
    expect(managerPerson).toBeDefined();
    const manager = new Map([
      [creator.userId, creator],
      [memberA.userId, memberA],
      [memberB.userId, memberB],
    ]).get(managerPerson!.user_id);
    expect(manager).toBeDefined();

    const inputResourceIds = business.recipe_inputs.map((input) => input.resourceTypeId);
    const productionInputs = await client.pool.query<{
      id: string;
      row_version: string;
    }>(
      `select inventory.id::text,inventory.row_version::text
         from inventories inventory
        where inventory.world_id=$1 and inventory.owner_entity_id=$2
          and inventory.container_asset_id=$3
          and inventory.resource_type_id=any($4::uuid[])
        order by inventory.resource_type_id`,
      [
        world.worldId,
        business.backing_organization_entity_id,
        business.facility_asset_id,
        inputResourceIds,
      ],
    );
    expect(productionInputs.rows).toHaveLength(2);
    const startProduction = commerceCommandFromContext(
      await commerceContext(manager!, world.worldId),
      'StartProductionRunV1',
      {
        businessId: business.business_id,
        expectedBusinessVersion: business.business_row_version,
        expectedFacilityVersion: business.facility_row_version,
        expectedInventories: productionInputs.rows.map((inventory) => ({
          inventoryId: inventory.id,
          rowVersion: inventory.row_version,
        })),
        facilityId: business.facility_id,
        recipeVersionId: business.recipe_version_id,
        runQuantity: '1',
      },
      'm09-start-failed-production',
    );
    const started = await submit(manager!, world.worldId, startProduction);
    expect(started.statusCode, started.body).toBe(200);
    const productionRunId = await eventAggregateId(
      startProduction.commandId,
      'ProductionRunStartedV1',
    );
    const ready = await client.pool.query<{
      due_tick: string;
      row_version: string;
      scheduled_action_id: string;
      snapshot_checksum: string;
      status: string;
    }>(
      `select due_tick::text,row_version::text,scheduled_action_id::text,status::text,
              encode(snapshot_checksum,'hex') as snapshot_checksum
         from production_runs where world_id=$1 and id=$2`,
      [world.worldId, productionRunId],
    );
    expect(ready.rows).toMatchObject([
      {
        row_version: '1',
        status: 'ready',
      },
    ]);
    expect(ready.rows[0]!.snapshot_checksum).toMatch(/^[a-f0-9]{64}$/u);
    const reservedBefore = await client.pool.query<{
      inventory_id: string;
      inventory_quantity: string;
      inventory_reserved_quantity: string;
      inventory_row_version: string;
      quantity: string;
      reservation_id: string;
      reservation_row_version: string;
      status: string;
    }>(
      `select reservation.id::text as reservation_id,reservation.quantity::text,
              reservation.status::text,reservation.row_version::text
                as reservation_row_version,
              inventory.id::text as inventory_id,inventory.quantity::text
                as inventory_quantity,inventory.reserved_quantity::text
                as inventory_reserved_quantity,inventory.row_version::text
                as inventory_row_version
         from inventory_reservations reservation
         join inventories inventory
           on inventory.world_id=reservation.world_id
          and inventory.id=reservation.inventory_id
        where reservation.world_id=$1 and reservation.purpose_type='production_input'
          and reservation.purpose_id=$2
        order by inventory.id`,
      [world.worldId, productionRunId],
    );
    expect(reservedBefore.rows).toHaveLength(2);
    expect(
      reservedBefore.rows.every(
        (row) =>
          row.status === 'active' &&
          row.reservation_row_version === '1' &&
          row.inventory_reserved_quantity === row.quantity,
      ),
    ).toBe(true);

    const completionResults = await advanceCommerceTo(
      world.worldId,
      BigInt(ready.rows[0]!.due_tick),
    );
    expect(
      completionResults.filter((result) => result.actionType === 'CompleteProductionRunV1'),
    ).toEqual([
      {
        actionType: 'CompleteProductionRunV1',
        outcome: 'applied',
        scheduledActionId: ready.rows[0]!.scheduled_action_id,
      },
    ]);

    const terminal = await client.pool.query<{
      aggregate_version: string;
      causation_id: string;
      command_id: string;
      command_status: string;
      command_type: string;
      completed_event_id: string;
      event_id: string;
      event_ordinal: number;
      event_type: string;
      failure_code: string;
      payload: Record<string, unknown>;
      row_version: string;
      schedule_status: string;
      status: string;
      terminal_state_revision: string;
    }>(
      `select run.status::text,run.failure_code,run.row_version::text,
              run.terminal_command_id::text as command_id,
              run.terminal_event_id::text as event_id,
              run.terminal_state_revision::text,
              command.command_type,command.status::text as command_status,
              command.causation_id::text,event.event_type,event.event_ordinal,
              event.aggregate_version::text,event.payload,
              schedule.status::text as schedule_status,
              schedule.completed_event_id::text
         from production_runs run
         join command_records command
           on command.world_id=run.world_id and command.id=run.terminal_command_id
         join domain_events event
           on event.world_id=run.world_id and event.id=run.terminal_event_id
         join scheduled_actions schedule
           on schedule.world_id=run.world_id and schedule.id=run.scheduled_action_id
        where run.world_id=$1 and run.id=$2`,
      [world.worldId, productionRunId],
    );
    expect(terminal.rows).toHaveLength(1);
    const failed = terminal.rows[0]!;
    expect(failed).toMatchObject({
      aggregate_version: '2',
      command_status: 'accepted',
      command_type: 'CompleteProductionRunV1',
      event_ordinal: 0,
      event_type: 'ProductionFailedV1',
      failure_code: 'OUTPUT_INVENTORY_UNAVAILABLE',
      payload: {
        aggregateVersion: '2',
        errorCode: 'OUTPUT_INVENTORY_UNAVAILABLE',
        productionRunId,
        tick: ready.rows[0]!.due_tick,
      },
      row_version: '2',
      schedule_status: 'completed',
      status: 'failed',
    });
    expect(failed.causation_id).toBe(failed.completed_event_id);

    const transitions = await client.pool.query<{
      command_id: string;
      event_id: string;
      occurred_tick: string;
      snapshot_checksum: string;
      state_revision: string;
      status: string;
      transition_version: string;
    }>(
      `select transition_version::text,status::text,command_id::text,event_id::text,
              occurred_tick::text,state_revision::text,
              encode(snapshot_hash,'hex') as snapshot_checksum
         from production_run_transitions
        where world_id=$1 and run_id=$2 order by transition_version`,
      [world.worldId, productionRunId],
    );
    expect(transitions.rows).toHaveLength(2);
    expect(transitions.rows[0]).toMatchObject({
      command_id: startProduction.commandId,
      snapshot_checksum: ready.rows[0]!.snapshot_checksum,
      status: 'ready',
      transition_version: '1',
    });
    expect(transitions.rows[1]).toMatchObject({
      command_id: failed.command_id,
      event_id: failed.event_id,
      occurred_tick: ready.rows[0]!.due_tick,
      snapshot_checksum: ready.rows[0]!.snapshot_checksum,
      state_revision: failed.terminal_state_revision,
      status: 'failed',
      transition_version: '2',
    });

    const reservationsAfter = await client.pool.query<{
      inventory_id: string;
      inventory_quantity: string;
      inventory_reserved_quantity: string;
      inventory_row_version: string;
      reservation_id: string;
      reservation_row_version: string;
      status: string;
      terminal_command_id: string;
      terminal_event_id: string;
      terminal_state_revision: string;
    }>(
      `select reservation.id::text as reservation_id,reservation.status::text,
              reservation.row_version::text as reservation_row_version,
              reservation.terminal_command_id::text,reservation.terminal_event_id::text,
              reservation.terminal_state_revision::text,
              inventory.id::text as inventory_id,inventory.quantity::text
                as inventory_quantity,inventory.reserved_quantity::text
                as inventory_reserved_quantity,inventory.row_version::text
                as inventory_row_version
         from inventory_reservations reservation
         join inventories inventory
           on inventory.world_id=reservation.world_id
          and inventory.id=reservation.inventory_id
        where reservation.world_id=$1 and reservation.purpose_type='production_input'
          and reservation.purpose_id=$2
        order by inventory.id`,
      [world.worldId, productionRunId],
    );
    expect(reservationsAfter.rows).toHaveLength(reservedBefore.rows.length);
    for (const [index, row] of reservationsAfter.rows.entries()) {
      const before = reservedBefore.rows[index]!;
      expect(row).toMatchObject({
        inventory_id: before.inventory_id,
        inventory_quantity: before.inventory_quantity,
        inventory_reserved_quantity: '0.000000000000',
        reservation_id: before.reservation_id,
        reservation_row_version: '2',
        status: 'released',
        terminal_command_id: failed.command_id,
        terminal_event_id: failed.event_id,
        terminal_state_revision: failed.terminal_state_revision,
      });
      expect(BigInt(row.inventory_row_version)).toBe(BigInt(before.inventory_row_version) + 1n);
    }
    await expect(
      client.pool.query(
        `select
           (select count(*)::integer from inventory_movements
             where world_id=$1 and (
               (source_type='production_run' and source_id=$2)
               or command_id=$3
             )) as movement_count,
           (select count(*)::integer from domain_events
             where world_id=$1 and command_id=$3) as event_count`,
        [world.worldId, productionRunId, failed.command_id],
      ),
    ).resolves.toMatchObject({ rows: [{ event_count: 1, movement_count: 0 }] });

    const reconciliationContext = await commerceContext(creator, world.worldId);
    const reconcile = commerceCommandFromContext(
      reconciliationContext,
      'ReconcileWorldCommerceV1',
      { expectedExpansionVersion: reconciliationContext.expansionVersion },
      'm09-reconcile-failed-production',
    );
    const reconciled = await submit(creator, world.worldId, reconcile);
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    const reconciliation = await client.pool.query<{
      item_count: number;
      live_failure_code: string;
      live_movement_count: number;
      live_production_status: string;
      live_projection_matches: boolean;
      mismatch_count: number;
      production_matches: boolean;
      reconciliation_status: string;
      status: string;
    }>(
      `select run.status::text,run.mismatch_count,
              run.live_projection_checksum=run.rebuilt_journal_checksum
                as live_projection_matches,
              head.reconciliation_status::text,
              (select count(*)::integer from economy_expansion_reconciliation_items item
                where item.run_id=run.id) as item_count,
              documents.value -> 'productionLive'
                = documents.value -> 'productionRebuilt' as production_matches,
              documents.value #>> '{productionLive,0,status}' as live_production_status,
              documents.value #>> '{productionLive,0,failureCode}' as live_failure_code,
              jsonb_array_length(
                documents.value #> '{productionLive,0,productionMovements}'
              ) as live_movement_count
         from economy_expansion_reconciliation_runs run
         join world_economy_expansion_heads head
           on head.world_id=run.world_id and head.last_reconciliation_run_id=run.id
         cross join lateral (
           select worldgraph_economy_reconciliation_documents_v2($1,$2) as value
         ) documents
        where run.world_id=$1 and run.command_id=$2`,
      [world.worldId, reconcile.commandId],
    );
    expect(reconciliation.rows).toEqual([
      {
        item_count: 0,
        live_failure_code: 'OUTPUT_INVENTORY_UNAVAILABLE',
        live_movement_count: 0,
        live_production_status: 'failed',
        live_projection_matches: true,
        mismatch_count: 0,
        production_matches: true,
        reconciliation_status: 'current',
        status: 'matched',
      },
    ]);
  }, 240_000);

  it('replays twin Harbor catch-up schedules to identical ledger and projection evidence', async () => {
    const firstWorld = await createCompiledCommerceWorld(
      'M09 Deterministic Harbor Replay',
      'm09-deterministic-harbor-a',
      'm09-deterministic-harbor-shared',
    );
    const replayWorld = await createCompiledCommerceWorld(
      'M09 Deterministic Harbor Replay',
      'm09-deterministic-harbor-b',
      'm09-deterministic-harbor-shared',
    );

    const first = await runDeterministicHarborSchedule(firstWorld, 'a');
    const replay = await runDeterministicHarborSchedule(replayWorld, 'b');

    expect(replayWorld.contentHash).toBe(firstWorld.contentHash);
    expect(replay.seedChecksum).toBe(first.seedChecksum);
    expect(replay.eventChecksum).toBe(first.eventChecksum);
    expect(replay.eventHashIntegrity).toBe(first.eventHashIntegrity);
    expect(replay.ledgerChecksum).toBe(first.ledgerChecksum);
    expect(replay.ledgerHashIntegrity).toBe(first.ledgerHashIntegrity);
    expect(replay.projectionChecksum).toBe(first.projectionChecksum);
    expect(replay.effectCounts).toEqual(first.effectCounts);
    expect(replay.nativeIntegrity).toEqual(first.nativeIntegrity);
    for (const evidence of [first, replay]) {
      expect(evidence.sourceArtifactHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(evidence.seedPlanHash).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(first.seedChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.eventChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.eventHashIntegrity).toBe(true);
    expect(first.ledgerChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.ledgerHashIntegrity).toBe(true);
    expect(first.projectionChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.nativeIntegrity).toEqual({
      commerce: true,
      economy: true,
      graph: true,
      ledger: true,
      simulation: true,
    });
    expect(first.effectCounts).toEqual({
      expiredListings: 1,
      paidPayrolls: 1,
      periodicTaxes: 1,
      productionMovements: 3,
      productionRuns: 1,
    });
  }, 300_000);

  it('repairs a journal-proven Harbor inventory mismatch through independent append-only approval', async () => {
    const inventoryBefore = await client.pool.query<{
      id: string;
      quantity: string;
      reserved_quantity: string;
      row_version: string;
    }>(
      `select id,quantity::text,reserved_quantity::text,row_version::text
         from inventories
        where world_id=$1
        order by id
        limit 1`,
      [commerceWorld.worldId],
    );
    expect(inventoryBefore.rows).toHaveLength(1);
    const inventory = inventoryBefore.rows[0]!;

    const corruptionConnection = await client.pool.connect();
    try {
      await corruptionConnection.query('begin');
      await corruptionConnection.query(`set local session_replication_role = 'replica'`);
      await corruptionConnection.query(
        `update users set platform_role='platform_admin'
          where id=any($1::uuid[]);
         update inventories set quantity=quantity+1
          where world_id=$2 and id=$3`,
        [[memberA.userId, memberB.userId], commerceWorld.worldId, inventory.id],
      );
      await corruptionConnection.query('commit');
    } catch (error) {
      await corruptionConnection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      corruptionConnection.release();
    }

    const mismatchContext = await commerceContext(creator, commerceWorld.worldId);
    const mismatchCommand = commerceCommandFromContext(
      mismatchContext,
      'ReconcileWorldCommerceV1',
      { expectedExpansionVersion: mismatchContext.expansionVersion },
      'm09-reconcile-commerce-mismatch',
    );
    const mismatchResponse = await submit(creator, commerceWorld.worldId, mismatchCommand);
    expect(mismatchResponse.statusCode, mismatchResponse.body).toBe(200);
    const mismatchRun = await client.pool.query<{
      id: string;
      mismatch_count: number;
      status: string;
    }>(
      `select id,status::text,mismatch_count
         from economy_expansion_reconciliation_runs
        where world_id=$1 and command_id=$2`,
      [commerceWorld.worldId, mismatchCommand.commandId],
    );
    expect(mismatchRun.rows).toMatchObject([{ mismatch_count: 1, status: 'mismatch' }]);

    const reason = 'INCIDENT-COMMERCE-REPAIR-001 journal-backed inventory restoration';
    const prepared = await client.pool.query<{ plan: CommerceProjectionRepairPlanV1 }>(
      `select worldgraph_prepare_commerce_projection_repair($1,$2,$3) as plan`,
      [commerceWorld.worldId, memberA.userId, reason],
    );
    const plan = prepared.rows[0]!.plan;
    expect(plan).toMatchObject({
      domain: 'worldgraph.commerce-projection-repair-plan.v1',
      preparedByUserId: memberA.userId,
      reason,
      repairPlanSchemaVersion: 1,
      sourceReconciliationRunId: mismatchRun.rows[0]!.id,
      worldId: commerceWorld.worldId,
    });
    expect(plan.items).toEqual([
      expect.objectContaining({
        actualQuantity: (Number(inventory.quantity) + 1).toFixed(12),
        actualReservedQuantity: Number(inventory.reserved_quantity).toFixed(12),
        expectedRowVersion: inventory.row_version,
        inventoryId: inventory.id,
        itemOrdinal: 0,
        mismatchKinds: ['quantity'],
        repairedQuantity: Number(inventory.quantity).toFixed(12),
        repairedReservedQuantity: Number(inventory.reserved_quantity).toFixed(12),
      }),
    ]);
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      client.pool.query(`select worldgraph_approve_commerce_projection_repair($1,$2,$3,$4,$5)`, [
        plan.repairPlanId,
        memberA.userId,
        ids.next(),
        plan.planHash,
        'APPROVE APPEND-ONLY COMMERCE REPAIR',
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    const approvalId = ids.next();
    const approved = await client.pool.query<{
      approval: {
        approvalId: string;
        approverUserId: string;
        planHash: string;
        repairPlanId: string;
        worldId: string;
      };
    }>(`select worldgraph_approve_commerce_projection_repair($1,$2,$3,$4,$5) as approval`, [
      plan.repairPlanId,
      memberB.userId,
      approvalId,
      plan.planHash,
      'APPROVE APPEND-ONLY COMMERCE REPAIR',
    ]);
    expect(approved.rows[0]!.approval).toMatchObject({
      approvalId,
      approverUserId: memberB.userId,
      planHash: plan.planHash,
      repairPlanId: plan.repairPlanId,
      worldId: commerceWorld.worldId,
    });

    const execute = () =>
      client.pool.query<{
        command_id: string;
        event_id: string;
        ledger_entry_id: string;
        reconciliation_run_id: string;
        repair_fact_count: number;
        repair_plan_id: string;
        resulting_checksum: Buffer;
        resulting_event_sequence: string;
        resulting_ledger_sequence: string;
        resulting_state_revision: string;
      }>(`select * from worldgraph_execute_commerce_projection_repair($1,$2,$3,$4)`, [
        plan.repairPlanId,
        memberB.userId,
        plan.planHash,
        'APPLY APPEND-ONLY COMMERCE REPAIR',
      ]);
    const executed = await execute();
    expect(executed.rows).toHaveLength(1);
    expect(executed.rows[0]).toMatchObject({
      repair_fact_count: 1,
      repair_plan_id: plan.repairPlanId,
    });
    expect(executed.rows[0]!.resulting_checksum).toHaveLength(32);
    await expect(execute()).resolves.toEqual(executed);

    const evidence = await client.pool.query<{
      event_type: string;
      fact_count: number;
      inventory_quantity: string;
      inventory_reserved_quantity: string;
      ledger_kind: string;
      reconciliation_status: string;
    }>(
      `select
         (select count(*)::integer from commerce_projection_repair_facts
           where repair_plan_id=$2) as fact_count,
         inventory.quantity::text as inventory_quantity,
         inventory.reserved_quantity::text as inventory_reserved_quantity,
         event.event_type,
         ledger.entry_kind::text as ledger_kind,
         reconciliation.status::text as reconciliation_status
       from inventories inventory
       join domain_events event on event.id=$3 and event.world_id=inventory.world_id
       join ledger_entries ledger on ledger.id=$4 and ledger.world_id=inventory.world_id
       join economy_expansion_reconciliation_runs reconciliation
         on reconciliation.id=$5 and reconciliation.world_id=inventory.world_id
       where inventory.world_id=$1 and inventory.id=$6`,
      [
        commerceWorld.worldId,
        plan.repairPlanId,
        executed.rows[0]!.event_id,
        executed.rows[0]!.ledger_entry_id,
        executed.rows[0]!.reconciliation_run_id,
        inventory.id,
      ],
    );
    expect(evidence.rows).toEqual([
      {
        event_type: 'WorldCommerceProjectionRepairedV1',
        fact_count: 1,
        inventory_quantity: Number(inventory.quantity).toFixed(12),
        inventory_reserved_quantity: Number(inventory.reserved_quantity).toFixed(12),
        ledger_kind: 'repair_anchor',
        reconciliation_status: 'matched',
      },
    ]);
    await expect(
      client.pool.query(
        `update commerce_projection_repair_facts set repaired_quantity=repaired_quantity+1
          where repair_plan_id=$1`,
        [plan.repairPlanId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  }, 60_000);

  it('detects every mutable M09 projection category and rejects reservation-record repair', async () => {
    const commandAuthority = await client.pool.query<{
      accepted_count: number;
      fact_count: number;
      invalid_count: number;
    }>(
      `select count(*)::integer as accepted_count,
              count(fact.command_id)::integer as fact_count,
              count(*) filter (
                where command.payload is not null
                   or fact.command_id is null
                   or fact.evidence_source <> 'command_hash'
                   or fact.payload_hash <> command.payload_hash
                   or fact.authority is distinct from
                     worldgraph_commerce_command_authority_document(
                       command.id,command.world_id,fact.payload
                     )
              )::integer as invalid_count
         from command_records command
         left join commerce_command_payload_facts fact
           on fact.command_id=command.id
          and fact.world_id=command.world_id
          and fact.command_type=command.command_type
        where command.world_id=$1
          and command.status='accepted'
          and command.command_type in (
            'CreateEmploymentContractV1','EndEmploymentContractV1',
            'StartProductionRunV1','CreateMarketListingV1',
            'PurchaseMarketListingV1'
          )`,
      [commerceWorld.worldId],
    );
    expect(commandAuthority.rows).toHaveLength(1);
    expect(commandAuthority.rows[0]!.accepted_count).toBeGreaterThan(0);
    expect(commandAuthority.rows[0]).toMatchObject({
      fact_count: commandAuthority.rows[0]!.accepted_count,
      invalid_count: 0,
    });
    await expect(
      client.pool.query(
        `update commerce_command_payload_facts
            set authority=authority || '{"tampered":true}'::jsonb
          where world_id=$1`,
        [commerceWorld.worldId],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    const payrollAuthority = await client.pool.query<{
      fact_count: number;
      invalid_count: number;
      payroll_count: number;
    }>(
      `select count(*)::integer as payroll_count,
              count(selection.payroll_record_id)::integer as fact_count,
              count(*) filter (
                where selection.payroll_record_id is null
                   or event.id is null
                   or event.payload ? 'taxPolicyId' is not true
                   or event.payload ->> 'taxPolicyId'
                        is distinct from selection.tax_policy_id::text
                   or event.resulting_state_revision <> selection.state_revision
              )::integer as invalid_count
         from payroll_records payroll
         left join payroll_policy_selection_facts selection
           on selection.world_id=payroll.world_id
          and selection.payroll_record_id=payroll.id
          and selection.work_record_id=payroll.work_record_id
          and selection.command_id=payroll.created_command_id
          and selection.event_id=payroll.created_event_id
         left join domain_events event
           on event.world_id=selection.world_id
          and event.id=selection.event_id
          and event.command_id=selection.command_id
          and event.event_type='WorkRecordedV1'
        where payroll.world_id=$1`,
      [commerceWorld.worldId],
    );
    expect(payrollAuthority.rows).toHaveLength(1);
    expect(payrollAuthority.rows[0]!.payroll_count).toBeGreaterThan(0);
    expect(payrollAuthority.rows[0]).toMatchObject({
      fact_count: payrollAuthority.rows[0]!.payroll_count,
      invalid_count: 0,
    });
    await expect(
      client.pool.query(
        `update payroll_policy_selection_facts
            set gross_minor=gross_minor+1
          where world_id=$1`,
        [commerceWorld.worldId],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    const omittedSelection = await client.pool.connect();
    try {
      await omittedSelection.query('begin');
      await omittedSelection.query(
        `alter table payroll_policy_selection_facts
           disable trigger payroll_policy_selection_facts_protect`,
      );
      await omittedSelection.query(
        `alter table payroll_records disable trigger payroll_records_protect`,
      );
      const removed = await omittedSelection.query(
        `delete from payroll_policy_selection_facts
          where payroll_record_id=(
            select id from payroll_records where world_id=$1 order by id limit 1
          )`,
        [commerceWorld.worldId],
      );
      expect(removed.rowCount).toBe(1);
      await omittedSelection.query(
        `update payroll_records set updated_at=updated_at
          where id=(
            select id from payroll_records where world_id=$1 order by id limit 1
          )`,
        [commerceWorld.worldId],
      );
      await omittedSelection.query(
        `alter table payroll_policy_selection_facts
           enable trigger payroll_policy_selection_facts_protect`,
      );
      await omittedSelection.query(
        `alter table payroll_records enable trigger payroll_records_protect`,
      );
      await expect(omittedSelection.query('set constraints all immediate')).rejects.toMatchObject({
        code: '23514',
        constraint: 'payroll_policy_selection_fact_required',
      });
    } finally {
      await omittedSelection.query('rollback').catch(() => undefined);
      omittedSelection.release();
    }

    const persistedEvidence = await client.pool.query<{ invalid_count: number }>(
      `select count(*)::integer as invalid_count
         from economy_expansion_reconciliation_runs run
        where run.world_id=$1 and (
          run.mismatch_count <> (
            select count(*) from economy_expansion_reconciliation_items item
             where item.run_id=run.id
          )
          or exists (
            select 1 from economy_expansion_reconciliation_items item
             where item.run_id=run.id
               and item.item_key_hash <> extensions.digest(
                 convert_to(item.item_key,'UTF8'),'sha256'
               )
          )
          or exists (
            select 1
              from economy_expansion_reconciliation_items item
             where item.run_id=run.id
             having min(item.item_ordinal) <> 0
                or max(item.item_ordinal) <> count(*)-1
          )
        )`,
      [commerceWorld.worldId],
    );
    expect(persistedEvidence.rows).toEqual([{ invalid_count: 0 }]);

    const cleanSnapshot = await client.pool.query<{
      snapshot: {
        itemCount: number;
        matched: boolean;
        mismatchCount: number;
      };
    }>(
      `select worldgraph_reconcile_economy_expansion_v2(
        $1,null::uuid
      ) as snapshot`,
      [commerceWorld.worldId],
    );
    expect(cleanSnapshot.rows[0]!.snapshot).toMatchObject({
      itemCount: 0,
      matched: true,
      mismatchCount: 0,
    });

    const corruptionCases = [
      {
        expectedKind: 'business',
        mutation: `update businesses set row_version=row_version+1
          where id=(select id from businesses where world_id=$1 order by id limit 1)`,
      },
      {
        expectedKind: 'facility',
        mutation: `update business_facilities set row_version=row_version+1
          where id=(
            select id from business_facilities where world_id=$1 order by id limit 1
          )`,
      },
      {
        expectedKind: 'recipe_version',
        mutation: `update production_recipe_versions set duration_ticks=duration_ticks+1
          where id=(
            select id from production_recipe_versions
             where world_id=$1 order by id limit 1
          )`,
      },
      {
        expectedKind: 'production',
        mutation: `update production_runs set row_version=row_version+1
          where id=(
            select id from production_runs where world_id=$1 order by id limit 1
          )`,
      },
      {
        expectedKind: 'production',
        mutation: `update production_runs
          set input_snapshot=jsonb_set(
            input_snapshot,'{0,quantity}',to_jsonb('999999.000000000000'::text),false
          )
          where id=(
            select id from production_runs where world_id=$1 order by id limit 1
          )`,
      },
      {
        expectedKind: 'production',
        mutation: `with changed as (
            update inventory_movements set quantity=quantity+1
             where id=(
               select id from inventory_movements
                where world_id=$1 and movement_kind='production_output'
                order by id limit 1
             )
             returning world_id,to_inventory_id
          )
          update inventories inventory set quantity=inventory.quantity+1
            from changed
           where inventory.world_id=changed.world_id
             and inventory.id=changed.to_inventory_id`,
      },
      {
        expectedKind: 'production',
        mutation: `update production_runs
          set output_snapshot=jsonb_set(
            output_snapshot,'{0,quantity}',to_jsonb('999999.000000000000'::text),false
          )
          where id=(
            select id from production_runs where world_id=$1 order by id limit 1
          )`,
      },
      {
        expectedKind: 'employment_contract',
        mutation: `update employment_contracts set row_version=row_version+1
          where id=(
            select id from employment_contracts where world_id=$1 order by id limit 1
          )`,
      },
      {
        expectedKind: 'employment_contract',
        mutation: `update employment_contracts
          set currency_id='00000000-0000-8000-8000-000000000001'::uuid
          where id=(
            select id from employment_contracts where world_id=$1 order by id limit 1
          )`,
      },
      {
        expectedKind: 'market_listing',
        mutation: `update market_listings set row_version=row_version+1
          where id=(
            select id from market_listings where world_id=$1 order by id limit 1
          )`,
      },
      {
        expectedKind: 'market_trade',
        mutation: `update market_trades set state_revision=state_revision+1
          where id=(select id from market_trades where world_id=$1 order by id limit 1)`,
      },
      {
        expectedKind: 'payroll',
        mutation: `update payroll_records set row_version=row_version+1
          where id=(select id from payroll_records where world_id=$1 order by id limit 1)`,
      },
      {
        expectedKind: 'tax_policy',
        mutation: `update tax_policies set rate_basis_points=rate_basis_points+1
          where id=(
            select id from tax_policies
             where world_id=$1 and rate_basis_points is not null order by id limit 1
          )`,
      },
      {
        expectedKind: 'tax_assessment',
        mutation: `update tax_assessments set state_revision=state_revision+1
          where id=(select id from tax_assessments where world_id=$1 order by id limit 1)`,
      },
      {
        expectedKind: 'reservation_lifecycle',
        mutation: `update inventory_reservations set row_version=row_version+1
          where id=(
            select id from inventory_reservations where world_id=$1 order by id limit 1
          )`,
      },
    ] as const;
    const corruptionConnection = await client.pool.connect();
    try {
      for (const corruption of corruptionCases) {
        await corruptionConnection.query('begin');
        try {
          await corruptionConnection.query(`set local session_replication_role='replica'`);
          const mutated = await corruptionConnection.query(corruption.mutation, [
            commerceWorld.worldId,
          ]);
          expect(mutated.rowCount, corruption.expectedKind).toBe(1);
          const result = await corruptionConnection.query<{
            snapshot: {
              items: Array<{ itemKind: string }>;
              matched: boolean;
            };
          }>(
            `select worldgraph_reconcile_economy_expansion_v2(
              $1,null::uuid
            ) as snapshot`,
            [commerceWorld.worldId],
          );
          expect(result.rows[0]!.snapshot.matched, corruption.expectedKind).toBe(false);
          expect(
            result.rows[0]!.snapshot.items.map((item) => item.itemKind),
            corruption.expectedKind,
          ).toContain(corruption.expectedKind);
        } finally {
          await corruptionConnection.query('rollback');
        }
      }
    } finally {
      corruptionConnection.release();
    }

    const reservationBefore = await client.pool.query<{
      id: string;
      row_version: string;
    }>(
      `select id,row_version::text
         from inventory_reservations
        where world_id=$1
        order by id
        limit 1`,
      [commerceWorld.worldId],
    );
    expect(reservationBefore.rows).toHaveLength(1);
    const reservation = reservationBefore.rows[0]!;
    const reservationConnection = await client.pool.connect();
    try {
      await reservationConnection.query('begin');
      await reservationConnection.query(`set local session_replication_role='replica'`);
      const corrupted = await reservationConnection.query(
        `update inventory_reservations set row_version=row_version+1
          where world_id=$1 and id=$2 and row_version=$3::bigint`,
        [commerceWorld.worldId, reservation.id, reservation.row_version],
      );
      expect(corrupted.rowCount).toBe(1);
      await reservationConnection.query('commit');
    } catch (error) {
      await reservationConnection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      reservationConnection.release();
    }

    const mismatchContext = await commerceContext(creator, commerceWorld.worldId);
    const mismatchCommand = commerceCommandFromContext(
      mismatchContext,
      'ReconcileWorldCommerceV1',
      { expectedExpansionVersion: mismatchContext.expansionVersion },
      'm09-reconcile-reservation-record-mismatch',
    );
    const mismatchResponse = await submit(creator, commerceWorld.worldId, mismatchCommand);
    expect(mismatchResponse.statusCode, mismatchResponse.body).toBe(200);
    const mismatchItems = await client.pool.query<{ item_kind: string }>(
      `select item.item_kind
         from economy_expansion_reconciliation_runs run
         join economy_expansion_reconciliation_items item on item.run_id=run.id
        where run.world_id=$1 and run.command_id=$2
        order by item.item_ordinal`,
      [commerceWorld.worldId, mismatchCommand.commandId],
    );
    expect(mismatchItems.rows.map((item) => item.item_kind)).toContain('reservation_lifecycle');
    await expect(
      client.pool.query(`select worldgraph_prepare_commerce_projection_repair($1,$2,$3)`, [
        commerceWorld.worldId,
        memberA.userId,
        'INCIDENT-COMMERCE-RESERVATION-RECORD-001 canonical record mismatch',
      ]),
    ).rejects.toMatchObject({ code: '55000' });

    const restoreConnection = await client.pool.connect();
    try {
      await restoreConnection.query('begin');
      await restoreConnection.query(`set local session_replication_role='replica'`);
      const restored = await restoreConnection.query(
        `update inventory_reservations set row_version=$3::bigint
          where world_id=$1 and id=$2 and row_version=$3::bigint+1`,
        [commerceWorld.worldId, reservation.id, reservation.row_version],
      );
      expect(restored.rowCount).toBe(1);
      await restoreConnection.query('commit');
    } catch (error) {
      await restoreConnection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      restoreConnection.release();
    }

    const restoredContext = await commerceContext(creator, commerceWorld.worldId);
    const restoredCommand = commerceCommandFromContext(
      restoredContext,
      'ReconcileWorldCommerceV1',
      { expectedExpansionVersion: restoredContext.expansionVersion },
      'm09-reconcile-reservation-record-restored',
    );
    const restoredResponse = await submit(creator, commerceWorld.worldId, restoredCommand);
    expect(restoredResponse.statusCode, restoredResponse.body).toBe(200);
    const restoredRun = await client.pool.query<{ mismatch_count: number; status: string }>(
      `select status::text,mismatch_count
         from economy_expansion_reconciliation_runs
        where world_id=$1 and command_id=$2`,
      [commerceWorld.worldId, restoredCommand.commandId],
    );
    expect(restoredRun.rows).toEqual([{ mismatch_count: 0, status: 'matched' }]);
  }, 120_000);

  async function register(
    email: string,
    displayName: string,
    remoteAddress?: string,
  ): Promise<BrowserSession> {
    const response = await app.inject({
      headers: { origin },
      method: 'POST',
      payload: { displayName, email, password },
      ...(remoteAddress ? { remoteAddress } : {}),
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
      userId: response.json<{ user: { id: string } }>().user.id,
    };
  }

  async function createCompiledWorld(name: string, key: string): Promise<ApprovedWorld> {
    const world = await createApprovedWorld(name, `${key}-manifest`);
    await client.pool.query(
      `insert into world_memberships(world_id,user_id,role,status,granted_by_user_id)
       values ($1,$2,'player','active',$5),($1,$3,'player','active',$5),
              ($1,$4,'observer','active',$5)`,
      [world.worldId, memberA.userId, memberB.userId, observer.userId, creator.userId],
    );
    const compilation = await compilationService.start(
      { user: { id: creator.userId, platformRole: 'user' } } as AuthenticatedActor,
      world.worldId,
      {
        expectedManifestHash: world.contentHash,
        manifestRevisionId: world.revisionId,
        seed: `${key}-compile-seed`,
      },
      { idempotencyKey: `${key}-compile`, requestId: ids.next() },
    );
    expect(compilation).toMatchObject({ status: 'queued' });
    const workerResult = await runWorkerOnce(client.pool);
    expect(workerResult, JSON.stringify(workerResult)).toMatchObject({ outcome: 'succeeded' });
    await expect(
      client.pool.query(
        `select count(*)::integer as count from compiled_economy_seed_plans
          where world_id=$1 and source_kind='compiler_1_1'`,
        [world.worldId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    return world;
  }

  async function createCompiledCommerceWorld(
    name: string,
    key: string,
    deterministicSourceKey = key,
    payrollTax = false,
    unavailableProductionOutput = false,
    additionalPlayers: readonly BrowserSession[] = [],
  ): Promise<ApprovedWorld> {
    const world = await createApprovedWorld(
      name,
      `${key}-manifest`,
      true,
      `${deterministicSourceKey}-manifest`,
      payrollTax,
      unavailableProductionOutput,
    );
    await client.pool.query(
      `insert into world_memberships(world_id,user_id,role,status,granted_by_user_id)
       values ($1,$2,'player','active',$5),($1,$3,'player','active',$5),
              ($1,$4,'observer','active',$5)`,
      [world.worldId, memberA.userId, memberB.userId, observer.userId, creator.userId],
    );
    if (additionalPlayers.length > 0) {
      await client.pool.query(
        `insert into world_memberships(
           world_id,user_id,role,status,granted_by_user_id
         )
         select $1,player.user_id,'player','active',$3
           from unnest($2::uuid[]) with ordinality as player(user_id,ordinal)
          order by player.ordinal`,
        [world.worldId, additionalPlayers.map((player) => player.userId), creator.userId],
      );
    }
    const compilation = await compilationService.start(
      { user: { id: creator.userId, platformRole: 'user' } } as AuthenticatedActor,
      world.worldId,
      {
        expectedManifestHash: world.contentHash,
        manifestRevisionId: world.revisionId,
        seed: `${deterministicSourceKey}-compile-seed`,
      },
      { idempotencyKey: `${key}-compile`, requestId: ids.next() },
    );
    expect(compilation).toMatchObject({ status: 'queued' });
    const workerResult = await runWorkerOnce(client.pool);
    expect(workerResult, JSON.stringify(workerResult)).toMatchObject({ outcome: 'succeeded' });
    await expect(
      client.pool.query(
        `select count(*)::integer as count from compiled_economy_seed_plans
          where world_id=$1 and source_kind='compiler_1_2'
            and seed_plan_schema_version=2`,
        [world.worldId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    return world;
  }

  async function createApprovedWorld(
    name: string,
    key: string,
    harbor = false,
    deterministicSourceKey = key,
    payrollTax = false,
    unavailableProductionOutput = false,
  ): Promise<ApprovedWorld> {
    const response = await app.inject({
      headers: mutationHeaders(creator, `create-${key}`),
      method: 'POST',
      payload: { name },
      url: '/api/v1/worlds',
    });
    expect(response.statusCode, response.body).toBe(201);
    const worldId = response.json<{ world: { id: string } }>().world.id;
    const revisionId = ids.next();
    const validationReportId = ids.next();
    const fallback = harbor
      ? createDeterministicHarborCityFallback({
          catalog: harborCityManifestCatalog(),
          prompt: `${name} has guild production, employment, a fixed-price market, and tax.`,
          seed: deterministicSourceKey,
        })
      : createDeterministicFallback({
          catalog: starterManifestCatalog(),
          prompt: `${name} is a deterministic closed-loop guild city.`,
          providerConfigurationId: 'disabled-v1',
          seed: deterministicSourceKey,
        });
    const manifest = structuredClone(fallback.envelope.manifest);
    if (payrollTax) {
      const extension = manifest.extensions['worldgraph.economy'] as {
        taxPolicies?: Array<Record<string, unknown>>;
      };
      const salesPolicy = extension.taxPolicies?.find((policy) => policy.taxType === 'sales');
      if (!salesPolicy || !extension.taxPolicies) {
        throw new Error('M09_PAYROLL_CONCURRENCY_TAX_FIXTURE_INVALID');
      }
      extension.taxPolicies = [
        ...extension.taxPolicies,
        {
          ...salesPolicy,
          collectionMode: 'withheld_from_recipient',
          stableKey: 'tax-policy:guild-council:payroll',
          taxType: 'payroll',
        },
      ].sort((left, right) => {
        const leftKey = String(left.stableKey);
        const rightKey = String(right.stableKey);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    }
    if (unavailableProductionOutput) {
      const extension = manifest.extensions['worldgraph.economy'] as {
        facilities?: Array<Record<string, unknown>>;
        inventories?: Array<Record<string, unknown>>;
      };
      const workshop = extension.facilities?.find(
        (facility) => facility.stableKey === 'facility:energy-harbor-workshop',
      );
      const outputInventory = extension.inventories?.find(
        (inventory) => inventory.resourceStableKey === 'resource:metal-part',
      );
      if (!workshop || !outputInventory || !extension.facilities || !extension.inventories) {
        throw new Error('M09_FAILED_PRODUCTION_FIXTURE_INVALID');
      }
      const outputAssetStableKey = 'asset:facility:energy-harbor-output-warehouse';
      extension.facilities = [
        ...extension.facilities,
        {
          assetStableKey: outputAssetStableKey,
          assetType: workshop.assetType,
          buildingPrimitiveRef: workshop.buildingPrimitiveRef,
          businessStableKey: workshop.businessStableKey,
          displayName: 'Energy Harbor Output Warehouse',
          initialOwnerOrganizationKey: workshop.initialOwnerOrganizationKey,
          recipeVersionStableKeys: workshop.recipeVersionStableKeys,
          stableKey: 'facility:energy-harbor-output-warehouse',
          transferable: workshop.transferable,
        },
      ].sort((left, right) => {
        const leftKey = String(left.stableKey);
        const rightKey = String(right.stableKey);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      outputInventory.containerAssetStableKey = outputAssetStableKey;
      outputInventory.stableKey = 'inventory:energy-harbor-output-warehouse:metal-part';
      extension.inventories.sort((left, right) => {
        const leftKey = String(left.stableKey);
        const rightKey = String(right.stableKey);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    }
    const contentHash = createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex');
    await client.pool.query(
      `insert into manifest_revisions(
         id,world_id,revision_number,manifest_schema_version,canonical_manifest,
         content_hash,source,created_by_user_id
       ) values ($1,$2,1,1,$3,decode($4,'hex'),'manual',$5)`,
      [revisionId, worldId, JSON.stringify(manifest), contentHash, creator.userId],
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
    return { contentHash, revisionId, worldId };
  }

  async function summary(
    session: BrowserSession,
    worldId: string,
  ): Promise<EconomySummaryTransport> {
    const response = await app.inject({
      headers: { cookie: session.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/economy/summary`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<EconomySummaryTransport>();
  }

  function economyCommand(
    context: EconomySummaryTransport,
    type: string,
    payload: Record<string, unknown>,
    key: string,
  ): SubmitWorldCommand {
    return {
      commandId: ids.next(),
      expectedAggregateVersion: context.economyHeadVersion ?? '0',
      expectedStateRevision: context.stateRevision,
      expectedWorldVersion: context.designVersion,
      idempotencyKey: `${key}-${ids.next()}`,
      payload,
      schemaVersion: 1,
      type,
    };
  }

  async function submit(
    session: BrowserSession,
    worldId: string,
    body: SubmitWorldCommand,
    remoteAddress?: string,
  ) {
    return app.inject({
      headers: mutationHeaders(session, body.idempotencyKey),
      method: 'POST',
      payload: body,
      ...(remoteAddress ? { remoteAddress } : {}),
      url: `/api/v1/worlds/${worldId}/commands`,
    });
  }

  async function initialize(world: ApprovedWorld): Promise<AcceptedCommandResult> {
    const source = await client.pool.query<{
      plan_hash: string;
      world_version_id: string;
    }>(
      `select encode(plan.plan_hash,'hex') as plan_hash,plan.world_version_id::text
         from compiled_economy_seed_plans plan
         join world_runtime_heads runtime
           on runtime.world_id=plan.world_id and runtime.active_world_version_id=plan.world_version_id
        where plan.world_id=$1`,
      [world.worldId],
    );
    const row = source.rows[0]!;
    const body = economyCommand(
      await summary(creator, world.worldId),
      'InitializeWorldEconomyV1',
      { compiledWorldVersionId: row.world_version_id, seedPlanHash: row.plan_hash },
      'm08-initialize',
    );
    const response = await submit(creator, world.worldId, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AcceptedCommandResult>();
  }

  async function initializeCommerce(world: ApprovedWorld): Promise<AcceptedCommandResult> {
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
    const row = source.rows[0]!;
    const body = commerceCommandFromContext(
      await commerceContext(creator, world.worldId),
      'InitializeWorldCommerceV1',
      { compiledWorldVersionId: row.world_version_id, seedPlanHash: row.plan_hash },
      'm09-initialize-commerce',
    );
    const response = await submit(creator, world.worldId, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AcceptedCommandResult>();
  }

  async function commerceContext(
    session: BrowserSession,
    worldId: string,
  ): Promise<CommerceCommandContext> {
    const [base, clock, expansion] = await Promise.all([
      summary(session, worldId),
      readClock(worldId),
      client.pool.query<{ row_version: string }>(
        `select row_version::text from world_economy_expansion_heads where world_id=$1`,
        [worldId],
      ),
    ]);
    return {
      designVersion: base.designVersion,
      expansionVersion: expansion.rows[0]?.row_version ?? '0',
      stateRevision: base.stateRevision,
      tick: clock.clock.currentTick,
    };
  }

  function commerceCommandFromContext(
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

  async function advanceCommerceTo(
    worldId: string,
    targetTick: bigint,
  ): Promise<Array<{ actionType: string; outcome: string; scheduledActionId: string }>> {
    await advanceClockTo(worldId, targetTick);
    const results = await runCommerceScheduleOnce(appClient.pool, ids);
    expect(
      results.every((result) => result.outcome !== 'failed'),
      JSON.stringify(results),
    ).toBe(true);
    return results;
  }

  async function advanceClockTo(worldId: string, targetTick: bigint): Promise<void> {
    const clock = await readClock(worldId);
    const currentTick = BigInt(clock.clock.currentTick);
    expect(targetTick).toBeGreaterThan(currentTick);
    const body: SubmitWorldCommand = {
      commandId: ids.next(),
      expectedAggregateVersion: clock.aggregateVersion,
      expectedStateRevision: clock.stateRevision,
      expectedTick: clock.clock.currentTick,
      expectedWorldVersion: clock.designVersion,
      idempotencyKey: `m09-advance-${targetTick.toString()}-${ids.next()}`,
      payload: { ticks: Number(targetTick - currentTick) },
      schemaVersion: 1,
      type: 'AdvanceSimulationV1',
    };
    const response = await submit(creator, worldId, body);
    expect(response.statusCode, response.body).toBe(200);
  }

  async function payrollScheduleRequest(
    worldId: string,
    performJobCommandId: string,
  ): Promise<{
    payrollRecordId: string;
    request: CommerceScheduledPayrollRequest;
  }> {
    const result = await client.pool.query<{
      completed_event_id: string;
      due_tick: string;
      payroll_record_id: string;
      schedule_sequence: string;
      scheduled_action_id: string;
      status: string;
    }>(
      `select payroll.id::text as payroll_record_id,
              schedule.id::text as scheduled_action_id,
              schedule.schedule_sequence::text,schedule.due_tick::text,
              schedule.completed_event_id::text,schedule.status::text
         from payroll_records payroll
         join scheduled_actions schedule
           on schedule.world_id=payroll.world_id
          and schedule.id=payroll.scheduled_action_id
        where payroll.world_id=$1 and payroll.created_command_id=$2`,
      [worldId, performJobCommandId],
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row).toMatchObject({ status: 'completed' });
    expect(row.completed_event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    return {
      payrollRecordId: row.payroll_record_id,
      request: {
        actionType: 'SettlePayrollV1',
        commandId: ids.next(),
        completedEventId: row.completed_event_id,
        dueTick: row.due_tick,
        idempotencyKey: `commerce-schedule-v1:SettlePayrollV1:${row.scheduled_action_id}`,
        payload: { payrollRecordId: row.payroll_record_id },
        scheduleSequence: row.schedule_sequence,
        scheduledActionId: row.scheduled_action_id,
        worldId,
      },
    };
  }

  async function payrollSettlementFootprint(
    worldId: string,
    payrollRecordId: string,
    settlementCommandId: string,
  ) {
    const [
      payroll,
      transaction,
      postings,
      tax,
      events,
      ledger,
      counts,
      balances,
      heads,
      checkpoints,
    ] = await Promise.all([
      client.pool.query<Record<string, string | null>>(
        `select payroll.status::text,payroll.row_version::text,
                payroll.gross_minor::text,payroll.tax_minor::text,payroll.net_minor::text,
                payroll.financial_transaction_id::text,
                payroll.terminal_command_id::text,payroll.terminal_event_id::text,
                payroll.terminal_state_revision::text,schedule.status::text as schedule_status
           from payroll_records payroll
           join scheduled_actions schedule
             on schedule.world_id=payroll.world_id
            and schedule.id=payroll.scheduled_action_id
          where payroll.world_id=$1 and payroll.id=$2`,
        [worldId, payrollRecordId],
      ),
      client.pool.query<Record<string, string>>(
        `select id::text,transaction_kind::text,supply_delta_minor::text,
                memo_code,command_id::text,event_id::text,state_revision::text
           from financial_transactions
          where world_id=$1 and command_id=$2`,
        [worldId, settlementCommandId],
      ),
      client.pool.query<Record<string, string>>(
        `select posting.signed_amount_minor::text,posting.posting_ordinal::text,
                posting.transaction_id::text
           from wallet_postings posting
           join financial_transactions financial
             on financial.world_id=posting.world_id
            and financial.id=posting.transaction_id
          where posting.world_id=$1 and financial.command_id=$2
          order by posting.signed_amount_minor,posting.wallet_id`,
        [worldId, settlementCommandId],
      ),
      client.pool.query<Record<string, string>>(
        `select assessment.basis_minor::text,assessment.amount_minor::text,
                assessment.source_type,assessment.source_id::text,
                assessment.settlement_transaction_id::text,
                assessment.command_id::text,assessment.event_id::text
           from tax_assessments assessment
          where assessment.world_id=$1 and assessment.command_id=$2
            and assessment.source_id=$3`,
        [worldId, settlementCommandId, payrollRecordId],
      ),
      client.pool.query<Record<string, string>>(
        `select event.id::text,event.event_type,
                event.payload ->> 'grossMinor' as gross_minor,
                event.payload ->> 'taxMinor' as tax_minor,
                event.payload ->> 'netMinor' as net_minor,
                event.payload ->> 'payrollRecordId' as payroll_record_id,
                event.resulting_state_revision::text
           from domain_events event
          where event.world_id=$1 and event.command_id=$2
          order by event.event_ordinal`,
        [worldId, settlementCommandId],
      ),
      client.pool.query<Record<string, string | null>>(
        `select entry_kind::text,event_id::text,ledger_sequence::text
           from ledger_entries where world_id=$1 and command_id=$2
          order by ledger_sequence`,
        [worldId, settlementCommandId],
      ),
      client.pool.query<{
        command_records: number;
        domain_events: number;
        economy_participant_history: number;
        expected_participant_history: number;
        financial_transactions: number;
        ledger_entries: number;
        outbox_messages: number;
        payroll_policy_selection_facts: number;
        tax_assessments: number;
        wallet_postings: number;
        world_history_entries: number;
      }>(
        `select
           (select count(*)::integer from command_records
             where world_id=$1 and id=$2) as command_records,
           (select count(*)::integer from financial_transactions
             where world_id=$1 and command_id=$2) as financial_transactions,
           (select count(*)::integer
              from wallet_postings posting
              join financial_transactions financial
                on financial.world_id=posting.world_id
               and financial.id=posting.transaction_id
             where posting.world_id=$1 and financial.command_id=$2) as wallet_postings,
           (select count(*)::integer from tax_assessments
             where world_id=$1 and command_id=$2
               and source_type='payroll' and source_id=$3) as tax_assessments,
           (select count(*)::integer from domain_events
             where world_id=$1 and command_id=$2
               and event_type='PayrollSettledV1') as domain_events,
           (select count(*)::integer from ledger_entries
             where world_id=$1 and command_id=$2) as ledger_entries,
           (select count(*)::integer
              from outbox_messages outbox
              join domain_events event
                on event.world_id=outbox.world_id and event.id=outbox.event_id
             where outbox.world_id=$1 and event.command_id=$2) as outbox_messages,
           (select count(*)::integer from world_history_entries
             where world_id=$1 and command_id=$2
               and event_type='PayrollSettledV1') as world_history_entries,
           (select count(*)::integer from economy_participant_history
             where world_id=$1 and command_id=$2
               and category='payroll') as economy_participant_history,
           (select count(distinct controller.user_id)::integer
              from payroll_records payroll
              join employment_contracts contract
                on contract.world_id=payroll.world_id
               and contract.id=payroll.contract_id
              join businesses business
                on business.world_id=contract.world_id
               and business.id=contract.business_id
              join world_entity_controllers controller
                on controller.world_id=payroll.world_id
               and controller.revoked_at is null
              join world_memberships membership
                on membership.world_id=controller.world_id
               and membership.user_id=controller.user_id
               and membership.status='active'
             where payroll.world_id=$1 and payroll.id=$3
               and (
                 worldgraph_user_controls_economy_entity_v1(
                   payroll.world_id,controller.user_id,
                   business.backing_organization_entity_id
                 )
                 or worldgraph_user_controls_economy_entity_v1(
                   payroll.world_id,controller.user_id,contract.worker_entity_id
                 )
               )) as expected_participant_history,
           (select count(*)::integer from payroll_policy_selection_facts
             where world_id=$1 and payroll_record_id=$3)
             as payroll_policy_selection_facts`,
        [worldId, settlementCommandId, payrollRecordId],
      ),
      client.pool.query<Record<string, string>>(
        `select wallet.id::text as wallet_id,balance.available_minor::text,
                balance.row_version::text,balance.updated_state_revision::text
           from wallets wallet
           join wallet_balances balance on balance.wallet_id=wallet.id
          where wallet.world_id=$1 order by wallet.id`,
        [worldId],
      ),
      client.pool.query<Record<string, string>>(
        `select runtime.state_revision::text,runtime.last_event_sequence::text,
                runtime.last_ledger_sequence::text,
                encode(runtime.projection_checksum,'hex') as projection_checksum,
                economy.row_version::text as economy_row_version,
                economy.updated_state_revision::text as economy_state_revision,
                economy.reconciliation_status::text as economy_reconciliation_status,
                encode(economy.checksum,'hex') as economy_checksum,
                expansion.row_version::text as expansion_row_version,
                expansion.updated_state_revision::text as expansion_state_revision,
                expansion.reconciliation_status::text as expansion_reconciliation_status,
                encode(expansion.checksum,'hex') as expansion_checksum
           from world_runtime_heads runtime
           join world_economy_heads economy on economy.world_id=runtime.world_id
           join world_economy_expansion_heads expansion
             on expansion.world_id=runtime.world_id
          where runtime.world_id=$1`,
        [worldId],
      ),
      client.pool.query<Record<string, string>>(
        `select projection_name,projection_schema_version::text,
                last_event_sequence::text,encode(checksum,'hex') as checksum,status::text
           from projection_checkpoints where world_id=$1 order by projection_name`,
        [worldId],
      ),
    ]);
    return {
      balances: balances.rows,
      checkpoints: checkpoints.rows,
      counts: counts.rows[0]!,
      events: events.rows,
      heads: heads.rows[0]!,
      ledger: ledger.rows,
      payroll: payroll.rows,
      postings: postings.rows,
      tax: tax.rows,
      transaction: transaction.rows,
    };
  }

  function expectSettledPayrollExactlyOnce(
    footprint: Awaited<ReturnType<typeof payrollSettlementFootprint>>,
    request: CommerceScheduledPayrollRequest,
  ): void {
    expect(footprint.payroll).toHaveLength(1);
    const payroll = footprint.payroll[0]!;
    expect(payroll.financial_transaction_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(payroll.terminal_event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(payroll.terminal_state_revision).toMatch(/^[1-9][0-9]*$/u);
    expect(footprint.payroll).toEqual([
      {
        financial_transaction_id: payroll.financial_transaction_id,
        gross_minor: '100',
        net_minor: '98',
        row_version: '2',
        schedule_status: 'completed',
        status: 'paid',
        tax_minor: '2',
        terminal_command_id: request.commandId,
        terminal_event_id: payroll.terminal_event_id,
        terminal_state_revision: payroll.terminal_state_revision,
      },
    ]);
    expect(footprint.transaction).toEqual([
      {
        command_id: request.commandId,
        event_id: payroll.terminal_event_id,
        id: payroll.financial_transaction_id,
        memo_code: 'payroll',
        state_revision: payroll.terminal_state_revision,
        supply_delta_minor: '0',
        transaction_kind: 'payroll',
      },
    ]);
    expect(footprint.postings.map((posting) => posting.signed_amount_minor)).toEqual([
      '-100',
      '2',
      '98',
    ]);
    expect(new Set(footprint.postings.map((posting) => posting.transaction_id))).toEqual(
      new Set([payroll.financial_transaction_id]),
    );
    expect(footprint.tax).toEqual([
      {
        amount_minor: '2',
        basis_minor: '100',
        command_id: request.commandId,
        event_id: payroll.terminal_event_id,
        settlement_transaction_id: payroll.financial_transaction_id,
        source_id: request.payload.payrollRecordId,
        source_type: 'payroll',
      },
    ]);
    expect(footprint.events).toEqual([
      {
        event_type: 'PayrollSettledV1',
        gross_minor: '100',
        id: payroll.terminal_event_id,
        net_minor: '98',
        payroll_record_id: request.payload.payrollRecordId,
        resulting_state_revision: payroll.terminal_state_revision,
        tax_minor: '2',
      },
    ]);
    expect(footprint.ledger.map((entry) => entry.entry_kind)).toEqual([
      'command_accepted',
      'domain_event',
    ]);
    expect(footprint.ledger.map((entry) => entry.event_id)).toEqual([
      null,
      payroll.terminal_event_id,
    ]);
    expect(footprint.counts.economy_participant_history).toBe(
      footprint.counts.expected_participant_history,
    );
    expect(footprint.counts.expected_participant_history).toBeGreaterThanOrEqual(2);
    expect(footprint.counts).toEqual({
      command_records: 1,
      domain_events: 1,
      economy_participant_history: footprint.counts.expected_participant_history,
      expected_participant_history: footprint.counts.expected_participant_history,
      financial_transactions: 1,
      ledger_entries: 2,
      outbox_messages: 1,
      payroll_policy_selection_facts: 1,
      tax_assessments: 1,
      wallet_postings: 3,
      world_history_entries: 1,
    });
  }

  async function runDeterministicHarborSchedule(
    world: ApprovedWorld,
    replayKey: string,
  ): Promise<DeterministicHarborEvidence> {
    await initialize(world);
    await initializeCommerce(world);
    const seedChecksum = await deterministicHarborSeedChecksum(world.worldId);

    const seeded = await client.pool.query<{
      backing_organization_entity_id: string;
      business_id: string;
      business_row_version: string;
      business_wallet_id: string;
      facility_asset_id: string;
      facility_id: string;
      facility_row_version: string;
      organization_key: string;
      recipe_inputs: Array<{ quantity: string; resourceTypeId: string }>;
      recipe_version_id: string;
    }>(
      `select business.id::text as business_id,business.row_version::text
                as business_row_version,business.wallet_id::text as business_wallet_id,
              business.backing_organization_entity_id::text,
              organization.logical_key::text as organization_key,
              facility.id::text as facility_id,facility.row_version::text
                as facility_row_version,facility.facility_asset_id::text,
              version.id::text as recipe_version_id,version.canonical_inputs as recipe_inputs
         from businesses business
         join world_entities organization
           on organization.world_id=business.world_id
          and organization.id=business.backing_organization_entity_id
         join business_facilities facility
           on facility.world_id=business.world_id and facility.business_id=business.id
         join business_facility_recipe_versions capability
           on capability.world_id=facility.world_id and capability.facility_id=facility.id
         join production_recipe_versions version
           on version.world_id=capability.world_id and version.id=capability.recipe_version_id
        where business.world_id=$1
        order by business.stable_key,facility.stable_key`,
      [world.worldId],
    );
    expect(seeded.rows).toHaveLength(1);
    const business = seeded.rows[0]!;
    const people = await client.pool.query<{
      entity_key: string;
      organization_key: string | null;
      user_id: string;
      wallet_id: string;
      wallet_version: string;
    }>(
      `select controller.user_id::text,character.logical_key::text as entity_key,
              character.state ->> 'organizationLogicalKey' as organization_key,
              wallet.id::text as wallet_id,balance.row_version::text as wallet_version
         from world_entity_controllers controller
         join world_entities character
           on character.world_id=controller.world_id and character.id=controller.entity_id
          and character.entity_type='player_character'
          and character.retired_world_version_id is null
         join wallets wallet
           on wallet.world_id=character.world_id and wallet.owner_entity_id=character.id
          and wallet.wallet_kind='player'
         join wallet_balances balance on balance.wallet_id=wallet.id
        where controller.world_id=$1 and controller.revoked_at is null
        order by controller.user_id`,
      [world.worldId],
    );
    const managerPerson = people.rows.find(
      (person) => person.organization_key === business.organization_key,
    );
    const workerPerson = people.rows.find((person) => person.user_id !== managerPerson?.user_id);
    expect(managerPerson).toBeDefined();
    expect(workerPerson).toBeDefined();
    const sessions = new Map([
      [creator.userId, creator],
      [memberA.userId, memberA],
      [memberB.userId, memberB],
    ]);
    const manager = sessions.get(managerPerson!.user_id);
    const worker = sessions.get(workerPerson!.user_id);
    expect(manager).toBeDefined();
    expect(worker).toBeDefined();

    const businessBalance = await client.pool.query<{ row_version: string }>(
      `select row_version::text from wallet_balances where wallet_id=$1`,
      [business.business_wallet_id],
    );
    const funding = economyCommand(
      await summary(manager!, world.worldId),
      'TransferCurrencyV1',
      {
        amount: '50.00',
        destinationWalletId: business.business_wallet_id,
        expectedDestinationVersion: businessBalance.rows[0]!.row_version,
        expectedSourceVersion: managerPerson!.wallet_version,
        sourceWalletId: managerPerson!.wallet_id,
      },
      `m09-deterministic-funding-${replayKey}`,
    );
    const funded = await submit(manager!, world.worldId, funding);
    expect(funded.statusCode, funded.body).toBe(200);

    const createContract = commerceCommandFromContext(
      await commerceContext(manager!, world.worldId),
      'CreateEmploymentContractV1',
      {
        businessId: business.business_id,
        cooldownTicks: '1',
        effectiveFromTick: '0',
        effectiveToTick: '100',
        employerWalletId: business.business_wallet_id,
        expectedBusinessVersion: business.business_row_version,
        maxPerformancesPerPeriod: 1,
        periodTicks: '12',
        rewardCapMinor: '100',
        roleCode: 'metalworker',
        wageMinor: '100',
        wageRuleKind: 'per_shift',
        workerEntityKey: workerPerson!.entity_key,
        workerWalletId: workerPerson!.wallet_id,
      },
      `m09-deterministic-contract-${replayKey}`,
    );
    const contractCreated = await submit(manager!, world.worldId, createContract);
    expect(contractCreated.statusCode, contractCreated.body).toBe(200);
    const contractId = await eventAggregateId(
      createContract.commandId,
      'EmploymentContractCreatedV1',
    );
    const acceptContract = commerceCommandFromContext(
      await commerceContext(worker!, world.worldId),
      'AcceptEmploymentContractV1',
      { contractId, expectedContractVersion: '1' },
      `m09-deterministic-accept-${replayKey}`,
    );
    const contractAccepted = await submit(worker!, world.worldId, acceptContract);
    expect(contractAccepted.statusCode, contractAccepted.body).toBe(200);
    const performJob = commerceCommandFromContext(
      await commerceContext(worker!, world.worldId),
      'PerformJobV1',
      { contractId, expectedContractVersion: '2' },
      `m09-deterministic-job-${replayKey}`,
    );
    const performed = await submit(worker!, world.worldId, performJob);
    expect(performed.statusCode, performed.body).toBe(200);
    const jobReplay = await submit(worker!, world.worldId, performJob);
    expect(jobReplay.statusCode, jobReplay.body).toBe(200);
    expect(jobReplay.json()).toEqual(performed.json());

    const inputResourceIds = business.recipe_inputs.map((input) => input.resourceTypeId);
    const productionInputs = await client.pool.query<{ id: string; row_version: string }>(
      `select inventory.id::text,inventory.row_version::text
         from inventories inventory
        where inventory.world_id=$1 and inventory.owner_entity_id=$2
          and inventory.container_asset_id=$3
          and inventory.resource_type_id=any($4::uuid[])
        order by inventory.resource_type_id`,
      [
        world.worldId,
        business.backing_organization_entity_id,
        business.facility_asset_id,
        inputResourceIds,
      ],
    );
    expect(productionInputs.rows).toHaveLength(2);
    const startProduction = commerceCommandFromContext(
      await commerceContext(manager!, world.worldId),
      'StartProductionRunV1',
      {
        businessId: business.business_id,
        expectedBusinessVersion: business.business_row_version,
        expectedFacilityVersion: business.facility_row_version,
        expectedInventories: productionInputs.rows.map((inventory) => ({
          inventoryId: inventory.id,
          rowVersion: inventory.row_version,
        })),
        facilityId: business.facility_id,
        recipeVersionId: business.recipe_version_id,
        runQuantity: '1',
      },
      `m09-deterministic-production-${replayKey}`,
    );
    const productionStarted = await submit(manager!, world.worldId, startProduction);
    expect(productionStarted.statusCode, productionStarted.body).toBe(200);

    const listingInventory = await client.pool.query<{
      id: string;
      row_version: string;
    }>(
      `select inventory.id::text,inventory.row_version::text
         from inventories inventory
        where inventory.world_id=$1 and inventory.owner_entity_id=$2
          and inventory.container_asset_id=$3
          and inventory.resource_type_id=any($4::uuid[])
          and inventory.quantity-inventory.reserved_quantity >= 1
        order by inventory.stable_key
        limit 1`,
      [
        world.worldId,
        business.backing_organization_entity_id,
        business.facility_asset_id,
        inputResourceIds,
      ],
    );
    expect(listingInventory.rows).toHaveLength(1);
    const createListing = commerceCommandFromContext(
      await commerceContext(manager!, world.worldId),
      'CreateMarketListingV1',
      {
        expiresAtTick: '3',
        expectedInventoryVersion: listingInventory.rows[0]!.row_version,
        quantity: '1',
        sellerInventoryId: listingInventory.rows[0]!.id,
        sellerWalletId: business.business_wallet_id,
        unitPriceMinor: '100',
      },
      `m09-deterministic-listing-${replayKey}`,
    );
    const listed = await submit(manager!, world.worldId, createListing);
    expect(listed.statusCode, listed.body).toBe(200);

    const catchUpResults = await advanceCommerceTo(world.worldId, 12n);
    expect(catchUpResults.every((result) => result.outcome === 'applied')).toBe(true);
    expect(catchUpResults.map((result) => result.actionType).sort()).toEqual([
      'AssessPeriodicTaxV1',
      'CompleteProductionRunV1',
      'ExpireMarketListingV1',
      'SettlePayrollV1',
    ]);
    expect(await runCommerceScheduleOnce(appClient.pool, ids)).toEqual([]);

    const reconcileContext = await commerceContext(creator, world.worldId);
    const reconcile = commerceCommandFromContext(
      reconcileContext,
      'ReconcileWorldCommerceV1',
      { expectedExpansionVersion: reconcileContext.expansionVersion },
      `m09-deterministic-reconcile-${replayKey}`,
    );
    const reconciled = await submit(creator, world.worldId, reconcile);
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    await expect(
      client.pool.query(
        `select status::text,mismatch_count
           from economy_expansion_reconciliation_runs
          where world_id=$1 and command_id=$2`,
        [world.worldId, reconcile.commandId],
      ),
    ).resolves.toMatchObject({ rows: [{ mismatch_count: 0, status: 'matched' }] });

    return deterministicHarborEvidence(world.worldId, seedChecksum);
  }

  async function deterministicHarborSeedChecksum(worldId: string): Promise<string> {
    type SeedRow = Record<string, unknown>;
    const [
      currencies,
      wallets,
      resources,
      recipes,
      businesses,
      facilities,
      inventories,
      policies,
      offers,
    ] = await Promise.all([
      client.pool.query<SeedRow>(
        `select currency.stable_key::text,currency.code::text,currency.minor_unit_scale,
                  currency.max_supply_minor::text,currency.status::text,
                  supply.current_supply_minor::text
             from currencies currency
             join currency_supply supply
               on supply.world_id=currency.world_id and supply.currency_id=currency.id
            where currency.world_id=$1
            order by currency.stable_key`,
        [worldId],
      ),
      client.pool.query<SeedRow>(
        `select case when controller.user_id is null then wallet.stable_key::text
                    else 'wallet:player-organization:'
                      || coalesce(owner.state ->> 'organizationLogicalKey','unaffiliated')
                    end as wallet_key,
                  case when controller.user_id is null then owner.logical_key::text
                    else 'player-organization:'
                      || coalesce(owner.state ->> 'organizationLogicalKey','unaffiliated')
                    end as owner_key,
                  wallet.wallet_kind::text,currency.code::text as currency_code,
                  balance.available_minor::text
             from wallets wallet
             join world_entities owner
               on owner.world_id=wallet.world_id and owner.id=wallet.owner_entity_id
             left join world_entity_controllers controller
               on controller.world_id=owner.world_id and controller.entity_id=owner.id
              and controller.revoked_at is null
             join currencies currency
               on currency.world_id=wallet.world_id and currency.id=wallet.currency_id
             join wallet_balances balance on balance.wallet_id=wallet.id
            where wallet.world_id=$1
            order by wallet_key`,
        [worldId],
      ),
      client.pool.query<SeedRow>(
        `select stable_key::text,unit_code,quantity_scale,tags,status::text
             from resource_types
            where world_id=$1
            order by stable_key`,
        [worldId],
      ),
      client.pool.query<SeedRow>(
        `select recipe.stable_key::text,version.version,version.duration_ticks::text,
                  (
                    select jsonb_agg(
                      jsonb_build_object(
                        'resourceKey',resource.stable_key::text,
                        'quantity',item.value ->> 'quantity'
                      ) order by item.ordinality
                    )
                      from jsonb_array_elements(version.canonical_inputs)
                        with ordinality item(value,ordinality)
                      join resource_types resource
                        on resource.world_id=version.world_id
                       and resource.id=(item.value ->> 'resourceTypeId')::uuid
                  ) as inputs,
                  (
                    select jsonb_agg(
                      jsonb_build_object(
                        'resourceKey',resource.stable_key::text,
                        'quantity',item.value ->> 'quantity'
                      ) order by item.ordinality
                    )
                      from jsonb_array_elements(version.canonical_outputs)
                        with ordinality item(value,ordinality)
                      join resource_types resource
                        on resource.world_id=version.world_id
                       and resource.id=(item.value ->> 'resourceTypeId')::uuid
                  ) as outputs
             from production_recipe_versions version
             join production_recipes recipe
               on recipe.world_id=version.world_id and recipe.id=version.recipe_id
            where version.world_id=$1
            order by recipe.stable_key,version.version`,
        [worldId],
      ),
      client.pool.query<SeedRow>(
        `select business.stable_key::text,organization.logical_key::text
                    as organization_key,wallet.stable_key::text as wallet_key,
                  currency.code::text as currency_code,business.status::text
             from businesses business
             join world_entities organization
               on organization.world_id=business.world_id
              and organization.id=business.backing_organization_entity_id
             join wallets wallet
               on wallet.world_id=business.world_id and wallet.id=business.wallet_id
             join currencies currency
               on currency.world_id=business.world_id and currency.id=business.currency_id
            where business.world_id=$1
            order by business.stable_key`,
        [worldId],
      ),
      client.pool.query<SeedRow>(
        `select facility.stable_key::text,business.stable_key::text as business_key,
                  asset.stable_key::text as asset_key,facility.status::text
             from business_facilities facility
             join businesses business
               on business.world_id=facility.world_id and business.id=facility.business_id
             join assets asset
               on asset.world_id=facility.world_id and asset.id=facility.facility_asset_id
            where facility.world_id=$1
            order by facility.stable_key`,
        [worldId],
      ),
      client.pool.query<SeedRow>(
        `select inventory.stable_key::text,owner.logical_key::text as owner_key,
                  container.stable_key::text as container_key,
                  resource.stable_key::text as resource_key,
                  inventory.quantity::text,inventory.reserved_quantity::text
             from inventories inventory
             join world_entities owner
               on owner.world_id=inventory.world_id and owner.id=inventory.owner_entity_id
             left join assets container
               on container.world_id=inventory.world_id
              and container.id=inventory.container_asset_id
             join resource_types resource
               on resource.world_id=inventory.world_id
              and resource.id=inventory.resource_type_id
            where inventory.world_id=$1
            order by inventory.stable_key`,
        [worldId],
      ),
      client.pool.query<SeedRow>(
        `select policy.stable_key::text,policy.policy_version,policy.tax_type::text,
                  policy.collection_mode::text,policy.rounding_mode,
                  policy.rate_basis_points,policy.fixed_amount_minor::text,
                  policy.applicability ->> 'intervalTicks' as interval_ticks,
                  policy.effective_from_tick::text,policy.effective_until_tick::text,
                  treasury.stable_key::text as treasury_wallet_key,policy.status::text
             from tax_policies policy
             join wallets treasury
               on treasury.world_id=policy.world_id and treasury.id=policy.treasury_wallet_id
            where policy.world_id=$1
            order by policy.stable_key,policy.policy_version`,
        [worldId],
      ),
      client.pool.query<SeedRow>(
        `select offer.stable_key::text,business.stable_key::text as business_key,
                  offer.role_code,offer.wage_minor::text,offer.cadence_ticks::text,
                  offer.max_payments_per_period,offer.status::text
             from employment_offers offer
             join businesses business
               on business.world_id=offer.world_id and business.id=offer.business_id
            where offer.world_id=$1
            order by offer.stable_key`,
        [worldId],
      ),
    ]);
    return createHash('sha256')
      .update(
        canonicalJson({
          businesses: businesses.rows,
          currencies: currencies.rows,
          facilities: facilities.rows,
          inventories: inventories.rows,
          offers: offers.rows,
          policies: policies.rows,
          recipes: recipes.rows,
          resources: resources.rows,
          wallets: wallets.rows,
        }),
        'utf8',
      )
      .digest('hex');
  }

  async function deterministicHarborEvidence(
    worldId: string,
    seedChecksum: string,
  ): Promise<DeterministicHarborEvidence> {
    type EvidenceRow = Record<string, unknown>;
    const [
      source,
      events,
      ledger,
      heads,
      checkpoints,
      balances,
      inventories,
      production,
      employment,
      listings,
      taxes,
      schedules,
      movements,
      transactions,
      integrity,
      effects,
    ] = await Promise.all([
      client.pool.query<{
        seed_plan_hash: string;
        source_artifact_hash: string;
      }>(
        `select encode(plan.plan_hash,'hex') as seed_plan_hash,
                encode(plan.source_artifact_hash,'hex') as source_artifact_hash
           from compiled_economy_seed_plans plan
          where plan.world_id=$1 and plan.seed_plan_schema_version=2`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select event.world_event_sequence::text,event.event_ordinal,
                command.command_type,command.actor_type::text as command_actor_type,
                event.aggregate_type,event.aggregate_id,
                event.aggregate_version::text,event.event_type,
                event.event_schema_version,event.payload,event.metadata,
                event.resulting_state_revision::text,
                event.event_hash=worldgraph_domain_event_hash_v1(
                  event.id,event.world_id,event.world_event_sequence,event.command_id,
                  event.event_ordinal,event.aggregate_type,event.aggregate_id,
                  event.aggregate_version,event.event_type,event.event_schema_version,
                  event.payload,event.metadata,event.occurred_at,event.recorded_at,
                  event.resulting_state_revision
                ) as event_hash_valid
           from domain_events event
           join command_records command
             on command.world_id=event.world_id and command.id=event.command_id
          where event.world_id=$1
          order by event.world_event_sequence`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select entry.ledger_sequence::text,entry.entry_kind::text,entry.actor_type::text,
                entry.actor_id,entry.public_summary_code,entry.redacted_details,
                command.command_type,event.event_type,
                entry.entry_hash=worldgraph_ledger_entry_hash_v1(
                  entry.id,entry.world_id,entry.ledger_sequence,entry.entry_kind::text,
                  entry.command_id,entry.event_id,entry.actor_type::text,entry.actor_id,
                  entry.public_summary_code,entry.redacted_details,entry.previous_hash,
                  entry.recorded_at
                ) as entry_hash_valid,
                entry.previous_hash=coalesce(
                  lag(entry.entry_hash) over (order by entry.ledger_sequence),
                  decode(repeat('00',32),'hex')
                ) as previous_hash_valid
           from ledger_entries entry
           left join command_records command
             on command.world_id=entry.world_id and command.id=entry.command_id
           left join domain_events event
             on event.world_id=entry.world_id and event.id=entry.event_id
          where entry.world_id=$1
          order by entry.ledger_sequence`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select runtime.state_revision::text,runtime.last_ledger_sequence::text,
                runtime.last_event_sequence::text,
                ledger_head.next_ledger_sequence::text,ledger_head.next_event_sequence::text,
                clock.current_tick::text,clock.mode::text,clock.row_version::text
                  as clock_row_version,clock.updated_state_revision::text
                  as clock_state_revision,
                economy.row_version::text as economy_row_version,
                economy.updated_state_revision::text as economy_state_revision,
                economy.reconciliation_status::text as economy_reconciliation_status,
                expansion.row_version::text as expansion_row_version,
                expansion.updated_state_revision::text as expansion_state_revision,
                expansion.reconciliation_status::text as expansion_reconciliation_status
           from world_runtime_heads runtime
           join world_ledger_heads ledger_head on ledger_head.world_id=runtime.world_id
           join world_simulation_clocks clock on clock.world_id=runtime.world_id
           join world_economy_heads economy on economy.world_id=runtime.world_id
           join world_economy_expansion_heads expansion on expansion.world_id=runtime.world_id
          where runtime.world_id=$1`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select projection_name,projection_schema_version,last_event_sequence::text,status::text
           from projection_checkpoints
          where world_id=$1
          order by projection_name`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select case when controller.user_id is null then wallet.stable_key::text
                  else 'wallet:player-organization:'
                    || coalesce(owner.state ->> 'organizationLogicalKey','unaffiliated')
                  end as wallet_key,
                case when controller.user_id is null then owner.logical_key::text
                  else 'player-organization:'
                    || coalesce(owner.state ->> 'organizationLogicalKey','unaffiliated')
                  end as owner_key,
                wallet.wallet_kind::text,currency.code::text as currency_code,
                balance.available_minor::text,balance.row_version::text
           from wallets wallet
           join world_entities owner
             on owner.world_id=wallet.world_id and owner.id=wallet.owner_entity_id
           left join world_entity_controllers controller
             on controller.world_id=owner.world_id and controller.entity_id=owner.id
            and controller.revoked_at is null
           join currencies currency
             on currency.world_id=wallet.world_id and currency.id=wallet.currency_id
           join wallet_balances balance on balance.wallet_id=wallet.id
          where wallet.world_id=$1
          order by wallet_key`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select inventory.stable_key::text as inventory_key,
                owner.logical_key::text as owner_key,
                container.stable_key::text as container_key,
                resource.stable_key::text as resource_key,
                inventory.quantity::text,inventory.reserved_quantity::text,
                inventory.row_version::text
           from inventories inventory
           join world_entities owner
             on owner.world_id=inventory.world_id and owner.id=inventory.owner_entity_id
           left join assets container
             on container.world_id=inventory.world_id and container.id=inventory.container_asset_id
           join resource_types resource
             on resource.world_id=inventory.world_id and resource.id=inventory.resource_type_id
          where inventory.world_id=$1
          order by inventory.stable_key`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select business.stable_key::text as business_key,
                facility.stable_key::text as facility_key,
                recipe.stable_key::text as recipe_key,version.version,
                run.quantity::text,run.status::text,run.due_tick::text,
                run.failure_code,run.row_version::text,
                run.created_state_revision::text,run.terminal_state_revision::text
           from production_runs run
           join businesses business
             on business.world_id=run.world_id and business.id=run.business_id
           join business_facilities facility
             on facility.world_id=run.world_id and facility.id=run.facility_id
           join production_recipe_versions version
             on version.world_id=run.world_id and version.id=run.recipe_version_id
           join production_recipes recipe
             on recipe.world_id=version.world_id and recipe.id=version.recipe_id
          where run.world_id=$1
          order by business.stable_key,facility.stable_key,recipe.stable_key`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select record_kind,record
           from (
             select 'contract'::text as record_kind,
                    jsonb_build_object(
                      'businessKey',business.stable_key::text,
                      'workerKey','player-organization:'
                        || coalesce(worker.state ->> 'organizationLogicalKey','unaffiliated'),
                      'employerWalletKey',employer_wallet.stable_key::text,
                      'workerWalletKey','wallet:player-organization:'
                        || coalesce(worker.state ->> 'organizationLogicalKey','unaffiliated'),
                      'roleCode',contract.role_code,
                      'wageRule',contract.wage_rule::text,
                      'wageMinor',contract.wage_minor::text,
                      'cooldownTicks',contract.cooldown_ticks::text,
                      'rewardCapMinor',contract.reward_cap_minor::text,
                      'maxPaymentsPerPeriod',contract.max_payments_per_period,
                      'effectiveFromTick',contract.effective_from_tick::text,
                      'effectiveUntilTick',contract.effective_until_tick::text,
                      'status',contract.status::text,
                      'rowVersion',contract.row_version::text
                    ) as record
               from employment_contracts contract
               join businesses business
                 on business.world_id=contract.world_id and business.id=contract.business_id
               join world_entities worker
                 on worker.world_id=contract.world_id and worker.id=contract.worker_entity_id
               join world_entity_controllers worker_controller
                 on worker_controller.world_id=worker.world_id
                and worker_controller.entity_id=worker.id
                and worker_controller.revoked_at is null
               join wallets employer_wallet
                 on employer_wallet.world_id=contract.world_id
                and employer_wallet.id=contract.employer_wallet_id
               join wallets worker_wallet
                 on worker_wallet.world_id=contract.world_id
                and worker_wallet.id=contract.worker_wallet_id
              where contract.world_id=$1
             union all
             select 'work'::text,
                    jsonb_build_object(
                      'businessKey',business.stable_key::text,
                      'workerKey','player-organization:'
                        || coalesce(worker.state ->> 'organizationLogicalKey','unaffiliated'),
                      'performedTick',work.performed_tick::text,
                      'grossMinor',work.gross_minor::text,
                      'stateRevision',work.state_revision::text
                    )
               from work_records work
               join employment_contracts contract
                 on contract.world_id=work.world_id and contract.id=work.contract_id
               join businesses business
                 on business.world_id=contract.world_id and business.id=contract.business_id
               join world_entities worker
                 on worker.world_id=contract.world_id and worker.id=contract.worker_entity_id
               join world_entity_controllers worker_controller
                 on worker_controller.world_id=worker.world_id
                and worker_controller.entity_id=worker.id
                and worker_controller.revoked_at is null
              where work.world_id=$1
             union all
             select 'payroll'::text,
                    jsonb_build_object(
                      'businessKey',business.stable_key::text,
                      'workerKey','player-organization:'
                        || coalesce(worker.state ->> 'organizationLogicalKey','unaffiliated'),
                      'payPeriodStart',split_part(payroll.pay_period_key,':',1),
                      'grossMinor',payroll.gross_minor::text,
                      'taxMinor',payroll.tax_minor::text,
                      'netMinor',payroll.net_minor::text,
                      'status',payroll.status::text,
                      'errorCode',payroll.error_code,
                      'rowVersion',payroll.row_version::text,
                      'createdStateRevision',payroll.created_state_revision::text,
                      'terminalStateRevision',payroll.terminal_state_revision::text
                    )
               from payroll_records payroll
               join employment_contracts contract
                 on contract.world_id=payroll.world_id and contract.id=payroll.contract_id
               join businesses business
                 on business.world_id=contract.world_id and business.id=contract.business_id
               join world_entities worker
                 on worker.world_id=contract.world_id and worker.id=contract.worker_entity_id
               join world_entity_controllers worker_controller
                 on worker_controller.world_id=worker.world_id
                and worker_controller.entity_id=worker.id
                and worker_controller.revoked_at is null
              where payroll.world_id=$1
           ) evidence
          order by record_kind,record::text`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select seller.logical_key::text as seller_key,
                inventory.stable_key::text as inventory_key,
                resource.stable_key::text as resource_key,
                wallet.stable_key::text as wallet_key,
                listing.offered_quantity::text,listing.remaining_quantity::text,
                listing.reserved_quantity::text,listing.unit_price_minor::text,
                listing.status::text,listing.expires_at_tick::text,listing.row_version::text
           from market_listings listing
           join world_entities seller
             on seller.world_id=listing.world_id and seller.id=listing.seller_entity_id
           join inventories inventory
             on inventory.world_id=listing.world_id and inventory.id=listing.seller_inventory_id
           join resource_types resource
             on resource.world_id=listing.world_id and resource.id=listing.resource_type_id
           join wallets wallet
             on wallet.world_id=listing.world_id and wallet.id=listing.seller_wallet_id
          where listing.world_id=$1
          order by inventory.stable_key,listing.expires_at_tick`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select policy.stable_key::text as policy_key,policy.policy_version,
                assessment.source_type,payer.logical_key::text as payer_key,
                payer_wallet.stable_key::text as payer_wallet_key,
                treasury_wallet.stable_key::text as treasury_wallet_key,
                currency.code::text as currency_code,assessment.basis_minor::text,
                assessment.amount_minor::text,assessment.occurred_tick::text,
                assessment.state_revision::text
           from tax_assessments assessment
           join tax_policies policy
             on policy.world_id=assessment.world_id and policy.id=assessment.policy_id
           join world_entities payer
             on payer.world_id=assessment.world_id and payer.id=assessment.payer_entity_id
           join wallets payer_wallet
             on payer_wallet.world_id=assessment.world_id
            and payer_wallet.id=assessment.payer_wallet_id
           join wallets treasury_wallet
             on treasury_wallet.world_id=assessment.world_id
            and treasury_wallet.id=assessment.treasury_wallet_id
           join currencies currency
             on currency.world_id=assessment.world_id and currency.id=assessment.currency_id
          where assessment.world_id=$1
          order by assessment.occurred_tick,policy.stable_key,assessment.source_type`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select due_tick::text,priority,schedule_sequence::text,action_type,
                action_schema_version,process_version,status::text,
                created_state_revision::text,completed_state_revision::text
           from scheduled_actions
          where world_id=$1
          order by schedule_sequence`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select resource.stable_key::text as resource_key,
                source_inventory.stable_key::text as source_inventory_key,
                target_inventory.stable_key::text as target_inventory_key,
                movement.quantity::text,movement.movement_kind::text,movement.source_type,
                movement.source_ordinal,movement.occurred_tick::text,
                movement.state_revision::text
           from inventory_movements movement
           join resource_types resource
             on resource.world_id=movement.world_id and resource.id=movement.resource_type_id
           left join inventories source_inventory
             on source_inventory.world_id=movement.world_id
            and source_inventory.id=movement.from_inventory_id
           left join inventories target_inventory
             on target_inventory.world_id=movement.world_id
            and target_inventory.id=movement.to_inventory_id
          where movement.world_id=$1
          order by movement.occurred_tick,movement.movement_kind,resource.stable_key,
                   movement.source_ordinal`,
        [worldId],
      ),
      client.pool.query<EvidenceRow>(
        `select transaction.state_revision::text,transaction.transaction_kind::text,
                currency.code::text as currency_code,transaction.supply_delta_minor::text,
                transaction.memo_code,transaction.occurred_tick::text,
                command.command_type,event.event_type,
                jsonb_agg(
                  jsonb_build_object(
                    'walletKey',case when wallet_controller.user_id is null
                      then wallet.stable_key::text
                      else 'wallet:player-organization:'
                        || coalesce(
                          wallet_owner.state ->> 'organizationLogicalKey','unaffiliated'
                        ) end,
                    'signedAmountMinor',posting.signed_amount_minor::text
                  ) order by case when wallet_controller.user_id is null
                    then wallet.stable_key::text
                    else 'wallet:player-organization:'
                      || coalesce(
                        wallet_owner.state ->> 'organizationLogicalKey','unaffiliated'
                      ) end
                ) as postings
           from financial_transactions transaction
           join currencies currency
             on currency.world_id=transaction.world_id and currency.id=transaction.currency_id
           join command_records command
             on command.world_id=transaction.world_id and command.id=transaction.command_id
           join domain_events event
             on event.world_id=transaction.world_id and event.id=transaction.event_id
           join wallet_postings posting
             on posting.world_id=transaction.world_id and posting.transaction_id=transaction.id
           join wallets wallet
             on wallet.world_id=posting.world_id and wallet.id=posting.wallet_id
           join world_entities wallet_owner
             on wallet_owner.world_id=wallet.world_id and wallet_owner.id=wallet.owner_entity_id
           left join world_entity_controllers wallet_controller
             on wallet_controller.world_id=wallet_owner.world_id
            and wallet_controller.entity_id=wallet_owner.id
            and wallet_controller.revoked_at is null
          where transaction.world_id=$1
          group by transaction.state_revision,transaction.transaction_kind,currency.code,
                   transaction.supply_delta_minor,transaction.memo_code,
                   transaction.occurred_tick,command.command_type,event.event_type
          order by transaction.state_revision,transaction.transaction_kind,
                   transaction.memo_code`,
        [worldId],
      ),
      client.pool.query<{
        commerce: boolean;
        economy: boolean;
        graph: boolean;
        ledger: boolean;
        simulation: boolean;
      }>(
        `select
           ledger_head.last_entry_hash is not null
             and ledger_head.last_entry_hash=(
               select entry.entry_hash from ledger_entries entry
                where entry.world_id=$1 order by entry.ledger_sequence desc limit 1
             ) as ledger,
           runtime.projection_checksum=worldgraph_projection_checksum(
             $1,runtime.state_revision
           ) and graph.checksum=runtime.projection_checksum
             and graph.status='current' as graph,
           simulation.checksum=worldgraph_simulation_projection_checksum($1)
             and simulation.status='current' as simulation,
           economy_head.checksum=worldgraph_economy_projection_checksum($1)
             and economy.checksum=economy_head.checksum
             and economy.status='current' as economy,
           expansion_head.checksum=worldgraph_economy_expansion_projection_checksum($1)
             and commerce.checksum=expansion_head.checksum
             and commerce.status='current' as commerce
          from world_ledger_heads ledger_head
          join world_runtime_heads runtime on runtime.world_id=ledger_head.world_id
          join world_economy_heads economy_head on economy_head.world_id=runtime.world_id
          join world_economy_expansion_heads expansion_head
            on expansion_head.world_id=runtime.world_id
          join projection_checkpoints graph
            on graph.world_id=runtime.world_id and graph.projection_name='world_graph'
          join projection_checkpoints simulation
            on simulation.world_id=runtime.world_id
           and simulation.projection_name='simulation_runtime'
          join projection_checkpoints economy
            on economy.world_id=runtime.world_id and economy.projection_name='economy_runtime'
          join projection_checkpoints commerce
            on commerce.world_id=runtime.world_id
           and commerce.projection_name='economy_closed_loop'
         where runtime.world_id=$1`,
        [worldId],
      ),
      client.pool.query<{
        expired_listings: number;
        paid_payrolls: number;
        periodic_taxes: number;
        production_movements: number;
        production_runs: number;
      }>(
        `select
           (select count(*)::integer from production_runs
             where world_id=$1 and status='completed') as production_runs,
           (select count(*)::integer from inventory_movements
             where world_id=$1 and source_type='production_run') as production_movements,
           (select count(*)::integer from payroll_records
             where world_id=$1 and status='paid') as paid_payrolls,
           (select count(*)::integer from market_listings
             where world_id=$1 and status='expired') as expired_listings,
           (select count(*)::integer from tax_assessments
             where world_id=$1 and source_type='periodic_tax') as periodic_taxes`,
        [worldId],
      ),
    ]);

    expect(source.rows).toHaveLength(1);
    expect(heads.rows).toHaveLength(1);
    expect(integrity.rows).toHaveLength(1);
    expect(effects.rows).toHaveLength(1);
    const projectionDocument = {
      balances: balances.rows,
      checkpoints: checkpoints.rows,
      employment: employment.rows,
      heads: heads.rows[0]!,
      inventories: inventories.rows,
      listings: listings.rows,
      movements: movements.rows,
      production: production.rows,
      schedules: schedules.rows,
      taxes: taxes.rows,
      transactions: transactions.rows,
    };
    const checksum = (value: unknown): string =>
      createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
    const eventHashIntegrity = events.rows.every((row) => row.event_hash_valid === true);
    const ledgerHashIntegrity = ledger.rows.every(
      (row) => row.entry_hash_valid === true && row.previous_hash_valid === true,
    );
    const effectCounts = effects.rows[0]!;
    return {
      effectCounts: {
        expiredListings: effectCounts.expired_listings,
        paidPayrolls: effectCounts.paid_payrolls,
        periodicTaxes: effectCounts.periodic_taxes,
        productionMovements: effectCounts.production_movements,
        productionRuns: effectCounts.production_runs,
      },
      eventChecksum: checksum(canonicalReplayRows(events.rows)),
      eventHashIntegrity,
      ledgerChecksum: checksum(canonicalReplayRows(ledger.rows)),
      ledgerHashIntegrity,
      nativeIntegrity: integrity.rows[0]!,
      projectionChecksum: checksum(projectionDocument),
      seedChecksum,
      seedPlanHash: source.rows[0]!.seed_plan_hash,
      sourceArtifactHash: source.rows[0]!.source_artifact_hash,
    };
  }

  function canonicalReplayRows(rows: readonly Record<string, unknown>[]): unknown[] {
    const identities = new Map<string, string>();
    let nextIdentity = 0;
    const uuidPattern =
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
    const normalize = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return value.replace(uuidPattern, (identity) => {
          const normalized = identity.toLowerCase();
          let alias = identities.get(normalized);
          if (!alias) {
            alias = `identity:${nextIdentity.toString()}`;
            nextIdentity += 1;
            identities.set(normalized, alias);
          }
          return alias;
        });
      }
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, item]) => [key, normalize(item)]),
        );
      }
      return value;
    };
    return rows.map((row) => normalize(row));
  }

  async function eventAggregateId(commandId: string, eventType: string): Promise<string> {
    const result = await client.pool.query<{ aggregate_id: string }>(
      `select aggregate_id::text from domain_events
        where command_id=$1 and event_type=$2 order by event_ordinal limit 1`,
      [commandId, eventType],
    );
    const value = result.rows[0]?.aggregate_id;
    if (!value) throw new Error(`Missing ${eventType} for ${commandId}.`);
    return value;
  }

  async function wallets(worldId: string): Promise<WorldActors> {
    return {
      creator: await onlyWallet(creator, worldId),
      memberA: await onlyWallet(memberA, worldId),
      memberB: await onlyWallet(memberB, worldId),
    };
  }

  async function onlyWallet(
    session: BrowserSession,
    worldId: string,
  ): Promise<ControlledWalletViewTransport> {
    const response = await app.inject({
      headers: { cookie: session.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/economy/wallets`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json<{ items: ControlledWalletViewTransport[] }>().items;
    expect(items).toHaveLength(1);
    return items[0]!;
  }

  async function asset(
    session: BrowserSession,
    worldId: string,
    assetKey = ASSET_KEY,
  ): Promise<AssetViewTransport> {
    const response = await app.inject({
      headers: { cookie: session.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/assets/${assetKey}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AssetViewTransport>();
  }

  async function offer(
    session: BrowserSession,
    worldId: string,
    offerId: string,
  ): Promise<OfferViewTransport> {
    const response = await app.inject({
      headers: { cookie: session.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/asset-transfer-offers?offerId=${offerId}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json<{ items: OfferViewTransport[] }>().items;
    expect(items).toHaveLength(1);
    return items[0]!;
  }

  async function createOffer(
    seller: BrowserSession,
    worldId: string,
    sellerWallet: ControlledWalletViewTransport,
    buyerEntityKey: string | null,
    expiresAtTick = '10',
  ): Promise<OfferViewTransport> {
    const currentAsset = await asset(seller, worldId);
    const context = await summary(seller, worldId);
    const body = economyCommand(
      context,
      'CreateAssetTransferOfferV1',
      {
        assetKey: ASSET_KEY,
        buyerEntityKey,
        currencyId: sellerWallet.wallet.currencyId,
        expectedOwnershipVersion: currentAsset.ownership.ownershipVersion,
        expiresAtTick,
        price: '10.00',
        sellerWalletId: sellerWallet.wallet.id,
      },
      'm08-create-offer',
    );
    const response = await submit(seller, worldId, body);
    expect(response.statusCode, response.body).toBe(200);
    const created = await client.pool.query<{ offer_id: string }>(
      `select aggregate_id as offer_id from domain_events
        where command_id=$1 and event_type='AssetTransferOfferCreatedV1'`,
      [body.commandId],
    );
    return offer(seller, worldId, created.rows[0]!.offer_id);
  }

  function acceptCommand(
    context: EconomySummaryTransport,
    view: OfferViewTransport,
    buyerWallet: ControlledWalletViewTransport,
    ownershipVersion: string,
    key = 'm08-accept-offer',
  ): SubmitWorldCommand {
    return economyCommand(
      context,
      'AcceptAssetTransferOfferV1',
      {
        buyerWalletId: buyerWallet.wallet.id,
        expectedBuyerWalletVersion: buyerWallet.balance.rowVersion,
        expectedOfferVersion: view.offer.rowVersion,
        expectedOwnershipVersion: ownershipVersion,
        expectedSellerWalletVersion: view.sellerWalletVersion,
        offerId: view.offer.id,
        sellerWalletId: view.offer.sellerWalletId,
      },
      key,
    );
  }

  async function transferAsset(session: BrowserSession, worldId: string, toOwnerEntityKey: string) {
    const current = await asset(session, worldId);
    const body = economyCommand(
      await summary(session, worldId),
      'TransferAssetV1',
      {
        assetKey: ASSET_KEY,
        expectedOwnershipVersion: current.ownership.ownershipVersion,
        toOwnerEntityKey,
      },
      'm08-transfer-asset',
    );
    const response = await submit(session, worldId, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AcceptedCommandResult>();
  }

  async function cancelOffer(session: BrowserSession, worldId: string, view: OfferViewTransport) {
    const body = economyCommand(
      await summary(session, worldId),
      'CancelAssetTransferOfferV1',
      { expectedOfferVersion: view.offer.rowVersion, offerId: view.offer.id },
      'm08-cancel-offer',
    );
    const response = await submit(session, worldId, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AcceptedCommandResult>();
  }

  async function readClock(worldId: string): Promise<SimulationClockViewTransport> {
    const response = await app.inject({
      headers: { cookie: creator.cookie },
      method: 'GET',
      url: `/api/v1/worlds/${worldId}/simulation/clock`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<SimulationClockViewTransport>();
  }

  async function balanceSnapshot(worldId: string) {
    const result = await client.pool.query<{
      available_minor: string;
      id: string;
      row_version: string;
    }>(
      `select wallet.id::text,balance.available_minor::text,balance.row_version::text
         from wallets wallet join wallet_balances balance on balance.wallet_id=wallet.id
        where wallet.world_id=$1 order by wallet.id`,
      [worldId],
    );
    return result.rows;
  }

  async function economyFootprint(worldId: string, offerId: string) {
    const result = await client.pool.query<{
      offer_status: string;
      offer_version: string;
      owner_entity_id: string;
      ownership_version: string;
      transactions: string;
      transfers: string;
    }>(
      `select ownership.owner_entity_id::text,ownership.ownership_version::text,
              offer.status::text as offer_status,offer.row_version::text as offer_version,
              (select count(*)::text from financial_transactions where world_id=$1) transactions,
              (select count(*)::text from asset_transfers where world_id=$1) transfers
         from asset_transfer_offers offer
         join asset_ownership ownership
           on ownership.world_id=offer.world_id and ownership.asset_id=offer.asset_id
        where offer.world_id=$1 and offer.id=$2`,
      [worldId, offerId],
    );
    return { balances: await balanceSnapshot(worldId), state: result.rows[0]! };
  }

  async function commerceAtomicFootprint(worldId: string, listingId: string) {
    type TextFootprintRow = Record<string, string | null>;
    const [balances, inventories, listing, counts, heads, checkpoints, aggregateStreams] =
      await Promise.all([
        client.pool.query<TextFootprintRow>(
          `select wallet_id::text,currency_id::text,available_minor::text,
                  row_version::text,updated_state_revision::text
             from wallet_balances where world_id=$1 order by wallet_id`,
          [worldId],
        ),
        client.pool.query<TextFootprintRow>(
          `select id::text,quantity::text,reserved_quantity::text,
                  row_version::text,updated_state_revision::text
             from inventories where world_id=$1 order by id`,
          [worldId],
        ),
        client.pool.query<TextFootprintRow>(
          `select listing.status::text,listing.remaining_quantity::text,
                  listing.reserved_quantity::text,listing.row_version::text,
                  listing.terminal_command_id::text,listing.terminal_event_id::text,
                  listing.terminal_state_revision::text,
                  reservation.status::text as reservation_status,
                  reservation.quantity::text as reservation_quantity,
                  reservation.row_version::text as reservation_row_version,
                  reservation.terminal_command_id::text as reservation_terminal_command_id,
                  reservation.terminal_event_id::text as reservation_terminal_event_id,
                  reservation.terminal_state_revision::text
                    as reservation_terminal_state_revision,
                  schedule.status::text as schedule_status
             from market_listings listing
             join inventory_reservations reservation
               on reservation.world_id=listing.world_id
              and reservation.purpose_type='market_listing'
              and reservation.purpose_id=listing.id
             join scheduled_actions schedule
               on schedule.world_id=listing.world_id
              and schedule.id=listing.scheduled_action_id
            where listing.world_id=$1 and listing.id=$2`,
          [worldId, listingId],
        ),
        client.pool.query<TextFootprintRow>(
          `select
             (select count(*)::text from financial_transactions where world_id=$1)
               as financial_transactions,
             (select count(*)::text from wallet_postings where world_id=$1) as wallet_postings,
             (select count(*)::text from inventory_movements where world_id=$1)
               as inventory_movements,
             (select count(*)::text from market_trades where world_id=$1) as market_trades,
             (select count(*)::text from tax_assessments where world_id=$1) as tax_assessments,
             (select count(*)::text from domain_events where world_id=$1) as domain_events,
             (select count(*)::text from ledger_entries where world_id=$1) as ledger_entries,
             (select count(*)::text from outbox_messages where world_id=$1) as outbox_messages,
             (select count(*)::text from world_history_entries where world_id=$1)
               as world_history_entries,
             (select count(*)::text from economy_participant_history where world_id=$1)
               as participant_history_entries`,
          [worldId],
        ),
        client.pool.query<TextFootprintRow>(
          `select runtime.state_revision::text,
                  runtime.last_ledger_sequence::text,
                  runtime.last_event_sequence::text,
                  encode(runtime.projection_checksum,'hex') as runtime_checksum,
                  ledger.next_ledger_sequence::text,
                  ledger.next_event_sequence::text,
                  encode(ledger.last_entry_hash,'hex') as last_entry_hash,
                  economy.row_version::text as economy_version,
                  economy.updated_state_revision::text as economy_state_revision,
                  encode(economy.checksum,'hex') as economy_checksum,
                  economy.reconciliation_status::text as economy_reconciliation_status,
                  expansion.row_version::text as expansion_version,
                  expansion.updated_state_revision::text as expansion_state_revision,
                  encode(expansion.checksum,'hex') as expansion_checksum,
                  expansion.reconciliation_status::text as expansion_reconciliation_status
             from world_runtime_heads runtime
             join world_ledger_heads ledger on ledger.world_id=runtime.world_id
             join world_economy_heads economy on economy.world_id=runtime.world_id
             join world_economy_expansion_heads expansion
               on expansion.world_id=runtime.world_id
            where runtime.world_id=$1`,
          [worldId],
        ),
        client.pool.query<TextFootprintRow>(
          `select projection_name,projection_schema_version::text,
                  last_event_sequence::text,encode(checksum,'hex') as checksum,status::text
             from projection_checkpoints where world_id=$1 order by projection_name`,
          [worldId],
        ),
        client.pool.query<TextFootprintRow>(
          `select aggregate_type,aggregate_id,current_version::text
             from aggregate_stream_heads
            where world_id=$1 order by aggregate_type,aggregate_id`,
          [worldId],
        ),
      ]);
    return {
      aggregateStreams: aggregateStreams.rows,
      balances: balances.rows,
      checkpoints: checkpoints.rows,
      counts: counts.rows[0]!,
      heads: heads.rows[0]!,
      inventories: inventories.rows,
      listing: listing.rows[0]!,
    };
  }

  async function installRuntimeHeadFailureTrigger(): Promise<void> {
    await client.pool.query(
      `create function worldgraph_m09_fail_runtime_head_update()
       returns trigger language plpgsql as $function$
       begin
         raise exception 'injected M09 publication failure' using errcode='P0001';
       end
       $function$`,
    );
    await client.pool.query(
      `create trigger worldgraph_m09_fail_runtime_head_update
       before update on world_runtime_heads
       for each row execute function worldgraph_m09_fail_runtime_head_update()`,
    );
  }

  async function removeRuntimeHeadFailureTrigger(): Promise<void> {
    await client.pool.query(
      `drop trigger worldgraph_m09_fail_runtime_head_update on world_runtime_heads`,
    );
    await client.pool.query(`drop function worldgraph_m09_fail_runtime_head_update()`);
  }

  async function installDropUpdateTrigger(target: 'ownership' | 'offer'): Promise<void> {
    const table = target === 'ownership' ? 'asset_ownership' : 'asset_transfer_offers';
    const condition =
      target === 'offer' ? "IF NEW.status = 'accepted' THEN RETURN NULL; END IF;" : 'RETURN NULL;';
    await client.pool.query(
      `create or replace function worldgraph_m08_drop_${target}_update()
       returns trigger language plpgsql as $function$
       begin ${condition} return new; end
       $function$`,
    );
    await client.pool.query(
      `create trigger worldgraph_m08_drop_${target}_update
       before update on ${table}
       for each row execute function worldgraph_m08_drop_${target}_update()`,
    );
  }

  async function removeDropUpdateTrigger(target: 'ownership' | 'offer'): Promise<void> {
    const table = target === 'ownership' ? 'asset_ownership' : 'asset_transfer_offers';
    await client.pool.query(`drop trigger worldgraph_m08_drop_${target}_update on ${table}`);
    await client.pool.query(`drop function worldgraph_m08_drop_${target}_update()`);
  }

  async function convertToLegacy(worldId: string): Promise<{
    artifactHash: string;
    plan: EconomySeedPlanV1;
    planHash: string;
    worldVersionId: string;
  }> {
    const source = await client.pool.query<{
      canonical_content: Record<string, unknown>;
      canonical_plan: EconomySeedPlanV1;
      compilation_run_id: string;
      source_artifact_id: string;
      world_version_id: string;
    }>(
      `select artifact.canonical_content,plan.canonical_plan,
              plan.compilation_run_id::text,plan.source_artifact_id::text,
              plan.world_version_id::text
         from compiled_economy_seed_plans plan
         join compiled_world_artifacts artifact on artifact.id=plan.source_artifact_id
        where plan.world_id=$1`,
      [worldId],
    );
    const row = source.rows[0]!;
    const base = { ...row.canonical_content };
    delete base.economySeedPlan;
    delete base.economySeedPlanHash;
    const legacy = { ...base, artifactSchemaVersion: 1, compilerVersion: '1.0.0' };
    const artifactHash = createHash('sha256').update(canonicalJson(legacy), 'utf8').digest('hex');
    const connection = await client.pool.connect();
    try {
      await connection.query('begin');
      await connection.query(`set local session_replication_role = 'replica'`);
      await connection.query(`delete from compiled_economy_seed_plans where world_id=$1`, [
        worldId,
      ]);
      await connection.query(
        `update world_compilation_runs
            set compiler_version='1.0.0',artifact_hash=decode($3,'hex')
          where id=$1 and world_id=$2`,
        [row.compilation_run_id, worldId, artifactHash],
      );
      await connection.query(
        `update compiled_world_artifacts
            set artifact_schema_version=1,canonical_content=$3,content_hash=decode($4,'hex')
          where id=$1 and world_id=$2`,
        [row.source_artifact_id, worldId, JSON.stringify(legacy), artifactHash],
      );
      await connection.query(
        `update world_versions
            set compiler_version='1.0.0',artifact_hash=decode($3,'hex')
          where id=$1 and world_id=$2`,
        [row.world_version_id, worldId, artifactHash],
      );
      await connection.query(
        `update world_ledger_heads set anchor_artifact_hash=decode($2,'hex') where world_id=$1`,
        [worldId, artifactHash],
      );
      await connection.query(
        `update world_runtime_heads set anchor_artifact_hash=decode($2,'hex') where world_id=$1`,
        [worldId, artifactHash],
      );
      await connection.query(
        `with anchor as (
           select event.id,
                  jsonb_set(
                    event.payload,'{artifactHash}',to_jsonb($2::text),false
                  ) as payload
             from domain_events event
             join world_runtime_heads runtime
               on runtime.world_id=event.world_id and runtime.ledger_anchor_event_id=event.id
            where event.world_id=$1
         )
         update domain_events event
            set payload=anchor.payload,
                event_hash=worldgraph_domain_event_hash_v1(
                  event.id,event.world_id,event.world_event_sequence,event.command_id,
                  event.event_ordinal,event.aggregate_type,event.aggregate_id,
                  event.aggregate_version,event.event_type,event.event_schema_version,
                  anchor.payload,event.metadata,event.occurred_at,event.recorded_at,
                  event.resulting_state_revision
                )
           from anchor where event.id=anchor.id`,
        [worldId, artifactHash],
      );
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    return {
      artifactHash,
      plan: row.canonical_plan,
      planHash: economySeedPlanHash(row.canonical_plan),
      worldVersionId: row.world_version_id,
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
      service: 'm08-api-economy-worker-test',
    }),
    { maxEntities: 2_000, maxRelationships: 8_000 },
    { maximumRunsPerReconciliation: 1 },
  );
  return runner.runOne();
}

async function runCommerceScheduleOnce(
  pool: Pool,
  ids: { next(): string },
): Promise<Array<{ actionType: string; outcome: string; scheduledActionId: string }>> {
  const repositoryPath = new URL(
    ['..', '..', 'worker', 'src', 'commerce-schedule-repository.ts'].join('/'),
    import.meta.url,
  ).href;
  const workerPath = new URL(
    ['..', '..', 'worker', 'src', 'commerce-schedule-worker.ts'].join('/'),
    import.meta.url,
  ).href;
  const commandPath = new URL(
    ['..', '..', '..', 'packages', 'economy-command', 'src', 'commerce-scheduled-postgres.ts'].join(
      '/',
    ),
    import.meta.url,
  ).href;
  const repositoryModule = (await import(
    repositoryPath
  )) as unknown as CommerceScheduleRepositoryModule;
  const workerModule = (await import(workerPath)) as unknown as CommerceScheduleWorkerModule;
  const commandModule = (await import(commandPath)) as unknown as CommerceScheduleCommandModule;
  const scheduledCommands = new commandModule.PostgresCommerceScheduledCommand(pool, {
    ids,
    maximumSerializationAttempts: 3,
    retryDelay: async () => undefined,
  });
  const runner = new workerModule.CommerceScheduleRunner(
    new repositoryModule.PostgresCommerceScheduleRepository(pool),
    scheduledCommands,
    createLogger({
      buildRevision: 'test',
      environment: 'test',
      level: 'fatal',
      service: 'm09-commerce-schedule-test',
    }),
    { batchSize: 25, ids },
  );
  return runner.reconcile();
}

async function createPayrollScheduledCommand(pool: Pool, ids: { next(): string }) {
  const commandPath = new URL(
    ['..', '..', '..', 'packages', 'economy-command', 'src', 'commerce-scheduled-postgres.ts'].join(
      '/',
    ),
    import.meta.url,
  ).href;
  const commandModule = (await import(commandPath)) as unknown as CommerceScheduleCommandModule;
  return new commandModule.PostgresCommerceScheduledCommand(pool, {
    ids,
    maximumSerializationAttempts: 3,
    retryDelay: async () => undefined,
  });
}

function mutationHeaders(session: BrowserSession, key: string) {
  return {
    cookie: session.cookie,
    'idempotency-key': key,
    origin,
    'x-csrf-token': session.csrf,
  };
}

function canonicalAmount(minor: bigint, scale: number): string {
  if (scale === 0) return minor.toString();
  const factor = 10n ** BigInt(scale);
  return `${minor / factor}.${(minor % factor).toString().padStart(scale, '0')}`;
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
