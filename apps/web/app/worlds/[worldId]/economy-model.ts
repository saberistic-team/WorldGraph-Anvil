export const MAX_SIGNED_MINOR = 9_223_372_036_854_775_807n;

export interface EconomySummary {
  capabilities: {
    canAdoptLegacySeed: boolean;
    canInitialize: boolean;
    canIssue: boolean;
    canReconcile: boolean;
  };
  currentTick: string;
  designVersion: string;
  economyHeadVersion: string | null;
  featurePolicy: {
    debitsFrozen: boolean;
    issuanceEnabled: boolean;
    offersEnabled: boolean;
    transfersEnabled: boolean;
  };
  initializedEventId: string | null;
  issuanceTarget: {
    currencyCode: string;
    currencyId: string;
    currencyVersion: string;
    currentSupplyMinor: string;
    maxSupplyMinor: string | null;
    minorUnitScale: number;
    supplyVersion: string;
    treasuryBalanceMinor: string;
    treasuryBalanceVersion: string;
    treasuryWalletId: string;
    treasuryWalletVersion: string;
  } | null;
  projectionChecksum: string | null;
  reconciliation: {
    lastReconciledAt: string | null;
    lastReconciledStateRevision: string | null;
    status: 'current' | 'mismatched' | 'not_run' | 'reconciling';
  };
  seedPlan: {
    available: boolean;
    hash: string | null;
    sourceKind: 'compiler_1_1' | 'legacy_adapter' | null;
  };
  stateRevision: string;
  status: 'mismatched' | 'not_initialized' | 'ready' | 'reconciling';
  virtualValueBoundary: { cashOutAllowed: false; noCashValue: true };
  worldId: string;
}

export interface Currency {
  cashOutAllowed: false;
  code: string;
  currencySchemaVersion: 1;
  id: string;
  issuerEntityLogicalKey: string | null;
  maxSupplyMinor: string | null;
  minorUnitScale: number;
  name: string;
  noCashValue: true;
  rowVersion: string;
  stableKey: string;
  status: 'active' | 'frozen' | 'retired';
  worldId: string;
}

export interface CurrencyView {
  currency: Currency;
  currentSupplyMinor: string;
  supplyVersion: string;
  updatedStateRevision: string;
}

export interface CurrencyPage {
  items: CurrencyView[];
  nextCursor: null;
}

export interface Wallet {
  currencyId: string;
  id: string;
  ownerEntityLogicalKey: string;
  rowVersion: string;
  stableKey: string;
  status: 'active' | 'closed' | 'frozen';
  walletKind: 'organization' | 'player' | 'treasury';
  walletSchemaVersion: 1;
  worldId: string;
}

export interface WalletBalance {
  availableMinor: string;
  rowVersion: string;
  updatedStateRevision: string;
  walletId: string;
}

export interface ControlledWalletView {
  balance: WalletBalance;
  controlled: true;
  currencyCode: string;
  minorUnitScale: number;
  wallet: Wallet;
}

export interface ControlledWalletPage {
  items: ControlledWalletView[];
  nextCursor: string | null;
}

export interface WalletPosting {
  currencyId: string;
  postingOrdinal: number;
  signedAmountMinor: string;
  transactionId: string;
  walletId: string;
  worldId: string;
}

export interface FinancialTransaction {
  commandId: string;
  currencyId: string;
  financialTransactionSchemaVersion: 1;
  id: string;
  kind: 'asset_purchase' | 'compensation' | 'initialization' | 'issuance' | 'transfer';
  occurredTick: string;
  postings: WalletPosting[];
  stateRevision: string;
  supplyDeltaMinor: string;
  worldId: string;
}

export interface WalletTransactionView {
  memo: string | null;
  transaction: FinancialTransaction;
}

export interface WalletTransactionPage {
  items: WalletTransactionView[];
  nextCursor: string | null;
}

export interface Asset {
  assetSchemaVersion: 1;
  assetType: string;
  id: string;
  metadata: { displayName: string; provenance: string };
  stableKey: string;
  status: 'active' | 'retired';
  transferable: boolean;
  worldEntityLogicalKey: string | null;
  worldId: string;
}

export interface AssetOwnership {
  acquiredEventId: string;
  assetId: string;
  ownerEntityLogicalKey: string;
  ownershipSchemaVersion: 1;
  ownershipVersion: string;
  updatedStateRevision: string;
  worldId: string;
}

export interface AssetView {
  asset: Asset;
  controlledByActor: boolean;
  ownership: AssetOwnership;
}

export interface AssetPage {
  items: AssetView[];
  nextCursor: string | null;
}

export interface AssetTransferOffer {
  assetId: string;
  buyerEntityLogicalKey: string | null;
  currencyId: string;
  expiresAtTick: string;
  id: string;
  offerSchemaVersion: 1;
  priceMinor: string;
  rowVersion: string;
  sellerEntityLogicalKey: string;
  sellerWalletId: string;
  status: 'accepted' | 'cancelled' | 'expired' | 'open';
  worldId: string;
}

export interface OfferView {
  assetKey: string;
  canAccept: boolean;
  controlledBuyer: boolean;
  controlledSeller: boolean;
  eligibleBuyerWallet: {
    ownerEntityLogicalKey: string;
    walletId: string;
    walletVersion: string;
  } | null;
  offer: AssetTransferOffer;
  /** Actor-scoped positive concurrency token exposed only on authorized offer views. */
  sellerWalletVersion: string;
}

export interface OfferPage {
  items: OfferView[];
  nextCursor: string | null;
}

export type EconomyCommandType =
  | 'AcceptAssetTransferOfferV1'
  | 'AcceptEmploymentContractV1'
  | 'CancelMarketListingV1'
  | 'ConfigureBusinessFacilityV1'
  | 'CreateBusinessV1'
  | 'CreateEmploymentContractV1'
  | 'CreateMarketListingV1'
  | 'CancelAssetTransferOfferV1'
  | 'CreateAssetTransferOfferV1'
  | 'EndEmploymentContractV1'
  | 'InitializeWorldEconomyV1'
  | 'InitializeWorldCommerceV1'
  | 'IssueCurrencyV1'
  | 'PerformJobV1'
  | 'PurchaseMarketListingV1'
  | 'ReconcileWorldCommerceV1'
  | 'ReconcileWorldEconomyV1'
  | 'StartProductionRunV1'
  | 'TransferAssetV1'
  | 'TransferCurrencyV1';

export interface EconomyCommandEnvelope {
  commandId: string;
  expectedAggregateVersion: string;
  expectedStateRevision: string;
  expectedTick?: string;
  expectedWorldVersion: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  schemaVersion: 1;
  type: EconomyCommandType;
}

export type EconomyCommandResult =
  | {
      commandId: string;
      eventIds: string[];
      eventSequenceRange: { from: string; to: string };
      ledgerSequenceRange: { from: string; to: string };
      resultingStateRevision: string;
      schemaVersion: 1;
      status: 'accepted';
    }
  | {
      commandId: string;
      currentStateRevision?: string;
      eventIds: string[];
      rejectionCode?: string;
      schemaVersion: 1;
      status: 'failed' | 'received' | 'rejected';
    };

export interface AmountPreview {
  canonical: string;
  minor: string;
}

export type AmountPreviewResult =
  { ok: true; value: AmountPreview } | { message: string; ok: false };

function groupedWhole(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

export function formatMinor(minor: string, scale: number): string {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(scale + 1, '0');
  const whole = scale === 0 ? padded : padded.slice(0, -scale);
  const fraction = scale === 0 ? '' : `.${padded.slice(-scale)}`;
  return `${negative ? '-' : ''}${groupedWhole(whole)}${fraction}`;
}

export function previewAmount(raw: string, scale: number): AmountPreviewResult {
  const input = raw.trim();
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) {
    return { message: 'Currency precision is unavailable.', ok: false };
  }
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(input)) {
    return {
      message: 'Use digits and an optional decimal point, without signs, grouping, or exponents.',
      ok: false,
    };
  }
  const parts = input.split('.');
  const whole = parts[0] ?? '0';
  const suppliedFraction = parts[1] ?? '';
  if (scale === 0 && suppliedFraction.length > 0) {
    return { message: 'This currency does not use fractional units.', ok: false };
  }
  if (suppliedFraction.length > scale) {
    return {
      message: `This currency permits at most ${scale} fractional digit${scale === 1 ? '' : 's'}.`,
      ok: false,
    };
  }
  const fraction = suppliedFraction.padEnd(scale, '0');
  const canonical = scale === 0 ? whole : `${whole}.${fraction}`;
  const minor = `${whole}${fraction}`.replace(/^0+(?=\d)/u, '');
  const parsedMinor = BigInt(minor);
  if (parsedMinor === 0n) return { message: 'Amount must be greater than zero.', ok: false };
  if (parsedMinor > MAX_SIGNED_MINOR) {
    return { message: 'Amount exceeds the supported 64-bit minor-unit range.', ok: false };
  }
  return { ok: true, value: { canonical, minor: parsedMinor.toString() } };
}

export function projectedMinor(currentMinor: string, changeMinor: string): string | null {
  try {
    const projected = BigInt(currentMinor) + BigInt(changeMinor);
    return projected < 0n || projected > MAX_SIGNED_MINOR ? null : projected.toString();
  } catch {
    return null;
  }
}

export function humanizeEconomyValue(value: string): string {
  return value.replaceAll(/[_:.-]+/gu, ' ').replaceAll(/\b\w/gu, (letter) => letter.toUpperCase());
}

const conflictCodes = new Set([
  'AGGREGATE_VERSION_CONFLICT',
  'CONFLICT',
  'CONTRACT_STATE_INVALID',
  'LISTING_STALE',
  'OWNERSHIP_CONFLICT',
  'REVISION_CONFLICT',
  'STALE_VERSION',
]);

export function isEconomyConflict(code: string): boolean {
  return conflictCodes.has(code);
}

const economyErrorMessages: Record<string, string> = {
  ASSET_NOT_OWNED: 'The authoritative owner changed. Refresh before trying another transfer.',
  ASSET_NOT_TRANSFERABLE: 'This asset cannot be transferred.',
  BUYER_MISMATCH: 'This direct offer is reserved for a different buyer.',
  CURRENCY_MISMATCH: 'The selected wallets do not use the same currency.',
  ECONOMY_NOT_INITIALIZED: 'This world economy has not been initialized.',
  INSUFFICIENT_FUNDS: 'The source wallet does not have enough available virtual currency.',
  INSUFFICIENT_INVENTORY:
    'The authoritative available inventory is lower than the requested quantity.',
  INVALID_AMOUNT_FORMAT: 'The amount does not match this currency’s exact precision.',
  OFFER_EXPIRED: 'This offer expired at the authoritative world tick.',
  OFFER_NOT_OPEN: 'This offer is no longer open.',
  LISTING_EXPIRED: 'This fixed-price listing expired at the authoritative world tick.',
  LISTING_NOT_OPEN: 'This fixed-price listing is already terminal and cannot be purchased.',
  JOB_COOLDOWN: 'This job is still inside its authoritative cooldown window.',
  JOB_CAP_EXCEEDED: 'This contract has reached its reward or performance cap for the period.',
  POLICY_INVALID: 'The configured tax or fee policy cannot produce a valid atomic settlement.',
  PRODUCTION_STATE_INVALID: 'This production run is no longer in a compatible state.',
  QUANTITY_INVALID: 'Use an exact positive quantity within this resource’s declared precision.',
  RECIPE_INVALID: 'The selected recipe or facility capability is no longer valid.',
  SUPPLY_CAP_EXCEEDED: 'Issuance would exceed the immutable supply cap.',
  WALLET_FROZEN: 'A required wallet is frozen.',
  WALLET_NOT_CONTROLLED: 'You do not control the wallet required for this action.',
};

export function economyErrorMessage(code: string, fallback?: string): string {
  if (isEconomyConflict(code)) {
    return 'Authoritative state changed before this command committed. Refresh and review the new values.';
  }
  return economyErrorMessages[code] ?? fallback ?? 'The authoritative economy request failed.';
}

export function buildEconomyCommand(
  summary: EconomySummary,
  type: EconomyCommandType,
  payload: Record<string, unknown>,
  commandId: string,
): EconomyCommandEnvelope {
  const idempotencyKey = `economy-${type}-${commandId}`;
  return {
    commandId,
    expectedAggregateVersion: summary.economyHeadVersion ?? '0',
    expectedStateRevision: summary.stateRevision,
    expectedWorldVersion: summary.designVersion,
    idempotencyKey,
    payload,
    schemaVersion: 1,
    type,
  };
}

export function buildCommerceCommand(
  summary: EconomySummary,
  expansionVersion: string,
  type: EconomyCommandType,
  payload: Record<string, unknown>,
  commandId: string,
): EconomyCommandEnvelope {
  return {
    ...buildEconomyCommand(summary, type, payload, commandId),
    expectedAggregateVersion: expansionVersion,
    expectedTick: summary.currentTick,
    idempotencyKey: `commerce-${type}-${commandId}`,
  };
}

export function isTickInFuture(expiresAtTick: string, currentTick: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(expiresAtTick)) return false;
  try {
    return BigInt(expiresAtTick) > BigInt(currentTick);
  } catch {
    return false;
  }
}
