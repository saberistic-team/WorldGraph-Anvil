import { describe, expect, it } from 'vitest';

import {
  commerceProjectionAllowsActions,
  exactPositiveQuantity,
  formatExactQuantity,
  isTerminalCommerceStatus,
  positiveWholeRunQuantity,
  projectionMessage,
  purchaseConfirmationRows,
  quantityFitsAvailable,
  selectProductionInventories,
  type InventoryView,
  type RecipeView,
} from './commerce-model';
import { buildCommerceCommand, type EconomySummary } from '../economy-model';

describe('commerce UI model', () => {
  it('formats fixed precision quantities without floating-point conversion', () => {
    expect(formatExactQuantity('9007199254740993.125000000001', 'kg')).toBe(
      '9,007,199,254,740,993.125000000001 kg',
    );
  });

  it('announces projection lag and terminal states explicitly', () => {
    expect(
      projectionMessage({
        checkpointVersion: '40',
        currentStateRevision: '42',
        lagRevisions: '2',
        status: 'catching_up',
      }),
    ).toContain('2 revisions behind');
    expect(isTerminalCommerceStatus('filled')).toBe(true);
    expect(isTerminalCommerceStatus('open')).toBe(false);
  });

  it('allows zero-lag pending verification while blocking stale or failed projections', () => {
    expect(
      commerceProjectionAllowsActions({
        checkpointVersion: '42',
        currentStateRevision: '42',
        lagRevisions: '0',
        status: 'current',
      }),
    ).toBe(true);
    expect(
      commerceProjectionAllowsActions({
        checkpointVersion: '42',
        currentStateRevision: '42',
        lagRevisions: '0',
        status: 'catching_up',
      }),
    ).toBe(true);
    expect(
      projectionMessage({
        checkpointVersion: '42',
        currentStateRevision: '42',
        lagRevisions: '0',
        status: 'catching_up',
      }),
    ).toContain('reconciliation verification is pending');
    for (const projection of [
      {
        checkpointVersion: '41',
        currentStateRevision: '42',
        lagRevisions: '1',
        status: 'catching_up' as const,
      },
      {
        checkpointVersion: '42',
        currentStateRevision: '42',
        lagRevisions: '0',
        status: 'failed' as const,
      },
      {
        checkpointVersion: '42',
        currentStateRevision: '42',
        lagRevisions: '0',
        status: 'mismatch' as const,
      },
    ]) {
      expect(commerceProjectionAllowsActions(projection)).toBe(false);
    }
  });

  it('keeps gross, tax, marketplace fee, and total separate in purchase confirmation', () => {
    expect(
      purchaseConfirmationRows({
        buyerTotalMinor: '108',
        currencyId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        feeMinor: '3',
        grossMinor: '100',
        listingId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        listingVersion: '4',
        quantity: '2.50',
        quoteHash: 'a'.repeat(64),
        sellerNetMinor: '100',
        taxMinor: '5',
      }),
    ).toEqual([
      ['Item subtotal', '100 minor units'],
      ['Tax', '5 minor units'],
      ['Marketplace fee', '3 minor units'],
      ['Exact total', '108 minor units'],
    ]);
  });

  it('validates exact resource precision and whole production quantities without Number conversion', () => {
    expect(exactPositiveQuantity('9007199254740993.125', 3)).toEqual({
      canonical: '9007199254740993.125',
      ok: true,
    });
    expect(exactPositiveQuantity('1.001', 2)).toEqual({
      message: 'This resource permits at most 2 decimal places.',
      ok: false,
    });
    expect(exactPositiveQuantity('0.00', 2)).toMatchObject({ ok: false });
    expect(positiveWholeRunQuantity('9007199254740993')).toEqual({
      canonical: '9007199254740993',
      ok: true,
    });
    expect(positiveWholeRunQuantity('1.5')).toMatchObject({ ok: false });
    expect(quantityFitsAvailable('8.125', '8.125', 3)).toBe(true);
    expect(quantityFitsAvailable('8.126', '8.125', 3)).toBe(false);
  });

  it('uses exact row versions only when every recipe input inventory is unambiguous', () => {
    const resource = {
      displayName: 'Ore',
      id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
      primitiveContentHash: 'a'.repeat(64),
      primitiveVersionId: '118f8652-3cb6-7d52-904b-cce7901d7e25',
      quantityScale: 2,
      rowVersion: '1',
      schemaVersion: 1,
      stableKey: 'resource:ore',
      status: 'active',
      unitCode: 'kg',
      worldId: '218f8652-3cb6-7d52-904b-cce7901d7e25',
    } as const;
    const recipe = {
      checksum: 'b'.repeat(64),
      durationTicks: '2',
      facilityAssetType: 'workshop',
      id: '318f8652-3cb6-7d52-904b-cce7901d7e25',
      inputs: [{ quantity: '2.00', resourceTypeId: resource.id }],
      outputs: [],
      recipeId: '418f8652-3cb6-7d52-904b-cce7901d7e25',
      schemaVersion: 1,
      version: 1,
      worldId: resource.worldId,
    } satisfies RecipeView;
    const inventory = {
      availableQuantity: '10.00',
      containerAssetId: '618f8652-3cb6-7d52-904b-cce7901d7e25',
      containerEntityKey: 'asset:forge',
      controlledByActor: true,
      id: '518f8652-3cb6-7d52-904b-cce7901d7e25',
      ownerEntityKey: 'organization:smiths',
      quantity: '10.00',
      reservedQuantity: '0.00',
      resourceType: resource,
      rowVersion: '7',
      updatedStateRevision: '9',
      worldId: resource.worldId,
    } satisfies InventoryView;

    expect(selectProductionInventories(recipe, [inventory], inventory.containerAssetId)).toEqual({
      expectedInventories: [{ inventoryId: inventory.id, rowVersion: '7' }],
      ok: true,
    });
    expect(
      selectProductionInventories(
        recipe,
        [inventory, { ...inventory, id: resource.id }],
        inventory.containerAssetId,
      ),
    ).toMatchObject({ ok: false });
  });

  it('uses the independent expansion version for commerce command concurrency', () => {
    const command = buildCommerceCommand(
      {
        capabilities: {
          canAdoptLegacySeed: false,
          canInitialize: false,
          canIssue: false,
          canReconcile: false,
        },
        currentTick: '9',
        designVersion: '3',
        economyHeadVersion: '11',
        featurePolicy: {
          debitsFrozen: false,
          issuanceEnabled: true,
          offersEnabled: true,
          transfersEnabled: true,
        },
        initializedEventId: null,
        issuanceTarget: null,
        projectionChecksum: null,
        reconciliation: {
          lastReconciledAt: null,
          lastReconciledStateRevision: null,
          status: 'not_run',
        },
        seedPlan: { available: true, hash: null, sourceKind: 'compiler_1_1' },
        stateRevision: '27',
        status: 'ready',
        virtualValueBoundary: { cashOutAllowed: false, noCashValue: true },
        worldId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
      } satisfies EconomySummary,
      '4',
      'PurchaseMarketListingV1',
      { listingId: '018f8652-3cb6-7d52-904b-cce7901d7e26' },
      '018f8652-3cb6-7d52-904b-cce7901d7e27',
    );

    expect(command).toMatchObject({
      expectedAggregateVersion: '4',
      expectedStateRevision: '27',
      expectedTick: '9',
      idempotencyKey: 'commerce-PurchaseMarketListingV1-018f8652-3cb6-7d52-904b-cce7901d7e27',
    });
  });
});
