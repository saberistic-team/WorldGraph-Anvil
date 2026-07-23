import { createHash } from 'node:crypto';

import { canonicalJson } from '@worldgraph/contracts';

import { ApplicationError, isPostgresError } from '../application/errors.js';
import type { AuthenticatedActor } from '../identity/service.js';
import type {
  AssetPageQueryTransport,
  AssetViewTransport,
  ControlledWalletViewTransport,
  CurrencyViewTransport,
  EconomyPageQueryTransport,
  EconomyRepairApprovalRequestTransport,
  EconomyRepairApprovalTransport,
  EconomyRepairPlanViewTransport,
  EconomySummaryTransport,
  OfferPageQueryTransport,
  OfferViewTransport,
  WalletTransactionViewTransport,
} from './api-contracts.js';
import { decodeEconomyCursor, encodeEconomyCursor, type EconomyCursorResource } from './cursor.js';
import type { EconomyPageResult, PostgresEconomyQueryRepository } from './repository.js';

export interface EconomyReadPolicy {
  debitsFrozen: boolean;
  issuanceEnabled: boolean;
  offersEnabled: boolean;
  transfersEnabled: boolean;
}

export interface EconomyPage<T> {
  items: T[];
  nextCursor: string | null;
}

export class EconomyQueryService {
  public constructor(
    private readonly repository: PostgresEconomyQueryRepository,
    private readonly cursorSecret: string,
    private readonly policy: EconomyReadPolicy,
  ) {}

  public async summary(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<EconomySummaryTransport> {
    return this.required(await this.repository.summary(actor.user.id, worldId, this.policy));
  }

  public async repairPlan(
    actor: AuthenticatedActor,
    worldId: string,
    planId: string,
  ): Promise<EconomyRepairPlanViewTransport> {
    try {
      const plan = await this.repository.repairPlan(actor.user.id, planId);
      return plan.worldId === worldId ? plan : this.notFound();
    } catch (error) {
      if (isPostgresError(error, '42501')) this.notFound();
      throw error;
    }
  }

  public async approveRepair(
    actor: AuthenticatedActor,
    worldId: string,
    planId: string,
    request: EconomyRepairApprovalRequestTransport,
  ): Promise<EconomyRepairApprovalTransport> {
    try {
      return this.required(
        await this.repository.approveRepair({
          ...request,
          actorId: actor.user.id,
          auditRecordId: repairEvidenceId(request.approvalId, 'audit'),
          creatorOverrideId:
            request.authorityKind === 'creator'
              ? repairEvidenceId(request.approvalId, 'creator-override')
              : null,
          planId,
          worldId,
        }),
      );
    } catch (error) {
      if (isPostgresError(error, '42501')) {
        throw new ApplicationError(
          'FORBIDDEN',
          'The economy repair approval is not authorized.',
          403,
        );
      }
      if (isPostgresError(error, '22023')) {
        throw new ApplicationError(
          'REPAIR_APPROVAL_INVALID',
          'The economy repair approval is invalid.',
          422,
        );
      }
      if (
        isPostgresError(error, '55000') ||
        isPostgresConstraint(error, '23514', 'economy_repair_approval_exact')
      ) {
        throw new ApplicationError(
          'REPAIR_APPROVAL_CONFLICT',
          'The economy repair approval conflicts with the sealed plan.',
          409,
        );
      }
      throw error;
    }
  }

  public async currencies(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<{ items: CurrencyViewTransport[]; nextCursor: null }> {
    return {
      items: this.required(await this.repository.currencies(actor.user.id, worldId)),
      nextCursor: null,
    };
  }

  public async wallets(
    actor: AuthenticatedActor,
    worldId: string,
    query: EconomyPageQueryTransport,
  ): Promise<EconomyPage<ControlledWalletViewTransport>> {
    const limit = pageLimit(query.limit);
    const cursor = this.cursor(actor, worldId, 'wallets', {}, query.cursor);
    const after = cursor ? stablePosition(cursor.position) : null;
    const page = this.required(
      await this.repository.wallets({
        actorId: actor.user.id,
        after,
        limit: limit + 1,
        worldId,
      }),
    );
    return this.page(actor, worldId, 'wallets', {}, limit, page);
  }

  public async walletTransactions(
    actor: AuthenticatedActor,
    worldId: string,
    walletId: string,
    query: EconomyPageQueryTransport,
  ): Promise<EconomyPage<WalletTransactionViewTransport>> {
    const limit = pageLimit(query.limit);
    const filters = { walletId };
    const cursor = this.cursor(actor, worldId, 'transactions', filters, query.cursor);
    const after = cursor ? transactionPosition(cursor.position) : null;
    const page = this.required(
      await this.repository.walletTransactions({
        actorId: actor.user.id,
        after,
        limit: limit + 1,
        walletId,
        worldId,
      }),
    );
    return this.page(actor, worldId, 'transactions', filters, limit, page);
  }

  public async assets(
    actor: AuthenticatedActor,
    worldId: string,
    query: AssetPageQueryTransport,
  ): Promise<EconomyPage<AssetViewTransport>> {
    const limit = pageLimit(query.limit);
    const owned = query.owned === undefined ? null : query.owned === true || query.owned === 'true';
    const filters = { owned };
    const cursor = this.cursor(actor, worldId, 'assets', filters, query.cursor);
    const after = cursor ? stablePosition(cursor.position) : null;
    const page = this.required(
      await this.repository.assets({
        actorId: actor.user.id,
        after,
        limit: limit + 1,
        owned,
        worldId,
      }),
    );
    return this.page(actor, worldId, 'assets', filters, limit, page);
  }

  public async asset(
    actor: AuthenticatedActor,
    worldId: string,
    assetKey: string,
  ): Promise<AssetViewTransport> {
    return this.required(await this.repository.asset(actor.user.id, worldId, assetKey));
  }

  public async offers(
    actor: AuthenticatedActor,
    worldId: string,
    query: OfferPageQueryTransport,
  ): Promise<EconomyPage<OfferViewTransport>> {
    const limit = pageLimit(query.limit);
    const filters = {
      offerId: query.offerId ?? null,
      status: query.status ?? null,
    };
    const cursor = this.cursor(actor, worldId, 'offers', filters, query.cursor);
    const after = cursor ? datedPosition(cursor.position) : null;
    const page = this.required(
      await this.repository.offers({
        actorId: actor.user.id,
        after,
        limit: limit + 1,
        query: {
          ...(query.offerId ? { offerId: query.offerId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        worldId,
      }),
    );
    return this.page(actor, worldId, 'offers', filters, limit, page);
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

  private page<T>(
    actor: AuthenticatedActor,
    worldId: string,
    resource: EconomyCursorResource,
    filters: Record<string, unknown>,
    limit: number,
    page: EconomyPageResult<T>,
  ): EconomyPage<T> {
    const hasMore = page.items.length > limit;
    const items = page.items.slice(0, limit);
    const position = page.positions[Math.min(limit, page.positions.length) - 1];
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
    };
  }

  private required<T>(value: T | null): T {
    if (value === null) this.notFound();
    return value;
  }

  private notFound(): never {
    throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
  }
}

function isPostgresConstraint(error: unknown, code: string, constraint: string): boolean {
  return (
    isPostgresError(error, code) &&
    typeof error === 'object' &&
    error !== null &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

function pageLimit(value: number | string | undefined): number {
  const parsed = value === undefined ? 25 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new ApplicationError('INVALID_QUERY', 'The page limit is invalid.', 400);
  }
  return parsed;
}

function stablePosition(value: string): { id: string; stableKey: string } {
  const separator = value.lastIndexOf('|');
  if (separator < 1) invalidPosition();
  const stableKey = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!UUID.test(id) || !STABLE_KEY.test(stableKey)) invalidPosition();
  return { id, stableKey };
}

function datedPosition(value: string): { createdAt: Date; id: string } {
  const separator = value.lastIndexOf('|');
  if (separator < 1) invalidPosition();
  const createdAt = new Date(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!UUID.test(id) || Number.isNaN(createdAt.getTime())) invalidPosition();
  return { createdAt, id };
}

function transactionPosition(value: string): { createdAt: Date; id: string; tick: string } {
  const parts = value.split('|');
  if (parts.length !== 3) invalidPosition();
  const [tick, timestamp, id] = parts as [string, string, string];
  const createdAt = new Date(timestamp);
  if (!INTEGER.test(tick) || !UUID.test(id) || Number.isNaN(createdAt.getTime())) invalidPosition();
  return { createdAt, id, tick };
}

function invalidPosition(): never {
  throw new ApplicationError('CURSOR_INVALID', 'The economy cursor position is invalid.', 400);
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

function repairEvidenceId(approvalId: string, purpose: 'audit' | 'creator-override'): string {
  const bytes = createHash('sha256')
    .update(`worldgraph.economy-repair-approval.${purpose}.v1\0${approvalId}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const INTEGER = /^(?:0|[1-9][0-9]{0,18})$/u;
const STABLE_KEY = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
