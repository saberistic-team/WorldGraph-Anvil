import { ErrorCodes } from '@worldgraph/contracts';

import type { EconomyTransactionDecision } from './accounting.js';
import { EconomyDomainError } from './errors.js';
import {
  assessTax,
  createWithholdingSettlement,
  type TaxAssessmentDecision,
  type TaxPolicyState,
} from './tax.js';

export type EmploymentContractStatus = 'offered' | 'active' | 'ended' | 'cancelled';

export interface EmploymentContractState {
  activeFromTick: bigint;
  activeUntilTick: bigint;
  cooldownTicks: bigint;
  employerWalletId: string;
  id: string;
  maxPerformancesPerPeriod: number;
  periodTicks: bigint;
  rowVersion: bigint;
  status: EmploymentContractStatus;
  wageMinor: bigint;
  workerWalletId: string;
}

export function assertEmploymentTransition(
  current: EmploymentContractStatus,
  target: EmploymentContractStatus,
): void {
  const allowed: Readonly<Record<EmploymentContractStatus, readonly EmploymentContractStatus[]>> = {
    active: ['ended'],
    cancelled: [],
    ended: [],
    offered: ['active', 'cancelled'],
  };
  if (!allowed[current].includes(target)) {
    throw new EconomyDomainError(
      ErrorCodes.contractStateInvalid,
      `Employment contract cannot transition from ${current} to ${target}.`,
    );
  }
}

export function decideJobPerformance(input: {
  contract: EmploymentContractState;
  currentTick: bigint;
  lastPerformedTick: bigint | null;
  performancesInPeriod: number;
  taxPolicy: TaxPolicyState | null;
}): {
  grossMinor: bigint;
  netMinor: bigint;
  settlement: EconomyTransactionDecision;
  tax: TaxAssessmentDecision | null;
} {
  const { contract } = input;
  if (
    contract.status !== 'active' ||
    input.currentTick < contract.activeFromTick ||
    input.currentTick > contract.activeUntilTick
  ) {
    throw new EconomyDomainError(ErrorCodes.contractStateInvalid, 'Contract is not active now.');
  }
  if (
    input.lastPerformedTick !== null &&
    input.currentTick - input.lastPerformedTick < contract.cooldownTicks
  ) {
    throw new EconomyDomainError(ErrorCodes.jobCooldown, 'Job cooldown has not elapsed.');
  }
  if (input.performancesInPeriod >= contract.maxPerformancesPerPeriod) {
    throw new EconomyDomainError(ErrorCodes.jobCapExceeded, 'Job period cap has been reached.');
  }
  const tax = input.taxPolicy ? assessTax(input.taxPolicy, contract.wageMinor) : null;
  const taxMinor = tax?.amountMinor ?? 0n;
  return {
    grossMinor: contract.wageMinor,
    netMinor:
      tax?.collectionMode === 'added_to_payer' ? contract.wageMinor : contract.wageMinor - taxMinor,
    settlement: createWithholdingSettlement({
      grossMinor: contract.wageMinor,
      payeeWalletId: contract.workerWalletId,
      payerWalletId: contract.employerWalletId,
      tax,
    }),
    tax,
  };
}
