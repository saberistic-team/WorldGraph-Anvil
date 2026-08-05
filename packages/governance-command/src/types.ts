import type {
  GovernanceActorMode,
  GovernanceCommandRequestV1,
  GovernanceElectionTieRule,
  GovernanceProposalChoice,
  IdGenerator,
  InternalGovernanceCommandRequestV1,
  PublicGovernanceCommandRequestV1,
  WorldCommandRejectionCode,
  WorldCommandResultV1,
} from '@worldgraph/contracts';

export const PUBLIC_GOVERNANCE_COMMAND_TYPES = [
  'InitializeWorldGovernanceV1',
  'AdoptGovernanceSeedPlanV1',
  'CreateProposalV1',
  'SponsorProposalV1',
  'WithdrawProposalV1',
  'CastProposalBallotV1',
  'NominateCandidateV1',
  'AcceptNominationV1',
  'CastElectionBallotV1',
  'AppointOfficeholderV1',
  'RemoveOfficeholderV1',
  'ExecuteCreatorOverrideV1',
  'RepairGovernanceResultV1',
] as const;

export const INTERNAL_GOVERNANCE_COMMAND_TYPES = [
  'OpenProposalVotingV1',
  'CloseAndTallyProposalV1',
  'CertifyAndEnactProposalV1',
  'OpenElectionV1',
  'CloseAndTallyElectionV1',
  'CertifyElectionV1',
] as const;

export type PublicGovernanceCommandType = (typeof PUBLIC_GOVERNANCE_COMMAND_TYPES)[number];
export type InternalGovernanceCommandType = (typeof INTERNAL_GOVERNANCE_COMMAND_TYPES)[number];
export type GovernanceCommandType = PublicGovernanceCommandType | InternalGovernanceCommandType;

export const PUBLIC_GOVERNANCE_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(
  PUBLIC_GOVERNANCE_COMMAND_TYPES,
);
export const INTERNAL_GOVERNANCE_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(
  INTERNAL_GOVERNANCE_COMMAND_TYPES,
);

export interface GovernanceSqlResult<TRow = Record<string, unknown>> {
  rowCount: number | null;
  rows: TRow[];
}

export interface GovernanceSqlExecutor {
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<GovernanceSqlResult<TRow>>;
}

export interface GovernanceSqlClient extends GovernanceSqlExecutor {
  on?(event: 'error', listener: (error: Error) => void): void;
  release(error?: Error): void;
  removeListener?(event: 'error', listener: (error: Error) => void): void;
}

export interface GovernanceSqlPool {
  connect(): Promise<GovernanceSqlClient>;
}

export type GovernanceCommandActor =
  | {
      actorEntityId: string | null;
      actorId: string;
      actorType: 'user';
    }
  | {
      actorEntityId: null;
      actorId: string;
      actorType: 'platform_admin';
    }
  | {
      actorEntityId: null;
      actorId: string;
      actorType: 'system';
    };

export interface GovernanceAuthoritySourceEvidence {
  contribution: 'allow' | 'context' | 'deny';
  effectiveFromTick?: string;
  effectiveUntilTick?: string | null;
  sourceChecksum: string;
  sourceId: string;
  sourceKind:
    | 'charter'
    | 'institution_power'
    | 'law'
    | 'membership_role'
    | 'organization_membership'
    | 'office_power'
    | 'office_term'
    | 'delegation'
    | 'override';
  sourceVersion: string;
}

export interface GovernanceAuthorizationEvidence {
  actionCode: string;
  allowed: boolean;
  context: Record<string, unknown>;
  reasonCode: string;
  resourceId: string;
  resourceType: string;
  ruleId: string;
  sources?: readonly GovernanceAuthoritySourceEvidence[];
}

export interface GovernanceSchedulerInvocation {
  completedEventId: string;
  dueTick: string;
  occurrenceKey: string;
  scheduledActionId: string;
}

/**
 * Server-only recent-credential evidence. The opaque proof is HMACed before it
 * reaches the command executor and is never part of a command, event, or log.
 */
export interface GovernanceRecentCredentialProof {
  commandRequestHash: Buffer;
  proofHash: Buffer;
  sessionId: string;
  userId: string;
}

export interface GovernanceCommandExecutionInput {
  actor: GovernanceCommandActor;
  authorization: GovernanceAuthorizationEvidence;
  causationId: string | null;
  command: GovernanceCommandRequestV1;
  correlationId: string;
  recentCredential?: GovernanceRecentCredentialProof;
  scheduler?: GovernanceSchedulerInvocation;
  worldId: string;
}

export type PublicGovernanceCommandExecutionInput = Omit<
  GovernanceCommandExecutionInput,
  'command' | 'scheduler'
> & {
  command: PublicGovernanceCommandRequestV1;
  scheduler?: never;
};

export type InternalGovernanceCommandExecutionInput = Omit<
  GovernanceCommandExecutionInput,
  'actor' | 'command' | 'recentCredential' | 'scheduler'
> & {
  actor: Extract<GovernanceCommandActor, { actorType: 'system' }>;
  command: InternalGovernanceCommandRequestV1;
  recentCredential?: never;
  scheduler: GovernanceSchedulerInvocation;
};

export interface RestrictedProposalTallyRequest {
  contestId: string;
  eligibilitySnapshotId: string;
  worldId: string;
}

export interface RestrictedElectionTallyRequest extends RestrictedProposalTallyRequest {
  candidateKeys: readonly string[];
}

export interface RestrictedProposalTallyBallot {
  ballotKey: string;
  choice: GovernanceProposalChoice;
}

export interface RestrictedElectionTallyBallot {
  ballotKey: string;
  candidateKey: string | null;
}

/** Implemented with the worker-only `worldgraph_governance_tally` credentials. */
export interface GovernanceRestrictedTallyExecutor {
  loadElectionBallots(
    request: RestrictedElectionTallyRequest,
  ): Promise<readonly RestrictedElectionTallyBallot[]>;
  loadProposalBallots(
    request: RestrictedProposalTallyRequest,
  ): Promise<readonly RestrictedProposalTallyBallot[]>;
}

export interface GovernanceCommandPolicy {
  allowNewContests: boolean;
  allowEnactment: boolean;
  allowOverrides: boolean;
  allowVoting: boolean;
  maximumTaxRateBps: number;
  minimumTaxRateBps: number;
  nominationRateLimitPerMinute: number;
  contestRateLimitPerHour: number;
  requireTwoPersonOverride: boolean;
  requireTwoPersonRepair: boolean;
  sponsorRateLimitPerMinute: number;
  voteRateLimitPerMinute: number;
}

export interface PostgresGovernanceCommandOptions {
  ids: IdGenerator;
  maximumSerializationAttempts?: number;
  policy?: Partial<GovernanceCommandPolicy>;
  restrictedTallyExecutor?: GovernanceRestrictedTallyExecutor;
  retryDelay?: (attempt: number) => Promise<void>;
  secretHashKey?: string;
}

export interface GovernanceCommandExecutionResult {
  /** Safe, non-authoritative details from a newly committed handler; absent on replay. */
  details?: Record<string, unknown>;
  replayed: boolean;
  result: WorldCommandResultV1;
}

export type GovernanceRejectionCode = Extract<
  WorldCommandRejectionCode,
  | 'AGGREGATE_VERSION_CONFLICT'
  | 'AUTHORIZATION_DENIED'
  | 'BALLOT_ALREADY_CAST'
  | 'BALLOT_INELIGIBLE'
  | 'BALLOT_REPLACEMENT_NOT_ALLOWED'
  | 'BALLOT_WINDOW_CLOSED'
  | 'CANDIDACY_STATE_INVALID'
  | 'COMMAND_TYPE_DISABLED'
  | 'CONFLICT'
  | 'ELECTION_STATE_INVALID'
  | 'ENACTMENT_FAILED'
  | 'EXPECTED_TICK_MISMATCH'
  | 'GOVERNANCE_ALREADY_INITIALIZED'
  | 'GOVERNANCE_CONTESTS_PAUSED'
  | 'GOVERNANCE_ENACTMENT_PAUSED'
  | 'GOVERNANCE_NOT_INITIALIZED'
  | 'GOVERNANCE_OVERRIDES_PAUSED'
  | 'GOVERNANCE_POLICY_DENIED'
  | 'GOVERNANCE_REPAIR_CONFLICT'
  | 'GOVERNANCE_RATE_LIMITED'
  | 'GOVERNANCE_VOTING_PAUSED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INTERNAL_COMMAND_FAILED'
  | 'LAW_VERSION_CONFLICT'
  | 'PROPOSAL_STATE_INVALID'
  | 'RESULT_FINALIZED'
  | 'REVISION_CONFLICT'
  | 'SECRET_TALLY_ROLE_UNAVAILABLE'
  | 'SEED_PLAN_HASH_MISMATCH'
  | 'SEED_PLAN_INCOMPATIBLE'
  | 'TALLY_CHECKSUM_MISMATCH'
  | 'TALLY_NOT_DUE'
  | 'TERM_CONFLICT'
  | 'TWO_PERSON_APPROVAL_REQUIRED'
  | 'VALIDATION_FAILED'
  | 'WORLD_NOT_ACTIVE'
  | 'WORLD_NOT_ANCHORED'
  | 'WORLD_VERSION_CONFLICT'
>;

export interface GovernancePostgresErrorShape {
  code?: string;
  constraint?: string;
  message?: string;
}

export interface GovernanceElectionRuleSnapshot {
  ballotMode: 'public' | 'secret';
  disclosure: 'aggregate_only' | 'choice_totals' | 'voter_and_choice';
  quorumBps: number;
  replacementAllowed: boolean;
  tieRule: GovernanceElectionTieRule;
}

export function isPublicGovernanceCommandType(value: string): value is PublicGovernanceCommandType {
  return PUBLIC_GOVERNANCE_COMMAND_TYPE_SET.has(value);
}

export function isInternalGovernanceCommandType(
  value: string,
): value is InternalGovernanceCommandType {
  return INTERNAL_GOVERNANCE_COMMAND_TYPE_SET.has(value);
}

export function governanceActorModeIsCompatible(
  actorMode: GovernanceActorMode,
  actor: GovernanceCommandActor,
): boolean {
  if (actorMode === 'system') return actor.actorType === 'system';
  if (actorMode === 'in_world') return actor.actorType === 'user' && actor.actorEntityId !== null;
  if (actorMode === 'administrator') return actor.actorType === 'platform_admin';
  return actor.actorType === 'user';
}
