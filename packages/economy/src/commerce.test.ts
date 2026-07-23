import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '@worldgraph/contracts';

import {
  EconomyDomainError,
  addQuantity,
  assessTax,
  assertBalancedTransaction,
  assertEmploymentTransition,
  assertInventoryState,
  assertProductionRecipeVersion,
  assertProductionRunTransition,
  availableInventory,
  consumeReservedInventory,
  createWithholdingSettlement,
  decideJobPerformance,
  decideListingTerminal,
  decideMarketPurchase,
  decideProductionCompletion,
  decideProductionReservation,
  formatQuantity,
  parseCanonicalQuantity,
  priceQuantityMinor,
  productionRecipeChecksum,
  releaseInventoryReservation,
  reserveInventory,
  type EmploymentContractState,
  type InventoryState,
  type MarketListingState,
  type ProductionRecipeVersionState,
  type TaxPolicyState,
} from './index.js';

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(EconomyDomainError);
    expect((error as EconomyDomainError).code).toBe(code);
  }
}

const salesTax: TaxPolicyState = {
  basisPoints: 250,
  collectionMode: 'added_to_payer',
  fixedMinor: null,
  id: 'tax:sales:1',
  roundingMode: 'half_up',
  status: 'active',
  taxType: 'sales',
  treasuryWalletId: 'wallet:treasury',
};

describe('fixed-precision resource quantities', () => {
  it('requires an exact declared scale and never uses binary floating point', () => {
    expect(parseCanonicalQuantity('10', 0, { positive: true })).toBe(10n);
    expect(parseCanonicalQuantity('10.250', 3)).toBe(10_250n);
    expect(formatQuantity(10_250n, 3)).toBe('10.250');
    expect(priceQuantityMinor(3n, 0, 175n)).toBe(525n);
    expect(priceQuantityMinor(15n, 1, 101n)).toBe(152n);
    for (const value of ['01.00', '+1.00', '-1.00', '1', '1.0', '1e0']) {
      expectCode(() => parseCanonicalQuantity(value, 2), ErrorCodes.quantityInvalid);
    }
  });

  it('preserves inventory bounds through 500 deterministic reserve/release/consume steps', () => {
    let inventory: InventoryState = {
      id: 'inventory:iron',
      quantityAtoms: 10_000n,
      reservedAtoms: 0n,
      rowVersion: 1n,
    };
    let state = 0x5eedn;
    for (let index = 0; index < 500; index += 1) {
      state = (state * 48_271n) % 2_147_483_647n;
      const candidate = (state % 19n) + 1n;
      if (index % 3 === 0 && availableInventory(inventory) >= candidate) {
        inventory = {
          id: inventory.id,
          ...reserveInventory(inventory, candidate, inventory.rowVersion),
        };
      } else if (index % 3 === 1 && inventory.reservedAtoms >= candidate) {
        inventory = {
          id: inventory.id,
          ...releaseInventoryReservation(inventory, candidate, inventory.rowVersion),
        };
      } else if (inventory.reservedAtoms >= candidate) {
        inventory = {
          id: inventory.id,
          ...consumeReservedInventory(inventory, candidate, inventory.rowVersion),
        };
      }
      expect(assertInventoryState(inventory)).toBe(inventory);
      expect(inventory.quantityAtoms).toBeGreaterThanOrEqual(0n);
      expect(inventory.reservedAtoms).toBeGreaterThanOrEqual(0n);
      expect(inventory.reservedAtoms).toBeLessThanOrEqual(inventory.quantityAtoms);
    }
  });
});

describe('immutable recipes and deterministic production', () => {
  const recipe: ProductionRecipeVersionState = {
    durationTicks: 12n,
    inputs: [
      { quantityAtoms: 2n, resourceTypeId: 'resource:iron-ore' },
      { quantityAtoms: 1n, resourceTypeId: 'resource:energy' },
    ],
    outputs: [{ quantityAtoms: 1n, resourceTypeId: 'resource:metal-part' }],
    recipeId: 'recipe:metal-part-fabrication',
    version: 1,
  };

  it('reserves exact scaled inputs and completes only at the due tick', () => {
    const decision = decideProductionReservation({
      currentTick: 20n,
      inputInventories: new Map([
        [
          'resource:iron-ore',
          { id: 'iron', quantityAtoms: 30n, reservedAtoms: 0n, rowVersion: 1n },
        ],
        [
          'resource:energy',
          { id: 'energy', quantityAtoms: 20n, reservedAtoms: 0n, rowVersion: 1n },
        ],
      ]),
      recipe,
      runQuantity: 10n,
    });
    expect(decision).toEqual({
      dueTick: 32n,
      inputs: [
        { quantityAtoms: 20n, resourceTypeId: 'resource:iron-ore' },
        { quantityAtoms: 10n, resourceTypeId: 'resource:energy' },
      ],
      outputs: [{ quantityAtoms: 10n, resourceTypeId: 'resource:metal-part' }],
      status: 'ready',
    });
    expectCode(
      () => decideProductionCompletion({ currentTick: 31n, dueTick: 32n, status: 'ready' }),
      ErrorCodes.conflict,
    );
    expect(decideProductionCompletion({ currentTick: 32n, dueTick: 32n, status: 'ready' })).toEqual(
      { status: 'completed' },
    );
  });

  it('hashes semantic recipe content independent of input order', () => {
    assertProductionRecipeVersion(recipe);
    expect(productionRecipeChecksum(recipe)).toMatch(/^[a-f0-9]{64}$/u);
    expect(productionRecipeChecksum({ ...recipe, inputs: [...recipe.inputs].reverse() })).toBe(
      productionRecipeChecksum(recipe),
    );
    expectCode(
      () =>
        assertProductionRecipeVersion({
          ...recipe,
          outputs: [...recipe.outputs, ...recipe.outputs],
        }),
      ErrorCodes.recipeInvalid,
    );
  });

  it('admits only the explicit production state machine', () => {
    expect(() => assertProductionRunTransition('scheduled', 'reserving')).not.toThrow();
    expect(() => assertProductionRunTransition('reserving', 'ready')).not.toThrow();
    expect(() => assertProductionRunTransition('ready', 'completed')).not.toThrow();
    expectCode(
      () => assertProductionRunTransition('completed', 'ready'),
      ErrorCodes.productionStateInvalid,
    );
  });
});

describe('tax, market, and payroll settlement', () => {
  const listing: MarketListingState = {
    currencyId: 'currency:gcr',
    expiresAtTick: 100n,
    id: 'listing:parts',
    quantityScale: 0,
    remainingAtoms: 10n,
    rowVersion: 1n,
    sellerEntityId: 'organization:artisan-guild',
    sellerWalletId: 'wallet:seller',
    status: 'open',
    unitPriceMinor: 100n,
    worldId: 'world',
  };

  it('uses half-up tax rounding and balances added or withheld collection', () => {
    expect(assessTax(salesTax, 300n).amountMinor).toBe(8n);
    const added = createWithholdingSettlement({
      grossMinor: 300n,
      payeeWalletId: 'seller',
      payerWalletId: 'buyer',
      tax: assessTax(salesTax, 300n),
    });
    expect(added.postings).toEqual([
      { signedAmountMinor: -308n, walletId: 'buyer' },
      { signedAmountMinor: 300n, walletId: 'seller' },
      { signedAmountMinor: 8n, walletId: 'wallet:treasury' },
    ]);
    expect(() => assertBalancedTransaction(added)).not.toThrow();

    const payrollTax: TaxPolicyState = {
      ...salesTax,
      collectionMode: 'withheld_from_recipient',
      id: 'tax:payroll:1',
      taxType: 'payroll',
    };
    expect(
      createWithholdingSettlement({
        grossMinor: 300n,
        payeeWalletId: 'worker',
        payerWalletId: 'employer',
        tax: assessTax(payrollTax, 300n),
      }).postings,
    ).toEqual([
      { signedAmountMinor: -300n, walletId: 'employer' },
      { signedAmountMinor: 8n, walletId: 'wallet:treasury' },
      { signedAmountMinor: 292n, walletId: 'worker' },
    ]);
  });

  it('withholds a configured marketplace fee in the same balanced settlement', () => {
    const decision = decideMarketPurchase({
      buyerEntityId: 'buyer',
      buyerWalletId: 'buyer-wallet',
      currentTick: 10n,
      expectedListingVersion: 1n,
      feePolicy: {
        ...salesTax,
        basisPoints: 100,
        collectionMode: 'withheld_from_recipient',
        id: 'fee:market:1',
        roundingMode: 'floor',
        taxType: 'marketplace_fee',
        treasuryWalletId: 'wallet:market-fees',
      },
      listing,
      quantityAtoms: 3n,
      taxPolicy: salesTax,
    });
    expect(decision).toMatchObject({
      fee: { amountMinor: 3n },
      grossMinor: 300n,
      tax: { amountMinor: 8n },
    });
    expect(decision.settlement.postings).toEqual([
      { signedAmountMinor: -308n, walletId: 'buyer-wallet' },
      { signedAmountMinor: 3n, walletId: 'wallet:market-fees' },
      { signedAmountMinor: 297n, walletId: 'wallet:seller' },
      { signedAmountMinor: 8n, walletId: 'wallet:treasury' },
    ]);
  });

  it('honors the compiler-pinned floor tax policy without implicit rounding', () => {
    expect(assessTax({ ...salesTax, roundingMode: 'floor' }, 300n)).toMatchObject({
      amountMinor: 7n,
      rounding: 'floor',
    });
  });

  it('partially fills once, computes server totals, and releases only the remainder', () => {
    const decision = decideMarketPurchase({
      buyerEntityId: 'character:buyer',
      buyerWalletId: 'wallet:buyer',
      currentTick: 10n,
      expectedListingVersion: 1n,
      listing,
      quantityAtoms: 3n,
      taxPolicy: salesTax,
    });
    expect(decision.grossMinor).toBe(300n);
    expect(decision.tax?.amountMinor).toBe(8n);
    expect(decision.remainingAtoms).toBe(7n);
    expect(decision.status).toBe('open');
    expect(() => assertBalancedTransaction(decision.settlement)).not.toThrow();
    expect(
      decideListingTerminal({
        currentTick: 20n,
        expectedVersion: 2n,
        listing: { ...listing, remainingAtoms: 7n, rowVersion: 2n },
        target: 'cancelled',
      }).releasedAtoms,
    ).toBe(7n);
  });

  it('rejects stale, expired, overfilled, and already-terminal purchases', () => {
    expectCode(
      () =>
        decideMarketPurchase({
          buyerEntityId: 'character:buyer',
          buyerWalletId: 'wallet:buyer',
          currentTick: 10n,
          expectedListingVersion: 2n,
          listing,
          quantityAtoms: 1n,
          taxPolicy: salesTax,
        }),
      ErrorCodes.listingStale,
    );
    expectCode(
      () =>
        decideMarketPurchase({
          buyerEntityId: 'character:buyer',
          buyerWalletId: 'wallet:buyer',
          currentTick: 100n,
          expectedListingVersion: 1n,
          listing,
          quantityAtoms: 1n,
          taxPolicy: salesTax,
        }),
      ErrorCodes.listingExpired,
    );
    expectCode(
      () =>
        decideMarketPurchase({
          buyerEntityId: 'character:buyer',
          buyerWalletId: 'wallet:buyer',
          currentTick: 10n,
          expectedListingVersion: 1n,
          listing,
          quantityAtoms: 11n,
          taxPolicy: salesTax,
        }),
      ErrorCodes.insufficientInventory,
    );
  });

  it('enforces bounded active work and exact payroll withholding', () => {
    const contract: EmploymentContractState = {
      activeFromTick: 1n,
      activeUntilTick: 1_000n,
      cooldownTicks: 5n,
      employerWalletId: 'wallet:employer',
      id: 'contract:worker',
      maxPerformancesPerPeriod: 2,
      periodTicks: 20n,
      rowVersion: 2n,
      status: 'active',
      wageMinor: 1_000n,
      workerWalletId: 'wallet:worker',
    };
    const payrollTax: TaxPolicyState = {
      ...salesTax,
      collectionMode: 'withheld_from_recipient',
      taxType: 'payroll',
    };
    expect(
      decideJobPerformance({
        contract,
        currentTick: 20n,
        lastPerformedTick: 10n,
        performancesInPeriod: 1,
        taxPolicy: payrollTax,
      }),
    ).toMatchObject({ grossMinor: 1_000n, netMinor: 975n });
    expectCode(
      () =>
        decideJobPerformance({
          contract,
          currentTick: 12n,
          lastPerformedTick: 10n,
          performancesInPeriod: 1,
          taxPolicy: payrollTax,
        }),
      ErrorCodes.jobCooldown,
    );
    expectCode(
      () =>
        decideJobPerformance({
          contract,
          currentTick: 20n,
          lastPerformedTick: 10n,
          performancesInPeriod: 2,
          taxPolicy: payrollTax,
        }),
      ErrorCodes.jobCapExceeded,
    );
    expect(() => assertEmploymentTransition('offered', 'active')).not.toThrow();
    expectCode(
      () => assertEmploymentTransition('ended', 'active'),
      ErrorCodes.contractStateInvalid,
    );
  });
});

describe('arithmetic overflow and conservation guards', () => {
  it('rejects unsupported quantity magnitude and balanced postings survive aggregation', () => {
    expectCode(
      () => addQuantity(999_999_999_999_999_999_999_999_999_999n, 1n),
      ErrorCodes.quantityInvalid,
    );
    const assessment = assessTax(salesTax, 1n);
    expect(assessment.amountMinor).toBe(0n);
  });
});
