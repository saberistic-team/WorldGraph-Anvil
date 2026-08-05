import type {
  GovernanceRestrictedTallyExecutor,
  RestrictedElectionTallyBallot,
  RestrictedElectionTallyRequest,
  RestrictedProposalTallyBallot,
  RestrictedProposalTallyRequest,
} from '@worldgraph/governance-command';

import type {
  GovernanceCertificationSourceReader,
  GovernanceScheduleQueryExecutor,
} from './governance-schedule-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const STABLE_KEY = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$/u;

interface RestrictedRoleRow {
  role_name: string;
}

interface RestrictedBallotRow {
  ballot_key: string;
  choice_payload: unknown;
}

interface RestrictedChecksumRow {
  result_checksum: string;
}

/**
 * The only worker component constructed with worldgraph_governance_tally
 * credentials. Its fixed statements cannot read users, participation rows, or
 * voter identifiers. Effective anonymous choice-revision IDs provide stable,
 * unique tally keys without reconstructing voter-to-choice linkage.
 */
export class PostgresGovernanceRestrictedTallyRepository
  implements GovernanceRestrictedTallyExecutor, GovernanceCertificationSourceReader
{
  public constructor(private readonly pool: GovernanceScheduleQueryExecutor) {}

  public async assertRestrictedRole(): Promise<void> {
    const result = await this.pool.query<RestrictedRoleRow>(
      `/* governance:tally:role-boundary */
       select current_user::text as role_name`,
    );
    if (result.rows[0]?.role_name !== 'worldgraph_governance_tally') {
      throw new Error('GOVERNANCE_TALLY_ROLE_REQUIRED');
    }
  }

  public async loadProposalBallots(
    request: RestrictedProposalTallyRequest,
  ): Promise<readonly RestrictedProposalTallyBallot[]> {
    assertTallyRequest(request);
    const result = await this.pool.query<RestrictedBallotRow>(
      `${effectiveChoicesCte()}
       select effective_choice.ballot_key,effective_choice.choice_payload
         from effective_choice
         join eligibility_snapshots snapshot
           on snapshot.world_id=$1 and snapshot.id=$3 and snapshot.contest_id=$2
        order by effective_choice.ballot_key collate "C"`,
      [request.worldId, request.contestId, request.eligibilitySnapshotId],
    );
    return result.rows.map((row) => {
      assertBallotKey(row.ballot_key);
      const payload = record(row.choice_payload);
      const choice = payload?.choice;
      if (
        !payload ||
        Object.keys(payload).length !== 1 ||
        (choice !== 'yes' && choice !== 'no' && choice !== 'abstain')
      ) {
        throw new Error('GOVERNANCE_RESTRICTED_PROPOSAL_CHOICE_INVALID');
      }
      return { ballotKey: row.ballot_key, choice };
    });
  }

  public async loadElectionBallots(
    request: RestrictedElectionTallyRequest,
  ): Promise<readonly RestrictedElectionTallyBallot[]> {
    assertTallyRequest(request);
    if (
      request.candidateKeys.length < 1 ||
      request.candidateKeys.length > 128 ||
      request.candidateKeys.some((key) => !STABLE_KEY.test(key)) ||
      new Set(request.candidateKeys).size !== request.candidateKeys.length
    ) {
      throw new Error('GOVERNANCE_RESTRICTED_CANDIDATE_SET_INVALID');
    }
    const candidates = new Set(request.candidateKeys);
    const result = await this.pool.query<RestrictedBallotRow>(
      `${effectiveChoicesCte()}
       select effective_choice.ballot_key,effective_choice.choice_payload
         from effective_choice
         join eligibility_snapshots snapshot
           on snapshot.world_id=$1 and snapshot.id=$3 and snapshot.contest_id=$2
        order by effective_choice.ballot_key collate "C"`,
      [request.worldId, request.contestId, request.eligibilitySnapshotId],
    );
    return result.rows.map((row) => {
      assertBallotKey(row.ballot_key);
      const payload = record(row.choice_payload);
      if (payload && Object.keys(payload).length === 1 && payload.choiceType === 'abstain') {
        return { ballotKey: row.ballot_key, candidateKey: null };
      }
      const candidateKey = payload?.candidateKey;
      if (
        !payload ||
        Object.keys(payload).length !== 2 ||
        payload.choiceType !== 'candidate' ||
        typeof candidateKey !== 'string' ||
        !candidates.has(candidateKey)
      ) {
        throw new Error('GOVERNANCE_RESTRICTED_ELECTION_CHOICE_INVALID');
      }
      return { ballotKey: row.ballot_key, candidateKey };
    });
  }

  public async loadProposalResultChecksum(
    worldId: string,
    proposalId: string,
  ): Promise<string | null> {
    assertWorldTarget(worldId, proposalId);
    const result = await this.pool.query<RestrictedChecksumRow>(
      `/* governance:tally:proposal-certification-source */
       select encode(tally.output_checksum,'hex') as result_checksum
         from proposal_tallies tally
        where tally.world_id=$1 and tally.proposal_id=$2
        order by tally.tally_version desc,tally.id desc limit 1`,
      [worldId, proposalId],
    );
    return checksum(result.rows[0]);
  }

  public async loadElectionResultChecksum(
    worldId: string,
    electionId: string,
  ): Promise<string | null> {
    assertWorldTarget(worldId, electionId);
    const result = await this.pool.query<RestrictedChecksumRow>(
      `/* governance:tally:election-certification-source */
       select encode(tally.output_checksum,'hex') as result_checksum
         from election_tallies tally
        where tally.world_id=$1 and tally.election_id=$2
        order by tally.tally_version desc,tally.id desc limit 1`,
      [worldId, electionId],
    );
    return checksum(result.rows[0]);
  }
}

function effectiveChoicesCte(): string {
  return `/* governance:tally:effective-anonymous-choices */
    with effective_choice as (
      select choice.choice_revision_id::text as ballot_key,choice.choice_payload
        from ballot_effective_revisions effective
        join secret_ballot_choices choice
          on choice.world_id=effective.world_id
         and choice.choice_revision_id=effective.choice_revision_id
       where effective.world_id=$1 and effective.contest_id=$2
      union all
      select choice.choice_revision_id::text as ballot_key,choice.choice_payload
        from ballot_effective_revisions effective
        join public_ballot_choices choice
          on choice.world_id=effective.world_id
         and choice.choice_revision_id=effective.choice_revision_id
       where effective.world_id=$1 and effective.contest_id=$2
    )`;
}

function assertTallyRequest(request: RestrictedProposalTallyRequest): void {
  if (
    !UUID.test(request.worldId) ||
    !UUID.test(request.contestId) ||
    !UUID.test(request.eligibilitySnapshotId)
  ) {
    throw new Error('GOVERNANCE_RESTRICTED_TALLY_REQUEST_INVALID');
  }
}

function assertWorldTarget(worldId: string, targetId: string): void {
  if (!UUID.test(worldId) || !UUID.test(targetId)) {
    throw new Error('GOVERNANCE_RESTRICTED_CERTIFICATION_REQUEST_INVALID');
  }
}

function assertBallotKey(value: string): void {
  if (!UUID.test(value)) throw new Error('GOVERNANCE_RESTRICTED_BALLOT_KEY_INVALID');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function checksum(row: RestrictedChecksumRow | undefined): string | null {
  if (!row) return null;
  if (!HASH.test(row.result_checksum)) {
    throw new Error('GOVERNANCE_RESTRICTED_RESULT_CHECKSUM_INVALID');
  }
  return row.result_checksum;
}
