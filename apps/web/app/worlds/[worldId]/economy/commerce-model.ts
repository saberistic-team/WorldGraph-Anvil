export interface CommerceProjection {
  checkpointVersion: string;
  currentStateRevision: string;
  lagRevisions: string;
  status: 'catching_up' | 'current' | 'failed' | 'mismatch';
}

export interface CommercePage<T> {
  items: T[];
  nextCursor: string | null;
  projection: CommerceProjection;
}

export interface ResourceTypeView {
  displayName: string;
  id: string;
  primitiveContentHash: string;
  primitiveVersionId: string;
  quantityScale: number;
  rowVersion: string;
  schemaVersion: 1;
  stableKey: string;
  status: 'active' | 'retired';
  unitCode: string;
  worldId: string;
}

export interface InventoryView {
  availableQuantity: string;
  containerAssetId: string | null;
  containerEntityKey: string | null;
  controlledByActor: boolean;
  id: string;
  ownerEntityKey: string;
  quantity: string;
  reservedQuantity: string;
  resourceType: ResourceTypeView;
  rowVersion: string;
  updatedStateRevision: string;
  worldId: string;
}

export interface RecipeView {
  checksum: string;
  durationTicks: string;
  facilityAssetType: string;
  id: string;
  inputs: Array<{ quantity: string; resourceTypeId: string }>;
  outputs: Array<{ quantity: string; resourceTypeId: string }>;
  recipeId: string;
  schemaVersion: 1;
  version: number;
  worldId: string;
}

export interface BusinessView {
  backingOrganizationEntityKey: string;
  canManage: boolean;
  id: string;
  rowVersion: string;
  schemaVersion: 1;
  status: 'active' | 'closed' | 'suspended';
  walletId: string;
  worldId: string;
}

export interface FacilityView {
  businessId: string;
  facilityAssetId: string;
  id: string;
  recipeVersionIds: string[];
  rowVersion: string;
  schemaVersion: 1;
  status: 'active' | 'disabled' | 'retired';
  worldId: string;
}

export interface EmploymentOfferView {
  businessId: string;
  cadenceTicks: string;
  currencyId: string;
  id: string;
  maxPaymentsPerPeriod: number;
  roleCode: string;
  rowVersion: string;
  stableKey: string;
  status: 'closed' | 'open' | 'retired';
  wageMinor: string;
  worldId: string;
}

export interface EmploymentContractView {
  businessId: string;
  canManage: boolean;
  canWork: boolean;
  effectiveFromTick: string;
  effectiveToTick: string;
  id: string;
  privateTermsVisible: boolean;
  roleCode: string;
  rowVersion: string;
  status: 'active' | 'cancelled' | 'ended' | 'offered';
  wageMinor: string | null;
  workerEntityKey: string;
  worldId: string;
}

export interface EmploymentCandidateView {
  businessId: string;
  currencyId: string;
  workerEntityKey: string;
  workerWalletId: string;
}

export interface JobRecordView {
  contractId: string;
  grossMinor: string;
  id: string;
  payroll: {
    errorCode: string | null;
    grossMinor: string;
    id: string;
    netMinor: string;
    rowVersion: string;
    status: 'failed' | 'paid' | 'pending';
    taxMinor: string;
  } | null;
  performedTick: string;
  worldId: string;
}

export interface ProductionRunView {
  businessId: string;
  dueTick: string;
  facilityId: string;
  failureCode: string | null;
  id: string;
  inputSnapshot: Array<{ quantity: string; resourceTypeId: string }>;
  outputSnapshot: Array<{ quantity: string; resourceTypeId: string }>;
  recipeVersionId: string;
  rowVersion: string;
  runQuantity: string;
  status: 'cancelled' | 'completed' | 'failed' | 'ready' | 'reserving' | 'scheduled';
  worldId: string;
}

export interface MarketListingView {
  canCancel: boolean;
  currencyId: string;
  expiresAtTick: string;
  id: string;
  offeredQuantity: string;
  remainingQuantity: string;
  resourceType: ResourceTypeView;
  rowVersion: string;
  sellerEntityKey: string;
  status: 'cancelled' | 'expired' | 'filled' | 'open';
  unitPriceMinor: string;
  worldId: string;
}

export interface MarketTradeView {
  buyerTotalMinor: string;
  createdTick: string;
  feeMinor: string;
  grossMinor: string;
  id: string;
  listingId: string;
  quantity: string;
  sellerNetMinor: string;
  taxMinor: string;
  unitPriceMinor: string;
  worldId: string;
}

export interface PurchasePreview {
  buyerTotalMinor: string;
  currencyId: string;
  feeMinor: string;
  grossMinor: string;
  listingId: string;
  listingVersion: string;
  quantity: string;
  quoteHash: string;
  sellerNetMinor: string;
  taxMinor: string;
}

export interface TreasuryView {
  balanceMinor: string;
  currencyId: string;
  lastRevenueTick: string | null;
  noCashValue: true;
  revenueMinor: string;
  treasuryWalletId: string;
  worldId: string;
}

export interface TaxAssessmentView {
  amountMinor: string;
  basisMinor: string;
  id: string;
  policyId: string;
  sourceId: string;
  sourceType: 'market_trade' | 'payroll' | 'periodic_tax';
  tick: string;
  worldId: string;
}

export interface ReconciliationSummary {
  expansionVersion: string;
  lastRun: {
    assessmentCount: number;
    id: string;
    inventoryCount: number;
    mismatchCount: number;
    resourceCount: number;
    sourceStateRevision: string;
    status: 'matched' | 'mismatch';
    tradeCount: number;
  } | null;
  projection: CommerceProjection;
  projectionChecksum: string;
  worldId: string;
}

export type ExactQuantityResult = { canonical: string; ok: true } | { message: string; ok: false };

export type ProductionInventorySelection =
  | { expectedInventories: Array<{ inventoryId: string; rowVersion: string }>; ok: true }
  | { message: string; ok: false };

export type CommerceSection = 'business' | 'market' | 'production' | 'resources' | 'treasury';

export function formatExactQuantity(quantity: string, unitCode: string): string {
  const [whole = '0', fraction] = quantity.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${fraction === undefined ? grouped : `${grouped}.${fraction}`} ${unitCode}`;
}

export function exactPositiveQuantity(raw: string, scale: number): ExactQuantityResult {
  const canonical = raw.trim();
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) {
    return { message: 'Resource precision is unavailable.', ok: false };
  }
  const match = /^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,12}))?$/u.exec(canonical);
  if (!match) {
    return {
      message: 'Use a positive exact quantity with at most 30 whole digits and 12 decimals.',
      ok: false,
    };
  }
  const fraction = match[2] ?? '';
  if (fraction.length > scale) {
    return {
      message: `This resource permits at most ${scale} decimal place${scale === 1 ? '' : 's'}.`,
      ok: false,
    };
  }
  if (!/[1-9]/u.test(canonical)) {
    return { message: 'Quantity must be greater than zero.', ok: false };
  }
  return { canonical, ok: true };
}

function quantityAtoms(canonical: string, scale: number): bigint | null {
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) return null;
  const match = /^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,12}))?$/u.exec(canonical);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > scale) return null;
  return BigInt(`${match[1]}${fraction.padEnd(scale, '0')}`);
}

export function quantityFitsAvailable(
  requested: string,
  available: string,
  scale: number,
): boolean {
  const requestedAtoms = quantityAtoms(requested, scale);
  const availableAtoms = quantityAtoms(available, scale);
  return requestedAtoms !== null && availableAtoms !== null && requestedAtoms <= availableAtoms;
}

export function positiveWholeRunQuantity(raw: string): ExactQuantityResult {
  const canonical = raw.trim();
  return /^[1-9][0-9]{0,17}$/u.test(canonical)
    ? { canonical, ok: true }
    : {
        message: 'Run quantity must be a positive whole number with at most 18 digits.',
        ok: false,
      };
}

export function selectProductionInventories(
  recipe: RecipeView,
  inventories: readonly InventoryView[],
  facilityAssetId: string,
): ProductionInventorySelection {
  const resourceIds = [...new Set(recipe.inputs.map((input) => input.resourceTypeId))].sort();
  if (resourceIds.length === 0) {
    return {
      message: 'This client requires at least one versioned input inventory for production.',
      ok: false,
    };
  }
  const expectedInventories: Array<{ inventoryId: string; rowVersion: string }> = [];
  for (const resourceId of resourceIds) {
    const candidates = inventories.filter(
      (inventory) =>
        inventory.controlledByActor &&
        inventory.containerAssetId === facilityAssetId &&
        inventory.resourceType.id === resourceId,
    );
    if (candidates.length === 0) {
      return {
        message: 'A controlled facility inventory for every recipe input is required.',
        ok: false,
      };
    }
    if (candidates.length > 1) {
      return {
        message:
          'More than one controlled inventory in this facility matches a recipe input, so no inventory is guessed.',
        ok: false,
      };
    }
    const inventory = candidates[0];
    if (!inventory) continue;
    expectedInventories.push({ inventoryId: inventory.id, rowVersion: inventory.rowVersion });
  }
  return { expectedInventories, ok: true };
}

export function projectionMessage(projection: CommerceProjection): string | null {
  if (projection.status === 'mismatch' || projection.status === 'failed') {
    return 'Projection verification failed. Treat these values as read-only until reconciliation succeeds.';
  }
  if (projection.lagRevisions !== '0') {
    return `Projection is ${projection.lagRevisions} revision${projection.lagRevisions === '1' ? '' : 's'} behind authoritative state.`;
  }
  if (projection.status === 'catching_up') {
    return 'Projection data is current; reconciliation verification is pending.';
  }
  return null;
}

export function commerceProjectionAllowsActions(projection: CommerceProjection): boolean {
  return (
    projection.lagRevisions === '0' &&
    (projection.status === 'current' || projection.status === 'catching_up')
  );
}

export function isTerminalCommerceStatus(status: string): boolean {
  return [
    'cancelled',
    'closed',
    'completed',
    'ended',
    'expired',
    'failed',
    'filled',
    'paid',
    'retired',
  ].includes(status);
}

export function purchaseConfirmationRows(preview: PurchasePreview) {
  return [
    ['Item subtotal', `${preview.grossMinor} minor units`],
    ['Tax', `${preview.taxMinor} minor units`],
    ['Marketplace fee', `${preview.feeMinor} minor units`],
    ['Exact total', `${preview.buyerTotalMinor} minor units`],
  ] as const;
}
