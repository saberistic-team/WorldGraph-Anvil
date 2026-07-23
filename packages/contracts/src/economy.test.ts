import { describe, expect, it } from 'vitest';

import {
  EconomyCommandRequestV1Schema,
  EconomyReconciliationDocumentV1Schema,
  EconomySeedPlanV1Schema,
  EconomySeedTaxPolicyV1Schema,
  IssueCurrencyV1Schema,
  PublicEconomyCommandRequestV1Schema,
} from './economy.js';
import { createValidator } from './validation.js';

const uuid = '018f8652-3cb6-7d52-904b-cce7901d7e25';

const commandBase = {
  commandId: uuid,
  expectedAggregateVersion: '0',
  expectedStateRevision: '0',
  expectedWorldVersion: '1',
  idempotencyKey: 'economy-command-0001',
  schemaVersion: 1,
};

describe('economy contracts', () => {
  it('discriminates percentage and periodic seed tax policy shapes', () => {
    const common = {
      authorityEntityLogicalKey: 'institution:guild-council',
      effectiveFromTick: '0',
      effectiveUntilTick: null,
      primitiveContentHash: 'a'.repeat(64),
      primitiveKey: 'worldgraph.tax.flat-transaction-levy',
      primitiveRef: 'transaction-tax',
      primitiveVersion: '1.0.0',
      primitiveVersionId: uuid,
      roundingMode: 'floor',
      stableKey: 'tax-policy:guild-council:test',
      status: 'active',
      taxPolicySchemaVersion: 1,
      treasuryWalletStableKey: 'wallet:treasury:gcr',
    };
    const validator = createValidator(EconomySeedTaxPolicyV1Schema);
    const sales = {
      ...common,
      collectionMode: 'added_to_payer',
      rateBps: 250,
      taxType: 'sales',
    };
    expect(validator.is(sales)).toBe(true);
    expect(
      validator.is({
        ...sales,
        collectionMode: 'withheld_from_recipient',
        taxType: 'transaction',
      }),
    ).toBe(true);
    expect(
      validator.is({
        ...sales,
        collectionMode: 'withheld_from_recipient',
        taxType: 'payroll',
      }),
    ).toBe(true);
    expect(
      validator.is({
        ...sales,
        collectionMode: 'withheld_from_recipient',
        taxType: 'marketplace_fee',
      }),
    ).toBe(true);
    expect(validator.is({ ...sales, collectionMode: 'added_to_payer', taxType: 'payroll' })).toBe(
      false,
    );

    const periodic = {
      ...common,
      collectionMode: 'added_to_payer',
      fixedAmountMinor: '10',
      intervalTicks: '5',
      payerEntityLogicalKey: 'organization:energy-guild',
      payerWalletStableKey: 'wallet:organization:energy-guild:gcr',
      taxType: 'periodic_flat',
    };
    expect(validator.is(periodic)).toBe(true);
    expect(validator.is({ ...periodic, rateBps: 250 })).toBe(false);
    expect(validator.is({ ...periodic, collectionMode: 'withheld_from_recipient' })).toBe(false);
  });

  it('accepts only the exact code-owned M08 seed asset shape', () => {
    const plan = {
      assets: [
        {
          assetSchemaVersion: 1,
          assetType: 'founding_seal',
          initialOwnerEntityLogicalKey: 'character:member-a',
          metadata: {
            displayName: 'Founding Seal',
            provenance: 'compiler-economy-adapter-v1',
          },
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
      initialSupplyMinor: '10000',
      wallets: [
        {
          initialBalanceMinor: '10000',
          ownerEntityLogicalKey: 'character:member-a',
          stableKey: 'wallet:player:character:member-a:gcr',
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
    const validator = createValidator(EconomySeedPlanV1Schema);
    expect(validator.is(plan)).toBe(true);
    expect(
      validator.is({
        ...plan,
        assets: [{ ...plan.assets[0], assetType: 'invented_asset' }],
      }),
    ).toBe(false);
    expect(validator.is({ ...plan, wallets: [plan.wallets[1]] })).toBe(false);
  });

  it('keeps scheduler expiry out of the public command union', () => {
    const expiry = {
      ...commandBase,
      payload: { expectedOfferVersion: '1', expectedTick: '42', offerId: uuid },
      type: 'ExpireAssetTransferOfferV1',
    };
    expect(createValidator(EconomyCommandRequestV1Schema).is(expiry)).toBe(true);
    expect(createValidator(PublicEconomyCommandRequestV1Schema).is(expiry)).toBe(false);
  });

  it('requires the explicit virtual issuance confirmation phrase', () => {
    const issuance = {
      ...commandBase,
      payload: {
        amount: '10.00',
        confirmation: 'ISSUE VIRTUAL CURRENCY',
        expectedSupplyVersion: '1',
        reason: 'Founding operations allocation',
        treasuryWalletId: uuid,
      },
      type: 'IssueCurrencyV1',
    };
    const validator = createValidator(IssueCurrencyV1Schema);
    expect(validator.is(issuance)).toBe(true);
    expect(
      validator.is({ ...issuance, payload: { ...issuance.payload, confirmation: 'yes' } }),
    ).toBe(false);
  });

  it('publishes an exact versioned reconciliation checksum document', () => {
    const document = {
      domain: 'worldgraph.economy-reconciliation.v1',
      economyReconciliationSchemaVersion: 1,
      ownership: [
        {
          assetKey: 'asset:founding-seal',
          ownerEntityLogicalKey: 'character:member-a',
          ownershipVersion: '1',
        },
      ],
      supply: [{ currencyKey: 'currency:gcr', currentSupplyMinor: '10000' }],
      wallets: [{ availableMinor: '10000', walletId: uuid }],
    };
    const validator = createValidator(EconomyReconciliationDocumentV1Schema);
    expect(validator.is(document)).toBe(true);
    expect(validator.is({ ...document, generatedAt: 'ambient-time' })).toBe(false);
  });
});
