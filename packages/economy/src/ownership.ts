import { ErrorCodes, type AssetTransferOfferStatus } from '@worldgraph/contracts';

import { createTransferDecision, type EconomyTransactionDecision } from './accounting.js';
import { assertPositiveInt64 } from './amount.js';
import { EconomyDomainError } from './errors.js';

export interface AssetDecisionState {
  active: boolean;
  controlledByActor: boolean;
  id: string;
  ownerEntityLogicalKey: string;
  ownershipVersion: bigint;
  transferable: boolean;
  worldId: string;
}

export interface AssetOfferDecisionState {
  assetId: string;
  buyerEntityLogicalKey: string | null;
  currencyId: string;
  expiresAtTick: bigint;
  id: string;
  priceMinor: bigint;
  rowVersion: bigint;
  sellerEntityLogicalKey: string;
  sellerWalletId: string;
  status: AssetTransferOfferStatus;
  worldId: string;
}

export interface OwnershipTransferDecision {
  fromOwnerEntityLogicalKey: string;
  ownershipVersion: bigint;
  toOwnerEntityLogicalKey: string;
}

function assertTransferableOwnedAsset(
  asset: AssetDecisionState,
  expectedVersion: bigint,
  requireControl = true,
): void {
  if (!asset.active || !asset.transferable) {
    throw new EconomyDomainError(ErrorCodes.assetNotTransferable, 'Asset is not transferable.');
  }
  if (requireControl && !asset.controlledByActor) {
    throw new EconomyDomainError(
      ErrorCodes.assetNotOwned,
      'Actor does not control the asset owner.',
    );
  }
  if (asset.ownershipVersion !== expectedVersion) {
    throw new EconomyDomainError(ErrorCodes.ownershipConflict, 'Ownership version is stale.');
  }
}

export function decideAssetGift(input: {
  asset: AssetDecisionState;
  expectedOwnershipVersion: bigint;
  recipientEntityLogicalKey: string;
}): OwnershipTransferDecision {
  assertTransferableOwnedAsset(input.asset, input.expectedOwnershipVersion);
  if (input.asset.ownerEntityLogicalKey === input.recipientEntityLogicalKey) {
    throw new EconomyDomainError(ErrorCodes.ownershipConflict, 'Recipient already owns the asset.');
  }
  return {
    fromOwnerEntityLogicalKey: input.asset.ownerEntityLogicalKey,
    ownershipVersion: input.asset.ownershipVersion + 1n,
    toOwnerEntityLogicalKey: input.recipientEntityLogicalKey,
  };
}

export function decideCreateAssetTransferOffer(input: {
  asset: AssetDecisionState;
  currentTick: bigint;
  expectedOwnershipVersion: bigint;
  expiresAtTick: bigint;
  priceMinor: bigint;
}): void {
  assertTransferableOwnedAsset(input.asset, input.expectedOwnershipVersion);
  assertPositiveInt64(input.priceMinor);
  if (input.expiresAtTick <= input.currentTick) {
    throw new EconomyDomainError(ErrorCodes.offerExpired, 'Offer expiry must be in the future.');
  }
}

export function decideCancelAssetTransferOffer(input: {
  actorControlsSeller: boolean;
  expectedOfferVersion: bigint;
  offer: AssetOfferDecisionState;
}): 'cancelled' {
  if (!input.actorControlsSeller) {
    throw new EconomyDomainError(ErrorCodes.assetNotOwned, 'Actor does not control the seller.');
  }
  assertOpenOffer(input.offer, input.expectedOfferVersion);
  return 'cancelled';
}

export function decideExpireAssetTransferOffer(input: {
  currentTick: bigint;
  expectedOfferVersion: bigint;
  offer: AssetOfferDecisionState;
}): 'expired' {
  assertOpenOffer(input.offer, input.expectedOfferVersion);
  if (input.currentTick < input.offer.expiresAtTick) {
    throw new EconomyDomainError(ErrorCodes.offerNotDue, 'Offer is not due for expiry.');
  }
  return 'expired';
}

function assertOpenOffer(offer: AssetOfferDecisionState, expectedOfferVersion: bigint): void {
  if (offer.status !== 'open') {
    throw new EconomyDomainError(ErrorCodes.offerNotOpen, 'Offer is not open.');
  }
  if (offer.rowVersion !== expectedOfferVersion) {
    throw new EconomyDomainError(ErrorCodes.staleVersion, 'Offer version is stale.');
  }
}

export function decideAcceptAssetTransferOffer(input: {
  asset: AssetDecisionState;
  buyerEntityLogicalKey: string;
  buyerWalletId: string;
  currentTick: bigint;
  expectedOfferVersion: bigint;
  expectedOwnershipVersion: bigint;
  offer: AssetOfferDecisionState;
}): {
  ownership: OwnershipTransferDecision;
  payment: EconomyTransactionDecision;
  status: 'accepted';
} {
  assertOpenOffer(input.offer, input.expectedOfferVersion);
  if (input.currentTick >= input.offer.expiresAtTick) {
    throw new EconomyDomainError(ErrorCodes.offerExpired, 'Offer has expired.');
  }
  if (
    input.offer.buyerEntityLogicalKey !== null &&
    input.offer.buyerEntityLogicalKey !== input.buyerEntityLogicalKey
  ) {
    throw new EconomyDomainError(ErrorCodes.buyerMismatch, 'Offer targets a different buyer.');
  }
  assertTransferableOwnedAsset(input.asset, input.expectedOwnershipVersion, false);
  if (
    input.asset.id !== input.offer.assetId ||
    input.asset.worldId !== input.offer.worldId ||
    input.asset.ownerEntityLogicalKey !== input.offer.sellerEntityLogicalKey
  ) {
    throw new EconomyDomainError(ErrorCodes.ownershipConflict, 'Seller no longer owns the asset.');
  }
  if (input.buyerEntityLogicalKey === input.offer.sellerEntityLogicalKey) {
    throw new EconomyDomainError(ErrorCodes.buyerMismatch, 'Seller cannot accept their own offer.');
  }
  return {
    ownership: {
      fromOwnerEntityLogicalKey: input.offer.sellerEntityLogicalKey,
      ownershipVersion: input.asset.ownershipVersion + 1n,
      toOwnerEntityLogicalKey: input.buyerEntityLogicalKey,
    },
    payment: createTransferDecision(
      input.buyerWalletId,
      input.offer.sellerWalletId,
      input.offer.priceMinor,
    ),
    status: 'accepted',
  };
}
