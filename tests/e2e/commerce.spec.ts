import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const currencyId = '118f8652-3cb6-7d52-904b-cce7901d7e25';
const businessId = '218f8652-3cb6-7d52-904b-cce7901d7e25';
const facilityId = '318f8652-3cb6-7d52-904b-cce7901d7e25';
const facilityAssetId = '418f8652-3cb6-7d52-904b-cce7901d7e25';
const unconfiguredFacilityAssetId = '428f8652-3cb6-7d52-904b-cce7901d7e25';
const oreId = '518f8652-3cb6-7d52-904b-cce7901d7e25';
const ingotId = '618f8652-3cb6-7d52-904b-cce7901d7e25';
const recipeId = '718f8652-3cb6-7d52-904b-cce7901d7e25';
const managerInventoryId = '818f8652-3cb6-7d52-904b-cce7901d7e25';
const participantInventoryId = '918f8652-3cb6-7d52-904b-cce7901d7e25';
const managerDestinationInventoryId = 'f18f8652-3cb6-7d52-904b-cce7901d7e27';
const managerWalletId = 'a18f8652-3cb6-7d52-904b-cce7901d7e25';
const participantWalletId = 'b18f8652-3cb6-7d52-904b-cce7901d7e25';
const candidateBusinessWalletId = 'b28f8652-3cb6-7d52-904b-cce7901d7e25';
const treasuryWalletId = 'c18f8652-3cb6-7d52-904b-cce7901d7e25';
const listingId = 'd18f8652-3cb6-7d52-904b-cce7901d7e25';
const eventId = 'e18f8652-3cb6-7d52-904b-cce7901d7e25';
const csrfToken = 'c'.repeat(43);

const projection = {
  checkpointVersion: '6',
  currentStateRevision: '27',
  lagRevisions: '0',
  status: 'current',
} as const;

const summary = {
  capabilities: {
    canAdoptLegacySeed: false,
    canInitialize: false,
    canIssue: false,
    canReconcile: true,
  },
  currentTick: '84',
  designVersion: '4',
  economyHeadVersion: '19',
  featurePolicy: {
    debitsFrozen: false,
    issuanceEnabled: false,
    offersEnabled: true,
    transfersEnabled: true,
  },
  initializedEventId: eventId,
  issuanceTarget: null,
  projectionChecksum: 'a'.repeat(64),
  reconciliation: {
    lastReconciledAt: '2026-07-22T12:00:00.000Z',
    lastReconciledStateRevision: '27',
    status: 'current',
  },
  seedPlan: { available: true, hash: 'b'.repeat(64), sourceKind: 'compiler_1_1' },
  stateRevision: '27',
  status: 'ready',
  virtualValueBoundary: { cashOutAllowed: false, noCashValue: true },
  worldId,
} as const;

const ore = {
  displayName: 'Iron Ore',
  id: oreId,
  primitiveContentHash: '1'.repeat(64),
  primitiveVersionId: 'f18f8652-3cb6-7d52-904b-cce7901d7e25',
  quantityScale: 2,
  rowVersion: '1',
  schemaVersion: 1,
  stableKey: 'resource:iron-ore',
  status: 'active',
  unitCode: 'kg',
  worldId,
} as const;

const ingot = {
  ...ore,
  displayName: 'Iron Ingot',
  id: ingotId,
  primitiveContentHash: '2'.repeat(64),
  primitiveVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
  stableKey: 'resource:iron-ingot',
};

const recipe = {
  checksum: '3'.repeat(64),
  durationTicks: '12',
  facilityAssetType: 'workshop',
  id: recipeId,
  inputs: [{ quantity: '2.00', resourceTypeId: oreId }],
  outputs: [{ quantity: '1.00', resourceTypeId: ingotId }],
  recipeId: '118f8652-3cb6-7d52-904b-cce7901d7e26',
  schemaVersion: 1,
  version: 2,
  worldId,
} as const;

const business = {
  backingOrganizationEntityKey: 'organization:energy-guild',
  id: businessId,
  rowVersion: '3',
  schemaVersion: 1,
  status: 'active',
  walletId: managerWalletId,
  worldId,
} as const;

const facility = {
  businessId,
  facilityAssetId,
  id: facilityId,
  recipeVersionIds: [recipeId],
  rowVersion: '2',
  schemaVersion: 1,
  status: 'active',
  worldId,
} as const;

const unconfiguredFacilityAsset = {
  asset: {
    assetSchemaVersion: 1,
    assetType: 'workshop',
    id: unconfiguredFacilityAssetId,
    metadata: { displayName: 'Harbor Annex', provenance: 'compiler:1.2.0' },
    stableKey: 'asset:harbor-annex',
    status: 'active',
    transferable: true,
    worldEntityLogicalKey: null,
    worldId,
  },
  controlledByActor: true,
  ownership: {
    acquiredEventId: eventId,
    assetId: unconfiguredFacilityAssetId,
    ownerEntityLogicalKey: 'organization:energy-guild',
    ownershipSchemaVersion: 1,
    ownershipVersion: '3',
    updatedStateRevision: '27',
    worldId,
  },
} as const;

const publicOffer = {
  businessId,
  cadenceTicks: '8',
  currencyId,
  id: '218f8652-3cb6-7d52-904b-cce7901d7e26',
  maxPaymentsPerPeriod: 3,
  roleCode: 'forge_operator',
  rowVersion: '1',
  stableKey: 'employment-offer:forge-operator',
  status: 'open',
  wageMinor: '2400',
  worldId,
} as const;

const managerContract = {
  businessId,
  canManage: true,
  canWork: false,
  effectiveFromTick: '60',
  effectiveToTick: '120',
  id: '318f8652-3cb6-7d52-904b-cce7901d7e26',
  privateTermsVisible: true,
  roleCode: 'forge_operator',
  rowVersion: '4',
  status: 'active',
  wageMinor: '2400',
  workerEntityKey: 'character:participant-smith',
  worldId,
} as const;

const otherWorkerContract = {
  ...managerContract,
  id: '418f8652-3cb6-7d52-904b-cce7901d7e26',
  roleCode: 'private_bookkeeper',
  wageMinor: '3900',
  workerEntityKey: 'character:other-worker',
};

const participantContract = {
  ...managerContract,
  canManage: false,
  canWork: true,
};

const managerJob = {
  contractId: managerContract.id,
  grossMinor: '2400',
  id: '518f8652-3cb6-7d52-904b-cce7901d7e26',
  payroll: {
    errorCode: null,
    grossMinor: '2400',
    id: '618f8652-3cb6-7d52-904b-cce7901d7e26',
    netMinor: '2160',
    rowVersion: '2',
    status: 'paid',
    taxMinor: '240',
  },
  performedTick: '72',
  worldId,
} as const;

const participantOfferedContract = {
  ...participantContract,
  id: '428f8652-3cb6-7d52-904b-cce7901d7e26',
  rowVersion: '1',
  status: 'offered',
} as const;

const productionRuns = [
  {
    businessId,
    dueTick: '96',
    facilityId,
    failureCode: null,
    id: '718f8652-3cb6-7d52-904b-cce7901d7e26',
    inputSnapshot: [{ quantity: '20.00', resourceTypeId: oreId }],
    outputSnapshot: [{ quantity: '10.00', resourceTypeId: ingotId }],
    recipeVersionId: recipeId,
    rowVersion: '1',
    runQuantity: '10',
    status: 'scheduled',
    worldId,
  },
  {
    businessId,
    dueTick: '72',
    facilityId,
    failureCode: null,
    id: '818f8652-3cb6-7d52-904b-cce7901d7e26',
    inputSnapshot: [{ quantity: '4.00', resourceTypeId: oreId }],
    outputSnapshot: [{ quantity: '2.00', resourceTypeId: ingotId }],
    recipeVersionId: recipeId,
    rowVersion: '3',
    runQuantity: '2',
    status: 'completed',
    worldId,
  },
] as const;

const listing = {
  canCancel: false,
  currencyId,
  expiresAtTick: '120',
  id: listingId,
  offeredQuantity: '20.00',
  remainingQuantity: '12.50',
  resourceType: ingot,
  rowVersion: '5',
  sellerEntityKey: 'organization:energy-guild',
  status: 'open',
  unitPriceMinor: '400',
  worldId,
} as const;

const trade = {
  buyerTotalMinor: '880',
  createdTick: '80',
  feeMinor: '40',
  grossMinor: '800',
  id: '918f8652-3cb6-7d52-904b-cce7901d7e26',
  listingId,
  quantity: '2.00',
  sellerNetMinor: '720',
  taxMinor: '40',
  unitPriceMinor: '400',
  worldId,
} as const;

const reconciliation = {
  expansionVersion: '6',
  lastRun: {
    assessmentCount: 3,
    id: 'a18f8652-3cb6-7d52-904b-cce7901d7e26',
    inventoryCount: 2,
    mismatchCount: 0,
    resourceCount: 2,
    sourceStateRevision: '27',
    status: 'matched',
    tradeCount: 1,
  },
  projection,
  projectionChecksum: '4'.repeat(64),
  worldId,
} as const;

type CommerceRole = 'manager' | 'participant';

interface CommerceMockState {
  commandHeaders: Array<Record<string, string>>;
  commands: Array<Record<string, unknown>>;
}

function json(route: Route, body: object, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

function commercePage(items: readonly object[]) {
  return { items, nextCursor: null, projection };
}

function inventory(role: CommerceRole) {
  const manager = role === 'manager';
  return {
    availableQuantity: manager ? '87.50' : '3.00',
    containerAssetId: manager ? facilityAssetId : null,
    containerEntityKey: manager ? 'asset:harbor-forge' : null,
    controlledByActor: true,
    id: manager ? managerInventoryId : participantInventoryId,
    ownerEntityKey: manager ? 'organization:energy-guild' : 'character:participant-smith',
    quantity: manager ? '100.00' : '3.00',
    reservedQuantity: manager ? '12.50' : '0.00',
    resourceType: manager ? ore : ingot,
    rowVersion: manager ? '8' : '2',
    updatedStateRevision: '27',
    worldId,
  };
}

function inventories(role: CommerceRole) {
  const primary = inventory(role);
  return role === 'participant'
    ? [primary]
    : [
        primary,
        {
          ...primary,
          availableQuantity: '8.00',
          containerAssetId: facilityAssetId,
          containerEntityKey: 'asset:harbor-forge',
          id: managerDestinationInventoryId,
          quantity: '8.00',
          reservedQuantity: '0.00',
          resourceType: ingot,
          rowVersion: '1',
        },
      ];
}

function wallet(role: CommerceRole) {
  const manager = role === 'manager';
  const walletId = manager ? managerWalletId : participantWalletId;
  return {
    balance: {
      availableMinor: manager ? '75000' : '12500',
      rowVersion: manager ? '9' : '4',
      updatedStateRevision: '27',
      walletId,
    },
    controlled: true,
    currencyCode: 'GCR',
    minorUnitScale: 2,
    wallet: {
      currencyId,
      id: walletId,
      ownerEntityLogicalKey: manager ? 'organization:energy-guild' : 'character:participant-smith',
      rowVersion: manager ? '6' : '3',
      stableKey: manager ? 'wallet:energy-guild' : 'wallet:participant-smith',
      status: 'active',
      walletKind: manager ? 'organization' : 'player',
      walletSchemaVersion: 1,
      worldId,
    },
  };
}

const candidateBusinessWallet = {
  balance: {
    availableMinor: '20000',
    rowVersion: '2',
    updatedStateRevision: '27',
    walletId: candidateBusinessWalletId,
  },
  controlled: true,
  currencyCode: 'GCR',
  minorUnitScale: 2,
  wallet: {
    currencyId,
    id: candidateBusinessWalletId,
    ownerEntityLogicalKey: 'organization:harbor-cooperative',
    rowVersion: '2',
    stableKey: 'wallet:harbor-cooperative',
    status: 'active',
    walletKind: 'organization',
    walletSchemaVersion: 1,
    worldId,
  },
} as const;

async function mockCommerce(
  page: Page,
  role: CommerceRole,
  options: { uncertainFirstPurchase?: boolean } = {},
): Promise<CommerceMockState> {
  const state: CommerceMockState = { commandHeaders: [], commands: [] };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/v1/auth/csrf' && request.method() === 'POST') {
      return json(route, { csrfToken });
    }
    if (path === `/api/v1/worlds/${worldId}/economy/summary`) {
      return json(route, summary);
    }
    if (path === `/api/v1/worlds/${worldId}/economy/reconciliation`) {
      return json(route, reconciliation);
    }
    if (path === `/api/v1/worlds/${worldId}/economy/resources`) {
      return json(route, commercePage([ore, ingot]));
    }
    if (path === `/api/v1/worlds/${worldId}/assets`) {
      return json(route, {
        items: role === 'manager' ? [unconfiguredFacilityAsset] : [],
        nextCursor: null,
      });
    }
    if (path === `/api/v1/worlds/${worldId}/economy/recipes`) {
      return json(route, commercePage([recipe]));
    }
    if (path === `/api/v1/worlds/${worldId}/economy/inventories`) {
      return json(route, commercePage(inventories(role)));
    }
    if (path === `/api/v1/worlds/${worldId}/economy/businesses`) {
      return json(route, commercePage([{ ...business, canManage: role === 'manager' }]));
    }
    if (path === `/api/v1/worlds/${worldId}/economy/facilities`) {
      return json(route, commercePage([facility]));
    }
    if (path === `/api/v1/worlds/${worldId}/economy/employment/offers`) {
      return json(route, commercePage([publicOffer]));
    }
    if (path === `/api/v1/worlds/${worldId}/economy/employment/contracts`) {
      return json(
        route,
        commercePage(
          role === 'manager'
            ? [managerContract, otherWorkerContract]
            : [participantOfferedContract, participantContract],
        ),
      );
    }
    if (
      path === `/api/v1/worlds/${worldId}/economy/businesses/${businessId}/employment-candidates`
    ) {
      return json(
        route,
        commercePage([
          {
            businessId,
            currencyId,
            workerEntityKey: 'character:participant-smith',
            workerWalletId: participantWalletId,
          },
        ]),
      );
    }
    if (path === `/api/v1/worlds/${worldId}/economy/employment/jobs`) {
      return json(route, commercePage([managerJob]));
    }
    if (path === `/api/v1/worlds/${worldId}/economy/production-runs`) {
      return json(route, commercePage(productionRuns));
    }
    if (path === `/api/v1/worlds/${worldId}/economy/market/listings`) {
      return json(route, commercePage([{ ...listing, canCancel: role === 'manager' }]));
    }
    if (path === `/api/v1/worlds/${worldId}/economy/market/trades`) {
      return json(route, commercePage([trade]));
    }
    if (path === `/api/v1/worlds/${worldId}/economy/wallets`) {
      return json(route, {
        items: role === 'manager' ? [wallet(role), candidateBusinessWallet] : [wallet(role)],
        nextCursor: null,
      });
    }
    if (path === `/api/v1/worlds/${worldId}/economy/treasury`) {
      return json(route, {
        projection,
        treasury: {
          balanceMinor: '205000',
          currencyId,
          lastRevenueTick: '80',
          noCashValue: true,
          revenueMinor: '5000',
          treasuryWalletId,
          worldId,
        },
      });
    }
    if (path === `/api/v1/worlds/${worldId}/economy/tax-assessments`) {
      return json(
        route,
        commercePage([
          {
            amountMinor: '40',
            basisMinor: '800',
            id: 'b18f8652-3cb6-7d52-904b-cce7901d7e26',
            policyId: 'c18f8652-3cb6-7d52-904b-cce7901d7e26',
            sourceId: trade.id,
            sourceType: 'market_trade',
            tick: '80',
            worldId,
          },
        ]),
      );
    }
    if (
      path === `/api/v1/worlds/${worldId}/economy/market/listings/${listingId}/purchase-preview`
    ) {
      expect(url.searchParams.get('quantity')).toBe('2.5');
      return json(route, {
        preview: {
          buyerTotalMinor: '1100',
          currencyId,
          feeMinor: '50',
          grossMinor: '1000',
          listingId,
          listingVersion: listing.rowVersion,
          quantity: '2.50',
          quoteHash: '5'.repeat(64),
          sellerNetMinor: '900',
          taxMinor: '50',
        },
      });
    }
    if (path === `/api/v1/worlds/${worldId}/commands` && request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      state.commands.push(body);
      state.commandHeaders.push(request.headers());
      if (options.uncertainFirstPurchase && state.commands.length === 1) {
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
        eventSequenceRange: { from: '28', to: '32' },
        ledgerSequenceRange: { from: '40', to: '43' },
        resultingStateRevision: '28',
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

async function openPurchase(page: Page, role: CommerceRole) {
  await page.getByRole('button', { name: 'Review purchase' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel(/^Exact quantity \(/u).fill('2.5');
  await page.getByRole('button', { name: 'Preview exact total' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Server-authoritative itemization' }),
  ).toBeVisible();
  await page
    .getByLabel('Controlled buyer wallet')
    .selectOption(role === 'manager' ? managerWalletId : participantWalletId);
  await page
    .getByLabel(/Destination inventory/u)
    .selectOption(role === 'manager' ? managerDestinationInventoryId : participantInventoryId);
  const confirmation = page.getByLabel(/I reviewed the exact quantity/u);
  await confirmation.focus();
  await page.keyboard.press('Space');
}

test('manager sees the complete commerce workspace and an itemized atomic purchase on desktop', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const state = await mockCommerce(page, 'manager');
  await page.goto(`/worlds/${worldId}/economy/resources`);

  await expect(
    page.getByRole('heading', { level: 1, name: 'Resources & inventory' }),
  ).toBeVisible();
  await expect(page.getByLabel('Virtual value boundary')).toContainText(
    'No cash value. Cash-out, withdrawal, and exchange for real money are not allowed.',
  );
  await expect(page.getByRole('heading', { name: 'Iron Ore' })).toBeVisible();
  await expect(page.getByText('87.50 kg')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Production recipes' })).toBeVisible();

  await page.getByRole('link', { name: 'Business & jobs' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Business & jobs' })).toBeVisible();
  await expect(page.getByText('You can manage this business.')).toBeVisible();
  await expect(page.getByText('Worker: character:other-worker')).toBeVisible();
  await expect(page.getByText('Compensation: 3900 minor units')).toBeVisible();

  await page.getByRole('link', { name: 'Production', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Production' })).toBeVisible();
  await expect(page.getByText('scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText('completed (terminal)', { exact: true })).toBeVisible();
  await expect(page.getByText('1 reserved input(s) → 1 output(s)')).toHaveCount(2);

  await page.getByRole('link', { name: 'Marketplace' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Marketplace' })).toBeVisible();
  await openPurchase(page, 'manager');
  const itemization = page.getByText('Server-authoritative itemization').locator('..');
  await expect(itemization).toContainText('Item subtotal1000 minor units');
  await expect(itemization).toContainText('Tax50 minor units');
  await expect(itemization).toContainText('Marketplace fee50 minor units');
  await expect(itemization).toContainText('Exact total1100 minor units');
  await page.getByRole('button', { name: 'Purchase with one atomic settlement' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Accepted at authoritative state revision 28.')).toBeVisible();

  expect(state.commands).toHaveLength(1);
  expect(state.commands[0]).toMatchObject({
    expectedAggregateVersion: reconciliation.expansionVersion,
    expectedStateRevision: summary.stateRevision,
    expectedTick: summary.currentTick,
    expectedWorldVersion: summary.designVersion,
    payload: {
      buyerInventoryId: managerDestinationInventoryId,
      buyerWalletId: managerWalletId,
      expectedBuyerInventoryVersion: '1',
      expectedBuyerWalletVersion: '9',
      expectedListingVersion: listing.rowVersion,
      listingId,
      quantity: '2.50',
    },
    schemaVersion: 1,
    type: 'PurchaseMarketListingV1',
  });
  expect(state.commandHeaders[0]?.['idempotency-key']).toBe(state.commands[0]?.idempotencyKey);

  await page.getByRole('link', { name: 'Treasury' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Treasury & reconciliation' }),
  ).toBeVisible();
  await expect(page.getByText('205000 minor units')).toBeVisible();
  await expect(page.getByText('5000 minor units', { exact: true })).toBeVisible();
  await expect(page.getByText('market trade')).toBeVisible();
  await expect(page.getByText('matched')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('manager can configure the full business, employment, production, and listing lifecycle', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const state = await mockCommerce(page, 'manager');
  await page.goto(`/worlds/${worldId}/economy/business`);

  await page.getByLabel('Organization and active wallet').selectOption(candidateBusinessWalletId);
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect.poll(() => state.commands.length).toBe(1);
  expect(state.commands[0]).toMatchObject({
    expectedAggregateVersion: reconciliation.expansionVersion,
    expectedTick: summary.currentTick,
    payload: {
      backingOrganizationEntityKey: 'organization:harbor-cooperative',
      walletId: candidateBusinessWalletId,
    },
    type: 'CreateBusinessV1',
  });

  await page.getByLabel('Managed business').selectOption(businessId);
  await page
    .getByLabel('Unconfigured asset owned by the business organization')
    .selectOption(unconfiguredFacilityAssetId);
  await page.getByLabel(/Recipe version 2/u).check();
  await page.getByRole('button', { name: 'Configure facility' }).click();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]).toMatchObject({
    expectedAggregateVersion: reconciliation.expansionVersion,
    expectedTick: summary.currentTick,
    payload: {
      businessId,
      expectedBusinessVersion: business.rowVersion,
      expectedOwnershipVersion: unconfiguredFacilityAsset.ownership.ownershipVersion,
      facilityAssetId: unconfiguredFacilityAssetId,
      recipeVersionIds: [recipeId],
    },
    type: 'ConfigureBusinessFacilityV1',
  });

  await page.getByLabel('Managed employer business').selectOption(businessId);
  await page.getByLabel('Eligible worker and active wallet').selectOption(participantWalletId);
  await page.getByLabel('Role code').fill('forge_operator');
  await page.getByLabel(/Wage per shift/u).fill('24.00');
  await page.getByLabel(/Reward cap per period/u).fill('72.00');
  await page.getByLabel('Effective until tick').fill('120');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Offer employment contract' }).click();
  await expect.poll(() => state.commands.length).toBe(3);
  expect(state.commands[2]).toMatchObject({
    expectedAggregateVersion: reconciliation.expansionVersion,
    expectedTick: summary.currentTick,
    payload: {
      businessId,
      cooldownTicks: '1',
      effectiveFromTick: summary.currentTick,
      effectiveToTick: '120',
      employerWalletId: managerWalletId,
      expectedBusinessVersion: business.rowVersion,
      maxPerformancesPerPeriod: 1,
      periodTicks: '10',
      rewardCapMinor: '7200',
      roleCode: 'forge_operator',
      wageMinor: '2400',
      wageRuleKind: 'per_shift',
      workerEntityKey: 'character:participant-smith',
      workerWalletId: participantWalletId,
    },
    type: 'CreateEmploymentContractV1',
  });

  await page.getByRole('link', { exact: true, name: 'Production' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Production' })).toBeVisible();
  await page.getByLabel('Managed business').selectOption(businessId);
  await page.getByLabel('Active facility').selectOption(facilityId);
  await page.getByLabel('Enabled immutable recipe version').selectOption(recipeId);
  await page.getByLabel('Whole run quantity').fill('3');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Reserve inputs and schedule run' }).click();
  await expect.poll(() => state.commands.length).toBe(4);
  expect(state.commands[3]).toMatchObject({
    expectedAggregateVersion: reconciliation.expansionVersion,
    expectedTick: summary.currentTick,
    payload: {
      businessId,
      expectedBusinessVersion: business.rowVersion,
      expectedFacilityVersion: facility.rowVersion,
      expectedInventories: [{ inventoryId: managerInventoryId, rowVersion: '8' }],
      facilityId,
      recipeVersionId: recipeId,
      runQuantity: '3',
    },
    type: 'StartProductionRunV1',
  });

  await page.getByRole('link', { name: 'Marketplace' }).click();
  await page.getByLabel('Controlled seller inventory').selectOption(managerDestinationInventoryId);
  await page.getByLabel('Active seller wallet with the same owner').selectOption(managerWalletId);
  await page.getByLabel('Exact quantity', { exact: true }).fill('2.00');
  await page.getByLabel(/Unit price in GCR/u).fill('4.00');
  await page.getByLabel('Expires at authoritative world tick').fill('100');
  await expect(page.getByText('Exact unit price: 4.00 GCR (400 minor units)')).toBeVisible();
  await page.getByRole('button', { name: 'Reserve inventory and create listing' }).click();
  await expect.poll(() => state.commands.length).toBe(5);
  expect(state.commands[4]).toMatchObject({
    expectedAggregateVersion: reconciliation.expansionVersion,
    expectedTick: summary.currentTick,
    payload: {
      expiresAtTick: '100',
      expectedInventoryVersion: '1',
      quantity: '2.00',
      sellerInventoryId: managerDestinationInventoryId,
      sellerWalletId: managerWalletId,
      unitPriceMinor: '400',
    },
    type: 'CreateMarketListingV1',
  });

  await page.getByRole('button', { name: 'Review listing cancellation' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm listing cancellation' })).toBeFocused();
  await page.getByLabel(/I understand this action permanently closes/u).check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Cancel listing and release reservation' }).click();
  await expect.poll(() => state.commands.length).toBe(6);
  expect(state.commands[5]).toMatchObject({
    expectedAggregateVersion: reconciliation.expansionVersion,
    expectedTick: summary.currentTick,
    payload: { expectedListingVersion: listing.rowVersion, listingId },
    type: 'CancelMarketListingV1',
  });

  for (let index = 0; index < state.commands.length; index += 1) {
    expect(state.commandHeaders[index]?.['idempotency-key']).toBe(
      state.commands[index]?.idempotencyKey,
    );
  }
});

test('eligible worker can accept, perform, and explicitly end a bounded employment contract', async ({
  page,
}) => {
  const state = await mockCommerce(page, 'participant');
  await page.goto(`/worlds/${worldId}/economy/business`);

  await page.getByRole('button', { name: 'Accept employment contract' }).click();
  await expect.poll(() => state.commands.length).toBe(1);
  expect(state.commands[0]).toMatchObject({
    expectedTick: summary.currentTick,
    payload: {
      contractId: participantOfferedContract.id,
      expectedContractVersion: participantOfferedContract.rowVersion,
    },
    type: 'AcceptEmploymentContractV1',
  });

  await page.getByRole('button', { name: 'Perform one bounded job' }).click();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]).toMatchObject({
    expectedTick: summary.currentTick,
    payload: {
      contractId: participantContract.id,
      expectedContractVersion: participantContract.rowVersion,
    },
    type: 'PerformJobV1',
  });

  await page.getByRole('button', { name: 'Review contract termination' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm contract termination' })).toBeFocused();
  await page.getByLabel('Auditable termination reason').fill('Seasonal work concluded.');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'End contract permanently' }).click();
  await expect.poll(() => state.commands.length).toBe(3);
  expect(state.commands[2]).toMatchObject({
    expectedTick: summary.currentTick,
    payload: {
      contractId: participantContract.id,
      expectedContractVersion: participantContract.rowVersion,
      reason: 'Seasonal work concluded.',
    },
    type: 'EndEmploymentContractV1',
  });
});

test('participant privacy and uncertain purchase retry remain safe at 375px', async ({ page }) => {
  await page.setViewportSize({ height: 812, width: 375 });
  const state = await mockCommerce(page, 'participant', { uncertainFirstPurchase: true });
  await page.goto(`/worlds/${worldId}/economy/business`);

  await expect(page.getByRole('heading', { level: 1, name: 'Business & jobs' })).toBeVisible();
  await expect(page.getByText('Read-only view.')).toBeVisible();
  await expect(page.getByText('Worker: character:participant-smith').first()).toBeVisible();
  await expect(page.getByText('Compensation: 2400 minor units').first()).toBeVisible();
  await expect(page.getByText(/participant view/u).first()).toBeVisible();
  await expect(page.getByText('Worker: character:other-worker')).toHaveCount(0);
  await expect(page.getByText('Compensation: 3900 minor units')).toHaveCount(0);
  await expect(page.getByLabel('Virtual value boundary')).toContainText('exchange for real money');

  await page.getByRole('link', { name: 'Marketplace' }).focus();
  await page.keyboard.press('Enter');
  await openPurchase(page, 'participant');
  await page.getByRole('button', { name: 'Purchase with one atomic settlement' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Outcome uncertain — do not submit a new command')).toBeVisible();

  const firstCommand = state.commands[0];
  await page.getByRole('button', { name: 'Retry same command safely' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Accepted at authoritative state revision 28.')).toBeVisible();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1]?.commandId).toBe(firstCommand?.commandId);
  expect(state.commands[1]?.idempotencyKey).toBe(firstCommand?.idempotencyKey);
  expect(state.commandHeaders[1]?.['idempotency-key']).toBe(firstCommand?.idempotencyKey);
  expect(state.commands[1]).toMatchObject({
    expectedTick: summary.currentTick,
    payload: {
      buyerInventoryId: participantInventoryId,
      buyerWalletId: participantWalletId,
      expectedBuyerInventoryVersion: '2',
      expectedBuyerWalletVersion: '4',
      listingId,
      quantity: '2.50',
    },
    type: 'PurchaseMarketListingV1',
  });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
