import { ErrorCodes } from '@worldgraph/contracts';

import type { EconomyTransactionDecision } from './accounting.js';
import { EconomyDomainError } from './errors.js';
import { priceQuantityMinor } from './quantity.js';
import {
  assessTax,
  createWithholdingSettlement,
  type TaxAssessmentDecision,
  type TaxPolicyState,
} from './tax.js';

export type MarketListingStatus = 'open' | 'filled' | 'cancelled' | 'expired';

export interface MarketListingState {
  currencyId: string;
  expiresAtTick: bigint;
  id: string;
  quantityScale: number;
  remainingAtoms: bigint;
  rowVersion: bigint;
  sellerEntityId: string;
  sellerWalletId: string;
  status: MarketListingStatus;
  unitPriceMinor: bigint;
  worldId: string;
}

export interface MarketPurchaseDecision {
  fee: TaxAssessmentDecision | null;
  grossMinor: bigint;
  listingVersion: bigint;
  remainingAtoms: bigint;
  settlement: EconomyTransactionDecision;
  status: 'filled' | 'open';
  tax: TaxAssessmentDecision | null;
}

export function decideMarketPurchase(input: {
  buyerEntityId: string;
  buyerWalletId: string;
  currentTick: bigint;
  expectedListingVersion: bigint;
  listing: MarketListingState;
  quantityAtoms: bigint;
  feePolicy?: TaxPolicyState | null;
  taxPolicy: TaxPolicyState | null;
}): MarketPurchaseDecision {
  const { listing } = input;
  if (listing.status !== 'open') {
    throw new EconomyDomainError(ErrorCodes.listingNotOpen, 'Listing is not open.');
  }
  if (input.currentTick >= listing.expiresAtTick) {
    throw new EconomyDomainError(ErrorCodes.listingExpired, 'Listing has expired.');
  }
  if (listing.rowVersion !== input.expectedListingVersion) {
    throw new EconomyDomainError(ErrorCodes.listingStale, 'Listing version is stale.');
  }
  if (input.quantityAtoms <= 0n || input.quantityAtoms > listing.remainingAtoms) {
    throw new EconomyDomainError(
      ErrorCodes.insufficientInventory,
      'Purchase quantity exceeds the listing remainder.',
    );
  }
  const grossMinor = priceQuantityMinor(
    input.quantityAtoms,
    listing.quantityScale,
    listing.unitPriceMinor,
  );
  const tax = input.taxPolicy ? assessTax(input.taxPolicy, grossMinor) : null;
  const fee = input.feePolicy ? assessTax(input.feePolicy, grossMinor) : null;
  if (
    fee &&
    (fee.taxType !== 'marketplace_fee' || fee.collectionMode !== 'withheld_from_recipient')
  ) {
    throw new EconomyDomainError(
      ErrorCodes.policyInvalid,
      'Marketplace fees must be withheld from recipient proceeds.',
    );
  }
  const remainingAtoms = listing.remainingAtoms - input.quantityAtoms;
  return {
    fee,
    grossMinor,
    listingVersion: listing.rowVersion + 1n,
    remainingAtoms,
    settlement: createWithholdingSettlement({
      grossMinor,
      ...(fee ? { feeMinor: fee.amountMinor, feeWalletId: fee.treasuryWalletId } : {}),
      payeeWalletId: listing.sellerWalletId,
      payerWalletId: input.buyerWalletId,
      tax,
    }),
    status: remainingAtoms === 0n ? 'filled' : 'open',
    tax,
  };
}

export function decideListingTerminal(input: {
  currentTick: bigint;
  expectedVersion: bigint;
  listing: MarketListingState;
  target: 'cancelled' | 'expired';
}): { releasedAtoms: bigint; rowVersion: bigint; status: 'cancelled' | 'expired' } {
  if (input.listing.status !== 'open') {
    throw new EconomyDomainError(ErrorCodes.listingNotOpen, 'Listing is already terminal.');
  }
  if (input.listing.rowVersion !== input.expectedVersion) {
    throw new EconomyDomainError(ErrorCodes.listingStale, 'Listing version is stale.');
  }
  if (input.target === 'expired' && input.currentTick < input.listing.expiresAtTick) {
    throw new EconomyDomainError(ErrorCodes.conflict, 'Listing is not due for expiry.');
  }
  return {
    releasedAtoms: input.listing.remainingAtoms,
    rowVersion: input.listing.rowVersion + 1n,
    status: input.target,
  };
}
