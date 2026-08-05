import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  repairActorId,
  repairApproval,
  repairApprovalId,
  repairOtherWorldId,
  repairPlanHash,
  repairPlanId,
  repairPlanView,
  repairTestId,
  repairWorldId,
} from './repair-test-fixtures.js';
import type { EconomyRepairApprovalInput } from './repository.js';
import { PostgresEconomyQueryRepository } from './repository.js';

const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e21';
const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const versionId = '018f8652-3cb6-7d52-904b-cce7901d7e23';
const initializedEventId = '018f8652-3cb6-7d52-904b-cce7901d7e24';
const reconciledAt = new Date('2026-07-22T12:34:56.789Z');

describe('PostgresEconomyQueryRepository economy summary', () => {
  it('returns the exact reconciliation revision and time from the last immutable run', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            active_world_version_id: versionId,
            current_tick: '42',
            design_version: '3',
            economy_head_version: '8',
            initialized_event_id: initializedEventId,
            issuance_currency_code: 'GCR',
            issuance_currency_id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
            issuance_currency_version: '1',
            issuance_current_supply_minor: '20000',
            issuance_max_supply_minor: '100000000',
            issuance_minor_unit_scale: 2,
            issuance_supply_version: '1',
            issuance_treasury_balance_minor: '0',
            issuance_treasury_balance_version: '1',
            issuance_treasury_wallet_id: '018f8652-3cb6-7d52-904b-cce7901d7e26',
            issuance_treasury_wallet_version: '1',
            last_reconciled_at: reconciledAt,
            last_reconciled_state_revision: '17',
            plan_hash: Buffer.from('a'.repeat(64), 'hex'),
            projection_checksum: Buffer.from('b'.repeat(64), 'hex'),
            reconciliation_status: 'current',
            source_kind: 'compiler_1_1',
            state_revision: '17',
            version_compiler_version: '1.1.0',
            world_id: worldId,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: 'creator' }] });
    const repository = new PostgresEconomyQueryRepository({} as never, { query });

    await expect(
      repository.summary(actorId, worldId, {
        debitsFrozen: false,
        issuanceEnabled: true,
        offersEnabled: true,
        transfersEnabled: true,
      }),
    ).resolves.toEqual({
      capabilities: {
        canAdoptLegacySeed: false,
        canInitialize: false,
        canIssue: true,
        canReconcile: true,
      },
      currentTick: '42',
      designVersion: '3',
      economyHeadVersion: '8',
      featurePolicy: {
        debitsFrozen: false,
        issuanceEnabled: true,
        offersEnabled: true,
        transfersEnabled: true,
      },
      initializedEventId,
      issuanceTarget: {
        currencyCode: 'GCR',
        currencyId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        currencyVersion: '1',
        currentSupplyMinor: '20000',
        maxSupplyMinor: '100000000',
        minorUnitScale: 2,
        supplyVersion: '1',
        treasuryBalanceMinor: '0',
        treasuryBalanceVersion: '1',
        treasuryWalletId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        treasuryWalletVersion: '1',
      },
      projectionChecksum: 'b'.repeat(64),
      reconciliation: {
        lastReconciledAt: '2026-07-22T12:34:56.789Z',
        lastReconciledStateRevision: '17',
        status: 'current',
      },
      seedPlan: {
        available: true,
        hash: 'a'.repeat(64),
        sourceKind: 'compiler_1_1',
      },
      stateRevision: '17',
      status: 'ready',
      virtualValueBoundary: { cashOutAllowed: false, noCashValue: true },
      worldId,
    });

    expect(query.mock.calls[0]?.[0]).toContain(
      'reconciliation_run.created_at as last_reconciled_at',
    );
  });

  it('uses null reconciliation time when no run exists', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            active_world_version_id: versionId,
            current_tick: '0',
            design_version: '1',
            economy_head_version: null,
            initialized_event_id: null,
            issuance_currency_code: null,
            issuance_currency_id: null,
            issuance_currency_version: null,
            issuance_current_supply_minor: null,
            issuance_max_supply_minor: null,
            issuance_minor_unit_scale: null,
            issuance_supply_version: null,
            issuance_treasury_balance_minor: null,
            issuance_treasury_balance_version: null,
            issuance_treasury_wallet_id: null,
            issuance_treasury_wallet_version: null,
            last_reconciled_at: null,
            last_reconciled_state_revision: null,
            plan_hash: Buffer.from('a'.repeat(64), 'hex'),
            projection_checksum: null,
            reconciliation_status: null,
            source_kind: 'compiler_1_2',
            state_revision: '0',
            version_compiler_version: '1.2.0',
            world_id: worldId,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: 'creator' }] });
    const repository = new PostgresEconomyQueryRepository({} as never, { query });

    const summary = await repository.summary(actorId, worldId, {
      debitsFrozen: false,
      issuanceEnabled: true,
      offersEnabled: true,
      transfersEnabled: true,
    });

    expect(summary?.reconciliation).toEqual({
      lastReconciledAt: null,
      lastReconciledStateRevision: null,
      status: 'not_run',
    });
    expect(summary?.seedPlan).toEqual({
      available: true,
      hash: 'a'.repeat(64),
      sourceKind: 'compiler_1_2',
    });
  });
});

describe('PostgresEconomyQueryRepository direct offer invitation', () => {
  it('reveals an open untargeted offer only by exact id and derives an eligible buyer wallet', async () => {
    const offerId = '018f8652-3cb6-7d52-904b-cce7901d7e30';
    const buyerWalletId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
    const sellerWalletId = '018f8652-3cb6-7d52-904b-cce7901d7e32';
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ role: 'player' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            asset_id: '018f8652-3cb6-7d52-904b-cce7901d7e33',
            asset_key: 'asset:founding-seal',
            buyer_entity_logical_key: null,
            can_accept: true,
            controlled_buyer: false,
            controlled_seller: false,
            created_at: new Date('2026-07-22T12:00:00.000Z'),
            currency_id: '018f8652-3cb6-7d52-904b-cce7901d7e34',
            eligible_buyer_owner_logical_key: 'character:buyer',
            eligible_buyer_wallet_id: buyerWalletId,
            eligible_buyer_wallet_version: '4',
            expires_at_tick: '10',
            id: offerId,
            price_minor: '1000',
            row_version: '1',
            seller_entity_logical_key: 'character:seller',
            seller_wallet_id: sellerWalletId,
            seller_wallet_version: '2',
            status: 'open',
            world_id: worldId,
          },
        ],
      });
    const repository = new PostgresEconomyQueryRepository({} as never, { query });

    await expect(
      repository.offers({
        actorId,
        after: null,
        limit: 2,
        query: { offerId },
        worldId,
      }),
    ).resolves.toEqual({
      items: [
        {
          assetKey: 'asset:founding-seal',
          canAccept: true,
          controlledBuyer: false,
          controlledSeller: false,
          eligibleBuyerWallet: {
            ownerEntityLogicalKey: 'character:buyer',
            walletId: buyerWalletId,
            walletVersion: '4',
          },
          offer: {
            assetId: '018f8652-3cb6-7d52-904b-cce7901d7e33',
            buyerEntityLogicalKey: null,
            currencyId: '018f8652-3cb6-7d52-904b-cce7901d7e34',
            expiresAtTick: '10',
            id: offerId,
            offerSchemaVersion: 1,
            priceMinor: '1000',
            rowVersion: '1',
            sellerEntityLogicalKey: 'character:seller',
            sellerWalletId,
            status: 'open',
            worldId,
          },
          sellerWalletVersion: '2',
        },
      ],
      positions: [`2026-07-22T12:00:00.000Z|${offerId}`],
    });
    expect(query.mock.calls[1]?.[0]).toContain('$3::uuid is not null and offer.id = $3::uuid');
    expect(query.mock.calls[1]?.[1]).toEqual([worldId, actorId, offerId, null, null, null, 2]);
  });
});

describe('PostgresEconomyQueryRepository asset transferability', () => {
  it('reports configured active or disabled facility assets as effectively non-transferable', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ role: 'player' }] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = new PostgresEconomyQueryRepository({} as never, { query });

    await expect(repository.asset(actorId, worldId, 'asset:facility:workshop')).resolves.toBeNull();

    const sql = String(query.mock.calls[1]?.[0]);
    expect(sql).toContain('asset.transferable and not exists');
    expect(sql).toContain('from business_facilities facility');
    expect(sql).toContain("facility.status in ('active','disabled')");
  });
});

describe('PostgresEconomyQueryRepository repair authority boundary', () => {
  const creatorApprovalInput = {
    actorId: repairActorId,
    approvalId: repairApprovalId,
    auditRecordId: repairTestId(34),
    authorityKind: 'creator',
    confirmation: 'APPROVE APPEND-ONLY ECONOMY REPAIR',
    creatorOverrideId: repairTestId(35),
    planHash: repairPlanHash,
    planId: repairPlanId,
    worldId: repairWorldId,
  } satisfies EconomyRepairApprovalInput;

  it('reads a strict private plan through the database authority function', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ document: repairPlanView }] });
    const repository = new PostgresEconomyQueryRepository({} as never, { query });

    await expect(repository.repairPlan(repairActorId, repairPlanId)).resolves.toEqual(
      repairPlanView,
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('worldgraph_economy_repair_plan'), [
      repairPlanId,
      repairActorId,
    ]);
  });

  it('rolls back a cross-world route before calling the approval function', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ document: { ...repairPlanView, worldId: repairOtherWorldId } }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;
    const repository = new PostgresEconomyQueryRepository(pool);

    await expect(repository.approveRepair(creatorApprovalInput)).resolves.toBeNull();

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'begin',
      expect.stringContaining('worldgraph_economy_repair_plan'),
      'rollback',
    ]);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('worldgraph_approve_economy_repair')),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('redacts a failed plan preflight and never attempts approval', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce({ code: '42501', detail: 'private database detail' })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool;
    const repository = new PostgresEconomyQueryRepository(pool);

    await expect(repository.approveRepair(creatorApprovalInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      statusCode: 404,
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('worldgraph_approve_economy_repair')),
    ).toBe(false);
  });

  it('forwards replay-stable evidence bytes and returns the exact approval document', async () => {
    const approval = repairApproval('creator');
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('worldgraph_economy_repair_plan')) {
        return { rows: [{ document: repairPlanView }] };
      }
      if (sql.includes('worldgraph_approve_economy_repair')) {
        return { rows: [{ document: approval }] };
      }
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool;
    const repository = new PostgresEconomyQueryRepository(pool);

    await expect(repository.approveRepair(creatorApprovalInput)).resolves.toEqual(approval);
    await expect(repository.approveRepair(creatorApprovalInput)).resolves.toEqual(approval);

    const approvalCalls = query.mock.calls.filter(([sql]) =>
      sql.includes('worldgraph_approve_economy_repair'),
    );
    expect(approvalCalls).toHaveLength(2);
    expect(approvalCalls[0]?.[1]).toEqual([
      repairPlanId,
      repairActorId,
      'creator',
      repairApprovalId,
      repairTestId(35),
      repairTestId(34),
      repairPlanHash,
      'APPROVE APPEND-ONLY ECONOMY REPAIR',
    ]);
    expect(approvalCalls[1]?.[1]).toEqual(approvalCalls[0]?.[1]);
  });
});
