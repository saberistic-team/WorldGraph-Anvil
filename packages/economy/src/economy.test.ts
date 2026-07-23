import { describe, expect, it } from 'vitest';

import {
  ErrorCodes,
  type EconomySeedPlanV1,
  type EconomySeedTaxPolicyV1,
} from '@worldgraph/contracts';

import {
  EconomyDomainError,
  MAX_INT64,
  assertBalancedTransaction,
  assertEconomySeedPlanV1,
  assertNonOverlappingEconomySeedTaxPolicies,
  createIssuanceDecision,
  createTransferDecision,
  decideAcceptAssetTransferOffer,
  decideAssetGift,
  decideCurrencyTransfer,
  deterministicEconomyLockOrder,
  deterministicWalletLockOrder,
  economySeedPlanHash,
  economyStateChecksum,
  formatMinorAmount,
  parseCanonicalAmount,
  rebuildEconomyState,
  reconcileEconomyState,
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

const seedPlan: EconomySeedPlanV1 = {
  assets: [
    {
      assetSchemaVersion: 1,
      assetType: 'founding_seal',
      initialOwnerEntityLogicalKey: 'character:member-a',
      metadata: { displayName: 'Founding Seal', provenance: 'compiler-economy-adapter-v1' },
      stableKey: 'asset:founding-seal',
      transferable: true,
      worldEntityLogicalKey: null,
    },
  ],
  currency: {
    cashOutAllowed: false,
    code: 'GCR',
    currencySchemaVersion: 1,
    issuerEntityLogicalKey: 'institution:guild-council',
    maxSupplyMinor: '10000000000',
    minorUnitScale: 2,
    name: 'Guild Credits',
    noCashValue: true,
    stableKey: 'currency:gcr',
  },
  economySeedPlanSchemaVersion: 1,
  initialSupplyMinor: '20000',
  wallets: [
    {
      initialBalanceMinor: '10000',
      ownerEntityLogicalKey: 'character:member-a',
      stableKey: 'wallet:player:character:member-a:gcr',
      walletKind: 'player',
      walletSchemaVersion: 1,
    },
    {
      initialBalanceMinor: '10000',
      ownerEntityLogicalKey: 'character:member-b',
      stableKey: 'wallet:player:character:member-b:gcr',
      walletKind: 'player',
      walletSchemaVersion: 1,
    },
    {
      initialBalanceMinor: '0',
      ownerEntityLogicalKey: 'institution:guild-council',
      stableKey: 'wallet:treasury:gcr',
      walletKind: 'treasury',
      walletSchemaVersion: 1,
    },
  ],
};

describe('canonical fixed-point amounts', () => {
  it('requires exact scale and rejects signs, exponent, ambiguity, zero, and overflow', () => {
    expect(parseCanonicalAmount('25.00', 2)).toBe(2_500n);
    for (const value of ['25', '25.0', '025.00', '+25.00', '-25.00', '2.5e1', '0.00']) {
      expectCode(() => parseCanonicalAmount(value, 2), ErrorCodes.invalidAmountFormat);
    }
    expectCode(
      () => parseCanonicalAmount('92233720368547758.08', 2),
      ErrorCodes.economyIntegerOverflow,
    );
  });

  it('round-trips deterministic generated values at every supported scale', () => {
    let state = 0x1357_2468n;
    for (let index = 0; index < 2_000; index += 1) {
      state = (state * 1_103_515_245n + 12_345n) & 0x7fff_ffffn;
      const value = (state % 1_000_000_000n) + 1n;
      const scale = index % 7;
      expect(parseCanonicalAmount(formatMinorAmount(value, scale), scale)).toBe(value);
    }
    expect(formatMinorAmount(MAX_INT64, 6)).toBe('9223372036854.775807');
  });
});

describe('accounting and wallet decisions', () => {
  it('enforces posting sum = supply delta and preserves transfer supply', () => {
    expect(createTransferDecision('wallet-a', 'wallet-b', 2_500n)).toEqual({
      postings: [
        { signedAmountMinor: -2_500n, walletId: 'wallet-a' },
        { signedAmountMinor: 2_500n, walletId: 'wallet-b' },
      ],
      supplyDeltaMinor: 0n,
    });
    expect(createIssuanceDecision('treasury', 100n).supplyDeltaMinor).toBe(100n);
    expectCode(
      () =>
        assertBalancedTransaction({
          postings: [{ signedAmountMinor: 5n, walletId: 'wallet-a' }],
          supplyDeltaMinor: 0n,
        }),
      ErrorCodes.accountingUnbalanced,
    );
  });

  it('never permits generated transfer sequences to overdraw or change supply', () => {
    let left = 10_000n;
    let right = 10_000n;
    for (let index = 1; index <= 1_000; index += 1) {
      const sourceIsLeft = index % 2 === 0;
      const available = sourceIsLeft ? left : right;
      const amount = BigInt((index % 97) + 1);
      if (amount > available) continue;
      const source = {
        availableMinor: available,
        controlledByActor: true,
        currencyId: 'currency',
        id: sourceIsLeft ? 'left' : 'right',
        rowVersion: 1n,
        status: 'active' as const,
        worldId: 'world',
      };
      const destination = {
        ...source,
        availableMinor: sourceIsLeft ? right : left,
        controlledByActor: false,
        id: sourceIsLeft ? 'right' : 'left',
      };
      const decision = decideCurrencyTransfer({
        amountMinor: amount,
        currency: {
          currentSupplyMinor: 20_000n,
          id: 'currency',
          maxSupplyMinor: 1_000_000n,
          rowVersion: 1n,
          status: 'active',
          worldId: 'world',
        },
        destination,
        expectedDestinationVersion: 1n,
        expectedSourceVersion: 1n,
        source,
      });
      if (sourceIsLeft) {
        left = decision.sourceBalanceMinor;
        right = decision.destinationBalanceMinor;
      } else {
        right = decision.sourceBalanceMinor;
        left = decision.destinationBalanceMinor;
      }
      expect(left).toBeGreaterThanOrEqual(0n);
      expect(right).toBeGreaterThanOrEqual(0n);
      expect(left + right).toBe(20_000n);
    }
  });
});

describe('ownership and offers', () => {
  const asset = {
    active: true,
    controlledByActor: true,
    id: 'asset',
    ownerEntityLogicalKey: 'character:seller',
    ownershipVersion: 1n,
    transferable: true,
    worldId: 'world',
  } as const;

  it('advances title once for a grant', () => {
    expect(
      decideAssetGift({
        asset,
        expectedOwnershipVersion: 1n,
        recipientEntityLogicalKey: 'character:buyer',
      }),
    ).toEqual({
      fromOwnerEntityLogicalKey: 'character:seller',
      ownershipVersion: 2n,
      toOwnerEntityLogicalKey: 'character:buyer',
    });
  });

  it('atomically decides exact payment and title for an open unexpired offer', () => {
    const decision = decideAcceptAssetTransferOffer({
      asset: { ...asset, controlledByActor: false },
      buyerEntityLogicalKey: 'character:buyer',
      buyerWalletId: 'buyer-wallet',
      currentTick: 9n,
      expectedOfferVersion: 1n,
      expectedOwnershipVersion: 1n,
      offer: {
        assetId: 'asset',
        buyerEntityLogicalKey: 'character:buyer',
        currencyId: 'currency',
        expiresAtTick: 10n,
        id: 'offer',
        priceMinor: 1_000n,
        rowVersion: 1n,
        sellerEntityLogicalKey: 'character:seller',
        sellerWalletId: 'seller-wallet',
        status: 'open',
        worldId: 'world',
      },
    });
    expect(decision.status).toBe('accepted');
    expect(decision.payment).toEqual(
      createTransferDecision('buyer-wallet', 'seller-wallet', 1_000n),
    );
    expect(decision.ownership.toOwnerEntityLogicalKey).toBe('character:buyer');
  });
});

describe('locks, seed plan, and reconciliation', () => {
  it('sorts and de-duplicates locks independently of request order', () => {
    expect(deterministicWalletLockOrder(['b', 'a', 'b'])).toEqual(['a', 'b']);
    expect(
      deterministicEconomyLockOrder([
        { id: 'b', kind: 'wallet' },
        { id: 'z', kind: 'offer' },
        { id: 'a', kind: 'asset' },
        { id: 'a', kind: 'wallet' },
      ]),
    ).toEqual([
      { id: 'z', kind: 'offer' },
      { id: 'a', kind: 'asset' },
      { id: 'a', kind: 'wallet' },
      { id: 'b', kind: 'wallet' },
    ]);
  });

  it('hashes the validated semantic seed plan without ambient provenance', () => {
    expect(assertEconomySeedPlanV1(seedPlan)).toBe(seedPlan);
    expect(economySeedPlanHash(seedPlan)).toMatch(/^[a-f0-9]{64}$/u);
    expect(economySeedPlanHash(structuredClone(seedPlan))).toBe(economySeedPlanHash(seedPlan));
    expectCode(
      () =>
        assertEconomySeedPlanV1({
          ...seedPlan,
          initialSupplyMinor: '19999',
        }),
      ErrorCodes.seedPlanIncompatible,
    );
  });

  it('rejects overlapping active tax windows only for one identical semantic scope', () => {
    const provenance = {
      authorityEntityLogicalKey: 'institution:guild-council',
      primitiveContentHash: '11'.repeat(32),
      primitiveKey: 'worldgraph.tax.test',
      primitiveRef: 'tax-test',
      primitiveVersion: '1.0.0',
      primitiveVersionId: '018f0000-0000-7000-8000-000000000701',
      roundingMode: 'floor' as const,
      status: 'active' as const,
      taxPolicySchemaVersion: 1 as const,
      treasuryWalletStableKey: 'wallet:treasury:gcr',
    };
    const sales: Extract<EconomySeedTaxPolicyV1, { taxType: 'sales' }> = {
      ...provenance,
      collectionMode: 'added_to_payer',
      effectiveFromTick: '0',
      effectiveUntilTick: '10',
      rateBps: 250,
      stableKey: 'tax-policy:guild-council:sales-a',
      taxType: 'sales',
    };
    const adjacent = {
      ...sales,
      effectiveFromTick: '10',
      effectiveUntilTick: null,
      stableKey: 'tax-policy:guild-council:sales-b',
    };
    expect(() =>
      assertNonOverlappingEconomySeedTaxPolicies([sales, adjacent]),
    ).not.toThrow();
    expectCode(
      () =>
        assertNonOverlappingEconomySeedTaxPolicies([
          sales,
          {
            ...adjacent,
            effectiveFromTick: '9',
          },
        ]),
      ErrorCodes.seedPlanIncompatible,
    );

    const periodic: Extract<EconomySeedTaxPolicyV1, { taxType: 'periodic_flat' }> = {
      ...provenance,
      collectionMode: 'added_to_payer',
      effectiveFromTick: '0',
      effectiveUntilTick: null,
      fixedAmountMinor: '10',
      intervalTicks: '5',
      payerEntityLogicalKey: 'organization:energy-guild',
      payerWalletStableKey: 'wallet:organization:energy-guild:gcr',
      stableKey: 'tax-policy:guild-council:dues-a',
      taxType: 'periodic_flat',
    };
    expectCode(
      () =>
        assertNonOverlappingEconomySeedTaxPolicies([
          periodic,
          {
            ...periodic,
            effectiveFromTick: '5',
            effectiveUntilTick: '20',
            intervalTicks: '7',
            stableKey: 'tax-policy:guild-council:dues-b',
          },
        ]),
      ErrorCodes.seedPlanIncompatible,
    );
    expect(() =>
      assertNonOverlappingEconomySeedTaxPolicies([
        periodic,
        {
          ...periodic,
          payerEntityLogicalKey: 'organization:artisan-guild',
          payerWalletStableKey: 'wallet:organization:artisan-guild:gcr',
          stableKey: 'tax-policy:guild-council:artisan-dues',
        },
      ]),
    ).not.toThrow();
  });

  it('rebuilds exact projections and detects a one-minor-unit corruption', () => {
    const rebuilt = rebuildEconomyState({
      accountingFacts: [
        {
          currencyKey: 'currency:gcr',
          postings: [
            { signedAmountMinor: 10_000n, walletId: 'a' },
            { signedAmountMinor: 10_000n, walletId: 'b' },
          ],
          sequence: 1n,
          supplyDeltaMinor: 20_000n,
          transactionId: 'init',
        },
        {
          currencyKey: 'currency:gcr',
          postings: [
            { signedAmountMinor: -2_500n, walletId: 'a' },
            { signedAmountMinor: 2_500n, walletId: 'b' },
          ],
          sequence: 2n,
          supplyDeltaMinor: 0n,
          transactionId: 'transfer',
        },
      ],
      ownershipFacts: [
        {
          assetKey: 'asset:founding-seal',
          ownerEntityLogicalKey: 'character:a',
          ownershipVersion: 1n,
          sequence: 1n,
        },
        {
          assetKey: 'asset:founding-seal',
          ownerEntityLogicalKey: 'character:b',
          ownershipVersion: 2n,
          sequence: 2n,
        },
      ],
    });
    expect(rebuilt.walletBalances.get('a')).toBe(7_500n);
    expect(rebuilt.walletBalances.get('b')).toBe(12_500n);
    expect(reconcileEconomyState(rebuilt, rebuilt).mismatches).toEqual([]);
    const corrupt = {
      ...rebuilt,
      walletBalances: new Map(rebuilt.walletBalances).set('a', 7_501n),
    };
    expect(reconcileEconomyState(rebuilt, corrupt).mismatches).toEqual([
      { actual: '7501', expected: '7500', key: 'a', kind: 'wallet_balance' },
    ]);
    expect(economyStateChecksum(rebuilt)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
