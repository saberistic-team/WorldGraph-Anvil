import type { GovernancePostgresErrorShape, GovernanceRejectionCode } from './types.js';

export class RecentCredentialProofError extends Error {
  public readonly code = 'RECENT_CREDENTIAL_INVALID';

  public constructor() {
    super('A valid recent-credential proof is required.');
    this.name = 'RecentCredentialProofError';
  }
}

export class GovernanceCommandError extends Error {
  public readonly code: GovernanceRejectionCode;
  public readonly safeFailure: boolean;

  public constructor(code: GovernanceRejectionCode, message: string, safeFailure = true) {
    super(message);
    this.name = 'GovernanceCommandError';
    this.code = code;
    this.safeFailure = safeFailure;
  }
}

const CONSTRAINT_REJECTIONS: Readonly<Record<string, GovernanceRejectionCode>> = {
  ballot_one_effective_revision_per_voter_idx: 'BALLOT_ALREADY_CAST',
  ballot_participation_voter_unique: 'BALLOT_REPLACEMENT_NOT_ALLOWED',
  candidacies_candidate_unique: 'CANDIDACY_STATE_INVALID',
  charter_authority_intervals_world_id_charter_id_effective_ticks_excl: 'LAW_VERSION_CONFLICT',
  election_results_repair_parent_unique: 'GOVERNANCE_REPAIR_CONFLICT',
  election_results_root_contest_unique: 'RESULT_FINALIZED',
  election_results_root_election_unique: 'RESULT_FINALIZED',
  governance_schedule_occurrences_action_unique: 'AGGREGATE_VERSION_CONFLICT',
  governance_schedule_occurrences_key_unique: 'AGGREGATE_VERSION_CONFLICT',
  law_authority_intervals_world_id_law_id_effective_ticks_excl: 'LAW_VERSION_CONFLICT',
  office_seat_authority_intervals_world_id_seat_id_effective_ticks_excl: 'TERM_CONFLICT',
  office_terms_number_unique: 'TERM_CONFLICT',
  office_terms_start_unique: 'TERM_CONFLICT',
  proposal_results_repair_parent_unique: 'GOVERNANCE_REPAIR_CONFLICT',
  proposal_results_root_contest_unique: 'RESULT_FINALIZED',
  proposal_results_root_proposal_unique: 'RESULT_FINALIZED',
  proposal_sponsors_member_unique: 'CONFLICT',
  treasury_encumbrances_wallet_solvency: 'ENACTMENT_FAILED',
};

export function mapPostgresGovernanceRejection(
  error: GovernancePostgresErrorShape,
): GovernanceCommandError | null {
  const constrainedRejection = error.constraint
    ? CONSTRAINT_REJECTIONS[error.constraint]
    : undefined;
  if (constrainedRejection) {
    return new GovernanceCommandError(
      constrainedRejection,
      'A governance database invariant rejected the command.',
    );
  }
  if (error.code === '40001' || error.code === '40P01') return null;
  if (error.code === '42501') {
    return new GovernanceCommandError(
      'BALLOT_INELIGIBLE',
      'The actor is not eligible for this governance operation.',
    );
  }
  if (error.code === '23505') {
    return new GovernanceCommandError('CONFLICT', 'A governance uniqueness invariant conflicted.');
  }
  if (error.code === '23P01') {
    return new GovernanceCommandError(
      'TERM_CONFLICT',
      'A governance effective interval overlaps an existing interval.',
    );
  }
  if (error.code === '55000') {
    const message = error.message ?? '';
    if (message.includes('contest is not open')) {
      return new GovernanceCommandError('BALLOT_WINDOW_CLOSED', 'The ballot window is closed.');
    }
    return new GovernanceCommandError(
      'AGGREGATE_VERSION_CONFLICT',
      'The governance aggregate changed.',
    );
  }
  if (error.code === '22023') {
    return new GovernanceCommandError('VALIDATION_FAILED', 'Governance input is invalid.');
  }
  return null;
}

export function isRetryableGovernanceTransactionError(error: unknown): boolean {
  const postgres = error as GovernancePostgresErrorShape | null;
  if (postgres?.code === '40001' || postgres?.code === '40P01') return true;
  if (postgres?.code !== '23505' || !postgres.constraint) return false;
  // A SERIALIZABLE waiter takes its snapshot while blocking on the per-world
  // advisory lock. It can therefore miss the just-committed receipt in the
  // replay read but still collide when inserting that exact identity. A fresh
  // transaction safely sees the winner and validates its full request hash.
  return [
    'command_records_pkey',
    'command_records_world_identity',
    'command_records_idempotency_unique',
  ].includes(postgres.constraint);
}
