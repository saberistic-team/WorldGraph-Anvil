import { describe, expect, it, vi } from 'vitest';

import { PostgresGovernanceRestrictedTallyRepository } from './governance-tally-repository.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const contestId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const snapshotId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const firstBallot = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const secondBallot = '018f8652-3cb6-7d52-904b-cce7901d7e29';

describe('restricted governance tally repository', () => {
  it('requires the exact NOINHERIT tally login at startup', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ role_name: 'worldgraph_governance_tally' }],
    }));
    const repository = new PostgresGovernanceRestrictedTallyRepository({ query } as never);
    await expect(repository.assertRestrictedRole()).resolves.toBeUndefined();

    query.mockResolvedValueOnce({ rows: [{ role_name: 'worldgraph_app' }] });
    await expect(repository.assertRestrictedRole()).rejects.toThrow(
      'GOVERNANCE_TALLY_ROLE_REQUIRED',
    );
  });

  it('loads effective proposal choices without voter, participation, or user joins', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [
        { ballot_key: firstBallot, choice_payload: { choice: 'yes' } },
        { ballot_key: secondBallot, choice_payload: { choice: 'abstain' } },
      ],
    }));
    const repository = new PostgresGovernanceRestrictedTallyRepository({ query } as never);
    await expect(
      repository.loadProposalBallots({ contestId, eligibilitySnapshotId: snapshotId, worldId }),
    ).resolves.toEqual([
      { ballotKey: firstBallot, choice: 'yes' },
      { ballotKey: secondBallot, choice: 'abstain' },
    ]);

    const sql = query.mock.calls[0]![0];
    expect(sql).toContain('ballot_effective_revisions');
    expect(sql).toContain('secret_ballot_choices');
    expect(sql).toContain('public_ballot_choices');
    expect(sql).toContain('eligibility_snapshots');
    expect(sql).not.toContain('ballot_participation');
    expect(sql).not.toMatch(/\busers\b/u);
    expect(sql).not.toContain('world_memberships');
    expect(sql).not.toContain('voter_entity_id');
  });

  it('validates election choices only against the authoritative candidate set', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [
        {
          ballot_key: firstBallot,
          choice_payload: { candidateKey: 'candidate:alice', choiceType: 'candidate' },
        },
        { ballot_key: secondBallot, choice_payload: { choiceType: 'abstain' } },
      ],
    }));
    const repository = new PostgresGovernanceRestrictedTallyRepository({ query } as never);
    await expect(
      repository.loadElectionBallots({
        candidateKeys: ['candidate:alice'],
        contestId,
        eligibilitySnapshotId: snapshotId,
        worldId,
      }),
    ).resolves.toEqual([
      { ballotKey: firstBallot, candidateKey: 'candidate:alice' },
      { ballotKey: secondBallot, candidateKey: null },
    ]);
  });

  it('returns aggregate-only certification checksums from the restricted workspace', async () => {
    const checksum = 'c'.repeat(64);
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ result_checksum: checksum }],
    }));
    const repository = new PostgresGovernanceRestrictedTallyRepository({ query } as never);
    await expect(repository.loadProposalResultChecksum(worldId, contestId)).resolves.toBe(checksum);
    await expect(repository.loadElectionResultChecksum(worldId, contestId)).resolves.toBe(checksum);
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toContain('secret_ballot_choices');
      expect(sql).not.toContain('ballot_participation');
      expect(sql).not.toMatch(/\busers\b/u);
      expect(sql).not.toContain('choice_payload');
    }
  });

  it('fails closed for malformed or off-ballot restricted choices', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [
        {
          ballot_key: firstBallot,
          choice_payload: { candidateKey: 'candidate:bob', choiceType: 'candidate' },
        },
      ],
    }));
    const repository = new PostgresGovernanceRestrictedTallyRepository({ query } as never);
    await expect(
      repository.loadElectionBallots({
        candidateKeys: ['candidate:alice'],
        contestId,
        eligibilitySnapshotId: snapshotId,
        worldId,
      }),
    ).rejects.toThrow('GOVERNANCE_RESTRICTED_ELECTION_CHOICE_INVALID');
  });
});
