import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  PostgresCommerceReadRepository,
  type CommerceReadExecutor,
} from './commerce-read-repository.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e21';

describe('PostgresCommerceReadRepository', () => {
  it('reports projection lag from the expansion checkpoint without changing the core head', async () => {
    const stub = executor([
      [
        {
          checkpoint_version: '17',
          current_state_revision: '20',
          reconciliation_status: 'current',
          role: 'player',
        },
      ],
    ]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    await expect(repository.context(actorId, worldId)).resolves.toEqual({
      projection: {
        checkpointVersion: '17',
        currentStateRevision: '20',
        lagRevisions: '3',
        status: 'catching_up',
      },
      role: 'player',
    });
    expect(stub.sql[0]).toContain('world_economy_expansion_heads');
  });

  it('filters private contracts by participant or business authority before cursor pagination', async () => {
    const stub = executor([
      [
        {
          checkpoint_version: '20',
          current_state_revision: '20',
          reconciliation_status: 'current',
          role: 'player',
        },
      ],
      [],
    ]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    await repository.employmentContracts({
      actorId,
      after: {
        id: '018f8652-3cb6-7d52-904b-cce7901d7e28',
        key: 'world:contract:one',
      },
      limit: 26,
      status: 'active',
      worldId,
    });

    const sql = stub.sql[1] ?? '';
    const privacy = sql.lastIndexOf('worldgraph_user_controls_economy_entity_v1(');
    const cursor = sql.indexOf('(contract.stable_key::text collate');
    const limit = sql.indexOf('limit $6');
    expect(privacy).toBeGreaterThan(0);
    expect(cursor).toBeGreaterThan(privacy);
    expect(limit).toBeGreaterThan(cursor);
    expect(sql).not.toContain('employer_wallet_id::text');
    expect(sql).not.toContain('worker_wallet_id::text');
    expect(sql).toContain('business.backing_organization_entity_id');
    expect(sql.indexOf("membership.status = 'active'")).toBeLessThan(privacy);
  });

  it('applies the same participant privacy boundary to job and payroll terms before its cursor', async () => {
    const stub = executor([
      [
        {
          checkpoint_version: '20',
          current_state_revision: '20',
          reconciliation_status: 'current',
          role: 'observer',
        },
      ],
      [],
    ]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    await repository.jobs({ actorId, after: null, limit: 25, worldId });

    const sql = stub.sql[1] ?? '';
    expect(sql.indexOf('controller.entity_id in (contract.worker_entity_id')).toBeLessThan(
      sql.indexOf('(work.performed_tick, work.id)'),
    );
  });

  it('authorizes business control before paginating minimal worker and active-wallet pairs', async () => {
    const businessId = '118f8652-3cb6-7d52-904b-cce7901d7e25';
    const stub = executor([
      [
        {
          checkpoint_version: '20',
          current_state_revision: '20',
          reconciliation_status: 'current',
          role: 'player',
        },
      ],
      [{ id: businessId }],
      [],
    ]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    await repository.employmentCandidates({
      actorId,
      after: {
        id: '218f8652-3cb6-7d52-904b-cce7901d7e25',
        key: 'character:worker-one',
      },
      businessId,
      limit: 26,
      worldId,
    });

    expect(stub.sql[1]).toContain('worldgraph_user_controls_economy_entity_v1');
    const sql = stub.sql[2] ?? '';
    const privacy = sql.indexOf('worldgraph_user_controls_economy_entity_v1');
    const cursor = sql.indexOf('(worker.logical_key::text collate');
    expect(privacy).toBeGreaterThan(0);
    expect(cursor).toBeGreaterThan(privacy);
    expect(sql).toContain("candidate_membership.status = 'active'");
    expect(sql).toContain("wallet.wallet_kind = 'player' and wallet.status = 'active'");
    expect(sql).not.toContain('controller.user_id::text');
    expect(sql).not.toContain('available_minor');
  });

  it('does not query worker candidates when the actor does not control the business', async () => {
    const stub = executor([
      [
        {
          checkpoint_version: '20',
          current_state_revision: '20',
          reconciliation_status: 'current',
          role: 'player',
        },
      ],
      [],
    ]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    await expect(
      repository.employmentCandidates({
        actorId,
        after: null,
        businessId: '118f8652-3cb6-7d52-904b-cce7901d7e25',
        limit: 26,
        worldId,
      }),
    ).resolves.toBeNull();
    expect(stub.sql).toHaveLength(2);
  });

  it('advertises business, contract, and listing actions only through executor-equivalent control', async () => {
    const context = [
      {
        checkpoint_version: '20',
        current_state_revision: '20',
        reconciliation_status: 'current',
        role: 'creator',
      },
    ];
    const stub = executor([context, [], context, [], context, []]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    await repository.businesses({ actorId, after: null, limit: 25, worldId });
    await repository.employmentContracts({
      actorId,
      after: null,
      limit: 25,
      status: null,
      worldId,
    });
    await repository.marketListings({
      actorId,
      after: null,
      limit: 25,
      resourceTypeId: null,
      status: null,
      worldId,
    });

    const businessProjection = (stub.sql[1] ?? '').split('from businesses business')[0] ?? '';
    const contractProjection =
      (stub.sql[3] ?? '').split('from employment_contracts contract')[0] ?? '';
    const listingProjection = (stub.sql[5] ?? '').split('from market_listings listing')[0] ?? '';
    for (const projectionSql of [businessProjection, contractProjection, listingProjection]) {
      expect(projectionSql).toContain('worldgraph_user_controls_economy_entity_v1');
      expect(projectionSql).not.toContain("membership.role in ('creator','administrator')");
      expect(projectionSql).not.toMatch(/\$[0-9]+::boolean or/u);
    }
  });

  it('authorizes private payroll summaries before aggregate-transaction pagination', async () => {
    const stub = executor([
      [
        {
          checkpoint_version: '20',
          current_state_revision: '20',
          reconciliation_status: 'current',
          role: 'player',
        },
      ],
      [],
    ]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    await repository.transactions({
      actorId,
      after: {
        createdAt: new Date('2026-07-22T10:00:00.000Z'),
        id: '118f8652-3cb6-7d52-904b-cce7901d7e25',
        tick: '9',
      },
      limit: 26,
      worldId,
    });

    const sql = stub.sql[1] ?? '';
    const participantPrivacy = sql.indexOf('from economy_participant_history participant');
    const workerPrivacy = sql.indexOf('contract.worker_entity_id');
    const businessPrivacy = sql.indexOf('business.backing_organization_entity_id');
    const cursor = sql.indexOf(
      '(transaction.occurred_tick, transaction.created_at, transaction.id)',
    );
    expect(sql).toContain("membership.role in ('creator','administrator')");
    expect(sql).toContain("membership.status = 'active'");
    expect(participantPrivacy).toBeGreaterThan(0);
    expect(workerPrivacy).toBeGreaterThan(participantPrivacy);
    expect(businessPrivacy).toBeGreaterThan(workerPrivacy);
    expect(cursor).toBeGreaterThan(businessPrivacy);
    expect(sql).toContain(
      "(transaction.transaction_kind = 'market_purchase' and trade.id is not null)",
    );
    expect(sql).toContain(
      "(transaction.transaction_kind = 'periodic_tax' and periodic.id is not null)",
    );

    const projectionSql = sql.split('from financial_transactions transaction')[0] ?? '';
    expect(projectionSql).not.toContain('wallet_id');
    expect(projectionSql).not.toContain('entity_id');
    expect(projectionSql).not.toContain('command_id');
    expect(projectionSql).not.toContain('memo');
    expect(projectionSql).not.toContain('posting');
  });

  it('filters payroll tax assessments by participant authority before pagination', async () => {
    const stub = executor([
      [
        {
          checkpoint_version: '20',
          current_state_revision: '20',
          reconciliation_status: 'current',
          role: 'player',
        },
      ],
      [],
    ]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    await repository.taxAssessments({
      actorId,
      after: {
        id: '118f8652-3cb6-7d52-904b-cce7901d7e25',
        tick: '9',
      },
      limit: 26,
      worldId,
    });

    const sql = stub.sql[1] ?? '';
    const publicAssessment = sql.indexOf("assessment.source_type <> 'payroll'");
    const payrollBinding = sql.indexOf('payroll.id = assessment.source_id');
    const participantPrivacy = sql.indexOf('from economy_participant_history participant');
    const workerPrivacy = sql.indexOf('contract.worker_entity_id');
    const businessPrivacy = sql.indexOf('business.backing_organization_entity_id');
    const cursor = sql.indexOf('(assessment.occurred_tick, assessment.id)');
    expect(sql).toContain("membership.status = 'active'");
    expect(sql).toContain("membership.role in ('creator','administrator')");
    expect(sql).toContain("payroll.status = 'paid'");
    expect(sql).toContain(
      'payroll.financial_transaction_id = assessment.settlement_transaction_id',
    );
    expect(sql).toContain('payroll.terminal_event_id = assessment.event_id');
    expect(publicAssessment).toBeGreaterThan(0);
    expect(payrollBinding).toBeGreaterThan(publicAssessment);
    expect(participantPrivacy).toBeGreaterThan(payrollBinding);
    expect(workerPrivacy).toBeGreaterThan(participantPrivacy);
    expect(businessPrivacy).toBeGreaterThan(workerPrivacy);
    expect(cursor).toBeGreaterThan(businessPrivacy);
    expect(sql).not.toContain('payer_entity_id::text');
    expect(sql).not.toContain('payer_wallet_id::text');
    expect(sql).not.toContain('treasury_wallet_id::text');
    expect(sql).not.toContain('settlement_transaction_id::text');
  });

  it('excludes the configured tax-policy kill switch from purchase previews', async () => {
    const disabledPolicyIds = [
      '118f8652-3cb6-7d52-904b-cce7901d7e25',
      '218f8652-3cb6-7d52-904b-cce7901d7e25',
    ];
    const stub = executor([
      [
        {
          checkpoint_version: '20',
          current_state_revision: '20',
          reconciliation_status: 'current',
          role: 'player',
        },
      ],
      [
        {
          collection_mode: null,
          currency_id: '318f8652-3cb6-7d52-904b-cce7901d7e25',
          current_tick: '7',
          expires_at_tick: '20',
          fee_collection_mode: null,
          fee_fixed_amount_minor: null,
          fee_policy_id: null,
          fee_rate_basis_points: null,
          fee_rounding_mode: null,
          fixed_amount_minor: null,
          listing_id: '418f8652-3cb6-7d52-904b-cce7901d7e25',
          listing_version: '1',
          quantity_scale: 0,
          rate_basis_points: null,
          remaining_quantity: '2',
          rounding_mode: null,
          tax_policy_id: null,
          tax_type: null,
          unit_price_minor: '10',
        },
      ],
    ]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    await expect(
      repository.purchasePreviewSource(
        actorId,
        worldId,
        '418f8652-3cb6-7d52-904b-cce7901d7e25',
        disabledPolicyIds,
      ),
    ).resolves.toMatchObject({ source: { taxPolicyId: null, feePolicyId: null } });

    const sql = stub.sql[1] ?? '';
    expect(sql.match(/not \(tax\.id = any\(\$3::uuid\[\]\)\)/gu)).toHaveLength(2);
    expect(stub.values[1]).toEqual([
      worldId,
      '418f8652-3cb6-7d52-904b-cce7901d7e25',
      disabledPolicyIds,
    ]);
  });

  it('maps each supported immutable transaction source to its safe summary variant', async () => {
    const stub = executor([
      [
        {
          checkpoint_version: '20',
          current_state_revision: '20',
          reconciliation_status: 'current',
          role: 'administrator',
        },
      ],
      [
        {
          amount_minor: null,
          basis_minor: null,
          buyer_total_minor: '108',
          created_at: new Date('2026-07-22T10:03:00.000Z'),
          currency_id: '218f8652-3cb6-7d52-904b-cce7901d7e25',
          fee_minor: '3',
          gross_minor: '100',
          id: '318f8652-3cb6-7d52-904b-cce7901d7e25',
          market_trade_id: '418f8652-3cb6-7d52-904b-cce7901d7e25',
          net_minor: null,
          occurred_tick: '12',
          payroll_record_id: null,
          seller_net_minor: '100',
          tax_assessment_id: null,
          tax_minor: '5',
          transaction_kind: 'market_purchase',
          world_id: worldId,
        },
        {
          amount_minor: null,
          basis_minor: null,
          buyer_total_minor: null,
          created_at: new Date('2026-07-22T10:02:00.000Z'),
          currency_id: '218f8652-3cb6-7d52-904b-cce7901d7e25',
          fee_minor: null,
          gross_minor: '50',
          id: '518f8652-3cb6-7d52-904b-cce7901d7e25',
          market_trade_id: null,
          net_minor: '45',
          occurred_tick: '11',
          payroll_record_id: '618f8652-3cb6-7d52-904b-cce7901d7e25',
          seller_net_minor: null,
          tax_assessment_id: null,
          tax_minor: '5',
          transaction_kind: 'payroll',
          world_id: worldId,
        },
        {
          amount_minor: '7',
          basis_minor: '0',
          buyer_total_minor: null,
          created_at: new Date('2026-07-22T10:01:00.000Z'),
          currency_id: '218f8652-3cb6-7d52-904b-cce7901d7e25',
          fee_minor: null,
          gross_minor: null,
          id: '718f8652-3cb6-7d52-904b-cce7901d7e25',
          market_trade_id: null,
          net_minor: null,
          occurred_tick: '10',
          payroll_record_id: null,
          seller_net_minor: null,
          tax_assessment_id: '818f8652-3cb6-7d52-904b-cce7901d7e25',
          tax_minor: null,
          transaction_kind: 'periodic_tax',
          world_id: worldId,
        },
      ],
    ]);
    const repository = new PostgresCommerceReadRepository(stub.executor);

    const result = await repository.transactions({
      actorId,
      after: null,
      limit: 4,
      worldId,
    });

    expect(result?.items).toEqual([
      expect.objectContaining({
        buyerTotalMinor: '108',
        kind: 'market_purchase',
        marketTradeId: '418f8652-3cb6-7d52-904b-cce7901d7e25',
      }),
      expect.objectContaining({
        grossMinor: '50',
        kind: 'payroll',
        payrollRecordId: '618f8652-3cb6-7d52-904b-cce7901d7e25',
      }),
      expect.objectContaining({
        amountMinor: '7',
        kind: 'periodic_tax',
        taxAssessmentId: '818f8652-3cb6-7d52-904b-cce7901d7e25',
      }),
    ]);
    expect(result?.positions).toEqual([
      '12|2026-07-22T10:03:00.000Z|318f8652-3cb6-7d52-904b-cce7901d7e25',
      '11|2026-07-22T10:02:00.000Z|518f8652-3cb6-7d52-904b-cce7901d7e25',
      '10|2026-07-22T10:01:00.000Z|718f8652-3cb6-7d52-904b-cce7901d7e25',
    ]);
  });
});

function executor(batches: unknown[][]): {
  executor: CommerceReadExecutor;
  sql: string[];
  values: unknown[][];
} {
  const sql: string[] = [];
  const values: unknown[][] = [];
  return {
    executor: {
      async query<Row extends QueryResultRow>(
        text: string,
        parameters: unknown[] = [],
      ): Promise<QueryResult<Row>> {
        sql.push(text);
        values.push(parameters);
        const rows = (batches.shift() ?? []) as Row[];
        return {
          command: 'SELECT',
          fields: [],
          oid: 0,
          rowCount: rows.length,
          rows,
        };
      },
    },
    sql,
    values,
  };
}
