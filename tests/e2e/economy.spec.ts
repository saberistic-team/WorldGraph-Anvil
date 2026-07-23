import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const currencyId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const sourceWalletId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const destinationWalletId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const sellerWalletId = '018f8652-3cb6-7d52-904b-cce7901d7e29';
const assetId = '018f8652-3cb6-7d52-904b-cce7901d7e30';
const controlledAssetId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
const offerId = '018f8652-3cb6-7d52-904b-cce7901d7e32';
const transactionId = '018f8652-3cb6-7d52-904b-cce7901d7e33';
const previousCommandId = '018f8652-3cb6-7d52-904b-cce7901d7e34';
const eventId = '018f8652-3cb6-7d52-904b-cce7901d7e35';
const csrfToken = 'c'.repeat(43);

const summary = {
  capabilities: {
    canAdoptLegacySeed: false,
    canInitialize: false,
    canIssue: true,
    canReconcile: true,
  },
  currentTick: '42',
  designVersion: '3',
  economyHeadVersion: '9',
  featurePolicy: {
    debitsFrozen: false,
    issuanceEnabled: true,
    offersEnabled: true,
    transfersEnabled: true,
  },
  initializedEventId: eventId,
  issuanceTarget: {
    currencyCode: 'GCR',
    currencyId,
    currencyVersion: '1',
    currentSupplyMinor: '250000',
    maxSupplyMinor: '100000000',
    minorUnitScale: 2,
    supplyVersion: '4',
    treasuryBalanceMinor: '200000',
    treasuryBalanceVersion: '7',
    treasuryWalletId: sellerWalletId,
    treasuryWalletVersion: '1',
  },
  projectionChecksum: 'a'.repeat(64),
  reconciliation: {
    lastReconciledAt: '2026-07-21T12:00:00.000Z',
    lastReconciledStateRevision: '12',
    status: 'current',
  },
  seedPlan: { available: true, hash: 'b'.repeat(64), sourceKind: 'compiler_1_1' },
  stateRevision: '12',
  status: 'ready',
  virtualValueBoundary: { cashOutAllowed: false, noCashValue: true },
  worldId,
} as const;

const currencyView = {
  currency: {
    cashOutAllowed: false,
    code: 'GCR',
    currencySchemaVersion: 1,
    id: currencyId,
    issuerEntityLogicalKey: 'organization:guild-treasury',
    maxSupplyMinor: '100000000',
    minorUnitScale: 2,
    name: 'Guild Credits',
    noCashValue: true,
    rowVersion: '1',
    stableKey: 'currency:guild-credit',
    status: 'active',
    worldId,
  },
  currentSupplyMinor: '250000',
  supplyVersion: '4',
  updatedStateRevision: '12',
} as const;

const walletView = {
  balance: {
    availableMinor: '10000',
    rowVersion: '7',
    updatedStateRevision: '12',
    walletId: sourceWalletId,
  },
  controlled: true,
  currencyCode: 'GCR',
  minorUnitScale: 2,
  wallet: {
    currencyId,
    id: sourceWalletId,
    ownerEntityLogicalKey: 'character:buyer',
    rowVersion: '2',
    stableKey: 'wallet:buyer-guild-credit',
    status: 'active',
    walletKind: 'player',
    walletSchemaVersion: 1,
    worldId,
  },
} as const;

const transactionView = {
  memo: 'Guild supplies',
  transaction: {
    commandId: previousCommandId,
    currencyId,
    financialTransactionSchemaVersion: 1,
    id: transactionId,
    kind: 'transfer',
    occurredTick: '41',
    postings: [
      {
        currencyId,
        postingOrdinal: 0,
        signedAmountMinor: '-2500',
        transactionId,
        walletId: sourceWalletId,
        worldId,
      },
      {
        currencyId,
        postingOrdinal: 1,
        signedAmountMinor: '2500',
        transactionId,
        walletId: destinationWalletId,
        worldId,
      },
    ],
    stateRevision: '12',
    supplyDeltaMinor: '0',
    worldId,
  },
} as const;

const offeredAsset = {
  asset: {
    assetSchemaVersion: 1,
    assetType: 'vehicle',
    id: assetId,
    metadata: { displayName: 'Cloud Skiff', provenance: 'compiled_seed' },
    stableKey: 'asset:cloud-skiff',
    status: 'active',
    transferable: true,
    worldEntityLogicalKey: null,
    worldId,
  },
  controlledByActor: false,
  ownership: {
    acquiredEventId: eventId,
    assetId,
    ownerEntityLogicalKey: 'character:seller',
    ownershipSchemaVersion: 1,
    ownershipVersion: '5',
    updatedStateRevision: '12',
    worldId,
  },
} as const;

const controlledAsset = {
  asset: {
    assetSchemaVersion: 1,
    assetType: 'tool',
    id: controlledAssetId,
    metadata: { displayName: 'Survey Compass', provenance: 'compiled_seed' },
    stableKey: 'asset:survey-compass',
    status: 'active',
    transferable: true,
    worldEntityLogicalKey: null,
    worldId,
  },
  controlledByActor: true,
  ownership: {
    acquiredEventId: eventId,
    assetId: controlledAssetId,
    ownerEntityLogicalKey: 'character:buyer',
    ownershipSchemaVersion: 1,
    ownershipVersion: '2',
    updatedStateRevision: '12',
    worldId,
  },
} as const;

const offerView = {
  assetKey: offeredAsset.asset.stableKey,
  canAccept: true,
  controlledBuyer: true,
  controlledSeller: true,
  eligibleBuyerWallet: {
    ownerEntityLogicalKey: walletView.wallet.ownerEntityLogicalKey,
    walletId: sourceWalletId,
    walletVersion: walletView.balance.rowVersion,
  },
  offer: {
    assetId,
    buyerEntityLogicalKey: 'character:buyer',
    currencyId,
    expiresAtTick: '50',
    id: offerId,
    offerSchemaVersion: 1,
    priceMinor: '1000',
    rowVersion: '3',
    sellerEntityLogicalKey: 'character:seller',
    sellerWalletId,
    status: 'open',
    worldId,
  },
  sellerWalletVersion: '11',
} as const;

interface EconomyMockState {
  assetQueries: URLSearchParams[];
  commands: Array<Record<string, unknown>>;
  headers: Array<Record<string, string>>;
  offerQueries: URLSearchParams[];
}

function json(route: Route, body: object, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

async function mockEconomy(
  page: Page,
  options: { notInitialized?: boolean; receivedCommand?: boolean } = {},
): Promise<EconomyMockState> {
  const state: EconomyMockState = {
    assetQueries: [],
    commands: [],
    headers: [],
    offerQueries: [],
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/v1/auth/csrf' && request.method() === 'POST') {
      return json(route, { csrfToken });
    }
    if (path === `/api/v1/worlds/${worldId}/economy/summary`) {
      return json(
        route,
        options.notInitialized
          ? {
              ...summary,
              capabilities: { ...summary.capabilities, canInitialize: true },
              economyHeadVersion: null,
              initializedEventId: null,
              issuanceTarget: null,
              projectionChecksum: null,
              reconciliation: {
                lastReconciledAt: null,
                lastReconciledStateRevision: null,
                status: 'not_run',
              },
              status: 'not_initialized',
            }
          : summary,
      );
    }
    if (path === `/api/v1/worlds/${worldId}`) {
      return json(route, {
        world: { activeWorldVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e36' },
      });
    }
    if (path === `/api/v1/worlds/${worldId}/economy/currencies`) {
      return json(route, { items: [currencyView], nextCursor: null });
    }
    if (path === `/api/v1/worlds/${worldId}/economy/wallets`) {
      return json(route, { items: [walletView], nextCursor: null });
    }
    if (path === `/api/v1/worlds/${worldId}/economy/wallets/${sourceWalletId}/transactions`) {
      return json(route, { items: [transactionView], nextCursor: null });
    }
    if (path === `/api/v1/worlds/${worldId}/assets`) {
      state.assetQueries.push(new URLSearchParams(url.search));
      return json(route, { items: [offeredAsset, controlledAsset], nextCursor: null });
    }
    if (path === `/api/v1/worlds/${worldId}/asset-transfer-offers`) {
      state.offerQueries.push(new URLSearchParams(url.search));
      return json(route, { items: [offerView], nextCursor: null });
    }
    if (path === `/api/v1/worlds/${worldId}/commands` && request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      state.commands.push(body);
      state.headers.push(request.headers());
      if (options.receivedCommand) {
        return json(route, {
          commandId: body.commandId,
          eventIds: [],
          schemaVersion: 1,
          status: 'received',
        });
      }
      return json(route, {
        commandId: body.commandId,
        eventIds: [eventId],
        eventSequenceRange: { from: '13', to: '13' },
        ledgerSequenceRange: { from: '20', to: '22' },
        resultingStateRevision: '13',
        schemaVersion: 1,
        status: 'accepted',
      });
    }
    return json(
      route,
      { error: { code: 'NOT_FOUND', message: `${request.method()} ${path} not mocked` } },
      404,
    );
  });
  return state;
}

test('economy presents the virtual boundary and submits exact transfer intent on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ height: 720, width: 320 });
  const state = await mockEconomy(page);
  await page.goto(`/worlds/${worldId}/economy`);

  await expect(page.getByRole('heading', { level: 1, name: 'Economy' })).toBeVisible();
  await expect(page.getByLabel('Virtual value boundary')).toContainText(
    'No cash value. Cash-out, withdrawal, and exchange for real money are not allowed.',
  );
  await expect(
    page.getByRole('table', { name: 'Wallets whose owners are controlled by the signed-in actor' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', {
      name: 'Immutable financial transactions and their balanced wallet postings',
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy transaction ID' })).toBeVisible();

  await page.getByLabel('Recipient wallet ID').fill(destinationWalletId);
  await page.getByLabel('Recipient wallet version').fill('6');
  await page.getByLabel('Amount in GCR').fill('25');
  await expect(page.getByText('Exact submission: 25.00 GCR')).toBeVisible();
  await expect(page.getByText('Source balance preview: 75.00 GCR')).toBeVisible();
  await page.getByLabel('Memo (optional, visible under transaction policy)').fill('Guild supplies');
  await page
    .getByLabel('I checked the recipient wallet and exact virtual-currency amount above.')
    .check();
  await page.getByRole('button', { name: 'Transfer virtual currency' }).press('Enter');
  await expect(page.getByText(/Accepted at authoritative state revision 13/u)).toBeVisible();

  expect(state.commands).toHaveLength(1);
  expect(state.commands[0]).toMatchObject({
    expectedAggregateVersion: '9',
    expectedStateRevision: '12',
    expectedWorldVersion: '3',
    payload: {
      amount: '25.00',
      destinationWalletId,
      expectedDestinationVersion: '6',
      expectedSourceVersion: '7',
      memo: 'Guild supplies',
      sourceWalletId,
    },
    schemaVersion: 1,
    type: 'TransferCurrencyV1',
  });
  expect(state.headers[0]?.['idempotency-key']).toBe(state.commands[0]?.idempotencyKey);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('creator issuance uses the server-authorized treasury target without treasury control', async ({
  page,
}) => {
  const state = await mockEconomy(page);
  await page.goto(`/worlds/${worldId}/economy`);

  await page.getByText('Creator override: issue virtual currency').click();
  await expect(page.getByText('Current treasury balance')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy treasury wallet ID' })).toBeVisible();
  await page.getByLabel('Amount to issue').fill('10');
  await expect(page.getByText('Exact issuance: 10.00 GCR')).toBeVisible();
  await page.getByLabel('Audit reason').fill('Approved alpha-world grant');
  await page.getByLabel('Type ISSUE VIRTUAL CURRENCY to confirm').fill('ISSUE VIRTUAL CURRENCY');
  await page.getByRole('button', { name: 'Issue and record override' }).click();

  await expect(page.getByText(/Accepted at authoritative state revision 13/u)).toBeVisible();
  await expect.poll(() => state.commands.length).toBe(1);
  expect(state.commands[0]).toMatchObject({
    payload: {
      amount: '10.00',
      confirmation: 'ISSUE VIRTUAL CURRENCY',
      expectedSupplyVersion: '4',
      reason: 'Approved alpha-world grant',
      treasuryWalletId: sellerWalletId,
    },
    type: 'IssueCurrencyV1',
  });
});

test('assets expose exact title and confirm direct offer payment and ownership atomically', async ({
  page,
}) => {
  const state = await mockEconomy(page);
  await page.goto(`/worlds/${worldId}/assets`);

  await expect(page.getByRole('heading', { level: 1, name: 'Assets' })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Visible asset identity and current authoritative owner' }),
  ).toContainText('Cloud Skiff');
  await expect(page.getByText('Seller: character:seller')).toBeVisible();
  await expect(page.getByText('10.00 GCR')).toBeVisible();
  await expect(page.getByText('Tick 50')).toBeVisible();

  await page.getByLabel('Exact offer ID').fill(offerId);
  await page.getByRole('button', { name: 'Open exact invitation' }).click();
  await expect(page.getByText('The exact open invitation is ready for review.')).toBeVisible();
  await expect.poll(() => state.offerQueries.at(-1)?.get('offerId')).toBe(offerId);
  await page.getByRole('button', { name: 'Close review' }).click();

  await page.getByLabel('Only assets I control').check();
  await expect.poll(() => state.assetQueries.at(-1)?.get('owned')).toBe('true');

  const createOfferCard = page
    .getByRole('heading', { name: 'Create a direct offer' })
    .locator('..');
  await createOfferCard
    .getByLabel('Buyer entity key (optional direct target)')
    .fill('character:buyer');
  await createOfferCard.getByLabel('Exact price in GCR').fill('10');
  await createOfferCard.getByLabel('Expires at world tick').fill('50');
  await expect(
    createOfferCard.getByText('Exact price: 10.00 GCR (1000 minor units)'),
  ).toBeVisible();
  await createOfferCard.getByRole('button', { name: 'Create direct offer' }).click();
  await expect(page.getByText(/Accepted at authoritative state revision 13/u)).toBeVisible();

  expect(state.commands[0]).toMatchObject({
    payload: {
      assetKey: controlledAsset.asset.stableKey,
      buyerEntityKey: 'character:buyer',
      currencyId,
      expectedOwnershipVersion: '2',
      expiresAtTick: '50',
      price: '10.00',
      sellerWalletId: sourceWalletId,
    },
    type: 'CreateAssetTransferOfferV1',
  });

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Cancel offer' }).click();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]).toMatchObject({
    payload: { expectedOfferVersion: '3', offerId },
    type: 'CancelAssetTransferOfferV1',
  });

  await page.getByRole('button', { name: 'Review purchase' }).click();
  const confirmation = page.getByLabel(
    'I understand the server will commit payment and title together or commit neither.',
  );
  await confirmation.check();
  await page.getByRole('button', { name: 'Accept exact price atomically' }).press('Enter');
  await expect(page.getByText(/Accepted at authoritative state revision 13/u)).toBeVisible();

  expect(state.commands).toHaveLength(3);
  expect(state.commands[2]).toMatchObject({
    expectedAggregateVersion: '9',
    payload: {
      buyerWalletId: sourceWalletId,
      expectedBuyerWalletVersion: '7',
      expectedOfferVersion: '3',
      expectedOwnershipVersion: '5',
      expectedSellerWalletVersion: '11',
      offerId,
      sellerWalletId,
    },
    type: 'AcceptAssetTransferOfferV1',
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('an uncertain transfer keeps one command and idempotency identity for a safe retry', async ({
  page,
}) => {
  const state = await mockEconomy(page, { receivedCommand: true });
  await page.goto(`/worlds/${worldId}/economy`);
  await page.getByLabel('Recipient wallet ID').fill(destinationWalletId);
  await page.getByLabel('Recipient wallet version').fill('6');
  await page.getByLabel('Amount in GCR').fill('1');
  await page
    .getByLabel('I checked the recipient wallet and exact virtual-currency amount above.')
    .check();
  await page.getByRole('button', { name: 'Transfer virtual currency' }).click();

  await expect(page.getByText('Outcome uncertain — do not submit a new command')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check authoritative status' })).toBeVisible();
  const first = state.commands[0];
  await page.getByRole('button', { name: 'Retry same command safely' }).click();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]?.commandId).toBe(first?.commandId);
  expect(state.commands[1]?.idempotencyKey).toBe(first?.idempotencyKey);
  expect(state.headers[1]?.['idempotency-key']).toBe(first?.idempotencyKey);
});

test('not-initialized state never invents currency, balances, assets, or owners', async ({
  page,
}) => {
  await mockEconomy(page, { notInitialized: true });
  await page.goto(`/worlds/${worldId}/economy`);
  await expect(
    page.getByRole('heading', { name: 'No authoritative economy exists yet' }),
  ).toBeVisible();
  await expect(page.getByText('creator initialization available')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Initialize deterministic economy' }),
  ).toBeDisabled();
  await page.getByLabel(/Initialize exactly from this compiled seed plan/u).check();
  await expect(
    page.getByRole('button', { name: 'Initialize deterministic economy' }),
  ).toBeEnabled();
  await expect(page.getByText('Guild Credits')).toHaveCount(0);

  await page.goto(`/worlds/${worldId}/assets`);
  await expect(
    page.getByRole('heading', { name: 'No authoritative asset registry exists yet' }),
  ).toBeVisible();
  await expect(page.getByText('Cloud Skiff')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
