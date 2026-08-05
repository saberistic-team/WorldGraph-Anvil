import { describe, expect, it } from 'vitest';

import type {
  GovernancePolicyEvaluationContextV1,
  GovernancePolicyExpressionV1,
  GovernanceProposalActionV1,
  GovernanceSeedPlanV1,
} from '@worldgraph/contracts';

import {
  GovernanceDomainError,
  assertGovernancePolicyV1,
  assertGovernanceProposalActionV1,
  assertGovernanceSeedPlanV1,
  assertHalfOpenGovernanceWindowV1,
  calculateOfficeTermV1,
  classifyGovernanceWindowV1,
  evaluateGovernancePolicyV1,
  governanceSeedPlanHashV1,
  isTickInHalfOpenGovernanceWindowV1,
  tallyElectionPluralityV1,
  tallyProposalYesNoV1,
} from './index.js';

const uuid = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const hash = 'a'.repeat(64);

const citizenPolicy: GovernancePolicyExpressionV1 = {
  kind: 'all',
  operands: [
    { kind: 'actor_mode', mode: 'in_world' },
    { kind: 'membership_role', role: 'player' },
    { action: 'governance.vote', kind: 'action' },
    { kind: 'resource', resourceKey: null, resourceType: 'proposal' },
    { fromTick: '10', kind: 'tick_between', untilTick: '20' },
    {
      kind: 'any',
      operands: [
        { kind: 'holds_office', officeKey: 'office:council-speaker' },
        { kind: 'not', operand: { kind: 'membership_role', role: 'suspended' } },
      ],
    },
  ],
};

const context: GovernancePolicyEvaluationContextV1 = {
  action: 'governance.vote',
  actorMode: 'in_world',
  heldOfficeKeys: [],
  membershipRoles: ['player'],
  organizationKeys: ['organization:harbor-guild'],
  resourceKey: 'proposal:transit',
  resourceType: 'proposal',
  tick: '10',
};

function power(action: string) {
  return { action, policy: citizenPolicy, resourceType: 'proposal' };
}

function seedPlan(): GovernanceSeedPlanV1 {
  return {
    charter: {
      citizenEligibilityPolicy: citizenPolicy,
      effectiveFromTick: '0',
      effectiveUntilTick: null,
      proposalRules: {
        approvalThresholdBps: 5_001,
        ballotPolicy: {
          ballotMode: 'public',
          disclosure: 'choice_totals',
          replacementAllowed: true,
        },
        debateTicks: '5',
        minimumSponsors: 1,
        quorumBps: 5_000,
        sponsorshipTicks: '5',
        votingTicks: '5',
      },
      stableKey: 'charter:harbor-city',
      summary: 'The founding civic charter.',
      title: 'Harbor City Charter',
    },
    governanceSeedPlanSchemaVersion: 1,
    initialLaws: [
      {
        effectiveFromTick: '0',
        effectiveUntilTick: null,
        jurisdictionEntityKey: 'jurisdiction:harbor-city',
        policy: citizenPolicy,
        stableKey: 'law:founding-rights',
        summary: 'The initial rights and responsibilities.',
        title: 'Founding Rights',
      },
    ],
    institutions: [
      {
        displayName: 'Guild Council',
        institutionType: 'council',
        jurisdictionEntityKey: 'jurisdiction:harbor-city',
        powers: [power('governance.proposal.create'), power('governance.vote')],
        stableKey: 'institution:guild-council',
        worldEntityKey: 'entity:guild-council',
      },
    ],
    offices: [
      {
        ballotPolicy: {
          ballotMode: 'secret',
          disclosure: 'aggregate_only',
          replacementAllowed: false,
        },
        displayName: 'Council Speaker',
        electionCadenceTicks: '100',
        eligibilityPolicy: citizenPolicy,
        institutionKey: 'institution:guild-council',
        powers: [
          {
            ...power('governance.certify'),
            delegatedOrganizationEntityKeys: ['organization:harbor-guild'],
          },
        ],
        seats: 1,
        stableKey: 'office:council-speaker',
        termDurationTicks: '100',
        tieRule: 'vacancy',
        transitionDelayTicks: '1',
      },
    ],
  };
}

function expectDomainError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('Expected governance domain operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(GovernanceDomainError);
    expect(error).toMatchObject({ code });
  }
}

describe('governance seed plan', () => {
  it('validates semantic closure and hashes canonical input deterministically', () => {
    const plan = seedPlan();
    expect(assertGovernanceSeedPlanV1(plan)).toBe(plan);
    const first = governanceSeedPlanHashV1(plan);
    const second = governanceSeedPlanHashV1(structuredClone(plan));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(
      governanceSeedPlanHashV1({ ...plan, charter: { ...plan.charter, title: 'Changed' } }),
    ).not.toBe(first);
  });

  it('rejects unsorted/duplicate keys, dangling institutions, and invalid windows', () => {
    const plan = seedPlan();
    expectDomainError(
      () =>
        assertGovernanceSeedPlanV1({
          ...plan,
          institutions: [
            { ...plan.institutions[0]!, stableKey: 'institution:zeta' },
            { ...plan.institutions[0]!, stableKey: 'institution:alpha' },
          ],
        }),
      'SEED_PLAN_ORDER_INVALID',
    );
    expectDomainError(
      () =>
        assertGovernanceSeedPlanV1({
          ...plan,
          offices: [{ ...plan.offices[0]!, institutionKey: 'institution:missing' }],
        }),
      'SEED_PLAN_REFERENCE_INVALID',
    );
    expectDomainError(
      () =>
        assertGovernanceSeedPlanV1({
          ...plan,
          initialLaws: [{ ...plan.initialLaws[0]!, effectiveUntilTick: '0' }],
        }),
      'ACTION_TICK_RANGE_INVALID',
    );
  });
});

describe('finite governance policy evaluation', () => {
  it('evaluates every allowlisted predicate deterministically and fails closed', () => {
    expect(assertGovernancePolicyV1(citizenPolicy)).toBe(citizenPolicy);
    expect(evaluateGovernancePolicyV1(citizenPolicy, context)).toMatchObject({
      allowed: true,
      reasonCode: 'POLICY_ALLOWED',
    });
    expect(
      evaluateGovernancePolicyV1(citizenPolicy, { ...context, actorMode: 'creator' }),
    ).toMatchObject({ allowed: false, reasonCode: 'POLICY_NOT_SATISFIED' });
    expect(evaluateGovernancePolicyV1(citizenPolicy, { ...context, tick: '20' })).toMatchObject({
      allowed: false,
      reasonCode: 'POLICY_NOT_SATISFIED',
    });
    expect(evaluateGovernancePolicyV1({ kind: 'arbitrary_code' }, context)).toEqual({
      allowed: false,
      evaluatedNodes: 0,
      reasonCode: 'POLICY_SCHEMA_INVALID',
    });
    expect(evaluateGovernancePolicyV1(citizenPolicy, { ...context, extra: true })).toEqual({
      allowed: false,
      evaluatedNodes: 0,
      reasonCode: 'POLICY_CONTEXT_INVALID',
    });
  });

  it('enforces node/depth budgets before evaluation', () => {
    const largePolicy = {
      kind: 'all',
      operands: Array.from({ length: 8 }, () => ({
        kind: 'all',
        operands: Array.from({ length: 8 }, () => ({ kind: 'actor_mode', mode: 'in_world' })),
      })),
    };
    expect(evaluateGovernancePolicyV1(largePolicy, context)).toEqual({
      allowed: false,
      evaluatedNodes: 0,
      reasonCode: 'POLICY_LIMIT_EXCEEDED',
    });
    expectDomainError(() => assertGovernancePolicyV1(largePolicy), 'POLICY_LIMIT_EXCEEDED');

    let deepPolicy: unknown = { kind: 'actor_mode', mode: 'in_world' };
    for (let depth = 0; depth < 5; depth += 1) deepPolicy = { kind: 'not', operand: deepPolicy };
    expect(evaluateGovernancePolicyV1(deepPolicy, context).reasonCode).toBe(
      'POLICY_LIMIT_EXCEEDED',
    );
  });

  it('property-checks exact half-open tick behavior across a bounded range', () => {
    const tickPolicy: GovernancePolicyExpressionV1 = {
      fromTick: '10',
      kind: 'tick_between',
      untilTick: '20',
    };
    for (let tick = 0; tick <= 30; tick += 1) {
      expect(
        evaluateGovernancePolicyV1(tickPolicy, { ...context, tick: String(tick) }).allowed,
      ).toBe(tick >= 10 && tick < 20);
    }
  });
});

describe('governance windows and actions', () => {
  it('uses half-open [open, close) boundaries and rejects empty/inverted intervals', () => {
    const window = { closesAtTick: '20', opensAtTick: '10' };
    expect(assertHalfOpenGovernanceWindowV1(window)).toBe(window);
    expect(classifyGovernanceWindowV1('9', window)).toBe('before');
    expect(classifyGovernanceWindowV1('10', window)).toBe('open');
    expect(classifyGovernanceWindowV1('19', window)).toBe('open');
    expect(classifyGovernanceWindowV1('20', window)).toBe('closed');
    for (let tick = 0; tick < 30; tick += 1) {
      expect(isTickInHalfOpenGovernanceWindowV1(String(tick), window)).toBe(
        tick >= 10 && tick < 20,
      );
    }
    expectDomainError(
      () => assertHalfOpenGovernanceWindowV1({ closesAtTick: '10', opensAtTick: '10' }),
      'GOVERNANCE_WINDOW_INVALID',
    );
  });

  it('validates every allowlisted action and charter tax/window bounds', () => {
    const actions: GovernanceProposalActionV1[] = [
      {
        actionSchemaVersion: 1,
        actionType: 'create_law',
        effectiveFromTick: '20',
        effectiveUntilTick: null,
        lawKey: 'law:transit-funding',
        policy: citizenPolicy,
        summary: 'Creates a transit funding authority.',
        targetCharterVersion: '1',
        title: 'Transit Funding Act',
      },
      {
        actionSchemaVersion: 1,
        actionType: 'amend_law',
        effectiveFromTick: '20',
        effectiveUntilTick: '40',
        expectedLawVersion: '1',
        lawId: uuid,
        policy: citizenPolicy,
        summary: 'Updates the transit funding authority.',
        title: 'Transit Funding Act',
      },
      {
        actionSchemaVersion: 1,
        actionType: 'repeal_law',
        effectiveAtTick: '40',
        expectedLawVersion: '2',
        lawId: uuid,
        reason: 'The program reached its documented end.',
      },
      {
        actionSchemaVersion: 1,
        actionType: 'update_tax',
        effectiveFromTick: '20',
        expectedTaxPolicyVersion: '1',
        newRateBps: 250,
        taxPolicyId: uuid,
      },
      {
        actionSchemaVersion: 1,
        actionType: 'authorize_public_project',
        amountMinor: '50000',
        budgetKey: 'budget:transit:one',
        currencyId: uuid,
        description: 'Authorizes the first public ferry connection.',
        effectiveAtTick: '20',
        projectKey: 'project:public-ferry',
        treasuryWalletId: uuid,
      },
      {
        actionSchemaVersion: 1,
        actionType: 'appoint_officeholder',
        expectedOfficeVersion: '1',
        holderEntityKey: 'character:alice',
        officeId: uuid,
        seatIndex: 0,
        termEndsAtTick: '120',
        termStartsAtTick: '20',
      },
      {
        actionSchemaVersion: 1,
        actionType: 'approve_world_patch',
        effectiveAtTick: '20',
        expectedWorldVersion: '2',
        patchHash: hash,
        patchId: uuid,
      },
    ];
    for (const action of actions) expect(assertGovernanceProposalActionV1(action)).toBe(action);
    expectDomainError(
      () => assertGovernanceProposalActionV1(actions[3], { maximumTaxRateBps: 200 }),
      'ACTION_TAX_OUT_OF_BOUNDS',
    );
    expectDomainError(
      () =>
        assertGovernanceProposalActionV1({
          ...actions[0],
          effectiveFromTick: '40',
          effectiveUntilTick: '40',
        }),
      'ACTION_TICK_RANGE_INVALID',
    );
    expectDomainError(
      () => assertGovernanceProposalActionV1({ actionSchemaVersion: 1, actionType: 'run_code' }),
      'ACTION_SCHEMA_INVALID',
    );
  });
});

describe('proposal tally', () => {
  it('calculates quorum and approval with abstentions and exact basis-point boundaries', () => {
    const result = tallyProposalYesNoV1({
      approvalThresholdBps: 5_000,
      ballots: [
        { ballotKey: 'receipt:c', choice: 'abstain' },
        { ballotKey: 'receipt:a', choice: 'yes' },
        { ballotKey: 'receipt:b', choice: 'no' },
      ],
      eligibleCount: 6,
      quorumBps: 5_000,
    });
    expect(result).toMatchObject({
      abstainCount: 1,
      noCount: 1,
      outcome: 'passed',
      quorumSatisfied: true,
      thresholdSatisfied: true,
      turnoutCount: 3,
      yesCount: 1,
    });
    expect(result.inputChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.resultChecksum).toMatch(/^[a-f0-9]{64}$/);

    expect(
      tallyProposalYesNoV1({
        approvalThresholdBps: 5_001,
        ballots: [
          { ballotKey: 'receipt:a', choice: 'yes' },
          { ballotKey: 'receipt:b', choice: 'no' },
        ],
        eligibleCount: 2,
        quorumBps: 10_000,
      }).outcome,
    ).toBe('rejected_threshold');
  });

  it('is permutation-invariant and rejects duplicate effective ballots', () => {
    const ballots = [
      { ballotKey: 'receipt:a', choice: 'yes' as const },
      { ballotKey: 'receipt:b', choice: 'yes' as const },
      { ballotKey: 'receipt:c', choice: 'no' as const },
    ];
    const first = tallyProposalYesNoV1({
      approvalThresholdBps: 5_001,
      ballots,
      eligibleCount: 5,
      quorumBps: 5_000,
    });
    const second = tallyProposalYesNoV1({
      approvalThresholdBps: 5_001,
      ballots: [...ballots].reverse(),
      eligibleCount: 5,
      quorumBps: 5_000,
    });
    expect(second).toEqual(first);
    expectDomainError(
      () =>
        tallyProposalYesNoV1({
          approvalThresholdBps: 5_001,
          ballots: [ballots[0]!, ballots[0]!],
          eligibleCount: 2,
          quorumBps: 0,
        }),
      'TALLY_DUPLICATE_BALLOT',
    );
  });

  it('property-checks count conservation over small exhaustive tallies', () => {
    for (let yes = 0; yes <= 5; yes += 1) {
      for (let no = 0; no <= 5; no += 1) {
        for (let abstain = 0; abstain <= 3; abstain += 1) {
          const choices = [
            ...Array.from({ length: yes }, () => 'yes' as const),
            ...Array.from({ length: no }, () => 'no' as const),
            ...Array.from({ length: abstain }, () => 'abstain' as const),
          ];
          const result = tallyProposalYesNoV1({
            approvalThresholdBps: 5_001,
            ballots: choices.map((choice, index) => ({ ballotKey: `receipt:${index}`, choice })),
            eligibleCount: choices.length + 1,
            quorumBps: 0,
          });
          expect(result.yesCount + result.noCount + result.abstainCount).toBe(result.turnoutCount);
          expect(result.turnoutCount).toBe(choices.length);
        }
      }
    }
  });
});

describe('election plurality tally', () => {
  const candidateKeys = ['candidate:alice', 'candidate:bob'];

  it('applies deterministic stable-key and vacancy tie rules', () => {
    const ballots = [
      { ballotKey: 'receipt:b', candidateKey: 'candidate:bob' },
      { ballotKey: 'receipt:a', candidateKey: 'candidate:alice' },
    ];
    const deterministic = tallyElectionPluralityV1({
      ballots,
      candidateKeys,
      eligibleCount: 2,
      quorumBps: 10_000,
      tieRule: 'stable_key',
    });
    expect(deterministic).toMatchObject({
      outcome: 'elected',
      tiedCandidateKeys: candidateKeys,
      winnerCandidateKey: 'candidate:alice',
    });
    expect(
      tallyElectionPluralityV1({
        ballots,
        candidateKeys,
        eligibleCount: 2,
        quorumBps: 10_000,
        tieRule: 'vacancy',
      }),
    ).toMatchObject({ outcome: 'vacant_tie', winnerCandidateKey: null });
  });

  it('distinguishes no quorum/no votes and rejects unknown candidates', () => {
    expect(
      tallyElectionPluralityV1({
        ballots: [{ ballotKey: 'receipt:a', candidateKey: 'candidate:alice' }],
        candidateKeys,
        eligibleCount: 3,
        quorumBps: 5_000,
        tieRule: 'vacancy',
      }).outcome,
    ).toBe('vacant_no_quorum');
    expect(
      tallyElectionPluralityV1({
        ballots: [{ ballotKey: 'receipt:a', candidateKey: null }],
        candidateKeys,
        eligibleCount: 1,
        quorumBps: 10_000,
        tieRule: 'vacancy',
      }).outcome,
    ).toBe('vacant_no_votes');
    expectDomainError(
      () =>
        tallyElectionPluralityV1({
          ballots: [{ ballotKey: 'receipt:a', candidateKey: 'candidate:mallory' }],
          candidateKeys,
          eligibleCount: 1,
          quorumBps: 0,
          tieRule: 'vacancy',
        }),
      'ELECTION_UNKNOWN_CANDIDATE',
    );
  });

  it('produces identical canonical checksums for every ballot/candidate permutation', () => {
    const input = {
      ballots: [
        { ballotKey: 'receipt:c', candidateKey: null },
        { ballotKey: 'receipt:a', candidateKey: 'candidate:alice' },
        { ballotKey: 'receipt:b', candidateKey: 'candidate:bob' },
      ],
      candidateKeys,
      eligibleCount: 4,
      quorumBps: 5_000,
      tieRule: 'stable_key' as const,
    };
    const first = tallyElectionPluralityV1(input);
    const second = tallyElectionPluralityV1({
      ...input,
      ballots: [...input.ballots].reverse(),
      candidateKeys: [...candidateKeys].reverse(),
    });
    expect(second).toEqual(first);
  });
});

describe('deterministic office terms', () => {
  it('calculates half-open terms from certification, delay, and duration', () => {
    expect(
      calculateOfficeTermV1({
        certifiedAtTick: '100',
        officeKey: 'office:council-speaker',
        seatIndex: 0,
        termDurationTicks: '200',
        transitionDelayTicks: '1',
      }),
    ).toMatchObject({ endsAtTick: '301', startsAtTick: '101' });
  });

  it('property-checks duration and rejects zero/overflow', () => {
    for (let certified = 0; certified < 50; certified += 1) {
      const term = calculateOfficeTermV1({
        certifiedAtTick: String(certified),
        officeKey: 'office:council-speaker',
        seatIndex: certified % 2,
        termDurationTicks: '10',
        transitionDelayTicks: '2',
      });
      expect(BigInt(term.endsAtTick) - BigInt(term.startsAtTick)).toBe(10n);
      expect(term.startsAtTick).toBe(String(certified + 2));
    }
    expectDomainError(
      () =>
        calculateOfficeTermV1({
          certifiedAtTick: '1',
          officeKey: 'office:council-speaker',
          seatIndex: 0,
          termDurationTicks: '0',
          transitionDelayTicks: '0',
        }),
      'TERM_INVALID',
    );
    expectDomainError(
      () =>
        calculateOfficeTermV1({
          certifiedAtTick: '9223372036854775807',
          officeKey: 'office:council-speaker',
          seatIndex: 0,
          termDurationTicks: '1',
          transitionDelayTicks: '1',
        }),
      'GOVERNANCE_INTEGER_OVERFLOW',
    );
  });
});
