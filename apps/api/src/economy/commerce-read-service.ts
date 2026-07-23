import { createHash } from 'node:crypto';

import {
  canonicalJson,
  type BusinessFacilityViewV1,
  type BusinessViewV1,
  type CommerceTransactionSummaryViewV1,
  type EmploymentContractViewV1,
  type InventoryViewV1,
  type MarketPurchasePreviewV1,
  type MarketTradeViewV1,
  type ProductionRecipeVersionViewV1,
  type ProductionRunViewV1,
  type ResourceTypeViewV1,
  type TaxAssessmentViewV1,
  type TreasurySummaryViewV1,
} from '@worldgraph/contracts';
import {
  assessTax,
  EconomyDomainError,
  parseCanonicalQuantity,
  priceQuantityMinor,
} from '@worldgraph/economy';

import { ApplicationError } from '../application/errors.js';
import type { AuthenticatedActor } from '../identity/service.js';
import type {
  CommerceReadPageQuery,
  CommerceReconciliationSummaryV1,
  EmploymentCandidateViewV1,
  EmploymentOfferViewV1,
  EmploymentPageQuery,
  InventoryPageQuery,
  JobRecordViewV1,
  MarketListingPageQuery,
  MarketTradePageQuery,
  ProductionRunPageQuery,
  PurchasePreviewQuery,
  ResourcePageQuery,
} from './commerce-read-contracts.js';
import type {
  CommerceProjectionMeta,
  CommerceReadPage,
  PostgresCommerceReadRepository,
} from './commerce-read-repository.js';
import { decodeEconomyCursor, encodeEconomyCursor, type EconomyCursorResource } from './cursor.js';

export interface CommercePage<T> {
  items: T[];
  nextCursor: string | null;
  projection: CommerceProjectionMeta;
}

export class CommerceReadService {
  public constructor(
    private readonly repository: PostgresCommerceReadRepository,
    private readonly cursorSecret: string,
    private readonly disabledTaxPolicyIds: readonly string[] = [],
  ) {}

  public resources(actor: AuthenticatedActor, worldId: string, query: ResourcePageQuery) {
    return this.stablePage<ResourceTypeViewV1>(
      actor,
      worldId,
      'commerce-resources',
      query,
      {
        status: query.status ?? null,
      },
      (after, limit) =>
        this.repository.resources({
          actorId: actor.user.id,
          after,
          limit,
          status: query.status ?? null,
          worldId,
        }),
    );
  }

  public recipes(actor: AuthenticatedActor, worldId: string, query: CommerceReadPageQuery) {
    return this.stablePage<ProductionRecipeVersionViewV1>(
      actor,
      worldId,
      'commerce-recipes',
      query,
      {},
      (after, limit) => this.repository.recipes({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public inventories(actor: AuthenticatedActor, worldId: string, query: InventoryPageQuery) {
    const controlled = booleanFilter(query.controlled);
    const filters = { controlled, resourceTypeId: query.resourceTypeId ?? null };
    return this.stablePage<InventoryViewV1>(
      actor,
      worldId,
      'commerce-inventories',
      query,
      filters,
      (after, limit) =>
        this.repository.inventories({
          actorId: actor.user.id,
          after,
          controlled,
          limit,
          resourceTypeId: query.resourceTypeId ?? null,
          worldId,
        }),
    );
  }

  public businesses(actor: AuthenticatedActor, worldId: string, query: CommerceReadPageQuery) {
    return this.stablePage<BusinessViewV1>(
      actor,
      worldId,
      'businesses',
      query,
      {},
      (after, limit) =>
        this.repository.businesses({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public facilities(actor: AuthenticatedActor, worldId: string, query: CommerceReadPageQuery) {
    return this.stablePage<BusinessFacilityViewV1>(
      actor,
      worldId,
      'commerce-facilities',
      query,
      {},
      (after, limit) =>
        this.repository.facilities({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public employmentOffers(
    actor: AuthenticatedActor,
    worldId: string,
    query: CommerceReadPageQuery,
  ) {
    return this.stablePage<EmploymentOfferViewV1>(
      actor,
      worldId,
      'commerce-offers',
      query,
      {},
      (after, limit) =>
        this.repository.employmentOffers({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public employmentCandidates(
    actor: AuthenticatedActor,
    worldId: string,
    businessId: string,
    query: CommerceReadPageQuery,
  ) {
    const filters = { businessId };
    return this.stablePage<EmploymentCandidateViewV1>(
      actor,
      worldId,
      'commerce-workers',
      query,
      filters,
      (after, limit) =>
        this.repository.employmentCandidates({
          actorId: actor.user.id,
          after,
          businessId,
          limit,
          worldId,
        }),
    );
  }

  public employmentContracts(
    actor: AuthenticatedActor,
    worldId: string,
    query: EmploymentPageQuery,
  ) {
    const filters = { status: query.status ?? null };
    return this.stablePage<EmploymentContractViewV1>(
      actor,
      worldId,
      'employment-contracts',
      query,
      filters,
      (after, limit) =>
        this.repository.employmentContracts({
          actorId: actor.user.id,
          after,
          limit,
          status: query.status ?? null,
          worldId,
        }),
    );
  }

  public jobs(actor: AuthenticatedActor, worldId: string, query: CommerceReadPageQuery) {
    return this.tickPage<JobRecordViewV1>(
      actor,
      worldId,
      'commerce-jobs',
      query,
      {},
      (after, limit) => this.repository.jobs({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public productionRuns(actor: AuthenticatedActor, worldId: string, query: ProductionRunPageQuery) {
    const filters = { businessId: query.businessId ?? null, status: query.status ?? null };
    return this.tickPage<ProductionRunViewV1>(
      actor,
      worldId,
      'commerce-runs',
      query,
      filters,
      (after, limit) =>
        this.repository.productionRuns({
          actorId: actor.user.id,
          after,
          businessId: query.businessId ?? null,
          limit,
          status: query.status ?? null,
          worldId,
        }),
    );
  }

  public marketListings(actor: AuthenticatedActor, worldId: string, query: MarketListingPageQuery) {
    const filters = { resourceTypeId: query.resourceTypeId ?? null, status: query.status ?? null };
    const limit = pageLimit(query.limit);
    const cursor = this.cursor(actor, worldId, 'commerce-listings', filters, query.cursor);
    const after = cursor ? pricePosition(cursor.position) : null;
    return this.finishPage(
      actor,
      worldId,
      'commerce-listings',
      filters,
      limit,
      this.repository.marketListings({
        actorId: actor.user.id,
        after,
        limit: limit + 1,
        resourceTypeId: query.resourceTypeId ?? null,
        status: query.status ?? null,
        worldId,
      }),
    );
  }

  public marketTrades(actor: AuthenticatedActor, worldId: string, query: MarketTradePageQuery) {
    const filters = { listingId: query.listingId ?? null };
    return this.tickPage<MarketTradeViewV1>(
      actor,
      worldId,
      'commerce-trades',
      query,
      filters,
      (after, limit) =>
        this.repository.marketTrades({
          actorId: actor.user.id,
          after,
          limit,
          listingId: query.listingId ?? null,
          worldId,
        }),
    );
  }

  public transactions(actor: AuthenticatedActor, worldId: string, query: CommerceReadPageQuery) {
    const filters = {};
    const limit = pageLimit(query.limit);
    const cursor = this.cursor(actor, worldId, 'commerce-transactions', filters, query.cursor);
    return this.finishPage<CommerceTransactionSummaryViewV1>(
      actor,
      worldId,
      'commerce-transactions',
      filters,
      limit,
      this.repository.transactions({
        actorId: actor.user.id,
        after: cursor ? transactionPosition(cursor.position) : null,
        limit: limit + 1,
        worldId,
      }),
    );
  }

  public taxAssessments(actor: AuthenticatedActor, worldId: string, query: CommerceReadPageQuery) {
    return this.tickPage<TaxAssessmentViewV1>(
      actor,
      worldId,
      'commerce-tax',
      query,
      {},
      (after, limit) =>
        this.repository.taxAssessments({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public async treasury(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<{ projection: CommerceProjectionMeta; treasury: TreasurySummaryViewV1 }> {
    return this.required(await this.repository.treasury(actor.user.id, worldId));
  }

  public async reconciliation(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<CommerceReconciliationSummaryV1> {
    return this.required(await this.repository.reconciliation(actor.user.id, worldId));
  }

  public async purchasePreview(
    actor: AuthenticatedActor,
    worldId: string,
    listingId: string,
    query: PurchasePreviewQuery,
  ): Promise<{ preview: MarketPurchasePreviewV1; projection: CommerceProjectionMeta }> {
    const result = this.required(
      await this.repository.purchasePreviewSource(
        actor.user.id,
        worldId,
        listingId,
        this.disabledTaxPolicyIds,
      ),
    );
    const source = result.source;
    if (BigInt(source.currentTick) >= BigInt(source.expiresAtTick)) {
      throw new ApplicationError('LISTING_EXPIRED', 'The listing has expired.', 409);
    }
    try {
      const quantity = exactQuantity(query.quantity, source.quantityScale);
      const quantityAtoms = parseCanonicalQuantity(quantity, source.quantityScale, {
        positive: true,
      });
      const remainingAtoms = parseCanonicalQuantity(
        exactQuantity(source.remainingQuantity, source.quantityScale),
        source.quantityScale,
      );
      if (quantityAtoms > remainingAtoms) {
        throw new ApplicationError(
          'INSUFFICIENT_INVENTORY',
          'The requested quantity exceeds the listing remainder.',
          409,
        );
      }
      const gross = priceQuantityMinor(
        quantityAtoms,
        source.quantityScale,
        BigInt(source.unitPriceMinor),
      );
      const tax =
        source.taxPolicyId && source.taxType && source.collectionMode && source.roundingMode
          ? assessTax(
              {
                basisPoints: source.rateBasisPoints,
                collectionMode: source.collectionMode,
                fixedMinor:
                  source.fixedAmountMinor === null ? null : BigInt(source.fixedAmountMinor),
                id: source.taxPolicyId,
                roundingMode: source.roundingMode,
                status: 'active',
                taxType: source.taxType,
                treasuryWalletId: '00000000-0000-8000-8000-000000000001',
              },
              gross,
            )
          : null;
      const taxMinor = tax?.amountMinor ?? 0n;
      const fee =
        source.feePolicyId && source.feeCollectionMode && source.feeRoundingMode
          ? assessTax(
              {
                basisPoints: source.feeRateBasisPoints,
                collectionMode: source.feeCollectionMode,
                fixedMinor:
                  source.feeFixedAmountMinor === null ? null : BigInt(source.feeFixedAmountMinor),
                id: source.feePolicyId,
                roundingMode: source.feeRoundingMode,
                status: 'active',
                taxType: 'marketplace_fee',
                treasuryWalletId: '00000000-0000-8000-8000-000000000001',
              },
              gross,
            )
          : null;
      if (fee && fee.collectionMode !== 'withheld_from_recipient') {
        throw new ApplicationError(
          'POLICY_INVALID',
          'Marketplace fees must be withheld from seller proceeds.',
          409,
        );
      }
      const feeMinor = fee?.amountMinor ?? 0n;
      const buyerTotal = tax?.collectionMode === 'added_to_payer' ? gross + taxMinor : gross;
      const sellerNet =
        (tax?.collectionMode === 'withheld_from_recipient' ? gross - taxMinor : gross) - feeMinor;
      if (sellerNet <= 0n) {
        throw new ApplicationError(
          'POLICY_INVALID',
          'The tax policy leaves no seller proceeds.',
          409,
        );
      }
      const quote = {
        buyerTotalMinor: buyerTotal.toString(),
        currencyId: source.currencyId,
        feeMinor: feeMinor.toString(),
        grossMinor: gross.toString(),
        listingId,
        listingVersion: source.listingVersion,
        quantity,
        sellerNetMinor: sellerNet.toString(),
        taxMinor: taxMinor.toString(),
      };
      return {
        preview: {
          ...quote,
          quoteHash: createHash('sha256').update(canonicalJson(quote), 'utf8').digest('hex'),
        },
        projection: result.projection,
      };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof EconomyDomainError) {
        throw new ApplicationError(error.code, error.message, 422);
      }
      throw error;
    }
  }

  private stablePage<T>(
    actor: AuthenticatedActor,
    worldId: string,
    resource: EconomyCursorResource,
    query: { cursor?: string; limit?: number | string },
    filters: Record<string, unknown>,
    load: (
      after: { id: string; key: string } | null,
      limit: number,
    ) => Promise<CommerceReadPage<T> | null>,
  ): Promise<CommercePage<T>> {
    const limit = pageLimit(query.limit);
    const cursor = this.cursor(actor, worldId, resource, filters, query.cursor);
    return this.finishPage(
      actor,
      worldId,
      resource,
      filters,
      limit,
      load(cursor ? stablePosition(cursor.position) : null, limit + 1),
    );
  }

  private tickPage<T>(
    actor: AuthenticatedActor,
    worldId: string,
    resource: EconomyCursorResource,
    query: { cursor?: string; limit?: number | string },
    filters: Record<string, unknown>,
    load: (
      after: { id: string; tick: string } | null,
      limit: number,
    ) => Promise<CommerceReadPage<T> | null>,
  ): Promise<CommercePage<T>> {
    const limit = pageLimit(query.limit);
    const cursor = this.cursor(actor, worldId, resource, filters, query.cursor);
    return this.finishPage(
      actor,
      worldId,
      resource,
      filters,
      limit,
      load(cursor ? tickPosition(cursor.position) : null, limit + 1),
    );
  }

  private async finishPage<T>(
    actor: AuthenticatedActor,
    worldId: string,
    resource: EconomyCursorResource,
    filters: Record<string, unknown>,
    limit: number,
    result: Promise<CommerceReadPage<T> | null>,
  ): Promise<CommercePage<T>> {
    const loaded = this.required(await result);
    const hasMore = loaded.items.length > limit;
    const items = loaded.items.slice(0, limit);
    const position = loaded.positions[Math.min(limit, loaded.positions.length) - 1];
    return {
      items,
      nextCursor:
        hasMore && position
          ? encodeEconomyCursor(
              {
                filterHash: hash(filters),
                kind: 'economy-page-v1',
                position,
                resource,
                scopeHash: scopeHash(actor.user.id, worldId, resource, filters),
                worldId,
              },
              this.cursorSecret,
            )
          : null,
      projection: loaded.projection,
    };
  }

  private cursor(
    actor: AuthenticatedActor,
    worldId: string,
    resource: EconomyCursorResource,
    filters: Record<string, unknown>,
    value: string | undefined,
  ) {
    if (!value) return null;
    return decodeEconomyCursor(
      value,
      {
        filterHash: hash(filters),
        resource,
        scopeHash: scopeHash(actor.user.id, worldId, resource, filters),
        worldId,
      },
      this.cursorSecret,
    );
  }

  private required<T>(value: T | null): T {
    if (value === null) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Commerce is unavailable in this world or is outside your access scope.',
        404,
      );
    }
    return value;
  }
}

function booleanFilter(value: boolean | 'false' | 'true' | undefined): boolean | null {
  return value === undefined ? null : value === true || value === 'true';
}

function pageLimit(value: number | string | undefined): number {
  const parsed = value === undefined ? 25 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new ApplicationError('INVALID_QUERY', 'The page limit is invalid.', 400);
  }
  return parsed;
}

function stablePosition(value: string): { id: string; key: string } {
  const separator = value.lastIndexOf('|');
  if (separator < 1) invalidPosition();
  const key = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!UUID.test(id) || !STABLE_KEY.test(key)) invalidPosition();
  return { id, key };
}

function tickPosition(value: string): { id: string; tick: string } {
  const [tick, id, extra] = value.split('|');
  if (extra !== undefined || !tick || !id || !INTEGER.test(tick) || !UUID.test(id)) {
    invalidPosition();
  }
  return { id, tick };
}

function pricePosition(value: string): { id: string; price: string } {
  const position = tickPosition(value);
  return { id: position.id, price: position.tick };
}

function transactionPosition(value: string): { createdAt: Date; id: string; tick: string } {
  const [tick, timestamp, id, extra] = value.split('|');
  const createdAt = new Date(timestamp ?? '');
  if (
    extra !== undefined ||
    !tick ||
    !timestamp ||
    !id ||
    !INTEGER.test(tick) ||
    !UUID.test(id) ||
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== timestamp
  ) {
    invalidPosition();
  }
  return { createdAt, id, tick };
}

function invalidPosition(): never {
  throw new ApplicationError('CURSOR_INVALID', 'The commerce cursor position is invalid.', 400);
}

function exactQuantity(value: string, scale: number): string {
  const [whole, fraction = ''] = value.split('.');
  if (
    whole === undefined ||
    !/^(?:0|[1-9][0-9]*)$/u.test(whole) ||
    !/^[0-9]*$/u.test(fraction) ||
    fraction.length > scale
  ) {
    throw new ApplicationError(
      'QUANTITY_INVALID',
      `Quantity must use at most ${String(scale)} fractional digits.`,
      422,
    );
  }
  return scale === 0 ? whole : `${whole}.${fraction.padEnd(scale, '0')}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function scopeHash(
  actorId: string,
  worldId: string,
  resource: EconomyCursorResource,
  filters: Record<string, unknown>,
): string {
  return hash({ actorId, filters, resource, worldId });
}

const INTEGER = /^(?:0|[1-9][0-9]{0,18})$/u;
const STABLE_KEY = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
