import { describe, expect, it } from 'vitest';

import { DomainEventEnvelopeV1Schema } from './ledger.js';
import { createValidator } from './validation.js';

const uuid = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const hash = 'a'.repeat(64);

function envelope(eventType: string, payload: Record<string, unknown>) {
  return {
    aggregateId: uuid,
    aggregateType: 'governance_contest',
    aggregateVersion: '2',
    commandId: uuid,
    eventHash: hash,
    eventId: uuid,
    eventOrdinal: 0,
    eventSchemaVersion: 1,
    eventType,
    metadata: {
      actor: { actorId: uuid, actorType: 'user' },
      authorizationRuleId: 'governance.compiled_policy.v1',
      causationId: null,
      commandSchemaVersion: 1,
      commandType: 'CastProposalBallotV1',
      correlationId: uuid,
      overrideId: null,
      payloadClassification: 'member',
    },
    occurredAt: '2026-08-03T00:00:00.000Z',
    payload,
    recordedAt: '2026-08-03T00:00:00.000Z',
    resultingStateRevision: '12',
    worldEventSequence: '12',
    worldId: uuid,
  };
}

describe('governance authoritative event envelopes', () => {
  const validator = createValidator(DomainEventEnvelopeV1Schema);

  it('accepts configured public disclosure and rejects mismatched outer discriminators', () => {
    const value = envelope('ProposalBallotRecordedPublicV1', {
      aggregateVersion: '2',
      ballotMode: 'public',
      choice: 'yes',
      disclosure: 'voter_and_choice',
      eventType: 'ProposalBallotRecordedPublicV1',
      proposalId: uuid,
      receiptHash: hash,
      turnoutCount: 1,
      voterEntityKey: 'harbor-city:citizen:one',
    });
    expect(validator.is(value)).toBe(true);
    expect(validator.is({ ...value, eventType: 'ProposalBallotRecordedSecretV1' })).toBe(false);
  });

  it('proves secret ballot events cannot carry a voter-choice linkage', () => {
    const payload = {
      aggregateVersion: '2',
      ballotMode: 'secret',
      disclosure: 'aggregate_only',
      eventType: 'ProposalBallotRecordedSecretV1',
      proposalId: uuid,
      receiptHash: hash,
    };
    expect(validator.is(envelope('ProposalBallotRecordedSecretV1', payload))).toBe(true);
    expect(
      validator.is(
        envelope('ProposalBallotRecordedSecretV1', {
          ...payload,
          choice: 'yes',
          voterEntityKey: 'harbor-city:citizen:one',
        }),
      ),
    ).toBe(false);
  });

  it('accepts initialization, adopted-seed, and candidacy event variants exactly', () => {
    expect(
      validator.is(
        envelope('WorldGovernanceInitializedV1', {
          eventType: 'WorldGovernanceInitializedV1',
          seedPlanHash: hash,
          sourceWorldVersionId: uuid,
        }),
      ),
    ).toBe(true);
    expect(
      validator.is(
        envelope('GovernanceSeedPlanAdoptedV1', {
          adoptionReasonHash: hash,
          eventType: 'GovernanceSeedPlanAdoptedV1',
          seedPlanHash: hash,
        }),
      ),
    ).toBe(true);
    const candidacy = envelope('GovernanceCandidacyChangedV1', {
      candidacyId: uuid,
      electionId: uuid,
      eventType: 'GovernanceCandidacyChangedV1',
      status: 'accepted',
    });
    expect(validator.is(candidacy)).toBe(true);
    expect(
      validator.is({
        ...candidacy,
        payload: { ...candidacy.payload, choice: 'secret', status: 'withdrawn' },
      }),
    ).toBe(false);
  });
});
