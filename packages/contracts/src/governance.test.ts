import { describe, expect, it } from 'vitest';

import {
  AdoptGovernanceSeedPlanPayloadV1Schema,
  CastProposalBallotV1Schema,
  CloseAndTallyProposalV1Schema,
  GovernanceBallotPolicyV1Schema,
  GovernanceBodySchema,
  GovernanceAuditViewV1Schema,
  GovernanceCharterViewV1Schema,
  GovernanceCommandRequestV1Schema,
  GovernanceElectionReceiptViewV1Schema,
  GovernanceInstitutionPageV1Schema,
  ExecuteCreatorOverrideV1Schema,
  GovernancePolicyExpressionV1Schema,
  GovernanceProposalActionV1Schema,
  GovernanceProposalReceiptViewV1Schema,
  GovernanceProposalStatusSchema,
  GovernanceSeedPlanV1Schema,
  GovernanceUiCapabilitiesViewV1Schema,
  InternalGovernanceCommandRequestV1Schema,
  ProposalBallotRecordedPublicEventV1Schema,
  ProposalBallotRecordedSecretEventV1Schema,
  PublicGovernanceCommandRequestV1Schema,
  SafeGovernanceEventPayloadV1Schema,
} from './governance.js';
import { createValidator } from './validation.js';

const uuid = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const hash = 'a'.repeat(64);
const commandBase = {
  commandId: uuid,
  expectedAggregateVersion: '1',
  expectedStateRevision: '4',
  expectedTick: '12',
  expectedWorldVersion: '2',
  idempotencyKey: 'governance-command-0001',
  schemaVersion: 1,
};

describe('governance audit contracts', () => {
  it('accepts both durable authority reason codes and accountable human reasons', () => {
    const validator = createValidator(GovernanceAuditViewV1Schema);
    const audit = {
      actorMode: 'in_world',
      aggregateId: uuid,
      aggregateType: 'authority_decision',
      auditId: uuid,
      eventType: 'governance.authority_decision',
      occurredAtTick: '12',
      reason: 'ALLOWED',
    };

    expect(validator.is(audit)).toBe(true);
    expect(
      validator.is({ ...audit, eventType: 'governance.override', reason: 'Bounded emergency.' }),
    ).toBe(true);
    expect(validator.is({ ...audit, reason: 'short' })).toBe(false);
  });
});

const citizenPolicy = {
  kind: 'all',
  operands: [
    { kind: 'actor_mode', mode: 'in_world' },
    { kind: 'membership_role', role: 'player' },
    { kind: 'tick_at_or_after', tick: '0' },
  ],
};

const seedPlan = {
  charter: {
    citizenEligibilityPolicy: citizenPolicy,
    effectiveFromTick: '0',
    effectiveUntilTick: null,
    proposalRules: {
      approvalThresholdBps: 5_001,
      ballotPolicy: {
        ballotMode: 'secret',
        disclosure: 'aggregate_only',
        replacementAllowed: false,
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
  initialLaws: [],
  institutions: [
    {
      displayName: 'Guild Council',
      institutionType: 'council',
      jurisdictionEntityKey: 'jurisdiction:harbor-city',
      powers: [
        {
          action: 'governance.proposal.create',
          policy: citizenPolicy,
          resourceType: 'proposal',
        },
      ],
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
      powers: [],
      seats: 1,
      stableKey: 'office:council-speaker',
      termDurationTicks: '100',
      tieRule: 'vacancy',
      transitionDelayTicks: '1',
    },
  ],
};

describe('governance contracts', () => {
  it('allows readable multiline civic text but rejects control characters and trailing whitespace', () => {
    const body = createValidator(GovernanceBodySchema);
    expect(body.is('First paragraph.\n\nSecond paragraph.')).toBe(true);
    expect(body.is('Tab\tseparated text')).toBe(true);
    expect(body.is('Embedded\u0000NUL')).toBe(false);
    expect(body.is('Windows\r\nline ending')).toBe(false);
    expect(body.is('Trailing newline\n')).toBe(false);
    expect(body.is('Trailing space ')).toBe(false);
  });

  it('keeps enums and ballot disclosure finite and secret disclosure aggregate-only', () => {
    const status = createValidator(GovernanceProposalStatusSchema);
    expect(status.is('open')).toBe(true);
    expect(status.is('editing_final_result')).toBe(false);

    const ballotPolicy = createValidator(GovernanceBallotPolicyV1Schema);
    expect(
      ballotPolicy.is({
        ballotMode: 'public',
        disclosure: 'voter_and_choice',
        replacementAllowed: true,
      }),
    ).toBe(true);
    expect(
      ballotPolicy.is({
        ballotMode: 'secret',
        disclosure: 'voter_and_choice',
        replacementAllowed: false,
      }),
    ).toBe(false);
    expect(
      ballotPolicy.is({
        ballotMode: 'secret',
        disclosure: 'aggregate_only',
        replacementAllowed: false,
        revealChoiceAfterClose: true,
      }),
    ).toBe(false);
  });

  it('accepts only the bounded finite policy AST', () => {
    const startedAt = performance.now();
    const validator = createValidator(GovernancePolicyExpressionV1Schema);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(validator.is(citizenPolicy)).toBe(true);
    expect(validator.is({ kind: 'eval_javascript', source: 'return true' })).toBe(false);
    expect(validator.is({ kind: 'all', operands: [] })).toBe(false);
    expect(
      validator.is({
        kind: 'resource',
        resourceKey: null,
        resourceType: 'law',
        arbitraryScope: '*',
      }),
    ).toBe(false);

    let maximumDepth: unknown = { kind: 'actor_mode', mode: 'in_world' };
    for (let depth = 0; depth < 3; depth += 1) {
      maximumDepth = { kind: 'not', operand: maximumDepth };
    }
    expect(validator.is(maximumDepth)).toBe(true);
    const tooDeep = { kind: 'not', operand: maximumDepth };
    expect(validator.is(tooDeep)).toBe(false);
  });

  it('allows only typed proposal actions with bounded targets and text', () => {
    const validator = createValidator(GovernanceProposalActionV1Schema);
    expect(
      validator.is({
        actionSchemaVersion: 1,
        actionType: 'update_tax',
        effectiveFromTick: '20',
        expectedTaxPolicyVersion: '3',
        newRateBps: 250,
        taxPolicyId: uuid,
      }),
    ).toBe(true);
    expect(
      validator.is({
        actionSchemaVersion: 1,
        actionType: 'update_tax',
        effectiveFromTick: '20',
        expectedTaxPolicyVersion: '3',
        newRateBps: 10_001,
        taxPolicyId: uuid,
      }),
    ).toBe(false);
    expect(
      validator.is({
        actionSchemaVersion: 1,
        actionType: 'execute_sql',
        statement: 'UPDATE laws SET active = true',
      }),
    ).toBe(false);
  });

  it('exposes only override effects with durable direct execution paths', () => {
    const validator = createValidator(ExecuteCreatorOverrideV1Schema);
    const command = {
      ...commandBase,
      actorMode: 'administrator',
      payload: {
        approvalId: null,
        confirmation: 'EXECUTE EXPLICIT GOVERNANCE OVERRIDE',
        effect: {
          effectType: 'execute_proposal_action',
          proposalAction: {
            actionSchemaVersion: 1,
            actionType: 'repeal_law',
            effectiveAtTick: '12',
            expectedLawVersion: '1',
            lawId: uuid,
            reason: 'Emergency repeal with an immutable operator record.',
          },
        },
        impact: 'The active law interval closes at the command tick.',
        reason: 'Emergency action approved by the accountable operator.',
      },
      type: 'ExecuteCreatorOverrideV1',
    };
    expect(validator.is(command)).toBe(true);
    expect(
      validator.is({
        ...command,
        payload: {
          ...command.payload,
          effect: {
            effectType: 'execute_proposal_action',
            proposalAction: {
              actionSchemaVersion: 1,
              actionType: 'update_tax',
              effectiveFromTick: '12',
              expectedTaxPolicyVersion: '1',
              newRateBps: 250,
              taxPolicyId: uuid,
            },
          },
        },
      }),
    ).toBe(false);
  });

  it('defines compiler-stable seed data without a runtime world-version UUID', () => {
    const validator = createValidator(GovernanceSeedPlanV1Schema);
    expect(validator.is(seedPlan)).toBe(true);
    expect(validator.is({ ...seedPlan, compiledWorldVersionId: uuid })).toBe(false);
    expect(validator.is({ ...seedPlan, dynamicLegalCode: 'natural language' })).toBe(false);

    const adoption = createValidator(AdoptGovernanceSeedPlanPayloadV1Schema);
    expect(
      adoption.is({
        adoptionReason: 'Explicit legacy world adoption.',
        compiledWorldVersionId: uuid,
        seedPlan,
        seedPlanHash: hash,
        sourceArtifactHash: hash,
      }),
    ).toBe(true);
  });

  it('structurally pins civic and scheduler actor modes and transport allowlists', () => {
    const civic = {
      ...commandBase,
      actorMode: 'in_world',
      payload: {
        choice: 'yes',
        eligibilitySnapshotId: uuid,
        expectedProposalVersion: '2',
        proposalId: uuid,
        replaceExisting: false,
      },
      type: 'CastProposalBallotV1',
    };
    const civicValidator = createValidator(CastProposalBallotV1Schema);
    expect(civicValidator.is(civic)).toBe(true);
    expect(civicValidator.is({ ...civic, actorMode: 'creator' })).toBe(false);

    const scheduled = {
      ...commandBase,
      actorMode: 'system',
      payload: {
        algorithmVersion: 'proposal_yes_no_v1',
        eligibilitySnapshotId: uuid,
        expectedProposalVersion: '2',
        occurrenceKey: 'scheduler:proposal:close:1',
        proposalId: uuid,
      },
      type: 'CloseAndTallyProposalV1',
    };
    expect(createValidator(CloseAndTallyProposalV1Schema).is(scheduled)).toBe(true);
    expect(createValidator(InternalGovernanceCommandRequestV1Schema).is(scheduled)).toBe(true);
    expect(createValidator(GovernanceCommandRequestV1Schema).is(scheduled)).toBe(true);
    expect(createValidator(PublicGovernanceCommandRequestV1Schema).is(scheduled)).toBe(false);
  });

  it('types actor-scoped UI capabilities and discoverable fiscal proposal targets', () => {
    const validator = createValidator(GovernanceUiCapabilitiesViewV1Schema);
    const view = {
      actor: {
        actorEntityId: uuid,
        actorEntityKey: 'character:alex',
        authorityState: 'player',
        membershipRole: 'player',
        platformRole: 'user',
      },
      ballotEligibility: [],
      contractVersion: 1,
      decisions: [],
      evaluatedAtTick: '42',
      projectionRevision: '9',
      proposalTargets: {
        projectEntities: [
          {
            displayName: 'Civic Platform',
            projectEntityId: uuid,
            projectKey: 'district:civic-platform',
          },
        ],
        taxPolicies: [
          {
            currentRateBps: 250,
            currencyCode: 'GCR',
            currencyId: uuid,
            currencyKey: 'currency:gold-civic-reserve',
            expectedPolicyVersion: '3',
            policyId: uuid,
            policyKey: 'tax:harbor-sales',
            taxType: 'sales',
            treasuryWalletId: uuid,
            treasuryWalletKey: 'wallet:treasury:gcr',
          },
        ],
        treasuries: [
          {
            currencyCode: 'GCR',
            currencyId: uuid,
            currencyKey: 'currency:gold-civic-reserve',
            currencyVersion: '2',
            spendableMinor: '900',
            treasuryWalletId: uuid,
            treasuryWalletKey: 'wallet:treasury:gcr',
            treasuryWalletVersion: '4',
          },
        ],
      },
      worldId: uuid,
    };
    expect(validator.is(view)).toBe(true);
    expect(
      validator.is({
        ...view,
        proposalTargets: { ...view.proposalTargets, rawSqlTarget: 'tax_policies' },
      }),
    ).toBe(false);
  });

  it('requires revision and evaluation-tick evidence on charter and page reads', () => {
    const charter = {
      ...seedPlan.charter,
      aggregateVersion: '1',
      charterId: uuid,
      checksum: hash,
      evaluatedAtTick: '42',
      projectionRevision: '9',
      version: '1',
      worldId: uuid,
    };
    const page = {
      items: [],
      page: {
        evaluatedAtTick: '42',
        nextCursor: null,
        projectionRevision: '9',
      },
    };

    expect(createValidator(GovernanceCharterViewV1Schema).is(charter)).toBe(true);
    expect(
      createValidator(GovernanceCharterViewV1Schema).is({
        ...charter,
        evaluatedAtTick: undefined,
      }),
    ).toBe(false);
    expect(createValidator(GovernanceInstitutionPageV1Schema).is(page)).toBe(true);
    expect(
      createValidator(GovernanceInstitutionPageV1Schema).is({
        ...page,
        page: { nextCursor: null, projectionRevision: '9' },
      }),
    ).toBe(false);
  });

  it('makes secret ballot events and receipts incapable of carrying choice linkage', () => {
    const secretEvent = {
      aggregateVersion: '2',
      ballotMode: 'secret',
      disclosure: 'aggregate_only',
      eventType: 'ProposalBallotRecordedSecretV1',
      proposalId: uuid,
      receiptHash: hash,
    };
    const secretValidator = createValidator(ProposalBallotRecordedSecretEventV1Schema);
    expect(secretValidator.is(secretEvent)).toBe(true);
    expect(secretValidator.is({ ...secretEvent, choice: 'yes' })).toBe(false);
    expect(secretValidator.is({ ...secretEvent, voterEntityKey: 'character:alice' })).toBe(false);
    expect(createValidator(SafeGovernanceEventPayloadV1Schema).is(secretEvent)).toBe(true);

    const publicEvent = {
      ...secretEvent,
      ballotMode: 'public',
      choice: 'yes',
      disclosure: 'voter_and_choice',
      eventType: 'ProposalBallotRecordedPublicV1',
      turnoutCount: 1,
      voterEntityKey: 'character:alice',
    };
    expect(createValidator(ProposalBallotRecordedPublicEventV1Schema).is(publicEvent)).toBe(true);
    const aggregatePublicEvent = {
      aggregateVersion: '2',
      ballotMode: 'public',
      disclosure: 'choice_totals',
      eventType: 'ProposalBallotRecordedPublicV1',
      proposalId: uuid,
      turnoutCount: 3,
      yesCount: 2,
      noCount: 1,
      abstainCount: 0,
    };
    const publicValidator = createValidator(ProposalBallotRecordedPublicEventV1Schema);
    expect(publicValidator.is(aggregatePublicEvent)).toBe(true);
    expect(publicValidator.is({ ...aggregatePublicEvent, choice: 'yes' })).toBe(false);
    expect(publicValidator.is({ ...aggregatePublicEvent, voterEntityKey: 'character:alice' })).toBe(
      false,
    );

    const secretReceipt = {
      ballotMode: 'secret',
      castAtTick: '14',
      proposalId: uuid,
      receiptHash: hash,
    };
    expect(createValidator(GovernanceProposalReceiptViewV1Schema).is(secretReceipt)).toBe(true);
    expect(
      createValidator(GovernanceProposalReceiptViewV1Schema).is({
        ...secretReceipt,
        choice: 'yes',
      }),
    ).toBe(false);
    expect(
      createValidator(GovernanceElectionReceiptViewV1Schema).is({
        ballotMode: 'secret',
        castAtTick: '14',
        choice: { candidateKey: 'candidate:alice', choiceType: 'candidate' },
        electionId: uuid,
        receiptHash: hash,
      }),
    ).toBe(false);
  });
});
