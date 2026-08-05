import { describe, expect, it } from 'vitest';

import type { DomainEventEnvelopeV1, LedgerEntryV1 } from '@worldgraph/contracts';

import { LEDGER_GENESIS_PREVIOUS_HASH, sealLedgerEntryV1 } from './hash.js';
import { projectWorldHistoryEntryV1, renderWorldHistoryTitleV1 } from './history.js';
import { createDefaultEventRegistry } from './registry.js';

const uuid = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const hash = 'a'.repeat(64);

function event(eventType: string, payload: Record<string, unknown>): DomainEventEnvelopeV1 {
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
  } as DomainEventEnvelopeV1;
}

const ledger: LedgerEntryV1 = sealLedgerEntryV1({
  actor: { actorId: uuid, actorType: 'user' },
  commandId: uuid,
  entryId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
  entryKind: 'domain_event',
  eventId: uuid,
  ledgerSchemaVersion: 1,
  ledgerSequence: '12',
  previousHash: LEDGER_GENESIS_PREVIOUS_HASH,
  publicSummaryCode: 'GOVERNANCE_EVENT',
  recordedAt: '2026-08-03T00:00:00.000Z',
  redactedDetails: { eventType: 'GovernanceEventV1' },
  worldId: uuid,
});

describe('governance history projection', () => {
  it('registers every safe governance event for deterministic replay', () => {
    const registered = new Set(
      createDefaultEventRegistry()
        .registeredEvents()
        .map((entry) => entry.eventType),
    );
    for (const eventType of [
      'ProposalBallotRecordedPublicV1',
      'ProposalBallotRecordedSecretV1',
      'ElectionBallotRecordedPublicV1',
      'ElectionBallotRecordedSecretV1',
      'WorldGovernanceInitializedV1',
      'GovernanceSeedPlanAdoptedV1',
      'GovernanceCandidacyChangedV1',
      'GovernanceLifecycleChangedV1',
      'GovernanceResultFinalizedV1',
      'GovernanceLawVersionActivatedV1',
      'GovernanceOfficeTermChangedV1',
      'GovernanceOverrideExecutedV1',
      'GovernanceRepairAppendedV1',
    ]) {
      expect(registered.has(eventType), eventType).toBe(true);
    }
  });

  it('projects secret ballot receipts without voter or choice fields', () => {
    const entry = projectWorldHistoryEntryV1(
      event('ProposalBallotRecordedSecretV1', {
        aggregateVersion: '2',
        ballotMode: 'secret',
        disclosure: 'aggregate_only',
        eventType: 'ProposalBallotRecordedSecretV1',
        proposalId: uuid,
        receiptHash: hash,
      }),
      ledger,
    );
    expect(entry).toMatchObject({
      category: 'governance',
      summaryArgs: { ballotMode: 'secret', contestType: 'proposal', receiptHash: hash },
      titleKey: 'history.governance.ballot_recorded',
    });
    expect(JSON.stringify(entry)).not.toMatch(/choice|voterEntity/iu);
  });

  it('keeps explicit overrides permanently distinct in public governance history', () => {
    const entry = projectWorldHistoryEntryV1(
      event('GovernanceOverrideExecutedV1', {
        actorMode: 'creator',
        eventType: 'GovernanceOverrideExecutedV1',
        impactHash: hash,
        overrideId: uuid,
        reasonCode: 'emergency',
      }),
      ledger,
    );
    expect(entry).toMatchObject({
      category: 'governance',
      summaryArgs: { actorMode: 'creator', overrideUsed: true, reasonCode: 'emergency' },
      targetType: 'governance_override',
      visibility: 'public',
    });
    expect(renderWorldHistoryTitleV1(entry)).toContain('explicit creator governance override');
  });

  it('projects candidacy changes as public governance history', () => {
    const entry = projectWorldHistoryEntryV1(
      event('GovernanceCandidacyChangedV1', {
        candidacyId: uuid,
        electionId: uuid,
        eventType: 'GovernanceCandidacyChangedV1',
        status: 'accepted',
      }),
      ledger,
    );
    expect(entry).toMatchObject({
      category: 'governance',
      summaryArgs: { electionId: uuid, status: 'accepted' },
      targetId: uuid,
      targetType: 'candidacy',
      visibility: 'public',
    });
  });
});
