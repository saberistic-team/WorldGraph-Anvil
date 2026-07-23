import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedActor } from '../identity/service.js';
import type { PostgresCommerceReadRepository } from './commerce-read-repository.js';
import { CommerceReadService } from './commerce-read-service.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const actor = {
  user: { id: '018f8652-3cb6-7d52-904b-cce7901d7e21', platformRole: 'user' },
} as AuthenticatedActor;
const projection = {
  checkpointVersion: '20',
  currentStateRevision: '20',
  lagRevisions: '0',
  status: 'current' as const,
};

describe('CommerceReadService', () => {
  it('builds an exact, itemized fixed-price quote with deterministic half-up pricing and tax', async () => {
    const repository = {
      purchasePreviewSource: async () => ({
        projection,
        source: {
          collectionMode: 'added_to_payer' as const,
          currencyId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
          currentTick: '7',
          expiresAtTick: '20',
          fixedAmountMinor: null,
          listingId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
          listingVersion: '3',
          quantityScale: 2,
          rateBasisPoints: 2_500,
          remainingQuantity: '9.00',
          roundingMode: 'half_up' as const,
          taxPolicyId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
          taxType: 'sales' as const,
          unitPriceMinor: '3',
        },
      }),
    } as unknown as PostgresCommerceReadRepository;
    const service = new CommerceReadService(repository, 'test-secret');

    const result = await service.purchasePreview(
      actor,
      worldId,
      '018f8652-3cb6-7d52-904b-cce7901d7e27',
      { quantity: '1.25' },
    );

    expect(result.preview.quoteHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result).toEqual({
      preview: {
        buyerTotalMinor: '5',
        currencyId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        feeMinor: '0',
        grossMinor: '4',
        listingId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        listingVersion: '3',
        quantity: '1.25',
        quoteHash: result.preview.quoteHash,
        sellerNetMinor: '4',
        taxMinor: '1',
      },
      projection,
    });
  });

  it('rejects a preview larger than the authoritative listing remainder', async () => {
    const purchasePreviewSource = vi.fn(async () => ({
      projection,
      source: {
        collectionMode: null,
        currencyId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        currentTick: '7',
        expiresAtTick: '20',
        fixedAmountMinor: null,
        listingId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        listingVersion: '3',
        quantityScale: 0,
        rateBasisPoints: null,
        remainingQuantity: '1',
        roundingMode: null,
        taxPolicyId: null,
        taxType: null,
        unitPriceMinor: '3',
      },
    }));
    const repository = {
      purchasePreviewSource,
    } as unknown as PostgresCommerceReadRepository;
    const disabledPolicyIds = ['118f8652-3cb6-7d52-904b-cce7901d7e25'];
    const service = new CommerceReadService(repository, 'test-secret', disabledPolicyIds);

    await expect(
      service.purchasePreview(actor, worldId, '018f8652-3cb6-7d52-904b-cce7901d7e27', {
        quantity: '2',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_INVENTORY', statusCode: 409 });
    expect(purchasePreviewSource).toHaveBeenCalledWith(
      actor.user.id,
      worldId,
      '018f8652-3cb6-7d52-904b-cce7901d7e27',
      disabledPolicyIds,
    );
  });

  it('binds employment-candidate cursors to the managed business and actor scope', async () => {
    const businessId = '118f8652-3cb6-7d52-904b-cce7901d7e25';
    const firstWalletId = '218f8652-3cb6-7d52-904b-cce7901d7e25';
    const secondWalletId = '318f8652-3cb6-7d52-904b-cce7901d7e25';
    const candidates = [
      {
        businessId,
        currencyId: '418f8652-3cb6-7d52-904b-cce7901d7e25',
        workerEntityKey: 'character:one',
        workerWalletId: firstWalletId,
      },
      {
        businessId,
        currencyId: '418f8652-3cb6-7d52-904b-cce7901d7e25',
        workerEntityKey: 'character:two',
        workerWalletId: secondWalletId,
      },
    ];
    const employmentCandidates = vi.fn(
      async (input: { after: { id: string; key: string } | null; limit: number }) =>
        input.after
          ? {
              items: [candidates[1]],
              positions: [`character:two|${secondWalletId}`],
              projection,
            }
          : {
              items: candidates,
              positions: [`character:one|${firstWalletId}`, `character:two|${secondWalletId}`],
              projection,
            },
    );
    const repository = { employmentCandidates } as unknown as PostgresCommerceReadRepository;
    const service = new CommerceReadService(repository, 'test-secret');

    const first = await service.employmentCandidates(actor, worldId, businessId, { limit: 1 });
    expect(first.items).toEqual([candidates[0]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    if (!first.nextCursor) throw new Error('Expected a candidate cursor.');
    const cursor = first.nextCursor;
    expect(employmentCandidates).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actorId: actor.user.id,
        after: null,
        businessId,
        limit: 2,
        worldId,
      }),
    );

    const second = await service.employmentCandidates(actor, worldId, businessId, {
      cursor,
      limit: 1,
    });
    expect(second.items).toEqual([candidates[1]]);
    expect(employmentCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ after: { id: firstWalletId, key: 'character:one' } }),
    );
    expect(() =>
      service.employmentCandidates(actor, worldId, '518f8652-3cb6-7d52-904b-cce7901d7e25', {
        cursor,
        limit: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'CURSOR_INVALID', statusCode: 400 }));
  });

  it('paginates aggregate transactions by exact tick, timestamp, and id', async () => {
    const firstId = '618f8652-3cb6-7d52-904b-cce7901d7e25';
    const secondId = '718f8652-3cb6-7d52-904b-cce7901d7e25';
    const first = {
      currencyId: '818f8652-3cb6-7d52-904b-cce7901d7e25',
      grossMinor: '100',
      id: firstId,
      kind: 'payroll' as const,
      netMinor: '90',
      occurredTick: '12',
      payrollRecordId: '118f8652-3cb6-7d52-904b-cce7901d7e25',
      taxMinor: '10',
      worldId,
    };
    const second = {
      amountMinor: '5',
      basisMinor: '0',
      currencyId: '818f8652-3cb6-7d52-904b-cce7901d7e25',
      id: secondId,
      kind: 'periodic_tax' as const,
      occurredTick: '11',
      taxAssessmentId: '218f8652-3cb6-7d52-904b-cce7901d7e25',
      worldId,
    };
    const transactions = vi.fn(
      async (input: {
        after: { createdAt: Date; id: string; tick: string } | null;
        limit: number;
      }) =>
        input.after
          ? {
              items: [second],
              positions: [`11|2026-07-22T10:00:00.000Z|${secondId}`],
              projection,
            }
          : {
              items: [first, second],
              positions: [
                `12|2026-07-22T10:01:00.000Z|${firstId}`,
                `11|2026-07-22T10:00:00.000Z|${secondId}`,
              ],
              projection,
            },
    );
    const repository = { transactions } as unknown as PostgresCommerceReadRepository;
    const service = new CommerceReadService(repository, 'test-secret');

    const firstPage = await service.transactions(actor, worldId, { limit: 1 });
    expect(firstPage.items).toEqual([first]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    if (!firstPage.nextCursor) throw new Error('Expected a transaction cursor.');
    const cursor = firstPage.nextCursor;

    const secondPage = await service.transactions(actor, worldId, {
      cursor,
      limit: 1,
    });
    expect(secondPage.items).toEqual([second]);
    expect(transactions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        after: {
          createdAt: new Date('2026-07-22T10:01:00.000Z'),
          id: firstId,
          tick: '12',
        },
        limit: 2,
      }),
    );
    const otherActor = {
      user: { id: '918f8652-3cb6-7d52-904b-cce7901d7e25', platformRole: 'user' },
    } as AuthenticatedActor;
    expect(() =>
      service.transactions(otherActor, worldId, {
        cursor,
        limit: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'CURSOR_INVALID', statusCode: 400 }));
  });
});
