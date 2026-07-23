import { createHash } from 'node:crypto';

import {
  EconomyRepairDeltaV1Schema,
  EconomyRepairPlanBodyV1Schema,
  EconomyRepairPlanV1Schema,
  ErrorCodes,
  canonicalJson,
  createValidator,
  type AssetTransferKind,
  type CurrencyStatus,
  type EconomyRepairDeltaV1,
  type EconomyRepairFinancialDeltaV1,
  type EconomyRepairKind,
  type EconomyRepairPlanBodyV1,
  type EconomyRepairPlanV1,
  type EconomyRepairTitleDeltaV1,
  type FinancialTransactionKind,
  type Validator,
  type WalletStatus,
} from '@worldgraph/contracts';

import {
  assertBalancedTransaction,
  projectAccountingDecision,
  type EconomyPosting,
} from './accounting.js';
import { assertInt64, assertNonNegativeInt64, assertPositiveInt64 } from './amount.js';
import { EconomyDomainError } from './errors.js';

export interface EconomyRepairSourceCommandState {
  id: string;
  status: 'accepted' | 'failed' | 'received' | 'rejected';
  type: string;
  worldId: string;
}

export interface EconomyRepairSourcePostingState extends EconomyPosting {
  postingOrdinal: number;
}

export interface EconomyRepairSourceFinancialTransactionState {
  alreadyCompensated: boolean;
  commandId: string;
  currencyId: string;
  id: string;
  kind: FinancialTransactionKind;
  postings: readonly EconomyRepairSourcePostingState[];
  reversalOfTransactionId: string | null;
  supplyDeltaMinor: bigint;
  worldId: string;
}

export interface EconomyRepairCurrencyState {
  id: string;
  status: CurrencyStatus;
  worldId: string;
}

export interface EconomyRepairWalletState {
  availableMinor: bigint;
  currencyId: string;
  id: string;
  ownerEntityId: string;
  rowVersion: bigint;
  status: WalletStatus;
  worldId: string;
}

export interface EconomyRepairSupplyState {
  currencyId: string;
  currentSupplyMinor: bigint;
  maxSupplyMinor: bigint | null;
  rowVersion: bigint;
  worldId: string;
}

export interface EconomyRepairAssetState {
  active: boolean;
  id: string;
  transferable: boolean;
  worldId: string;
}

export interface EconomyRepairSourceAssetTransferState {
  alreadyCompensated: boolean;
  assetId: string;
  commandId: string;
  eventId: string;
  financialTransactionId: string | null;
  fromOwnerEntityId: string | null;
  id: string;
  kind: AssetTransferKind;
  reversalOfTransferId: string | null;
  toOwnerEntityId: string;
  worldId: string;
}

export interface EconomyRepairOwnershipState {
  acquiredEventId: string;
  assetId: string;
  ownerEntityId: string;
  ownershipVersion: bigint;
  worldId: string;
}

/**
 * Complete, already-locked source state for a V1 repair decision. Random IDs,
 * wall time, database access, and authority are deliberately outside this pure boundary.
 */
export interface EconomyRepairDerivationInput {
  asset: EconomyRepairAssetState | null;
  assetTransfer: EconomyRepairSourceAssetTransferState | null;
  compensationTransactionId: string | null;
  compensationTransferId: string | null;
  currency: EconomyRepairCurrencyState | null;
  financialTransaction: EconomyRepairSourceFinancialTransactionState | null;
  openOfferExists: boolean;
  ownership: EconomyRepairOwnershipState | null;
  reconciliationMatched: boolean;
  repairKind: EconomyRepairKind;
  sourceCommand: EconomyRepairSourceCommandState;
  supply: EconomyRepairSupplyState | null;
  wallets: readonly EconomyRepairWalletState[];
  worldId: string;
}

interface DerivedFinancialDelta {
  delta: EconomyRepairFinancialDeltaV1;
  sourcePostings: readonly EconomyRepairSourcePostingState[];
  walletsById: ReadonlyMap<string, EconomyRepairWalletState>;
}

const deltaValidator: Validator<EconomyRepairDeltaV1> = createValidator<EconomyRepairDeltaV1>(
  EconomyRepairDeltaV1Schema,
);
const planBodyValidator: Validator<EconomyRepairPlanBodyV1> =
  createValidator<EconomyRepairPlanBodyV1>(EconomyRepairPlanBodyV1Schema);
const planValidator: Validator<EconomyRepairPlanV1> =
  createValidator<EconomyRepairPlanV1>(EconomyRepairPlanV1Schema);

function invalidSource(message: string): never {
  throw new EconomyDomainError(ErrorCodes.validationFailed, message);
}

function assertCommonSource(
  input: EconomyRepairDerivationInput,
  expectedCommandTypes: readonly string[],
): void {
  if (!input.reconciliationMatched) {
    invalidSource('Economy repair requires a matched reconciliation snapshot.');
  }
  if (
    input.sourceCommand.status !== 'accepted' ||
    input.sourceCommand.worldId !== input.worldId ||
    !expectedCommandTypes.includes(input.sourceCommand.type)
  ) {
    invalidSource('Economy repair source command is not an eligible accepted world fact.');
  }
}

function nextPositiveVersion(value: bigint): bigint {
  assertPositiveInt64(value);
  return assertPositiveInt64(assertInt64(value + 1n));
}

function negateNonZero(value: bigint): bigint {
  assertInt64(value);
  if (value === 0n) invalidSource('A repair posting cannot reverse a zero posting.');
  return assertInt64(-value);
}

function sourcePostings(
  transaction: EconomyRepairSourceFinancialTransactionState,
): readonly EconomyRepairSourcePostingState[] {
  const postings = [...transaction.postings].sort(
    (left, right) => left.postingOrdinal - right.postingOrdinal,
  );
  if (postings.length < 1 || postings.length > 2) {
    invalidSource('A V1 repair source transaction must contain one or two postings.');
  }
  const walletIds = new Set<string>();
  for (const [ordinal, posting] of postings.entries()) {
    if (!Number.isInteger(posting.postingOrdinal) || posting.postingOrdinal !== ordinal) {
      invalidSource('Source posting ordinals must be exact and contiguous.');
    }
    if (walletIds.has(posting.walletId)) {
      invalidSource('Source postings must address distinct wallets.');
    }
    walletIds.add(posting.walletId);
    negateNonZero(posting.signedAmountMinor);
  }
  assertBalancedTransaction({
    postings,
    supplyDeltaMinor: transaction.supplyDeltaMinor,
  });
  return postings;
}

function assertFinancialSourceShape(
  commandType: string,
  transaction: EconomyRepairSourceFinancialTransactionState,
  postings: readonly EconomyRepairSourcePostingState[],
): void {
  const negative = postings.filter((posting) => posting.signedAmountMinor < 0n);
  const positive = postings.filter((posting) => posting.signedAmountMinor > 0n);
  if (commandType === 'IssueCurrencyV1') {
    if (
      transaction.kind !== 'issuance' ||
      transaction.supplyDeltaMinor <= 0n ||
      postings.length !== 1 ||
      postings[0]?.signedAmountMinor !== transaction.supplyDeltaMinor
    ) {
      invalidSource('Issuance repair requires the exact positive issuance fact.');
    }
    return;
  }
  const expectedKind: FinancialTransactionKind =
    commandType === 'AcceptAssetTransferOfferV1' ? 'asset_purchase' : 'transfer';
  if (
    transaction.kind !== expectedKind ||
    transaction.supplyDeltaMinor !== 0n ||
    postings.length !== 2 ||
    negative.length !== 1 ||
    positive.length !== 1 ||
    negative[0]!.signedAmountMinor !== -positive[0]!.signedAmountMinor
  ) {
    invalidSource('Transfer repair requires the exact zero-supply two-posting fact.');
  }
}

function walletsById(
  input: EconomyRepairDerivationInput,
  transaction: EconomyRepairSourceFinancialTransactionState,
  postings: readonly EconomyRepairSourcePostingState[],
): ReadonlyMap<string, EconomyRepairWalletState> {
  if (input.wallets.length !== postings.length) {
    invalidSource('Repair wallet state must cover exactly the source posting wallets.');
  }
  const states = new Map<string, EconomyRepairWalletState>();
  for (const wallet of input.wallets) {
    if (
      states.has(wallet.id) ||
      wallet.worldId !== input.worldId ||
      wallet.currencyId !== transaction.currencyId ||
      wallet.status === 'closed'
    ) {
      invalidSource('Repair wallet state is duplicated, closed, or outside source scope.');
    }
    assertNonNegativeInt64(wallet.availableMinor);
    assertPositiveInt64(wallet.rowVersion);
    states.set(wallet.id, wallet);
  }
  for (const posting of postings) {
    if (!states.has(posting.walletId)) {
      invalidSource('A source posting wallet is missing from repair state.');
    }
  }
  return states;
}

function deriveFinancialDelta(
  input: EconomyRepairDerivationInput,
  expectedCommandTypes: readonly string[],
): DerivedFinancialDelta {
  assertCommonSource(input, expectedCommandTypes);
  const transaction = input.financialTransaction;
  const currency = input.currency;
  const supply = input.supply;
  const compensationTransactionId = input.compensationTransactionId;
  if (!transaction || !currency || !supply || !compensationTransactionId) {
    invalidSource(
      'Financial repair requires its source transaction, currency, supply, and reserved ID.',
    );
  }
  if (
    transaction.worldId !== input.worldId ||
    transaction.commandId !== input.sourceCommand.id ||
    transaction.reversalOfTransactionId !== null ||
    transaction.alreadyCompensated ||
    transaction.id === compensationTransactionId ||
    currency.worldId !== input.worldId ||
    currency.id !== transaction.currencyId ||
    currency.status === 'retired' ||
    supply.worldId !== input.worldId ||
    supply.currencyId !== transaction.currencyId
  ) {
    invalidSource('Financial repair source identity or reversal state is invalid.');
  }
  assertNonNegativeInt64(supply.currentSupplyMinor);
  assertPositiveInt64(supply.rowVersion);
  if (supply.maxSupplyMinor !== null) assertNonNegativeInt64(supply.maxSupplyMinor);

  const postings = sourcePostings(transaction);
  assertFinancialSourceShape(input.sourceCommand.type, transaction, postings);
  const states = walletsById(input, transaction, postings);
  const decision = {
    postings: postings.map((posting) => ({
      signedAmountMinor: negateNonZero(posting.signedAmountMinor),
      walletId: posting.walletId,
    })),
    supplyDeltaMinor: assertInt64(-transaction.supplyDeltaMinor),
  };
  const projected = projectAccountingDecision({
    currentBalances: new Map(
      [...states.values()].map((wallet) => [wallet.id, wallet.availableMinor] as const),
    ),
    currentSupplyMinor: supply.currentSupplyMinor,
    decision,
    maxSupplyMinor: supply.maxSupplyMinor,
  });
  const delta: EconomyRepairFinancialDeltaV1 = {
    compensationTransactionId,
    currencyId: transaction.currencyId,
    postings: postings.map((posting) => {
      const wallet = states.get(posting.walletId)!;
      return {
        balanceAfterMinor: projected.balances.get(wallet.id)!.toString(),
        balanceBeforeMinor: wallet.availableMinor.toString(),
        balanceVersionAfter: nextPositiveVersion(wallet.rowVersion).toString(),
        balanceVersionBefore: wallet.rowVersion.toString(),
        compensationSignedAmountMinor: negateNonZero(posting.signedAmountMinor).toString(),
        sourcePostingOrdinal: posting.postingOrdinal,
        sourceSignedAmountMinor: posting.signedAmountMinor.toString(),
        walletId: wallet.id,
      };
    }),
    reversalOfTransactionId: transaction.id,
    supply: {
      compensationSupplyDeltaMinor: decision.supplyDeltaMinor.toString(),
      currencyId: transaction.currencyId,
      sourceSupplyDeltaMinor: transaction.supplyDeltaMinor.toString(),
      supplyAfterMinor: projected.supplyMinor.toString(),
      supplyBeforeMinor: supply.currentSupplyMinor.toString(),
      supplyVersionAfter:
        decision.supplyDeltaMinor === 0n
          ? supply.rowVersion.toString()
          : nextPositiveVersion(supply.rowVersion).toString(),
      supplyVersionBefore: supply.rowVersion.toString(),
    },
  };
  return { delta, sourcePostings: postings, walletsById: states };
}

function deriveTitleDelta(
  input: EconomyRepairDerivationInput,
  expectedCommandType: 'AcceptAssetTransferOfferV1' | 'TransferAssetV1',
): EconomyRepairTitleDeltaV1 {
  assertCommonSource(input, [expectedCommandType]);
  const asset = input.asset;
  const transfer = input.assetTransfer;
  const ownership = input.ownership;
  const compensationTransferId = input.compensationTransferId;
  if (!asset || !transfer || !ownership || !compensationTransferId) {
    invalidSource(
      'Title repair requires its source transfer, current title, asset, and reserved ID.',
    );
  }
  const expectedTransferKind: AssetTransferKind =
    expectedCommandType === 'AcceptAssetTransferOfferV1' ? 'purchase' : 'grant';
  if (
    transfer.worldId !== input.worldId ||
    transfer.commandId !== input.sourceCommand.id ||
    transfer.kind !== expectedTransferKind ||
    (expectedCommandType === 'TransferAssetV1' && transfer.financialTransactionId !== null) ||
    transfer.fromOwnerEntityId === null ||
    transfer.fromOwnerEntityId === transfer.toOwnerEntityId ||
    transfer.reversalOfTransferId !== null ||
    transfer.alreadyCompensated ||
    transfer.id === compensationTransferId ||
    asset.worldId !== input.worldId ||
    asset.id !== transfer.assetId ||
    !asset.active ||
    !asset.transferable ||
    ownership.worldId !== input.worldId ||
    ownership.assetId !== transfer.assetId ||
    ownership.ownerEntityId !== transfer.toOwnerEntityId ||
    ownership.acquiredEventId !== transfer.eventId ||
    input.openOfferExists
  ) {
    invalidSource('Title repair requires the latest transferable title with no open offer.');
  }
  assertPositiveInt64(ownership.ownershipVersion);
  return {
    assetId: transfer.assetId,
    compensationTransferId,
    fromOwnerEntityId: transfer.toOwnerEntityId,
    ownershipVersionAfter: nextPositiveVersion(ownership.ownershipVersion).toString(),
    ownershipVersionBefore: ownership.ownershipVersion.toString(),
    reversalOfTransferId: transfer.id,
    toOwnerEntityId: transfer.fromOwnerEntityId,
  };
}

function assertFinancialOnlyInput(input: EconomyRepairDerivationInput): void {
  if (
    input.asset !== null ||
    input.assetTransfer !== null ||
    input.compensationTransferId !== null ||
    input.ownership !== null ||
    input.openOfferExists
  ) {
    invalidSource('Financial-only repair cannot carry title inputs.');
  }
}

function assertTitleOnlyInput(input: EconomyRepairDerivationInput): void {
  if (
    input.compensationTransactionId !== null ||
    input.currency !== null ||
    input.financialTransaction !== null ||
    input.supply !== null ||
    input.wallets.length !== 0
  ) {
    invalidSource('Title-only repair cannot carry accounting inputs.');
  }
}

/** Derives only the exact inverse of one eligible accepted source command. */
export function deriveEconomyRepairDeltaV1(
  input: EconomyRepairDerivationInput,
): EconomyRepairDeltaV1 {
  let delta: EconomyRepairDeltaV1;
  switch (input.repairKind) {
    case 'reverse_financial_transaction': {
      assertFinancialOnlyInput(input);
      const financial = deriveFinancialDelta(input, ['IssueCurrencyV1', 'TransferCurrencyV1']);
      delta = {
        financialDelta: financial.delta,
        repairKind: input.repairKind,
        titleDelta: null,
      };
      break;
    }
    case 'reverse_asset_transfer':
      assertTitleOnlyInput(input);
      delta = {
        financialDelta: null,
        repairKind: input.repairKind,
        titleDelta: deriveTitleDelta(input, 'TransferAssetV1'),
      };
      break;
    case 'reverse_asset_purchase': {
      const financial = deriveFinancialDelta(input, ['AcceptAssetTransferOfferV1']);
      const title = deriveTitleDelta(input, 'AcceptAssetTransferOfferV1');
      const transfer = input.assetTransfer!;
      const transaction = input.financialTransaction!;
      const negative = financial.sourcePostings.find((posting) => posting.signedAmountMinor < 0n);
      const positive = financial.sourcePostings.find((posting) => posting.signedAmountMinor > 0n);
      if (
        transfer.financialTransactionId !== transaction.id ||
        negative === undefined ||
        positive === undefined ||
        financial.walletsById.get(negative.walletId)?.ownerEntityId !== transfer.toOwnerEntityId ||
        financial.walletsById.get(positive.walletId)?.ownerEntityId !== transfer.fromOwnerEntityId
      ) {
        invalidSource('Purchase repair requires its exact buyer payment and seller receipt.');
      }
      delta = {
        financialDelta: financial.delta,
        repairKind: input.repairKind,
        titleDelta: title,
      };
      break;
    }
  }
  deltaValidator.assert(delta);
  return delta;
}

function assertBoundedReason(value: string, field: string): void {
  const codePointLength = [...value].length;
  let containsControlCharacter = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      containsControlCharacter = true;
      break;
    }
  }
  if (
    codePointLength < 8 ||
    codePointLength > 500 ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    containsControlCharacter
  ) {
    invalidSource(
      `${field} must contain 8-500 Unicode code points without edge ASCII spaces or controls.`,
    );
  }
}

function assertPlanBodySemantics(plan: EconomyRepairPlanBodyV1): void {
  assertBoundedReason(plan.incidentReason, 'Incident reason');
  assertBoundedReason(plan.pitrNotUsedReason, 'PITR decision reason');
  if (plan.repairKind !== plan.delta.repairKind) {
    invalidSource('Repair plan kind must match its exact semantic delta.');
  }
  const preparedAt = Date.parse(plan.preparedAt);
  const expiresAt = Date.parse(plan.expiresAt);
  if (
    !Number.isFinite(preparedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - preparedAt !== 86_400_000
  ) {
    invalidSource('Repair plan expiry must be exactly 24 hours after preparation.');
  }
  if (
    plan.repairPlanId === plan.reservedCommandId ||
    plan.repairPlanId === plan.sourceCommandId ||
    plan.reservedCommandId === plan.sourceCommandId
  ) {
    invalidSource('Repair plan and command identities must be distinct.');
  }
  const compensationTransactionId = plan.delta.financialDelta?.compensationTransactionId;
  const compensationTransferId = plan.delta.titleDelta?.compensationTransferId;
  const reservedIdentities = new Set([
    plan.repairPlanId,
    plan.reservedCommandId,
    plan.sourceCommandId,
  ]);
  if (
    (compensationTransactionId !== undefined &&
      reservedIdentities.has(compensationTransactionId)) ||
    (compensationTransferId !== undefined && reservedIdentities.has(compensationTransferId)) ||
    (compensationTransactionId !== undefined &&
      compensationTransactionId === compensationTransferId)
  ) {
    invalidSource('Reserved compensation identities must be unique to this repair plan.');
  }
}

export function economyRepairPlanHashV1(plan: EconomyRepairPlanBodyV1): string {
  planBodyValidator.assert(plan);
  assertPlanBodySemantics(plan);
  return createHash('sha256')
    .update(
      canonicalJson({
        domain: 'worldgraph.economy-repair-plan-hash.v1',
        plan,
      }),
      'utf8',
    )
    .digest('hex');
}

export function createEconomyRepairPlanV1(plan: EconomyRepairPlanBodyV1): EconomyRepairPlanV1 {
  const complete = { ...plan, planHash: economyRepairPlanHashV1(plan) };
  planValidator.assert(complete);
  return complete;
}

export function assertEconomyRepairPlanV1(plan: EconomyRepairPlanV1): EconomyRepairPlanV1 {
  planValidator.assert(plan);
  const { planHash, ...body } = plan;
  if (economyRepairPlanHashV1(body) !== planHash) {
    invalidSource('Repair plan hash does not match its canonical semantic body.');
  }
  return plan;
}
