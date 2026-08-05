import { describe, expect, it, vi } from 'vitest';

import {
  GOVERNANCE_ELECTION_OPERATIONAL_STATES,
  GOVERNANCE_PROPOSAL_OPERATIONAL_STATES,
  PostgresGovernanceScheduleRepository,
  governanceScheduleDeterministicUuid,
  type GovernanceCertificationSourceReader,
} from './governance-schedule-repository.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const actionId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const completedEventId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const targetId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const contestId = '018f8652-3cb6-7d52-904b-cce7901d7e29';
const snapshotId = '018f8652-3cb6-7d52-904b-cce7901d7e30';
const checksum = 'a'.repeat(64);

function sources(overrides: Partial<GovernanceCertificationSourceReader> = {}) {
  return {
    loadElectionResultChecksum: vi.fn(async () => null),
    loadProposalResultChecksum: vi.fn(async () => null),
    ...overrides,
  } satisfies GovernanceCertificationSourceReader;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    action_schema_version: 1,
    action_type: 'OpenProposalVotingV1',
    aggregate_version: '3',
    completed_event_id: completedEventId,
    contest_id: contestId,
    current_tick: '15',
    due_tick: '12',
    eligible_count: 2,
    expected_state_revision: '19',
    expected_world_version: '4',
    open_window_expired: false,
    payload: { proposalId: targetId },
    policy_checksum: checksum,
    process_version: '1.0.0',
    schedule_sequence: '7',
    scheduled_action_id: actionId,
    snapshot_checksum: 'b'.repeat(64),
    snapshot_id: null,
    source_state_revision: null,
    target_id: targetId,
    target_kind: 'proposal',
    world_id: worldId,
    ...overrides,
  };
}

function operationalRows(): Array<{
  eligible_count: string;
  max_projection_lag_revisions: string;
  pending_outbox_count: string;
  state: string;
  target_count: string;
  target_kind: string;
  turnout_count: string;
}> {
  return [
    ...GOVERNANCE_PROPOSAL_OPERATIONAL_STATES.map((state) => ({
      eligible_count: state === 'open' ? '40' : '0',
      max_projection_lag_revisions: '6',
      pending_outbox_count: '3',
      state,
      target_count: state === 'open' ? '2' : '0',
      target_kind: 'proposal',
      turnout_count: state === 'open' ? '31' : '0',
    })),
    ...GOVERNANCE_ELECTION_OPERATIONAL_STATES.map((state) => ({
      eligible_count: state === 'certified' ? '25' : '0',
      max_projection_lag_revisions: '6',
      pending_outbox_count: '3',
      state,
      target_count: state === 'certified' ? '1' : '0',
      target_kind: 'election',
      turnout_count: state === 'certified' ? '22' : '0',
    })),
  ];
}

describe('Postgres governance schedule repository', () => {
  it('reads a fixed-cardinality operational snapshot without exporting identities', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: operationalRows(),
    }));
    const repository = new PostgresGovernanceScheduleRepository(
      { query } as never,
      sources(),
      worldId,
    );

    const snapshot = await repository.readOperationalSnapshot();
    expect(snapshot).toMatchObject({
      maxProjectionLagRevisions: 6,
      pendingOutboxCount: 3,
    });
    expect(snapshot.states).toHaveLength(20);
    expect(snapshot.states).toContainEqual({
      eligibleCount: 40,
      state: 'open',
      targetCount: 2,
      targetKind: 'proposal',
      turnoutCount: 31,
    });
    expect(snapshot.states).toContainEqual({
      eligibleCount: 25,
      state: 'certified',
      targetCount: 1,
      targetKind: 'election',
      turnoutCount: 22,
    });
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('/* governance:scheduler:operational-snapshot */');
    expect(sql).toContain("world.lifecycle='active'");
    expect(sql).toContain('from unnest($2::text[]) as allowed(state)');
    expect(sql).toContain('from unnest($3::text[]) as allowed(state)');
    expect(sql).toContain('from ballot_participation participation');
    expect(sql).toContain("command.status='accepted'");
    expect(sql).toContain('command.command_type=any($4::text[])');
    expect(sql).toContain(
      'coalesce(latest.state_revision,0)\n                    - coalesce(governance.updated_state_revision,0)',
    );
    expect(sql).not.toContain(
      'runtime.state_revision-coalesce(governance.updated_state_revision,0)',
    );
    expect(sql).toContain("message.status='pending'");
    expect(sql).toContain('command.command_type=any($4::text[])');
    expect(sql).not.toContain('voter_entity_id');
    expect(sql).not.toContain('secret_ballot_choices');
    expect(values?.[0]).toBe(worldId);
    expect(values?.[1]).toBe(GOVERNANCE_PROPOSAL_OPERATIONAL_STATES);
    expect(values?.[2]).toBe(GOVERNANCE_ELECTION_OPERATIONAL_STATES);
    expect(values?.[3]).toEqual(expect.arrayContaining(['CreateProposalV1', 'CertifyElectionV1']));
  });

  it('rejects malformed or non-allowlisted operational rows', async () => {
    const rows = operationalRows();
    rows[0] = { ...rows[0]!, state: 'world-id-shaped-state' };
    const repository = new PostgresGovernanceScheduleRepository(
      { query: vi.fn(async () => ({ rows })) } as never,
      sources(),
    );
    await expect(repository.readOperationalSnapshot()).rejects.toThrow(
      'GOVERNANCE_OPERATIONAL_SNAPSHOT_INVALID',
    );
  });

  it('discovers completed target-only actions with immutable completion provenance', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [row()] }));
    const repository = new PostgresGovernanceScheduleRepository({ query } as never, sources());

    await expect(repository.findPendingEffects(25)).resolves.toEqual([
      {
        actionType: 'OpenProposalVotingV1',
        aggregateVersion: '3',
        completedEventId,
        contestId,
        currentTick: '15',
        dueTick: '12',
        eligibilitySnapshot: {
          eligibleCount: 2,
          policyChecksum: checksum,
          snapshotChecksum: 'b'.repeat(64),
          snapshotId: governanceScheduleDeterministicUuid(actionId, 'eligibility-snapshot'),
          sourceStateRevision: '19',
        },
        expectedStateRevision: '19',
        expectedWorldVersion: '4',
        occurrenceKey: `governance:proposal:${targetId}:open:12`,
        scheduleSequence: '7',
        scheduledActionId: actionId,
        targetId,
        targetKind: 'proposal',
        worldId,
      },
    ]);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("action.status='completed'");
    expect(sql).toContain('action.completed_event_id is not null');
    expect(sql).toContain('command.causation_id=action.completed_event_id');
    expect(sql).toContain('governance_schedule_occurrences');
    expect(sql).toContain('clock.current_tick >= action.due_tick');
    expect(sql).toContain('eligible_count');
    expect(sql).toContain('policy_checksum');
    expect(sql).toContain('snapshot_checksum');
    expect(sql).toContain("canonical_policy_document -> 'citizenEligibilityPolicy'");
    expect(sql).toContain('charter_authority_intervals');
    expect(sql).toContain('effective_ticks @> candidate.current_tick::bigint');
    expect(sql).toContain('election_office.eligibility_policy');
    expect(sql).toContain(
      "election.status in ('nominations_scheduled','nominations_open','voting_scheduled')",
    );
    expect(sql).toContain("proposal.status in ('sponsoring','scheduled','debate')");
    expect(sql).toContain('office_seat_authority_intervals');
    expect(sql).toContain('worldgraph_governance_policy_matches_v1');
    expect(sql).toContain("'governance.vote'");
    expect(sql).toContain("'charter_citizen_eligibility'");
    expect(sql).toContain("'office_eligibility'");
    expect(sql).toContain("'governance_policy_v1'");
    expect(sql).not.toContain('active_playable_membership_v1');
    expect(sql).not.toContain('secret_ballot_choices');
    expect(sql).not.toContain('ballot_participation');
    expect(sql).not.toMatch(/\busers\b/u);
    expect(values).toEqual([
      [
        'OpenProposalVotingV1',
        'CloseAndTallyProposalV1',
        'CertifyAndEnactProposalV1',
        'OpenElectionV1',
        'CloseAndTallyElectionV1',
        'CertifyElectionV1',
      ],
      null,
      25,
      null,
    ]);
  });

  it('refreshes one exact claimed action without relying on a bounded discovery page', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [row()] }));
    const repository = new PostgresGovernanceScheduleRepository({ query } as never, sources());

    await expect(repository.findPendingEffect(actionId)).resolves.toMatchObject({
      expectedStateRevision: '19',
      scheduledActionId: actionId,
    });
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('action.id=$4::uuid');
    expect(values).toEqual([
      [
        'OpenProposalVotingV1',
        'CloseAndTallyProposalV1',
        'CertifyAndEnactProposalV1',
        'OpenElectionV1',
        'CloseAndTallyElectionV1',
        'CertifyElectionV1',
      ],
      null,
      1,
      actionId,
    ]);
    await expect(repository.findPendingEffect('not-an-action')).rejects.toThrow(
      'GOVERNANCE_SCHEDULE_ACTION_ID_INVALID',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('loads only the latest aggregate checksum through the restricted reader for certification', async () => {
    const restricted = sources({
      loadProposalResultChecksum: vi.fn(async () => checksum),
    });
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [
        row({
          action_type: 'CertifyAndEnactProposalV1',
          eligible_count: null,
          policy_checksum: null,
          snapshot_checksum: null,
        }),
      ],
    }));
    const repository = new PostgresGovernanceScheduleRepository({ query } as never, restricted);

    const result = await repository.findPendingEffects(1);
    expect(result[0]).toMatchObject({
      actionType: 'CertifyAndEnactProposalV1',
      expectedResultChecksum: checksum,
      targetId,
    });
    expect(restricted.loadProposalResultChecksum).toHaveBeenCalledWith(worldId, targetId);
  });

  it('maps a frozen eligibility snapshot for close-and-tally without reading any choices', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [
        row({
          action_type: 'CloseAndTallyProposalV1',
          eligible_count: null,
          policy_checksum: null,
          snapshot_checksum: null,
          snapshot_id: snapshotId,
          source_state_revision: '18',
        }),
      ],
    }));
    const repository = new PostgresGovernanceScheduleRepository({ query } as never, sources());

    await expect(repository.findPendingEffects(1)).resolves.toEqual([
      expect.objectContaining({
        actionType: 'CloseAndTallyProposalV1',
        algorithmVersion: 'proposal_yes_no_v1',
        eligibilitySnapshotId: snapshotId,
      }),
    ]);
  });

  it('discovers delayed proposal and election opens without deriving late eligibility', async () => {
    const secondActionId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
    const electionId = '018f8652-3cb6-7d52-904b-cce7901d7e32';
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [
        row({
          eligible_count: null,
          open_window_expired: true,
          policy_checksum: null,
          snapshot_checksum: null,
        }),
        row({
          action_type: 'OpenElectionV1',
          eligible_count: null,
          open_window_expired: true,
          payload: { electionId },
          policy_checksum: null,
          scheduled_action_id: secondActionId,
          snapshot_checksum: null,
          target_id: electionId,
          target_kind: 'election',
        }),
      ],
    }));
    const restricted = sources();
    const repository = new PostgresGovernanceScheduleRepository({ query } as never, restricted);

    const first = await repository.findPendingEffects(2);
    const second = await repository.findPendingEffects(2);

    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    for (const candidate of first) {
      expect(candidate).toMatchObject({
        eligibilitySnapshot: {
          eligibleCount: 0,
          sourceStateRevision: '19',
        },
      });
      if (
        candidate.actionType !== 'OpenProposalVotingV1' &&
        candidate.actionType !== 'OpenElectionV1'
      ) {
        throw new Error('expected a delayed open candidate');
      }
      expect(candidate.eligibilitySnapshot.policyChecksum).toMatch(/^[a-f0-9]{64}$/u);
      expect(candidate.eligibilitySnapshot.snapshotChecksum).toMatch(/^[a-f0-9]{64}$/u);
      expect(candidate.eligibilitySnapshot.policyChecksum).not.toBe(
        candidate.eligibilitySnapshot.snapshotChecksum,
      );
    }
    expect(restricted.loadElectionResultChecksum).not.toHaveBeenCalled();
    expect(restricted.loadProposalResultChecksum).not.toHaveBeenCalled();
    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain('end as open_window_expired');
    expect(sql).toContain('candidate.current_tick::bigint < case candidate.action_type');
  });

  it('rejects computed schedule payloads before command dispatch', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [row({ payload: { choice: 'yes', proposalId: targetId } })],
    }));
    const repository = new PostgresGovernanceScheduleRepository({ query } as never, sources());
    await expect(repository.findPendingEffects(1)).rejects.toThrow(
      'GOVERNANCE_SCHEDULE_PAYLOAD_INVALID',
    );
  });

  it('fails closed on unsafe scopes and batch sizes without querying', async () => {
    const query = vi.fn();
    expect(
      () => new PostgresGovernanceScheduleRepository({ query } as never, sources(), 'not-a-world'),
    ).toThrow('GOVERNANCE_SCHEDULE_WORLD_SCOPE_INVALID');
    const repository = new PostgresGovernanceScheduleRepository({ query } as never, sources());
    await expect(repository.findPendingEffects(0)).rejects.toThrow(
      'GOVERNANCE_SCHEDULE_DISCOVERY_LIMIT_INVALID',
    );
    await expect(repository.findPendingEffects(1, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('derives stable, purpose-separated UUIDs from schedule identity', () => {
    const first = governanceScheduleDeterministicUuid(actionId, 'command');
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(governanceScheduleDeterministicUuid(actionId, 'command')).toBe(first);
    expect(governanceScheduleDeterministicUuid(actionId, 'correlation')).not.toBe(first);
  });
});
