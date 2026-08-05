import { describe, expect, it } from 'vitest';

import {
  attachGovernanceApproval,
  governanceApprovalReviewCommand,
  officeAppointmentPayload,
  officeRemovalPayload,
  proposalWithdrawalPayload,
  type GovernanceSubmitCommand,
} from './governance-command-model.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const officeId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const institutionId = '018f8652-3cb6-7d52-904b-cce7901d7e27';
const termId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const proposalId = '018f8652-3cb6-7d52-904b-cce7901d7e29';

describe('governance civic command controls', () => {
  it('binds appointments and removals to the projected aggregate versions', () => {
    const office = {
      aggregateVersion: '7',
      displayName: 'Harbor Speaker',
      institutionId,
      officeId,
      seats: 2,
      stableKey: 'office:harbor-speaker',
      termDurationTicks: '100',
      tieRule: 'vacancy' as const,
      worldId,
    };
    expect(
      officeAppointmentPayload(office, {
        holderEntityKey: 'character:alice',
        reason: 'Charter-authorized interim appointment.',
        seatIndex: '1',
        termEndsAtTick: '120',
        termStartsAtTick: '20',
      }),
    ).toEqual({
      expectedOfficeVersion: '7',
      holderEntityKey: 'character:alice',
      officeId,
      reason: 'Charter-authorized interim appointment.',
      seatIndex: 1,
      termEndsAtTick: '120',
      termStartsAtTick: '20',
    });
    expect(
      officeRemovalPayload(
        {
          aggregateVersion: '3',
          endsAtTick: '120',
          holderEntityKey: 'character:alice',
          officeId,
          seatIndex: 1,
          sourceId: proposalId,
          sourceType: 'appointment',
          startsAtTick: '20',
          status: 'active',
          termId,
          worldId,
        },
        '42',
        'Authority revoked under the charter.',
      ),
    ).toEqual({
      effectiveAtTick: '42',
      expectedTermVersion: '3',
      reason: 'Authority revoked under the charter.',
      termId,
    });
  });

  it('binds withdrawal to the displayed proposal version', () => {
    expect(
      proposalWithdrawalPayload(
        {
          action: {
            actionSchemaVersion: 1,
            actionType: 'update_tax',
            effectiveFromTick: '20',
            expectedTaxPolicyVersion: '1',
            newRateBps: 100,
            taxPolicyId: officeId,
          },
          aggregateVersion: '4',
          approvalThresholdBps: 5001,
          ballotPolicy: {
            ballotMode: 'public',
            disclosure: 'choice_totals',
            replacementAllowed: false,
          },
          body: 'A proposal that its author now needs to withdraw.',
          debateEndsAtTick: '15',
          eligibleCount: null,
          eligibilitySnapshotId: null,
          institutionId,
          proposalId,
          quorumBps: 5000,
          status: 'sponsoring',
          sponsorshipEndsAtTick: '10',
          title: 'Withdrawn proposal',
          turnoutCount: 0,
          votingClosesAtTick: '20',
          votingOpensAtTick: '15',
          worldId,
        },
        'The author is replacing this with a corrected proposal.',
      ),
    ).toEqual({
      expectedProposalVersion: '4',
      proposalId,
      reason: 'The author is replacing this with a corrected proposal.',
    });
  });

  it('attaches only the reviewed approval UUID without regenerating command identity', () => {
    const command: GovernanceSubmitCommand = {
      commandId: proposalId,
      expectedAggregateVersion: '0',
      expectedStateRevision: '44',
      expectedTick: '23',
      expectedWorldVersion: '4',
      idempotencyKey: 'governance-review-command-0001',
      payload: {
        approvalId: null,
        confirmation: 'APPEND LINKED GOVERNANCE REPAIR',
        reason: 'Append a reviewed deterministic recount result.',
      },
      schemaVersion: 1,
      type: 'RepairGovernanceResultV1',
    };

    const review = governanceApprovalReviewCommand(command, 'administrator');
    const attached = attachGovernanceApproval(command, termId);

    expect(review).toEqual({
      ...command,
      actorMode: 'administrator',
      payload: { ...command.payload, approvalId: null },
    });
    expect(attached).toEqual({
      ...command,
      payload: { ...command.payload, approvalId: termId },
    });
    expect(attached.commandId).toBe(command.commandId);
    expect(attached.idempotencyKey).toBe(command.idempotencyKey);
    expect(command.payload['approvalId']).toBeNull();
    expect(governanceApprovalReviewCommand(attached, 'administrator').payload['approvalId']).toBe(
      null,
    );
    expect(() => attachGovernanceApproval(command, 'not-a-uuid')).toThrow(
      'GOVERNANCE_APPROVAL_ID_INVALID',
    );
  });
});
