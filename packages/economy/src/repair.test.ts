import { describe, expect, it } from 'vitest';

import { ErrorCodes, type EconomyRepairPlanBodyV1 } from '@worldgraph/contracts';

import { MIN_INT64 } from './amount.js';
import { EconomyDomainError } from './errors.js';
import {
  assertEconomyRepairPlanV1,
  createEconomyRepairPlanV1,
  deriveEconomyRepairDeltaV1,
  economyRepairPlanHashV1,
  type EconomyRepairDerivationInput,
} from './repair.js';

const id = (value: number): string => `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;

const WORLD_ID = id(1);
const SOURCE_COMMAND_ID = id(2);
const CURRENCY_ID = id(3);
const SOURCE_TRANSACTION_ID = id(4);
const COMPENSATION_TRANSACTION_ID = id(5);
const SOURCE_WALLET_ID = id(6);
const DESTINATION_WALLET_ID = id(7);
const ASSET_ID = id(8);
const SOURCE_TRANSFER_ID = id(9);
const COMPENSATION_TRANSFER_ID = id(10);
const SELLER_ENTITY_ID = id(11);
const BUYER_ENTITY_ID = id(12);
const SOURCE_TRANSFER_EVENT_ID = id(13);

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(EconomyDomainError);
    expect((error as EconomyDomainError).code).toBe(code);
  }
}

function cloneInput(input: EconomyRepairDerivationInput): EconomyRepairDerivationInput {
  return structuredClone(input);
}

function transferInput(): EconomyRepairDerivationInput {
  return {
    asset: null,
    assetTransfer: null,
    compensationTransactionId: COMPENSATION_TRANSACTION_ID,
    compensationTransferId: null,
    currency: { id: CURRENCY_ID, status: 'frozen', worldId: WORLD_ID },
    financialTransaction: {
      alreadyCompensated: false,
      commandId: SOURCE_COMMAND_ID,
      currencyId: CURRENCY_ID,
      id: SOURCE_TRANSACTION_ID,
      kind: 'transfer',
      postings: [
        {
          postingOrdinal: 1,
          signedAmountMinor: 300n,
          walletId: DESTINATION_WALLET_ID,
        },
        {
          postingOrdinal: 0,
          signedAmountMinor: -300n,
          walletId: SOURCE_WALLET_ID,
        },
      ],
      reversalOfTransactionId: null,
      supplyDeltaMinor: 0n,
      worldId: WORLD_ID,
    },
    openOfferExists: false,
    ownership: null,
    reconciliationMatched: true,
    repairKind: 'reverse_financial_transaction',
    sourceCommand: {
      id: SOURCE_COMMAND_ID,
      status: 'accepted',
      type: 'TransferCurrencyV1',
      worldId: WORLD_ID,
    },
    supply: {
      currencyId: CURRENCY_ID,
      currentSupplyMinor: 2_000n,
      maxSupplyMinor: 5_000n,
      rowVersion: 4n,
      worldId: WORLD_ID,
    },
    wallets: [
      {
        availableMinor: 1_300n,
        currencyId: CURRENCY_ID,
        id: DESTINATION_WALLET_ID,
        ownerEntityId: SELLER_ENTITY_ID,
        rowVersion: 4n,
        status: 'frozen',
        worldId: WORLD_ID,
      },
      {
        availableMinor: 700n,
        currencyId: CURRENCY_ID,
        id: SOURCE_WALLET_ID,
        ownerEntityId: BUYER_ENTITY_ID,
        rowVersion: 2n,
        status: 'active',
        worldId: WORLD_ID,
      },
    ],
    worldId: WORLD_ID,
  };
}

function issuanceInput(): EconomyRepairDerivationInput {
  const input = transferInput();
  input.currency = { id: CURRENCY_ID, status: 'active', worldId: WORLD_ID };
  input.financialTransaction = {
    alreadyCompensated: false,
    commandId: SOURCE_COMMAND_ID,
    currencyId: CURRENCY_ID,
    id: SOURCE_TRANSACTION_ID,
    kind: 'issuance',
    postings: [
      {
        postingOrdinal: 0,
        signedAmountMinor: 400n,
        walletId: DESTINATION_WALLET_ID,
      },
    ],
    reversalOfTransactionId: null,
    supplyDeltaMinor: 400n,
    worldId: WORLD_ID,
  };
  input.sourceCommand.type = 'IssueCurrencyV1';
  input.supply = {
    currencyId: CURRENCY_ID,
    currentSupplyMinor: 1_500n,
    maxSupplyMinor: 5_000n,
    rowVersion: 6n,
    worldId: WORLD_ID,
  };
  input.wallets = [
    {
      availableMinor: 500n,
      currencyId: CURRENCY_ID,
      id: DESTINATION_WALLET_ID,
      ownerEntityId: SELLER_ENTITY_ID,
      rowVersion: 8n,
      status: 'active',
      worldId: WORLD_ID,
    },
  ];
  return input;
}

function titleInput(): EconomyRepairDerivationInput {
  return {
    asset: { active: true, id: ASSET_ID, transferable: true, worldId: WORLD_ID },
    assetTransfer: {
      alreadyCompensated: false,
      assetId: ASSET_ID,
      commandId: SOURCE_COMMAND_ID,
      eventId: SOURCE_TRANSFER_EVENT_ID,
      financialTransactionId: null,
      fromOwnerEntityId: SELLER_ENTITY_ID,
      id: SOURCE_TRANSFER_ID,
      kind: 'grant',
      reversalOfTransferId: null,
      toOwnerEntityId: BUYER_ENTITY_ID,
      worldId: WORLD_ID,
    },
    compensationTransactionId: null,
    compensationTransferId: COMPENSATION_TRANSFER_ID,
    currency: null,
    financialTransaction: null,
    openOfferExists: false,
    ownership: {
      acquiredEventId: SOURCE_TRANSFER_EVENT_ID,
      assetId: ASSET_ID,
      ownerEntityId: BUYER_ENTITY_ID,
      ownershipVersion: 2n,
      worldId: WORLD_ID,
    },
    reconciliationMatched: true,
    repairKind: 'reverse_asset_transfer',
    sourceCommand: {
      id: SOURCE_COMMAND_ID,
      status: 'accepted',
      type: 'TransferAssetV1',
      worldId: WORLD_ID,
    },
    supply: null,
    wallets: [],
    worldId: WORLD_ID,
  };
}

function purchaseInput(): EconomyRepairDerivationInput {
  const input = transferInput();
  input.asset = { active: true, id: ASSET_ID, transferable: true, worldId: WORLD_ID };
  input.assetTransfer = {
    alreadyCompensated: false,
    assetId: ASSET_ID,
    commandId: SOURCE_COMMAND_ID,
    eventId: SOURCE_TRANSFER_EVENT_ID,
    financialTransactionId: SOURCE_TRANSACTION_ID,
    fromOwnerEntityId: SELLER_ENTITY_ID,
    id: SOURCE_TRANSFER_ID,
    kind: 'purchase',
    reversalOfTransferId: null,
    toOwnerEntityId: BUYER_ENTITY_ID,
    worldId: WORLD_ID,
  };
  input.compensationTransferId = COMPENSATION_TRANSFER_ID;
  input.currency = { id: CURRENCY_ID, status: 'active', worldId: WORLD_ID };
  input.financialTransaction = {
    ...input.financialTransaction!,
    kind: 'asset_purchase',
    postings: [
      { postingOrdinal: 0, signedAmountMinor: -250n, walletId: SOURCE_WALLET_ID },
      { postingOrdinal: 1, signedAmountMinor: 250n, walletId: DESTINATION_WALLET_ID },
    ],
  };
  input.ownership = {
    acquiredEventId: SOURCE_TRANSFER_EVENT_ID,
    assetId: ASSET_ID,
    ownerEntityId: BUYER_ENTITY_ID,
    ownershipVersion: 2n,
    worldId: WORLD_ID,
  };
  input.repairKind = 'reverse_asset_purchase';
  input.sourceCommand.type = 'AcceptAssetTransferOfferV1';
  input.wallets = [
    {
      availableMinor: 750n,
      currencyId: CURRENCY_ID,
      id: SOURCE_WALLET_ID,
      ownerEntityId: BUYER_ENTITY_ID,
      rowVersion: 5n,
      status: 'active',
      worldId: WORLD_ID,
    },
    {
      availableMinor: 1_250n,
      currencyId: CURRENCY_ID,
      id: DESTINATION_WALLET_ID,
      ownerEntityId: SELLER_ENTITY_ID,
      rowVersion: 7n,
      status: 'active',
      worldId: WORLD_ID,
    },
  ];
  return input;
}

describe('exact economy repair delta derivation', () => {
  it('reverses a transfer from immutable postings while permitting frozen repair state', () => {
    expect(deriveEconomyRepairDeltaV1(transferInput())).toEqual({
      financialDelta: {
        compensationTransactionId: COMPENSATION_TRANSACTION_ID,
        currencyId: CURRENCY_ID,
        postings: [
          {
            balanceAfterMinor: '1000',
            balanceBeforeMinor: '700',
            balanceVersionAfter: '3',
            balanceVersionBefore: '2',
            compensationSignedAmountMinor: '300',
            sourcePostingOrdinal: 0,
            sourceSignedAmountMinor: '-300',
            walletId: SOURCE_WALLET_ID,
          },
          {
            balanceAfterMinor: '1000',
            balanceBeforeMinor: '1300',
            balanceVersionAfter: '5',
            balanceVersionBefore: '4',
            compensationSignedAmountMinor: '-300',
            sourcePostingOrdinal: 1,
            sourceSignedAmountMinor: '300',
            walletId: DESTINATION_WALLET_ID,
          },
        ],
        reversalOfTransactionId: SOURCE_TRANSACTION_ID,
        supply: {
          compensationSupplyDeltaMinor: '0',
          currencyId: CURRENCY_ID,
          sourceSupplyDeltaMinor: '0',
          supplyAfterMinor: '2000',
          supplyBeforeMinor: '2000',
          supplyVersionAfter: '4',
          supplyVersionBefore: '4',
        },
      },
      repairKind: 'reverse_financial_transaction',
      titleDelta: null,
    });
  });

  it('reverses issuance with the exact negative posting and supply delta', () => {
    expect(deriveEconomyRepairDeltaV1(issuanceInput())).toEqual({
      financialDelta: {
        compensationTransactionId: COMPENSATION_TRANSACTION_ID,
        currencyId: CURRENCY_ID,
        postings: [
          {
            balanceAfterMinor: '100',
            balanceBeforeMinor: '500',
            balanceVersionAfter: '9',
            balanceVersionBefore: '8',
            compensationSignedAmountMinor: '-400',
            sourcePostingOrdinal: 0,
            sourceSignedAmountMinor: '400',
            walletId: DESTINATION_WALLET_ID,
          },
        ],
        reversalOfTransactionId: SOURCE_TRANSACTION_ID,
        supply: {
          compensationSupplyDeltaMinor: '-400',
          currencyId: CURRENCY_ID,
          sourceSupplyDeltaMinor: '400',
          supplyAfterMinor: '1100',
          supplyBeforeMinor: '1500',
          supplyVersionAfter: '7',
          supplyVersionBefore: '6',
        },
      },
      repairKind: 'reverse_financial_transaction',
      titleDelta: null,
    });
  });

  it('reverses only the latest owner gift with an inverse title fact', () => {
    expect(deriveEconomyRepairDeltaV1(titleInput())).toEqual({
      financialDelta: null,
      repairKind: 'reverse_asset_transfer',
      titleDelta: {
        assetId: ASSET_ID,
        compensationTransferId: COMPENSATION_TRANSFER_ID,
        fromOwnerEntityId: BUYER_ENTITY_ID,
        ownershipVersionAfter: '3',
        ownershipVersionBefore: '2',
        reversalOfTransferId: SOURCE_TRANSFER_ID,
        toOwnerEntityId: SELLER_ENTITY_ID,
      },
    });
  });

  it('atomically derives the exact payment refund and inverse purchase title', () => {
    expect(deriveEconomyRepairDeltaV1(purchaseInput())).toEqual({
      financialDelta: {
        compensationTransactionId: COMPENSATION_TRANSACTION_ID,
        currencyId: CURRENCY_ID,
        postings: [
          {
            balanceAfterMinor: '1000',
            balanceBeforeMinor: '750',
            balanceVersionAfter: '6',
            balanceVersionBefore: '5',
            compensationSignedAmountMinor: '250',
            sourcePostingOrdinal: 0,
            sourceSignedAmountMinor: '-250',
            walletId: SOURCE_WALLET_ID,
          },
          {
            balanceAfterMinor: '1000',
            balanceBeforeMinor: '1250',
            balanceVersionAfter: '8',
            balanceVersionBefore: '7',
            compensationSignedAmountMinor: '-250',
            sourcePostingOrdinal: 1,
            sourceSignedAmountMinor: '250',
            walletId: DESTINATION_WALLET_ID,
          },
        ],
        reversalOfTransactionId: SOURCE_TRANSACTION_ID,
        supply: {
          compensationSupplyDeltaMinor: '0',
          currencyId: CURRENCY_ID,
          sourceSupplyDeltaMinor: '0',
          supplyAfterMinor: '2000',
          supplyBeforeMinor: '2000',
          supplyVersionAfter: '4',
          supplyVersionBefore: '4',
        },
      },
      repairKind: 'reverse_asset_purchase',
      titleDelta: {
        assetId: ASSET_ID,
        compensationTransferId: COMPENSATION_TRANSFER_ID,
        fromOwnerEntityId: BUYER_ENTITY_ID,
        ownershipVersionAfter: '3',
        ownershipVersionBefore: '2',
        reversalOfTransferId: SOURCE_TRANSFER_ID,
        toOwnerEntityId: SELLER_ENTITY_ID,
      },
    });
  });
});

describe('economy repair rejection boundaries', () => {
  it.each([
    [
      'an unmatched reconciliation',
      (input: EconomyRepairDerivationInput) => {
        input.reconciliationMatched = false;
      },
    ],
    [
      'a rejected source command',
      (input: EconomyRepairDerivationInput) => {
        input.sourceCommand.status = 'rejected';
      },
    ],
    [
      'an ineligible source command type',
      (input: EconomyRepairDerivationInput) => {
        input.sourceCommand.type = 'InitializeWorldEconomyV1';
      },
    ],
    [
      'an already compensated source',
      (input: EconomyRepairDerivationInput) => {
        input.financialTransaction!.alreadyCompensated = true;
      },
    ],
    [
      'a compensation source transaction',
      (input: EconomyRepairDerivationInput) => {
        input.financialTransaction!.reversalOfTransactionId = id(99);
      },
    ],
    [
      'a retired currency',
      (input: EconomyRepairDerivationInput) => {
        input.currency!.status = 'retired';
      },
    ],
    [
      'a closed wallet',
      (input: EconomyRepairDerivationInput) => {
        input.wallets[0]!.status = 'closed';
      },
    ],
    [
      'a cross-world wallet',
      (input: EconomyRepairDerivationInput) => {
        input.wallets[0]!.worldId = id(98);
      },
    ],
    [
      'a noncontiguous posting ordinal',
      (input: EconomyRepairDerivationInput) => {
        input.financialTransaction!.postings[0]!.postingOrdinal = 2;
      },
    ],
    [
      'a duplicate posting wallet',
      (input: EconomyRepairDerivationInput) => {
        input.financialTransaction!.postings[0]!.walletId = SOURCE_WALLET_ID;
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const input = cloneInput(transferInput());
    mutate(input);
    expectCode(() => deriveEconomyRepairDeltaV1(input), ErrorCodes.validationFailed);
  });

  it('rejects an unbalanced immutable financial source', () => {
    const input = transferInput();
    input.financialTransaction!.postings[0]!.signedAmountMinor = 301n;
    expectCode(() => deriveEconomyRepairDeltaV1(input), ErrorCodes.accountingUnbalanced);
  });

  it('rejects a transfer refund that would overdraw the original receiver', () => {
    const input = transferInput();
    input.wallets[0]!.availableMinor = 299n;
    expectCode(() => deriveEconomyRepairDeltaV1(input), ErrorCodes.insufficientFunds);
  });

  it('rejects issuance reversal below zero supply', () => {
    const input = issuanceInput();
    input.supply!.currentSupplyMinor = 399n;
    expectCode(() => deriveEconomyRepairDeltaV1(input), ErrorCodes.invalidAmountFormat);
  });

  it('rejects signed 64-bit negation overflow before emitting a plan', () => {
    const input = transferInput();
    input.financialTransaction!.postings[1]!.signedAmountMinor = MIN_INT64;
    expectCode(() => deriveEconomyRepairDeltaV1(input), ErrorCodes.economyIntegerOverflow);
  });

  it.each([
    [
      'a stale current owner',
      (input: EconomyRepairDerivationInput) => {
        input.ownership!.ownerEntityId = SELLER_ENTITY_ID;
      },
    ],
    [
      'a later title fact',
      (input: EconomyRepairDerivationInput) => {
        input.ownership!.acquiredEventId = id(95);
      },
    ],
    [
      'an open offer',
      (input: EconomyRepairDerivationInput) => {
        input.openOfferExists = true;
      },
    ],
    [
      'a retired asset',
      (input: EconomyRepairDerivationInput) => {
        input.asset!.active = false;
      },
    ],
    [
      'a nontransferable asset',
      (input: EconomyRepairDerivationInput) => {
        input.asset!.transferable = false;
      },
    ],
    [
      'an already compensated transfer',
      (input: EconomyRepairDerivationInput) => {
        input.assetTransfer!.alreadyCompensated = true;
      },
    ],
    [
      'a grant with a hidden financial link',
      (input: EconomyRepairDerivationInput) => {
        input.assetTransfer!.financialTransactionId = id(97);
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const input = cloneInput(titleInput());
    mutate(input);
    expectCode(() => deriveEconomyRepairDeltaV1(input), ErrorCodes.validationFailed);
  });

  it('rejects a purchase whose title is not linked to its exact payment', () => {
    const input = purchaseInput();
    input.assetTransfer!.financialTransactionId = id(96);
    expectCode(() => deriveEconomyRepairDeltaV1(input), ErrorCodes.validationFailed);
  });

  it('rejects a purchase whose posting owners do not match buyer and seller', () => {
    const input = purchaseInput();
    input.wallets[0]!.ownerEntityId = SELLER_ENTITY_ID;
    expectCode(() => deriveEconomyRepairDeltaV1(input), ErrorCodes.validationFailed);
  });

  it('rejects mixed accounting inputs on title-only repairs and title inputs on financial-only repairs', () => {
    const title = titleInput();
    title.currency = { id: CURRENCY_ID, status: 'active', worldId: WORLD_ID };
    expectCode(() => deriveEconomyRepairDeltaV1(title), ErrorCodes.validationFailed);

    const financial = transferInput();
    financial.asset = { active: true, id: ASSET_ID, transferable: true, worldId: WORLD_ID };
    expectCode(() => deriveEconomyRepairDeltaV1(financial), ErrorCodes.validationFailed);
  });
});

describe('canonical economy repair plans', () => {
  function planBody(): EconomyRepairPlanBodyV1 {
    const delta = deriveEconomyRepairDeltaV1(purchaseInput());
    return {
      delta,
      domain: 'worldgraph.economy-repair-plan.v1',
      expiresAt: '2026-07-23T12:00:00.000Z',
      incidentReason: 'Duplicate purchase effect escaped command idempotency.',
      pitrNotUsedReason: 'The approved recovery objective cannot tolerate a world rollback.',
      preparedAt: '2026-07-22T12:00:00.000Z',
      preparedByUserId: id(20),
      reasonCode: 'DUPLICATE_EFFECT',
      repairKind: 'reverse_asset_purchase',
      repairPlanId: id(21),
      repairPlanSchemaVersion: 1,
      reservedCommandId: id(22),
      sourceCommandId: SOURCE_COMMAND_ID,
      sourceEconomyChecksum: 'a'.repeat(64),
      sourceEconomyHeadVersion: '9',
      sourceEventSequence: '81',
      sourceReconciliationRunId: id(23),
      sourceStateRevision: '47',
      sourceWorldVersion: '3',
      worldId: WORLD_ID,
    };
  }

  it('hashes only the validated canonical semantic body and verifies the sealed plan', () => {
    const body = planBody();
    const reordered = Object.fromEntries(
      Object.entries(body).reverse(),
    ) as unknown as EconomyRepairPlanBodyV1;
    const hash = economyRepairPlanHashV1(body);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(economyRepairPlanHashV1(reordered)).toBe(hash);

    const plan = createEconomyRepairPlanV1(body);
    expect(plan.planHash).toBe(hash);
    expect(assertEconomyRepairPlanV1(plan)).toBe(plan);
  });

  it('treats repair reasons as 8-500 Unicode code points and preserves non-ASCII spacing', () => {
    const astralBody = {
      ...planBody(),
      incidentReason: '😀'.repeat(300),
      pitrNotUsedReason: '\u00a0nonbreaking edge space\u00a0',
    };
    expect(createEconomyRepairPlanV1(astralBody).incidentReason).toBe('😀'.repeat(300));

    for (const incidentReason of [
      '😀'.repeat(501),
      ' leading ASCII space',
      'trailing ASCII space ',
      'embedded C0\u001fcontrol',
      'embedded DEL\u007fcontrol',
      'embedded C1\u0085control',
    ]) {
      expect(() => createEconomyRepairPlanV1({ ...planBody(), incidentReason })).toThrow(TypeError);
    }
  });

  it('rejects a changed semantic body, non-24-hour expiry, mismatched kind, and arbitrary fields', () => {
    const plan = createEconomyRepairPlanV1(planBody());
    expectCode(
      () =>
        assertEconomyRepairPlanV1({
          ...plan,
          incidentReason: 'A different incident reason that was never approved.',
        }),
      ErrorCodes.validationFailed,
    );

    expectCode(
      () =>
        economyRepairPlanHashV1({
          ...planBody(),
          expiresAt: '2026-07-23T12:00:01.000Z',
        }),
      ErrorCodes.validationFailed,
    );
    expectCode(
      () =>
        economyRepairPlanHashV1({
          ...planBody(),
          repairKind: 'reverse_asset_transfer',
        }),
      ErrorCodes.validationFailed,
    );
    const duplicateCompensationId = planBody();
    duplicateCompensationId.delta.titleDelta!.compensationTransferId =
      duplicateCompensationId.delta.financialDelta!.compensationTransactionId;
    expectCode(() => economyRepairPlanHashV1(duplicateCompensationId), ErrorCodes.validationFailed);
    expect(() =>
      economyRepairPlanHashV1({ ...planBody(), requestedAmountMinor: '1' } as never),
    ).toThrow(TypeError);
  });
});
