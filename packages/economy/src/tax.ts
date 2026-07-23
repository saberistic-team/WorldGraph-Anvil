import { ErrorCodes } from '@worldgraph/contracts';

import {
  assertBalancedTransaction,
  type EconomyPosting,
  type EconomyTransactionDecision,
} from './accounting.js';
import { assertNonNegativeInt64, assertPositiveInt64 } from './amount.js';
import { EconomyDomainError } from './errors.js';

export type TaxType = 'flat_periodic' | 'marketplace_fee' | 'payroll' | 'sales' | 'transaction';

export interface TaxPolicyState {
  basisPoints: number | null;
  collectionMode: 'added_to_payer' | 'withheld_from_recipient';
  fixedMinor: bigint | null;
  id: string;
  roundingMode: 'floor' | 'half_up';
  status: 'active' | 'disabled';
  taxType: TaxType;
  treasuryWalletId: string;
}

export interface TaxAssessmentDecision {
  amountMinor: bigint;
  basisMinor: bigint;
  collectionMode: 'added_to_payer' | 'withheld_from_recipient';
  policyId: string;
  rounding: 'floor' | 'half_up';
  taxType: TaxType;
  treasuryWalletId: string;
}

export function assessTax(policy: TaxPolicyState, basisMinor: bigint): TaxAssessmentDecision {
  assertNonNegativeInt64(basisMinor);
  if (
    policy.status !== 'active' ||
    (policy.basisPoints === null) === (policy.fixedMinor === null) ||
    (policy.basisPoints !== null &&
      (!Number.isSafeInteger(policy.basisPoints) ||
        policy.basisPoints < 0 ||
        policy.basisPoints > 5_000)) ||
    (policy.fixedMinor !== null && policy.fixedMinor < 0n)
  ) {
    throw new EconomyDomainError(ErrorCodes.policyInvalid, 'Tax policy is invalid or inactive.');
  }
  if (policy.roundingMode !== 'floor' && policy.roundingMode !== 'half_up') {
    throw new EconomyDomainError(ErrorCodes.policyInvalid, 'Tax rounding policy is invalid.');
  }
  const numerator = policy.basisPoints === null ? null : basisMinor * BigInt(policy.basisPoints);
  const amountMinor =
    numerator === null
      ? assertNonNegativeInt64(policy.fixedMinor!)
      : assertNonNegativeInt64(
          (numerator + (policy.roundingMode === 'half_up' ? 5_000n : 0n)) / 10_000n,
        );
  if (amountMinor > basisMinor && policy.taxType !== 'flat_periodic') {
    throw new EconomyDomainError(
      ErrorCodes.policyInvalid,
      'Withheld tax cannot exceed the source amount.',
    );
  }
  return {
    amountMinor,
    basisMinor,
    collectionMode: policy.collectionMode,
    policyId: policy.id,
    rounding: policy.roundingMode,
    taxType: policy.taxType,
    treasuryWalletId: policy.treasuryWalletId,
  };
}

export function createWithholdingSettlement(input: {
  feeMinor?: bigint;
  feeWalletId?: string | null;
  grossMinor: bigint;
  payerWalletId: string;
  payeeWalletId: string;
  tax: TaxAssessmentDecision | null;
}): EconomyTransactionDecision {
  assertPositiveInt64(input.grossMinor);
  const taxMinor = input.tax?.amountMinor ?? 0n;
  const feeMinor = assertNonNegativeInt64(input.feeMinor ?? 0n);
  if (input.tax?.collectionMode !== 'added_to_payer' && taxMinor + feeMinor >= input.grossMinor) {
    throw new EconomyDomainError(
      ErrorCodes.policyInvalid,
      'Tax and fee must leave positive seller or worker proceeds.',
    );
  }
  if (input.payerWalletId === input.payeeWalletId) {
    throw new EconomyDomainError(ErrorCodes.conflict, 'Payer and payee wallets must differ.');
  }
  const totals = new Map<string, bigint>();
  const add = (walletId: string, amount: bigint): void => {
    totals.set(walletId, (totals.get(walletId) ?? 0n) + amount);
  };
  const payerTotal =
    input.tax?.collectionMode === 'added_to_payer' ? input.grossMinor + taxMinor : input.grossMinor;
  const payeeNet =
    input.tax?.collectionMode === 'added_to_payer'
      ? input.grossMinor - feeMinor
      : input.grossMinor - taxMinor - feeMinor;
  assertPositiveInt64(payerTotal);
  assertPositiveInt64(payeeNet);
  add(input.payerWalletId, -payerTotal);
  add(input.payeeWalletId, payeeNet);
  if (taxMinor > 0n) add(input.tax!.treasuryWalletId, taxMinor);
  if (feeMinor > 0n) {
    if (!input.feeWalletId) {
      throw new EconomyDomainError(ErrorCodes.policyInvalid, 'A positive fee requires a wallet.');
    }
    add(input.feeWalletId, feeMinor);
  }
  const postings: EconomyPosting[] = [...totals.entries()]
    .filter(([, amount]) => amount !== 0n)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([walletId, signedAmountMinor]) => ({ signedAmountMinor, walletId }));
  return assertBalancedTransaction({ postings, supplyDeltaMinor: 0n });
}
