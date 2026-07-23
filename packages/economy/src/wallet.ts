import { ErrorCodes, type CurrencyStatus, type WalletStatus } from '@worldgraph/contracts';

import {
  createIssuanceDecision,
  createTransferDecision,
  projectAccountingDecision,
  type EconomyTransactionDecision,
} from './accounting.js';
import { assertPositiveInt64 } from './amount.js';
import { EconomyDomainError } from './errors.js';

export interface WalletDecisionState {
  availableMinor: bigint;
  controlledByActor: boolean;
  currencyId: string;
  id: string;
  rowVersion: bigint;
  status: WalletStatus;
  worldId: string;
}

export interface CurrencyDecisionState {
  currentSupplyMinor: bigint;
  id: string;
  maxSupplyMinor: bigint | null;
  rowVersion: bigint;
  status: CurrencyStatus;
  worldId: string;
}

export interface TransferCurrencyDecision {
  destinationBalanceMinor: bigint;
  sourceBalanceMinor: bigint;
  transaction: EconomyTransactionDecision;
}

export function decideCurrencyTransfer(input: {
  amountMinor: bigint;
  currency: CurrencyDecisionState;
  destination: WalletDecisionState;
  expectedDestinationVersion: bigint;
  expectedSourceVersion: bigint;
  source: WalletDecisionState;
}): TransferCurrencyDecision {
  assertPositiveInt64(input.amountMinor);
  if (input.currency.status !== 'active') {
    throw new EconomyDomainError(ErrorCodes.currencyFrozen, 'Currency is not active.');
  }
  if (input.source.status !== 'active' || input.destination.status !== 'active') {
    throw new EconomyDomainError(ErrorCodes.walletFrozen, 'Both transfer wallets must be active.');
  }
  if (!input.source.controlledByActor) {
    throw new EconomyDomainError(
      ErrorCodes.walletNotControlled,
      'Actor does not control the source wallet owner.',
    );
  }
  if (
    input.source.worldId !== input.destination.worldId ||
    input.source.worldId !== input.currency.worldId ||
    input.source.currencyId !== input.destination.currencyId ||
    input.source.currencyId !== input.currency.id
  ) {
    throw new EconomyDomainError(
      ErrorCodes.currencyMismatch,
      'Transfer wallets must share the active world and currency.',
    );
  }
  if (
    input.source.rowVersion !== input.expectedSourceVersion ||
    input.destination.rowVersion !== input.expectedDestinationVersion
  ) {
    throw new EconomyDomainError(ErrorCodes.staleVersion, 'Wallet version is stale.');
  }
  const transaction = createTransferDecision(
    input.source.id,
    input.destination.id,
    input.amountMinor,
  );
  const projected = projectAccountingDecision({
    currentBalances: new Map([
      [input.source.id, input.source.availableMinor],
      [input.destination.id, input.destination.availableMinor],
    ]),
    currentSupplyMinor: input.currency.currentSupplyMinor,
    decision: transaction,
    maxSupplyMinor: input.currency.maxSupplyMinor,
  });
  return {
    destinationBalanceMinor: projected.balances.get(input.destination.id)!,
    sourceBalanceMinor: projected.balances.get(input.source.id)!,
    transaction,
  };
}

export function decideCurrencyIssuance(input: {
  amountMinor: bigint;
  currency: CurrencyDecisionState;
  expectedSupplyVersion: bigint;
  treasury: WalletDecisionState;
}): { resultingSupplyMinor: bigint; transaction: EconomyTransactionDecision } {
  assertPositiveInt64(input.amountMinor);
  if (input.currency.status !== 'active') {
    throw new EconomyDomainError(ErrorCodes.currencyFrozen, 'Currency is not active.');
  }
  if (input.treasury.status !== 'active') {
    throw new EconomyDomainError(ErrorCodes.walletFrozen, 'Treasury wallet is not active.');
  }
  if (
    input.treasury.worldId !== input.currency.worldId ||
    input.treasury.currencyId !== input.currency.id
  ) {
    throw new EconomyDomainError(
      ErrorCodes.currencyMismatch,
      'Treasury wallet does not belong to the currency.',
    );
  }
  if (input.currency.rowVersion !== input.expectedSupplyVersion) {
    throw new EconomyDomainError(ErrorCodes.staleVersion, 'Currency supply version is stale.');
  }
  const transaction = createIssuanceDecision(input.treasury.id, input.amountMinor);
  const projected = projectAccountingDecision({
    currentBalances: new Map([[input.treasury.id, input.treasury.availableMinor]]),
    currentSupplyMinor: input.currency.currentSupplyMinor,
    decision: transaction,
    maxSupplyMinor: input.currency.maxSupplyMinor,
  });
  return { resultingSupplyMinor: projected.supplyMinor, transaction };
}

export function decideCurrencyStatusChange(
  current: CurrencyStatus,
  requested: 'active' | 'frozen',
): CurrencyStatus {
  if (current === 'retired' || current === requested) {
    throw new EconomyDomainError(ErrorCodes.staleVersion, 'Currency status transition is invalid.');
  }
  return requested;
}

export function decideWalletStatusChange(
  current: WalletStatus,
  requested: 'active' | 'frozen',
): WalletStatus {
  if (current === 'closed' || current === requested) {
    throw new EconomyDomainError(ErrorCodes.staleVersion, 'Wallet status transition is invalid.');
  }
  return requested;
}
