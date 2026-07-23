import { ErrorCodes } from '@worldgraph/contracts';

import { assertInt64, assertNonNegativeInt64, assertPositiveInt64 } from './amount.js';
import { EconomyDomainError } from './errors.js';

export interface EconomyPosting {
  signedAmountMinor: bigint;
  walletId: string;
}

export interface EconomyTransactionDecision {
  postings: readonly EconomyPosting[];
  supplyDeltaMinor: bigint;
}

export interface ProjectedBalances {
  balances: ReadonlyMap<string, bigint>;
  supplyMinor: bigint;
}

export function sumPostings(postings: readonly EconomyPosting[]): bigint {
  let sum = 0n;
  for (const posting of postings) {
    assertInt64(posting.signedAmountMinor);
    if (posting.signedAmountMinor === 0n) {
      throw new EconomyDomainError(
        ErrorCodes.accountingUnbalanced,
        'Accounting postings may not be zero.',
      );
    }
    sum = assertInt64(sum + posting.signedAmountMinor);
  }
  return sum;
}

export function assertBalancedTransaction(
  decision: EconomyTransactionDecision,
): EconomyTransactionDecision {
  assertInt64(decision.supplyDeltaMinor);
  if (
    decision.postings.length === 0 ||
    sumPostings(decision.postings) !== decision.supplyDeltaMinor
  ) {
    throw new EconomyDomainError(
      ErrorCodes.accountingUnbalanced,
      'Posting sum must equal the explicit supply delta.',
    );
  }
  return decision;
}

export function createTransferDecision(
  sourceWalletId: string,
  destinationWalletId: string,
  amountMinor: bigint,
): EconomyTransactionDecision {
  assertPositiveInt64(amountMinor);
  if (sourceWalletId === destinationWalletId) {
    throw new EconomyDomainError(
      ErrorCodes.accountingUnbalanced,
      'A transfer requires two distinct wallets.',
    );
  }
  return assertBalancedTransaction({
    postings: [
      { signedAmountMinor: -amountMinor, walletId: sourceWalletId },
      { signedAmountMinor: amountMinor, walletId: destinationWalletId },
    ],
    supplyDeltaMinor: 0n,
  });
}

export function createIssuanceDecision(
  destinationWalletId: string,
  amountMinor: bigint,
): EconomyTransactionDecision {
  assertPositiveInt64(amountMinor);
  return assertBalancedTransaction({
    postings: [{ signedAmountMinor: amountMinor, walletId: destinationWalletId }],
    supplyDeltaMinor: amountMinor,
  });
}

export function projectAccountingDecision(input: {
  currentBalances: ReadonlyMap<string, bigint>;
  currentSupplyMinor: bigint;
  decision: EconomyTransactionDecision;
  maxSupplyMinor: bigint | null;
}): ProjectedBalances {
  assertBalancedTransaction(input.decision);
  const balances = new Map(input.currentBalances);
  for (const posting of input.decision.postings) {
    const current = balances.get(posting.walletId);
    if (current === undefined) {
      throw new EconomyDomainError(ErrorCodes.walletNotControlled, 'Posting wallet is unknown.');
    }
    const next = assertInt64(current + posting.signedAmountMinor);
    if (next < 0n) {
      throw new EconomyDomainError(
        ErrorCodes.insufficientFunds,
        'Wallet balance cannot be negative.',
      );
    }
    balances.set(posting.walletId, next);
  }
  const supplyMinor = assertNonNegativeInt64(
    assertInt64(input.currentSupplyMinor + input.decision.supplyDeltaMinor),
  );
  if (input.maxSupplyMinor !== null && supplyMinor > input.maxSupplyMinor) {
    throw new EconomyDomainError(ErrorCodes.supplyCapExceeded, 'Currency supply cap exceeded.');
  }
  return { balances, supplyMinor };
}
