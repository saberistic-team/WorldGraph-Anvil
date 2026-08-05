import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresGovernanceReadRepository, type GovernanceReadExecutor } from './repository.js';

const actorId = '018f0000-0000-7000-8000-000000000001';
const worldId = '018f0000-0000-7000-8000-000000000002';
const targetId = '018f0000-0000-7000-8000-000000000003';
const restrictedAggregateTablePattern =
  /\b(?:proposal_tallies|proposal_tally_counts|election_tallies|election_tally_counts)\b/u;

interface RecordedQuery {
  text: string;
  values: unknown[] | undefined;
}

describe('governance read repository privacy boundary', () => {
  it('labels page rows from the same repeatable-read revision and tick snapshot', async () => {
    const connectionQueries: string[] = [];
    let released = false;
    const executor: GovernanceReadExecutor = {
      async connect() {
        return {
          async query<Row extends QueryResultRow>(text: string): Promise<QueryResult<Row>> {
            connectionQueries.push(text);
            if (text.includes('from world_memberships membership')) {
              return queryResult<Row>([{ evaluated_at_tick: '73', projection_revision: '119' }]);
            }
            return queryResult<Row>([]);
          },
          release() {
            released = true;
          },
        };
      },
      async query<Row extends QueryResultRow>(): Promise<QueryResult<Row>> {
        throw new Error('PAGE_READ_ESCAPED_SNAPSHOT_CONNECTION');
      },
    };

    const page = await new PostgresGovernanceReadRepository(executor).institutions({
      actorId,
      after: null,
      limit: 20,
      worldId,
    });

    expect(page).toMatchObject({
      evaluatedAtTick: '73',
      items: [],
      projectionRevision: '119',
    });
    expect(connectionQueries[0]).toBe('begin isolation level repeatable read read only');
    expect(connectionQueries[1]).toContain('from world_memberships membership');
    expect(connectionQueries[2]).toContain('from institutions institution');
    expect(connectionQueries[3]).toBe('commit');
    expect(released).toBe(true);
  });

  it('returns charter revision and tick evidence from its row snapshot', async () => {
    const transactionQueries: string[] = [];
    const executor = scriptedExecutor(
      [],
      [
        [{ evaluated_at_tick: '73', projection_revision: '119' }],
        [
          {
            aggregate_version: '2',
            charter_id: targetId,
            charter_version: 1,
            checksum: Buffer.from('11'.repeat(32), 'hex'),
            citizen_eligibility_policy: { kind: 'membership_role', role: 'player' },
            effective_from_tick: '0',
            effective_until_tick: null,
            proposal_rules: {
              approvalThresholdBps: 5001,
              ballotPolicy: {
                ballotMode: 'public',
                disclosure: 'choice_totals',
                replacementAllowed: true,
              },
              debateTicks: '2',
              minimumSponsors: 1,
              quorumBps: 5000,
              sponsorshipTicks: '2',
              votingTicks: '3',
            },
            stable_key: 'charter:harbor',
            summary: 'The current charter.',
            title: 'Harbor Charter',
            world_id: worldId,
          },
        ],
      ],
      transactionQueries,
    );

    const charter = await new PostgresGovernanceReadRepository(executor).charter(actorId, worldId);

    expect(charter).toMatchObject({ evaluatedAtTick: '73', projectionRevision: '119' });
    expect(transactionQueries).toEqual([
      'begin isolation level repeatable read read only',
      'commit',
    ]);
  });

  it('returns a secret receipt without querying or returning the secret selection', async () => {
    const queries: string[] = [];
    const executor = scriptedExecutor(queries, [
      [{ evaluated_at_tick: '42', projection_revision: '41' }],
      [
        {
          ballot_mode: 'secret',
          cast_tick: '18',
          choice_payload: null,
          contest_id: targetId,
          contest_target_id: targetId,
          receipt_hash: Buffer.from('11'.repeat(32), 'hex'),
        },
      ],
      [
        {
          ballot_mode: 'secret',
          cast_tick: '18',
          effective: true,
          public_choice: null,
          receipt_hash: Buffer.from('11'.repeat(32), 'hex'),
        },
      ],
    ]);

    const receipt = await new PostgresGovernanceReadRepository(executor).proposalReceipt(
      actorId,
      worldId,
      targetId,
    );

    expect(receipt).toEqual({
      ballotMode: 'secret',
      castAtTick: '18',
      proposalId: targetId,
      receiptHash: '11'.repeat(32),
    });
    expect(queries.join('\n')).toContain('worldgraph_governance_ballot_receipt_v1');
    expect(queries[0]).toContain('head.updated_state_revision::text as projection_revision');
    expect(queries[0]).toContain('join world_governance_heads head');
    expect(queries[0]).not.toContain('join world_runtime_heads runtime');
    expect(queries.join('\n')).not.toContain('secret_ballot_choices');
    expect(queries.join('\n')).not.toContain('ballot_effective_revisions');
    expect(queries.join('\n')).not.toContain('ballot_choice_revisions');
    expect(JSON.stringify(receipt)).not.toMatch(/choice|voter/iu);
  });

  it('returns the effective public selection only to the controlling actor', async () => {
    const queries: string[] = [];
    const executor = scriptedExecutor(queries, [
      [{ evaluated_at_tick: '42', projection_revision: '42' }],
      [
        {
          ballot_mode: 'public',
          cast_tick: '19',
          choice_payload: null,
          contest_id: targetId,
          contest_target_id: targetId,
          receipt_hash: Buffer.from('22'.repeat(32), 'hex'),
        },
      ],
      [
        {
          ballot_mode: 'public',
          cast_tick: '19',
          effective: true,
          public_choice: { choice: 'yes' },
          receipt_hash: Buffer.from('22'.repeat(32), 'hex'),
        },
      ],
    ]);

    const receipt = await new PostgresGovernanceReadRepository(executor).proposalReceipt(
      actorId,
      worldId,
      targetId,
    );

    expect(receipt).toMatchObject({ ballotMode: 'public', choice: 'yes' });
    expect(queries.at(-2)).toContain('controller.user_id = $3');
    expect(queries.at(-1)).toContain('worldgraph_governance_ballot_receipt_v1');
  });

  it('reports override and repair world ticks from their authoritative commands', async () => {
    const queries: string[] = [];
    const executor = scriptedExecutor(queries, [
      [{ evaluated_at_tick: '42', projection_revision: '42' }],
      [],
    ]);

    await new PostgresGovernanceReadRepository(executor).audit({
      actorId,
      after: null,
      limit: 20,
      worldId,
    });

    expect(queries.at(-1)).toContain('command.expected_tick::text as occurred_at_tick');
    expect(queries.at(-1)).toContain('command.expected_tick::text, repair.reason');
    expect(queries.at(-1)).toContain("decision.action_code='governance.result.repair'");
    expect(queries.at(-1)).toContain('authority.actor_mode::text');
    expect(queries.at(-1)).not.toContain('world.created_by_user_id = repair.actor_user_id');
    expect(queries.at(-1)).not.toContain(
      'event.resulting_state_revision::text as occurred_at_tick',
    );
  });

  it('keeps a platform-admin repair labeled administrator when that user also created the world', async () => {
    const queries: string[] = [];
    const executor = scriptedExecutor(queries, [
      [{ evaluated_at_tick: '42', projection_revision: '42' }],
      [
        {
          actor_mode: 'administrator',
          aggregate_id: targetId,
          aggregate_type: 'proposal_result',
          audit_id: '018f0000-0000-7000-8000-000000000009',
          event_type: 'governance.repair',
          occurred_at_tick: '27',
          reason: 'Platform repair by the world creator account.',
        },
      ],
    ]);

    const page = await new PostgresGovernanceReadRepository(executor).audit({
      actorId,
      after: null,
      limit: 20,
      worldId,
    });

    expect(page?.items[0]).toMatchObject({ actorMode: 'administrator' });
    expect(queries.at(-1)).not.toContain('created_by_user_id');
  });

  it('reads the current proposal-result leaf after a recount', async () => {
    const queries: string[] = [];
    const recordedQueries: RecordedQuery[] = [];
    const transactionQueries: string[] = [];
    const resultId = '018f0000-0000-7000-8000-000000000004';
    const executor = scriptedExecutor(
      queries,
      [
        [{ evaluated_at_tick: '42', projection_revision: '42' }],
        [
          {
            abstain_count: 1,
            eligible_count: 5,
            input_checksum: Buffer.from('11'.repeat(32), 'hex'),
            no_count: 1,
            outcome: 'passed',
            proposal_id: targetId,
            result_checksum: Buffer.from('22'.repeat(32), 'hex'),
            result_id: resultId,
            turnout_count: 5,
            yes_count: 3,
          },
        ],
      ],
      transactionQueries,
      recordedQueries,
    );

    const result = await new PostgresGovernanceReadRepository(executor).proposalResult(
      actorId,
      worldId,
      targetId,
    );

    const resultQuery = recordedQueries.find((query) =>
      query.text.includes('worldgraph_governance_proposal_result_v1'),
    );
    expect(result).toMatchObject({ outcome: 'passed', resultId, yesCount: 3 });
    expect(resultQuery).toMatchObject({ values: [worldId, actorId, targetId] });
    expect(resultQuery?.text).toContain('worldgraph_governance_proposal_result_v1($1,$2,$3)');
    expect(queries.join('\n')).not.toMatch(restrictedAggregateTablePattern);
    expect(transactionQueries).toEqual([
      'begin isolation level repeatable read read only',
      'commit',
    ]);
  });

  it('projects office-term concurrency from the aggregate stream head', async () => {
    const queries: string[] = [];
    const executor = scriptedExecutor(queries, [
      [{ evaluated_at_tick: '42', projection_revision: '42' }],
      [],
    ]);

    await new PostgresGovernanceReadRepository(executor).terms({
      actorId,
      after: null,
      limit: 20,
      worldId,
    });

    expect(queries.at(-1)).toContain('join aggregate_stream_heads head');
    expect(queries.at(-1)).toContain('join world_simulation_clocks clock');
    expect(queries.at(-1)).toContain('head.current_version::text as aggregate_version');
    expect(queries.at(-1)).toContain("clock.current_tick >= term.planned_ends_tick then 'ended'");
    expect(queries.at(-1)).not.toContain('term.term_number::text as aggregate_version');
  });

  it('derives scheduled, active, expired, repealed, and superseded law status at the world tick', async () => {
    const queries: string[] = [];
    const executor = scriptedExecutor(queries, [
      [{ evaluated_at_tick: '42', projection_revision: '42' }],
      [],
    ]);

    await new PostgresGovernanceReadRepository(executor).laws({
      actorId,
      after: null,
      limit: 20,
      worldId,
    });

    expect(queries.at(-1)).toContain('join world_simulation_clocks clock');
    expect(queries.at(-1)).toContain('interval.effective_ticks @> clock.current_tick');
    expect(queries.at(-1)).toContain(
      "clock.current_tick < lower(interval.effective_ticks) then 'scheduled'",
    );
    expect(queries.at(-1)).toContain("when successor.version_kind = 'repeal' then 'repealed'");
    expect(queries.at(-1)).toContain("when successor.version_kind is not null then 'superseded'");
    expect(queries.at(-1)).toContain("else 'expired'");
  });

  it('binds election totals to the current result leaf selected after a recount', async () => {
    const queries: string[] = [];
    const recordedQueries: RecordedQuery[] = [];
    const transactionQueries: string[] = [];
    const resultId = '018f0000-0000-7000-8000-000000000004';
    const executor = scriptedExecutor(
      queries,
      [
        [{ evaluated_at_tick: '42', projection_revision: '42' }],
        [
          {
            abstain_count: 0,
            election_id: targetId,
            eligible_count: 1,
            input_checksum: Buffer.from('11'.repeat(32), 'hex'),
            outcome: 'elected',
            result_checksum: Buffer.from('22'.repeat(32), 'hex'),
            result_id: resultId,
            turnout_count: 3,
            winner_candidate_key: 'character:alice',
          },
        ],
        [
          { ballot_count: 2, candidate_key: 'character:alice', count_kind: 'candidate' },
          { ballot_count: 1, candidate_key: 'character:bob', count_kind: 'candidate' },
          { ballot_count: 0, candidate_key: null, count_kind: 'abstain' },
        ],
      ],
      transactionQueries,
      recordedQueries,
    );

    const result = await new PostgresGovernanceReadRepository(executor).electionResult(
      actorId,
      worldId,
      targetId,
    );

    const summaryQuery = recordedQueries.find((query) =>
      query.text.includes('worldgraph_governance_election_result_v1'),
    );
    const countsQuery = recordedQueries.find((query) =>
      query.text.includes('worldgraph_governance_election_result_counts_v1'),
    );
    expect(result).toMatchObject({
      candidateTotals: [
        { candidateKey: 'character:alice', voteCount: 2 },
        { candidateKey: 'character:bob', voteCount: 1 },
      ],
      outcome: 'elected',
      resultId,
      tiedCandidateKeys: [],
      winnerCandidateKey: 'character:alice',
    });
    expect(summaryQuery).toMatchObject({ values: [worldId, actorId, targetId] });
    expect(summaryQuery?.text).toContain('worldgraph_governance_election_result_v1($1,$2,$3)');
    expect(countsQuery).toMatchObject({ values: [worldId, actorId, resultId] });
    expect(countsQuery?.text).toContain(
      'worldgraph_governance_election_result_counts_v1($1,$2,$3)',
    );
    expect(queries.join('\n')).not.toMatch(restrictedAggregateTablePattern);
    expect(transactionQueries).toEqual([
      'begin isolation level repeatable read read only',
      'commit',
    ]);
  });

  it('does not query election counts when the current result summary is absent', async () => {
    const queries: string[] = [];
    const recordedQueries: RecordedQuery[] = [];
    const transactionQueries: string[] = [];
    const executor = scriptedExecutor(
      queries,
      [[{ evaluated_at_tick: '42', projection_revision: '42' }], []],
      transactionQueries,
      recordedQueries,
    );

    const result = await new PostgresGovernanceReadRepository(executor).electionResult(
      actorId,
      worldId,
      targetId,
    );

    const summaryQuery = recordedQueries.find((query) =>
      query.text.includes('worldgraph_governance_election_result_v1'),
    );
    expect(result).toBeNull();
    expect(summaryQuery).toMatchObject({ values: [worldId, actorId, targetId] });
    expect(queries.join('\n')).not.toContain('worldgraph_governance_election_result_counts_v1');
    expect(queries.join('\n')).not.toMatch(restrictedAggregateTablePattern);
    expect(transactionQueries).toEqual([
      'begin isolation level repeatable read read only',
      'commit',
    ]);
  });

  it('projects selectable active fiscal and district targets with exact identities', async () => {
    const queries: string[] = [];
    const executor = scriptedExecutor(queries, [
      [{ evaluated_at_tick: '42', projection_revision: '42' }],
      [
        {
          currency_code: 'GCR',
          currency_id: targetId,
          currency_key: 'currency:gold-civic-reserve',
          current_rate_bps: 250,
          expected_policy_version: '3',
          policy_id: targetId,
          policy_key: 'tax:harbor-sales',
          tax_type: 'sales',
          treasury_wallet_id: targetId,
          treasury_wallet_key: 'wallet:treasury:gcr',
        },
      ],
      [
        {
          currency_code: 'GCR',
          currency_id: targetId,
          currency_key: 'currency:gold-civic-reserve',
          currency_version: '2',
          spendable_minor: '900',
          treasury_wallet_id: targetId,
          treasury_wallet_key: 'wallet:treasury:gcr',
          treasury_wallet_version: '4',
        },
      ],
      [
        {
          display_name: 'Civic Platform',
          project_entity_id: targetId,
          project_key: 'district:civic-platform',
        },
      ],
    ]);

    const targets = await new PostgresGovernanceReadRepository(executor).proposalTargets(
      actorId,
      worldId,
    );

    expect(targets).toMatchObject({
      projectEntities: [{ projectKey: 'district:civic-platform' }],
      taxPolicies: [
        {
          currentRateBps: 250,
          expectedPolicyVersion: '3',
          policyKey: 'tax:harbor-sales',
        },
      ],
      treasuries: [
        {
          currencyVersion: '2',
          spendableMinor: '900',
          treasuryWalletVersion: '4',
        },
      ],
    });
    expect(queries[1]).toContain('authority.effective_ticks @> clock.current_tick');
    expect(queries[1]).toContain('policy.rate_basis_points is not null');
    expect(queries[2]).toContain('worldgraph_wallet_spendable_minor_v1');
    expect(queries[3]).toContain("entity.entity_type='district'");
  });

  it('bounds each actionable capability class independently of historical candidacy volume', async () => {
    const queries: string[] = [];
    const executor = scriptedExecutor(queries, [
      [{ evaluated_at_tick: '42', projection_revision: '42' }],
      [],
    ]);

    await new PostgresGovernanceReadRepository(executor).capabilityResources(actorId, worldId);

    const sql = queries.at(-1)!;
    expect(sql).toContain('proposal_preballot_resources');
    expect(sql).toContain('proposal_ballot_resources');
    expect(sql).toContain('election_nomination_resources');
    expect(sql).toContain('election_ballot_resources');
    expect(sql).toContain("candidacy.status='nominated'");
    expect(sql).toContain("election.status='nominations_open'");
    expect(sql).toContain('clock.current_tick >= election.nomination_opens_tick');
    expect(sql).toContain('clock.current_tick < election.nomination_closes_tick');
    expect(sql).toContain('clock.current_tick >= proposal.voting_opens_tick');
    expect(sql).toContain('clock.current_tick < proposal.voting_closes_tick');
    expect(sql).toContain('clock.current_tick >= election.voting_opens_tick');
    expect(sql).toContain('clock.current_tick < election.voting_closes_tick');
    expect(sql).toContain('controller.user_id=$2');
    expect(sql).toContain("resource_state in ('active','scheduled')");
    expect(sql).not.toContain('limit 500');
  });
});

function scriptedExecutor(
  queries: string[],
  rows: QueryResultRow[][],
  transactionQueries: string[] = [],
  recordedQueries: RecordedQuery[] = [],
): GovernanceReadExecutor {
  const query = async <Row extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>> => {
    queries.push(text);
    recordedQueries.push({ text, values });
    const next = rows.shift() ?? [];
    return {
      command: 'SELECT',
      fields: [],
      oid: 0,
      rowCount: next.length,
      rows: next as Row[],
    };
  };
  return {
    async connect() {
      return {
        async query<Row extends QueryResultRow>(
          text: string,
          values?: unknown[],
        ): Promise<QueryResult<Row>> {
          if (/^(?:begin|commit|rollback)/iu.test(text)) {
            transactionQueries.push(text);
            return emptyResult<Row>();
          }
          return query<Row>(text, values);
        },
        release() {},
      };
    },
    query,
  };
}

function emptyResult<Row extends QueryResultRow>(): QueryResult<Row> {
  return { command: 'SELECT', fields: [], oid: 0, rowCount: 0, rows: [] };
}

function queryResult<Row extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<Row> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows: rows as Row[],
  };
}
