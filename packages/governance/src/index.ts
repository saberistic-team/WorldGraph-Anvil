import { createHash } from 'node:crypto';

import {
  GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION,
  GOVERNANCE_POLICY_MAX_DEPTH,
  GOVERNANCE_POLICY_MAX_NODES,
  GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION,
  GovernancePolicyEvaluationContextV1Schema,
  GovernancePolicyExpressionV1Schema,
  GovernanceProposalActionV1Schema,
  GovernanceSeedPlanV1Schema,
  GovernanceStableKeySchema,
  canonicalJson,
  createValidator,
  type GovernanceElectionTieRule,
  type GovernancePolicyDecisionV1,
  type GovernancePolicyEvaluationContextV1,
  type GovernancePolicyExpressionV1,
  type GovernanceProposalActionV1,
  type GovernanceProposalChoice,
  type GovernanceSeedPlanV1,
} from '@worldgraph/contracts';

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_TALLY_SIZE = 1_000_000_000;

export type GovernanceDomainErrorCode =
  | 'ACTION_SCHEMA_INVALID'
  | 'ACTION_TAX_OUT_OF_BOUNDS'
  | 'ACTION_TICK_RANGE_INVALID'
  | 'ELECTION_UNKNOWN_CANDIDATE'
  | 'GOVERNANCE_INTEGER_OVERFLOW'
  | 'GOVERNANCE_TICK_INVALID'
  | 'GOVERNANCE_WINDOW_INVALID'
  | 'POLICY_LIMIT_EXCEEDED'
  | 'POLICY_SCHEMA_INVALID'
  | 'SEED_PLAN_INVALID'
  | 'SEED_PLAN_ORDER_INVALID'
  | 'SEED_PLAN_REFERENCE_INVALID'
  | 'TALLY_DUPLICATE_BALLOT'
  | 'TALLY_INVALID'
  | 'TERM_INVALID';

export class GovernanceDomainError extends Error {
  readonly code: GovernanceDomainErrorCode;

  constructor(code: GovernanceDomainErrorCode, message: string) {
    super(message);
    this.name = 'GovernanceDomainError';
    this.code = code;
  }
}

const policyValidator = createValidator<GovernancePolicyExpressionV1>(
  GovernancePolicyExpressionV1Schema,
);
const policyContextValidator = createValidator<GovernancePolicyEvaluationContextV1>(
  GovernancePolicyEvaluationContextV1Schema,
);
const actionValidator = createValidator<GovernanceProposalActionV1>(
  GovernanceProposalActionV1Schema,
);
const seedPlanValidator = createValidator<GovernanceSeedPlanV1>(GovernanceSeedPlanV1Schema);
const stableKeyValidator = createValidator<string>(GovernanceStableKeySchema);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(domain: string, value: unknown): string {
  return createHash('sha256').update(canonicalJson({ domain, value }), 'utf8').digest('hex');
}

export function governanceSeedPlanHashV1(plan: GovernanceSeedPlanV1): string {
  return sha256('worldgraph.governance-seed-plan.v1', plan);
}

function parseNonNegativeInt64(value: string, noun: string): bigint {
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new GovernanceDomainError('GOVERNANCE_TICK_INVALID', `${noun} is not a canonical tick.`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_INT64) {
    throw new GovernanceDomainError(
      'GOVERNANCE_INTEGER_OVERFLOW',
      `${noun} exceeds signed 64-bit storage.`,
    );
  }
  return parsed;
}

function checkedAdd(left: bigint, right: bigint, noun: string): bigint {
  const result = left + right;
  if (result > MAX_INT64) {
    throw new GovernanceDomainError(
      'GOVERNANCE_INTEGER_OVERFLOW',
      `${noun} exceeds signed 64-bit storage.`,
    );
  }
  return result;
}

export interface GovernanceHalfOpenWindowV1 {
  closesAtTick: string;
  opensAtTick: string;
}

export type GovernanceWindowPosition = 'before' | 'open' | 'closed';

export function assertHalfOpenGovernanceWindowV1(
  window: GovernanceHalfOpenWindowV1,
): GovernanceHalfOpenWindowV1 {
  const opens = parseNonNegativeInt64(window.opensAtTick, 'Window opening tick');
  const closes = parseNonNegativeInt64(window.closesAtTick, 'Window closing tick');
  if (opens >= closes) {
    throw new GovernanceDomainError(
      'GOVERNANCE_WINDOW_INVALID',
      'A governance window must be a non-empty half-open interval.',
    );
  }
  return window;
}

export function classifyGovernanceWindowV1(
  tick: string,
  window: GovernanceHalfOpenWindowV1,
): GovernanceWindowPosition {
  assertHalfOpenGovernanceWindowV1(window);
  const current = parseNonNegativeInt64(tick, 'Current tick');
  const opens = BigInt(window.opensAtTick);
  const closes = BigInt(window.closesAtTick);
  if (current < opens) return 'before';
  return current < closes ? 'open' : 'closed';
}

export function isTickInHalfOpenGovernanceWindowV1(
  tick: string,
  window: GovernanceHalfOpenWindowV1,
): boolean {
  return classifyGovernanceWindowV1(tick, window) === 'open';
}

interface PolicyShapeInspection {
  limitExceeded: boolean;
  nodeCount: number;
  repeatedReference: boolean;
}

function inspectPolicyShape(value: unknown): PolicyShapeInspection {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
  const seen = new WeakSet<object>();
  let nodeCount = 0;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    nodeCount += 1;
    if (nodeCount > GOVERNANCE_POLICY_MAX_NODES || entry.depth > GOVERNANCE_POLICY_MAX_DEPTH) {
      return { limitExceeded: true, nodeCount, repeatedReference: false };
    }
    if (entry.value === null || typeof entry.value !== 'object') continue;
    if (seen.has(entry.value)) {
      return { limitExceeded: false, nodeCount, repeatedReference: true };
    }
    seen.add(entry.value);
    const record = entry.value as Record<string, unknown>;
    if ((record.kind === 'all' || record.kind === 'any') && Array.isArray(record.operands)) {
      for (const operand of record.operands) {
        stack.push({ depth: entry.depth + 1, value: operand });
      }
    } else if (record.kind === 'not') {
      stack.push({ depth: entry.depth + 1, value: record.operand });
    }
  }
  return { limitExceeded: false, nodeCount, repeatedReference: false };
}

export function assertGovernancePolicyV1(value: unknown): GovernancePolicyExpressionV1 {
  const inspection = inspectPolicyShape(value);
  if (inspection.limitExceeded) {
    throw new GovernanceDomainError(
      'POLICY_LIMIT_EXCEEDED',
      'Governance policy exceeds the maximum depth or node count.',
    );
  }
  if (inspection.repeatedReference || !policyValidator.is(value)) {
    throw new GovernanceDomainError(
      'POLICY_SCHEMA_INVALID',
      'Governance policy does not match the finite policy schema.',
    );
  }
  validatePolicyTickRanges(value);
  return value;
}

function validatePolicyTickRanges(policy: GovernancePolicyExpressionV1): void {
  if (policy.kind === 'all' || policy.kind === 'any') {
    for (const operand of policy.operands) validatePolicyTickRanges(operand);
    return;
  }
  if (policy.kind === 'not') {
    validatePolicyTickRanges(policy.operand);
    return;
  }
  if (policy.kind === 'tick_between') {
    assertHalfOpenGovernanceWindowV1({
      closesAtTick: policy.untilTick,
      opensAtTick: policy.fromTick,
    });
  } else if (policy.kind === 'tick_at_or_after' || policy.kind === 'tick_before') {
    parseNonNegativeInt64(policy.tick, 'Policy tick');
  }
}

function evaluatePolicyNode(
  policy: GovernancePolicyExpressionV1,
  context: GovernancePolicyEvaluationContextV1,
  counter: { value: number },
): boolean {
  counter.value += 1;
  switch (policy.kind) {
    case 'all':
      return policy.operands.every((operand) => evaluatePolicyNode(operand, context, counter));
    case 'any':
      return policy.operands.some((operand) => evaluatePolicyNode(operand, context, counter));
    case 'not':
      return !evaluatePolicyNode(policy.operand, context, counter);
    case 'actor_mode':
      return context.actorMode === policy.mode;
    case 'membership_role':
      return context.membershipRoles.includes(policy.role);
    case 'holds_office':
      return context.heldOfficeKeys.includes(policy.officeKey);
    case 'member_of_organization':
      return context.organizationKeys.includes(policy.organizationKey);
    case 'action':
      return context.action === policy.action;
    case 'resource':
      return (
        context.resourceType === policy.resourceType &&
        (policy.resourceKey === null || context.resourceKey === policy.resourceKey)
      );
    case 'tick_at_or_after':
      return BigInt(context.tick) >= BigInt(policy.tick);
    case 'tick_before':
      return BigInt(context.tick) < BigInt(policy.tick);
    case 'tick_between':
      return (
        BigInt(context.tick) >= BigInt(policy.fromTick) &&
        BigInt(context.tick) < BigInt(policy.untilTick)
      );
  }
}

export function evaluateGovernancePolicyV1(
  policyInput: unknown,
  contextInput: unknown,
): GovernancePolicyDecisionV1 {
  const inspection = inspectPolicyShape(policyInput);
  if (inspection.limitExceeded) {
    return { allowed: false, evaluatedNodes: 0, reasonCode: 'POLICY_LIMIT_EXCEEDED' };
  }
  if (inspection.repeatedReference || !policyValidator.is(policyInput)) {
    return { allowed: false, evaluatedNodes: 0, reasonCode: 'POLICY_SCHEMA_INVALID' };
  }
  if (!policyContextValidator.is(contextInput)) {
    return { allowed: false, evaluatedNodes: 0, reasonCode: 'POLICY_CONTEXT_INVALID' };
  }
  try {
    validatePolicyTickRanges(policyInput);
    parseNonNegativeInt64(contextInput.tick, 'Authority evaluation tick');
    const counter = { value: 0 };
    const allowed = evaluatePolicyNode(policyInput, contextInput, counter);
    return {
      allowed,
      evaluatedNodes: counter.value,
      reasonCode: allowed ? 'POLICY_ALLOWED' : 'POLICY_NOT_SATISFIED',
    };
  } catch {
    return { allowed: false, evaluatedNodes: 0, reasonCode: 'POLICY_EVALUATION_ERROR' };
  }
}

export interface GovernanceProposalActionBoundsV1 {
  maximumTaxRateBps?: number;
  minimumTaxRateBps?: number;
}

function assertOptionalEndAfterStart(start: string, end: string | null, noun: string): void {
  const parsedStart = parseNonNegativeInt64(start, `${noun} start tick`);
  if (end !== null && parseNonNegativeInt64(end, `${noun} end tick`) <= parsedStart) {
    throw new GovernanceDomainError(
      'ACTION_TICK_RANGE_INVALID',
      `${noun} effective interval must be non-empty and half-open.`,
    );
  }
}

export function assertGovernanceProposalActionV1(
  value: unknown,
  bounds: GovernanceProposalActionBoundsV1 = {},
): GovernanceProposalActionV1 {
  if (!actionValidator.is(value)) {
    throw new GovernanceDomainError(
      'ACTION_SCHEMA_INVALID',
      'Proposal action is not an allowlisted versioned action.',
    );
  }
  const minimumTaxRateBps = bounds.minimumTaxRateBps ?? 0;
  const maximumTaxRateBps = bounds.maximumTaxRateBps ?? 10_000;
  if (
    !Number.isInteger(minimumTaxRateBps) ||
    !Number.isInteger(maximumTaxRateBps) ||
    minimumTaxRateBps < 0 ||
    maximumTaxRateBps > 10_000 ||
    minimumTaxRateBps > maximumTaxRateBps
  ) {
    throw new GovernanceDomainError('ACTION_TAX_OUT_OF_BOUNDS', 'Tax bounds are invalid.');
  }
  switch (value.actionType) {
    case 'create_law':
    case 'amend_law':
      assertOptionalEndAfterStart(value.effectiveFromTick, value.effectiveUntilTick, 'Law version');
      assertGovernancePolicyV1(value.policy);
      break;
    case 'repeal_law':
      parseNonNegativeInt64(value.effectiveAtTick, 'Law repeal tick');
      break;
    case 'update_tax':
      parseNonNegativeInt64(value.effectiveFromTick, 'Tax effective tick');
      if (value.newRateBps < minimumTaxRateBps || value.newRateBps > maximumTaxRateBps) {
        throw new GovernanceDomainError(
          'ACTION_TAX_OUT_OF_BOUNDS',
          'Proposed tax rate exceeds the charter bounds.',
        );
      }
      break;
    case 'authorize_public_project':
      parseNonNegativeInt64(value.effectiveAtTick, 'Public project effective tick');
      if (BigInt(value.amountMinor) > MAX_INT64) {
        throw new GovernanceDomainError(
          'GOVERNANCE_INTEGER_OVERFLOW',
          'Public project amount exceeds signed 64-bit storage.',
        );
      }
      break;
    case 'appoint_officeholder': {
      const starts = parseNonNegativeInt64(value.termStartsAtTick, 'Term start tick');
      const ends = parseNonNegativeInt64(value.termEndsAtTick, 'Term end tick');
      if (starts >= ends) {
        throw new GovernanceDomainError(
          'ACTION_TICK_RANGE_INVALID',
          'Appointment term must be a non-empty half-open interval.',
        );
      }
      break;
    }
    case 'approve_world_patch':
      parseNonNegativeInt64(value.effectiveAtTick, 'Patch effective tick');
      break;
  }
  return value;
}

function assertSortedUnique(values: readonly string[], noun: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => index > 0 && compareText(values[index - 1]!, value) > 0)
  ) {
    throw new GovernanceDomainError(
      'SEED_PLAN_ORDER_INVALID',
      `${noun} keys must be unique and code-point sorted.`,
    );
  }
}

export function assertGovernanceSeedPlanV1(value: unknown): GovernanceSeedPlanV1 {
  if (!seedPlanValidator.is(value)) {
    throw new GovernanceDomainError('SEED_PLAN_INVALID', 'Governance seed plan is invalid.');
  }
  assertOptionalEndAfterStart(
    value.charter.effectiveFromTick,
    value.charter.effectiveUntilTick,
    'Charter version',
  );
  assertGovernancePolicyV1(value.charter.citizenEligibilityPolicy);
  const institutions = value.institutions.map((item) => item.stableKey);
  const offices = value.offices.map((item) => item.stableKey);
  const laws = value.initialLaws.map((item) => item.stableKey);
  assertSortedUnique(institutions, 'Institution');
  assertSortedUnique(offices, 'Office');
  assertSortedUnique(laws, 'Initial law');
  const institutionKeys = new Set(institutions);
  for (const institution of value.institutions) {
    assertSortedUnique(
      institution.powers.map((power) => `${power.action}:${power.resourceType}`),
      `Institution ${institution.stableKey} power`,
    );
    for (const power of institution.powers) assertGovernancePolicyV1(power.policy);
  }
  for (const office of value.offices) {
    if (!institutionKeys.has(office.institutionKey)) {
      throw new GovernanceDomainError(
        'SEED_PLAN_REFERENCE_INVALID',
        `Office ${office.stableKey} references an unknown institution.`,
      );
    }
    parseNonNegativeInt64(office.termDurationTicks, 'Office term duration');
    parseNonNegativeInt64(office.transitionDelayTicks, 'Office transition delay');
    parseNonNegativeInt64(office.electionCadenceTicks, 'Office election cadence');
    assertGovernancePolicyV1(office.eligibilityPolicy);
    assertSortedUnique(
      office.powers.map((power) => `${power.action}:${power.resourceType}`),
      `Office ${office.stableKey} power`,
    );
    for (const power of office.powers) {
      assertSortedUnique(
        power.delegatedOrganizationEntityKeys,
        `Office ${office.stableKey} power delegation`,
      );
      assertGovernancePolicyV1(power.policy);
    }
  }
  for (const law of value.initialLaws) {
    assertOptionalEndAfterStart(law.effectiveFromTick, law.effectiveUntilTick, 'Initial law');
    assertGovernancePolicyV1(law.policy);
  }
  return value;
}

function assertTallyCount(value: number, noun: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TALLY_SIZE) {
    throw new GovernanceDomainError('TALLY_INVALID', `${noun} is outside the tally bounds.`);
  }
}

function assertBasisPoints(value: number, noun: string, minimum = 0): void {
  if (!Number.isInteger(value) || value < minimum || value > 10_000) {
    throw new GovernanceDomainError('TALLY_INVALID', `${noun} is not valid basis points.`);
  }
}

function assertBallotKey(value: string): void {
  const containsControl = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
  if (value.length < 1 || value.length > 240 || containsControl) {
    throw new GovernanceDomainError('TALLY_INVALID', 'Ballot key is invalid.');
  }
}

function assertUniqueBallotKeys(ballots: readonly { ballotKey: string }[]): void {
  for (const ballot of ballots) assertBallotKey(ballot.ballotKey);
  if (new Set(ballots.map((ballot) => ballot.ballotKey)).size !== ballots.length) {
    throw new GovernanceDomainError(
      'TALLY_DUPLICATE_BALLOT',
      'A frozen tally input cannot contain duplicate effective ballots.',
    );
  }
}

function quorumSatisfied(turnout: number, eligible: number, quorumBps: number): boolean {
  return BigInt(turnout) * 10_000n >= BigInt(eligible) * BigInt(quorumBps);
}

export interface ProposalTallyBallotV1 {
  ballotKey: string;
  choice: GovernanceProposalChoice;
}

export interface ProposalTallyInputV1 {
  approvalThresholdBps: number;
  ballots: readonly ProposalTallyBallotV1[];
  eligibleCount: number;
  quorumBps: number;
}

export type ProposalTallyOutcomeV1 = 'passed' | 'rejected_quorum' | 'rejected_threshold';

export interface ProposalTallyResultV1 {
  abstainCount: number;
  algorithmVersion: typeof GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION;
  approvalThresholdBps: number;
  eligibleCount: number;
  inputChecksum: string;
  noCount: number;
  outcome: ProposalTallyOutcomeV1;
  quorumBps: number;
  quorumSatisfied: boolean;
  resultChecksum: string;
  thresholdSatisfied: boolean;
  turnoutCount: number;
  yesCount: number;
}

export function tallyProposalYesNoV1(input: ProposalTallyInputV1): ProposalTallyResultV1 {
  assertTallyCount(input.eligibleCount, 'Eligible count');
  assertBasisPoints(input.quorumBps, 'Quorum');
  assertBasisPoints(input.approvalThresholdBps, 'Approval threshold', 1);
  assertTallyCount(input.ballots.length, 'Ballot count');
  if (input.ballots.length > input.eligibleCount) {
    throw new GovernanceDomainError(
      'TALLY_INVALID',
      'Effective ballot count cannot exceed the frozen eligible count.',
    );
  }
  assertUniqueBallotKeys(input.ballots);
  const ballots = [...input.ballots].sort((left, right) =>
    compareText(left.ballotKey, right.ballotKey),
  );
  let yesCount = 0;
  let noCount = 0;
  let abstainCount = 0;
  for (const ballot of ballots) {
    if (ballot.choice === 'yes') yesCount += 1;
    else if (ballot.choice === 'no') noCount += 1;
    else if (ballot.choice === 'abstain') abstainCount += 1;
    else throw new GovernanceDomainError('TALLY_INVALID', 'Proposal ballot choice is invalid.');
  }
  const turnoutCount = ballots.length;
  const metQuorum = quorumSatisfied(turnoutCount, input.eligibleCount, input.quorumBps);
  const decisiveCount = yesCount + noCount;
  const metThreshold =
    decisiveCount > 0 &&
    BigInt(yesCount) * 10_000n >= BigInt(decisiveCount) * BigInt(input.approvalThresholdBps);
  const outcome: ProposalTallyOutcomeV1 = !metQuorum
    ? 'rejected_quorum'
    : metThreshold
      ? 'passed'
      : 'rejected_threshold';
  const inputChecksum = sha256('worldgraph.governance.proposal-tally-input.v1', {
    algorithmVersion: GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION,
    approvalThresholdBps: input.approvalThresholdBps,
    ballots,
    eligibleCount: input.eligibleCount,
    quorumBps: input.quorumBps,
  });
  const resultWithoutChecksum = {
    abstainCount,
    algorithmVersion: GOVERNANCE_PROPOSAL_TALLY_ALGORITHM_VERSION,
    approvalThresholdBps: input.approvalThresholdBps,
    eligibleCount: input.eligibleCount,
    inputChecksum,
    noCount,
    outcome,
    quorumBps: input.quorumBps,
    quorumSatisfied: metQuorum,
    thresholdSatisfied: metThreshold,
    turnoutCount,
    yesCount,
  };
  return {
    ...resultWithoutChecksum,
    resultChecksum: sha256('worldgraph.governance.proposal-tally-result.v1', resultWithoutChecksum),
  };
}

export interface ElectionTallyBallotV1 {
  ballotKey: string;
  candidateKey: string | null;
}

export interface ElectionPluralityTallyInputV1 {
  ballots: readonly ElectionTallyBallotV1[];
  candidateKeys: readonly string[];
  eligibleCount: number;
  quorumBps: number;
  tieRule: GovernanceElectionTieRule;
}

export type ElectionTallyOutcomeV1 =
  'elected' | 'vacant_no_quorum' | 'vacant_no_votes' | 'vacant_tie';

export interface ElectionCandidateTotalV1 {
  candidateKey: string;
  voteCount: number;
}

export interface ElectionPluralityTallyResultV1 {
  abstainCount: number;
  algorithmVersion: typeof GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION;
  candidateTotals: ElectionCandidateTotalV1[];
  eligibleCount: number;
  inputChecksum: string;
  outcome: ElectionTallyOutcomeV1;
  quorumBps: number;
  quorumSatisfied: boolean;
  resultChecksum: string;
  tieRule: GovernanceElectionTieRule;
  tiedCandidateKeys: string[];
  turnoutCount: number;
  winnerCandidateKey: string | null;
}

export function tallyElectionPluralityV1(
  input: ElectionPluralityTallyInputV1,
): ElectionPluralityTallyResultV1 {
  assertTallyCount(input.eligibleCount, 'Eligible count');
  assertBasisPoints(input.quorumBps, 'Quorum');
  assertTallyCount(input.ballots.length, 'Ballot count');
  if (input.ballots.length > input.eligibleCount) {
    throw new GovernanceDomainError('TALLY_INVALID', 'Ballot count exceeds eligible count.');
  }
  if (input.tieRule !== 'vacancy' && input.tieRule !== 'stable_key') {
    throw new GovernanceDomainError('TALLY_INVALID', 'Election tie rule is invalid.');
  }
  if (input.candidateKeys.length < 1 || input.candidateKeys.length > 128) {
    throw new GovernanceDomainError('TALLY_INVALID', 'Election candidate count is invalid.');
  }
  for (const key of input.candidateKeys) {
    if (!stableKeyValidator.is(key)) {
      throw new GovernanceDomainError('TALLY_INVALID', 'Candidate key is invalid.');
    }
  }
  const candidateKeys = [...input.candidateKeys].sort(compareText);
  if (new Set(candidateKeys).size !== candidateKeys.length) {
    throw new GovernanceDomainError('TALLY_INVALID', 'Candidate keys must be unique.');
  }
  assertUniqueBallotKeys(input.ballots);
  const ballots = [...input.ballots].sort((left, right) =>
    compareText(left.ballotKey, right.ballotKey),
  );
  const counts = new Map(candidateKeys.map((candidateKey) => [candidateKey, 0]));
  let abstainCount = 0;
  for (const ballot of ballots) {
    if (ballot.candidateKey === null) {
      abstainCount += 1;
      continue;
    }
    const current = counts.get(ballot.candidateKey);
    if (current === undefined) {
      throw new GovernanceDomainError(
        'ELECTION_UNKNOWN_CANDIDATE',
        'Election ballot references a candidate outside the frozen contest.',
      );
    }
    counts.set(ballot.candidateKey, current + 1);
  }
  const candidateTotals = candidateKeys.map((candidateKey) => ({
    candidateKey,
    voteCount: counts.get(candidateKey)!,
  }));
  const turnoutCount = ballots.length;
  const metQuorum = quorumSatisfied(turnoutCount, input.eligibleCount, input.quorumBps);
  const nonAbstainCount = turnoutCount - abstainCount;
  let outcome: ElectionTallyOutcomeV1;
  let tiedCandidateKeys: string[] = [];
  let winnerCandidateKey: string | null = null;
  if (!metQuorum) {
    outcome = 'vacant_no_quorum';
  } else if (nonAbstainCount === 0) {
    outcome = 'vacant_no_votes';
  } else {
    const maximum = Math.max(...candidateTotals.map((entry) => entry.voteCount));
    tiedCandidateKeys = candidateTotals
      .filter((entry) => entry.voteCount === maximum)
      .map((entry) => entry.candidateKey);
    if (tiedCandidateKeys.length === 1 || input.tieRule === 'stable_key') {
      outcome = 'elected';
      winnerCandidateKey = tiedCandidateKeys[0]!;
    } else {
      outcome = 'vacant_tie';
    }
  }
  const inputChecksum = sha256('worldgraph.governance.election-tally-input.v1', {
    algorithmVersion: GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION,
    ballots,
    candidateKeys,
    eligibleCount: input.eligibleCount,
    quorumBps: input.quorumBps,
    tieRule: input.tieRule,
  });
  const resultWithoutChecksum = {
    abstainCount,
    algorithmVersion: GOVERNANCE_ELECTION_TALLY_ALGORITHM_VERSION,
    candidateTotals,
    eligibleCount: input.eligibleCount,
    inputChecksum,
    outcome,
    quorumBps: input.quorumBps,
    quorumSatisfied: metQuorum,
    tieRule: input.tieRule,
    tiedCandidateKeys,
    turnoutCount,
    winnerCandidateKey,
  };
  return {
    ...resultWithoutChecksum,
    resultChecksum: sha256('worldgraph.governance.election-tally-result.v1', resultWithoutChecksum),
  };
}

export interface OfficeTermCalculationInputV1 {
  certifiedAtTick: string;
  officeKey: string;
  seatIndex: number;
  termDurationTicks: string;
  transitionDelayTicks: string;
}

export interface OfficeTermCalculationV1 {
  endsAtTick: string;
  officeKey: string;
  seatIndex: number;
  startsAtTick: string;
  termChecksum: string;
}

export function calculateOfficeTermV1(
  input: OfficeTermCalculationInputV1,
): OfficeTermCalculationV1 {
  if (!stableKeyValidator.is(input.officeKey)) {
    throw new GovernanceDomainError('TERM_INVALID', 'Office key is invalid.');
  }
  if (!Number.isInteger(input.seatIndex) || input.seatIndex < 0 || input.seatIndex > 63) {
    throw new GovernanceDomainError('TERM_INVALID', 'Office seat index is invalid.');
  }
  const certified = parseNonNegativeInt64(input.certifiedAtTick, 'Certification tick');
  const delay = parseNonNegativeInt64(input.transitionDelayTicks, 'Transition delay');
  const duration = parseNonNegativeInt64(input.termDurationTicks, 'Term duration');
  if (duration === 0n) {
    throw new GovernanceDomainError('TERM_INVALID', 'Office term duration must be positive.');
  }
  const startsAtTick = checkedAdd(certified, delay, 'Term start tick').toString();
  const endsAtTick = checkedAdd(BigInt(startsAtTick), duration, 'Term end tick').toString();
  const term = { endsAtTick, officeKey: input.officeKey, seatIndex: input.seatIndex, startsAtTick };
  return {
    ...term,
    termChecksum: sha256('worldgraph.governance.office-term.v1', term),
  };
}
