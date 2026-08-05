import type {
  GovernanceAuditViewV1,
  GovernanceCandidacyViewV1,
  GovernanceCharterViewV1,
  GovernanceElectionResultViewV1,
  GovernanceElectionViewV1,
  GovernanceInstitutionViewV1,
  GovernanceLawViewV1,
  GovernanceOfficeTermViewV1,
  GovernanceOfficeViewV1,
  GovernanceProposalResultViewV1,
  GovernanceProposalViewV1,
  GovernanceUiCapabilitiesViewV1,
  GovernanceUiBallotEligibilityV1,
  GovernanceUiCapabilityCodeV1,
  GovernanceUiCapabilityDecisionV1,
} from '@worldgraph/contracts';

export type GovernSection = 'audit' | 'elections' | 'laws' | 'overview' | 'override' | 'proposals';

export interface GovernancePage<T> {
  items: T[];
  page: {
    evaluatedAtTick: string;
    latestEvaluatedAtTick?: string;
    latestProjectionRevision?: string;
    nextCursor: string | null;
    projectionRevision: string;
  };
}

export interface GovernanceReadEvidence {
  evaluatedAtTick: string;
  latestEvaluatedAtTick?: string;
  latestProjectionRevision?: string;
  projectionRevision: string;
}

export type GovernanceCoherenceSource = GovernancePage<unknown> | GovernanceReadEvidence;

export interface GovernanceRuntimeHead {
  activeWorldVersionId: string;
  designVersion: string;
  stateRevision: string;
}

export interface GovernanceClockView {
  aggregateVersion: string;
  clock: { currentTick: string };
  designVersion: string;
  stateRevision: string;
}

export interface GovernanceWorkspaceData {
  audit: GovernanceAuditViewV1[];
  capabilities: GovernanceUiCapabilitiesViewV1;
  charter: GovernanceCharterViewV1;
  elections: GovernanceElectionViewV1[];
  evaluatedAtTick: string;
  institutions: GovernanceInstitutionViewV1[];
  latestEvaluatedAtTick: string;
  laws: GovernanceLawViewV1[];
  latestProjectionRevision: string;
  offices: GovernanceOfficeViewV1[];
  projectionRevision: string;
  proposals: GovernanceProposalViewV1[];
  terms: GovernanceOfficeTermViewV1[];
}

export interface GovernanceProjectionStatus {
  catchingUp: boolean;
  lag: string;
  newestEvaluatedAtTick: string;
  newestProjectionRevision: string;
  oldestEvaluatedAtTick: string;
  oldestProjectionRevision: string;
  revisionMismatch: boolean;
  tickLag: string;
  tickMismatch: boolean;
}

export type {
  GovernanceAuditViewV1,
  GovernanceCandidacyViewV1,
  GovernanceCharterViewV1,
  GovernanceElectionResultViewV1,
  GovernanceElectionViewV1,
  GovernanceInstitutionViewV1,
  GovernanceLawViewV1,
  GovernanceOfficeTermViewV1,
  GovernanceOfficeViewV1,
  GovernanceProposalResultViewV1,
  GovernanceProposalViewV1,
  GovernanceUiCapabilitiesViewV1,
  GovernanceUiBallotEligibilityV1,
  GovernanceUiCapabilityCodeV1,
  GovernanceUiCapabilityDecisionV1,
};

export function formatBasisPoints(value: number): string {
  const whole = Math.trunc(value / 100);
  const fraction = String(value % 100).padStart(2, '0');
  return `${whole}.${fraction}%`;
}

export function humanizeGovernance(value: string): string {
  return value
    .replace(/V[1-9][0-9]*$/u, '')
    .replaceAll(/[_:.-]+/gu, ' ')
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function ballotDisclosureText(policy: GovernanceProposalViewV1['ballotPolicy']): string {
  if (policy.ballotMode === 'secret') {
    return 'Secret ballot · your receipt remains visible, but your selection is not returned.';
  }
  if (policy.disclosure === 'voter_and_choice') return 'Public voter and selection';
  if (policy.disclosure === 'choice_totals') return 'Public choice totals';
  return 'Aggregate turnout only';
}

export function tickWindowState(
  currentTick: string,
  opensAtTick: string,
  closesAtTick: string,
): 'closed' | 'not_open' | 'open' {
  const current = BigInt(currentTick);
  if (current < BigInt(opensAtTick)) return 'not_open';
  return current < BigInt(closesAtTick) ? 'open' : 'closed';
}

export function minimumGovernanceProjectionRevision(
  sources: ReadonlyArray<GovernanceCoherenceSource>,
): string {
  if (sources.length === 0) return '0';
  return sources
    .reduce(
      (minimum, source) => {
        const revision = BigInt(governanceReadEvidence(source).projectionRevision);
        return revision < minimum ? revision : minimum;
      },
      BigInt(governanceReadEvidence(sources[0]!).projectionRevision),
    )
    .toString();
}

export function maximumGovernanceProjectionRevision(
  sources: ReadonlyArray<GovernanceCoherenceSource>,
): string {
  if (sources.length === 0) return '0';
  return sources
    .reduce(
      (maximum, source) => {
        const evidence = governanceReadEvidence(source);
        const revision = BigInt(evidence.latestProjectionRevision ?? evidence.projectionRevision);
        return revision > maximum ? revision : maximum;
      },
      BigInt(
        governanceReadEvidence(sources[0]!).latestProjectionRevision ??
          governanceReadEvidence(sources[0]!).projectionRevision,
      ),
    )
    .toString();
}

export function minimumGovernanceEvaluatedAtTick(
  sources: ReadonlyArray<GovernanceCoherenceSource>,
): string {
  if (sources.length === 0) return '0';
  return sources
    .reduce(
      (minimum, source) => {
        const tick = BigInt(governanceReadEvidence(source).evaluatedAtTick);
        return tick < minimum ? tick : minimum;
      },
      BigInt(governanceReadEvidence(sources[0]!).evaluatedAtTick),
    )
    .toString();
}

export function maximumGovernanceEvaluatedAtTick(
  sources: ReadonlyArray<GovernanceCoherenceSource>,
): string {
  if (sources.length === 0) return '0';
  return sources
    .reduce(
      (maximum, source) => {
        const evidence = governanceReadEvidence(source);
        const tick = BigInt(evidence.latestEvaluatedAtTick ?? evidence.evaluatedAtTick);
        return tick > maximum ? tick : maximum;
      },
      BigInt(
        governanceReadEvidence(sources[0]!).latestEvaluatedAtTick ??
          governanceReadEvidence(sources[0]!).evaluatedAtTick,
      ),
    )
    .toString();
}

export async function loadBoundedGovernancePages<T>(
  read: (cursor: string | null) => Promise<GovernancePage<T>>,
  maximumPages = 10,
): Promise<GovernancePage<T>> {
  const items: T[] = [];
  let cursor: string | null = null;
  let oldestTick: bigint | null = null;
  let newestTick: bigint | null = null;
  let oldest: bigint | null = null;
  let newest: bigint | null = null;
  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    const page = await read(cursor);
    items.push(...page.items);
    const pageOldest = BigInt(page.page.projectionRevision);
    const pageNewest = BigInt(page.page.latestProjectionRevision ?? page.page.projectionRevision);
    const pageOldestTick = BigInt(page.page.evaluatedAtTick);
    const pageNewestTick = BigInt(page.page.latestEvaluatedAtTick ?? page.page.evaluatedAtTick);
    oldest = oldest === null || pageOldest < oldest ? pageOldest : oldest;
    newest = newest === null || pageNewest > newest ? pageNewest : newest;
    oldestTick = oldestTick === null || pageOldestTick < oldestTick ? pageOldestTick : oldestTick;
    newestTick = newestTick === null || pageNewestTick > newestTick ? pageNewestTick : newestTick;
    cursor = page.page.nextCursor;
    if (cursor === null) {
      return {
        items,
        page: {
          evaluatedAtTick: (oldestTick ?? 0n).toString(),
          latestEvaluatedAtTick: (newestTick ?? 0n).toString(),
          latestProjectionRevision: (newest ?? 0n).toString(),
          nextCursor: null,
          projectionRevision: (oldest ?? 0n).toString(),
        },
      };
    }
  }
  throw new Error('GOVERNANCE_PAGE_BOUND_EXCEEDED');
}

export function governanceProjectionStatus(
  oldestProjectionRevision: string,
  newestProjectionRevision: string,
  oldestEvaluatedAtTick: string,
  newestEvaluatedAtTick: string,
): GovernanceProjectionStatus {
  const oldest = BigInt(oldestProjectionRevision);
  const newest = BigInt(newestProjectionRevision);
  const oldestTick = BigInt(oldestEvaluatedAtTick);
  const newestTick = BigInt(newestEvaluatedAtTick);
  const lag = newest > oldest ? newest - oldest : 0n;
  const tickLag = newestTick > oldestTick ? newestTick - oldestTick : 0n;
  const revisionMismatch = oldest !== newest;
  const tickMismatch = oldestTick !== newestTick;
  return {
    catchingUp: revisionMismatch || tickMismatch,
    lag: lag.toString(),
    newestEvaluatedAtTick,
    newestProjectionRevision,
    oldestEvaluatedAtTick,
    oldestProjectionRevision,
    revisionMismatch,
    tickLag: tickLag.toString(),
    tickMismatch,
  };
}

export function governanceCoherenceMessage(status: GovernanceProjectionStatus): string {
  const spans: string[] = [];
  if (status.revisionMismatch) {
    spans.push(
      `Loaded governance reads span ${status.lag} ${status.lag === '1' ? 'revision' : 'revisions'}, from revision ${status.oldestProjectionRevision} through ${status.newestProjectionRevision}.`,
    );
  }
  if (status.tickMismatch) {
    spans.push(
      `They were evaluated across ${status.tickLag} ${status.tickLag === '1' ? 'tick' : 'ticks'}, from tick ${status.oldestEvaluatedAtTick} through ${status.newestEvaluatedAtTick}.`,
    );
  }
  spans.push(
    'Civic actions are paused until the charter, capabilities, and all loaded governance pages share one revision and evaluation tick.',
  );
  return spans.join(' ');
}

function governanceReadEvidence(source: GovernanceCoherenceSource): GovernanceReadEvidence {
  return 'page' in source ? source.page : source;
}

export function governanceCapability(
  capabilities: GovernanceUiCapabilitiesViewV1,
  capability: GovernanceUiCapabilityCodeV1,
  resourceId: string,
): GovernanceUiCapabilityDecisionV1 | null {
  return (
    capabilities.decisions.find(
      (decision) => decision.capability === capability && decision.resourceId === resourceId,
    ) ?? null
  );
}

export function governanceBallotEligible(
  capabilities: GovernanceUiCapabilitiesViewV1,
  targetType: 'election' | 'proposal',
  targetId: string,
  snapshotId: string,
): boolean {
  return (
    governanceBallotEligibility(capabilities, targetType, targetId, snapshotId)?.eligible ?? false
  );
}

export function governanceBallotEligibility(
  capabilities: GovernanceUiCapabilitiesViewV1,
  targetType: 'election' | 'proposal',
  targetId: string,
  snapshotId: string,
): GovernanceUiBallotEligibilityV1 | null {
  return (
    capabilities.ballotEligibility.find(
      (eligibility) =>
        eligibility.targetType === targetType &&
        eligibility.targetId === targetId &&
        eligibility.snapshotId === snapshotId,
    ) ?? null
  );
}

export function actionSummary(action: GovernanceProposalViewV1['action']): string {
  switch (action.actionType) {
    case 'create_law':
      return `Create law “${action.title}” at tick ${action.effectiveFromTick}.`;
    case 'amend_law':
      return `Amend law ${action.lawId} from version ${action.expectedLawVersion}.`;
    case 'repeal_law':
      return `Repeal law ${action.lawId} at tick ${action.effectiveAtTick}.`;
    case 'update_tax':
      return `Set tax policy ${action.taxPolicyId} from exact version ${action.expectedTaxPolicyVersion} to ${formatBasisPoints(action.newRateBps)} at tick ${action.effectiveFromTick}.`;
    case 'authorize_public_project':
      return `Authorize project ${action.projectKey} against budget ${action.budgetKey}: ${action.amountMinor} minor units of currency ${action.currencyId} from treasury wallet ${action.treasuryWalletId} at tick ${action.effectiveAtTick}.`;
    case 'appoint_officeholder':
      return `Appoint ${action.holderEntityKey} to seat ${action.seatIndex + 1}.`;
    case 'approve_world_patch':
      return `Approve world patch ${action.patchId} for tick ${action.effectiveAtTick}.`;
  }
}

export function governanceErrorMessage(code: string, fallback: string): string {
  const messages: Record<string, string> = {
    AGGREGATE_VERSION_CONFLICT: 'Governance changed. Refresh before trying again.',
    AUTHORIZATION_DENIED: 'Your current civic or operator authority does not permit this action.',
    BALLOT_ALREADY_CAST: 'An effective ballot already exists for this voter.',
    BALLOT_INELIGIBLE: 'This world identity is not in the frozen eligibility snapshot.',
    BALLOT_REPLACEMENT_NOT_ALLOWED: 'This charter does not permit ballot replacement.',
    BALLOT_WINDOW_CLOSED: 'The half-open voting window is not currently open.',
    GOVERNANCE_CONTESTS_PAUSED: 'New governance contests are temporarily paused.',
    GOVERNANCE_ENACTMENT_PAUSED: 'Proposal enactment is temporarily paused.',
    GOVERNANCE_OVERRIDES_PAUSED: 'Operator overrides are temporarily paused.',
    GOVERNANCE_VOTING_PAUSED: 'Voting is temporarily paused.',
    REAUTHENTICATION_FAILED: 'The password was not accepted. Check it and try again.',
    RECENT_CREDENTIAL_INVALID:
      'The password verification expired or does not match this command. Review and verify again.',
    RECENT_CREDENTIAL_REQUIRED: 'Review this command and verify your password before submitting.',
    RESULT_FINALIZED: 'This result is immutable. A linked repair is required.',
    TWO_PERSON_APPROVAL_REQUIRED: 'A distinct second operator approval is required.',
  };
  return messages[code] ?? fallback;
}
