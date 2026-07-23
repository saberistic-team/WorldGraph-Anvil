import { describe, expect, it } from 'vitest';

import {
  DomainEventEnvelopeV1Schema,
  createValidator,
  type DomainEventEnvelopeV1,
} from '@worldgraph/contracts';

import { sealDomainEventV1, sealLedgerEntryV1 } from './hash.js';
import { projectWorldHistoryEntryV1 } from './history.js';
import { createDefaultEventRegistry } from './registry.js';
import type { WorldProjectionV1 } from './types.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e21';
const at = '2026-07-22T12:00:00.000Z';
const hash = 'a'.repeat(64);

const lifecycleFacts = [
  {
    aggregateId: worldId,
    aggregateType: 'world',
    eventType: 'WorldRenamedV1',
    payload: { newName: 'New Anvil Reach', previousName: 'Anvil Reach' },
  },
  {
    aggregateId: actorId,
    aggregateType: 'world_membership',
    eventType: 'WorldMembershipRoleChangedV1',
    payload: { newRole: 'observer', previousRole: 'player', targetUserId: actorId },
  },
  {
    aggregateId: actorId,
    aggregateType: 'world_membership',
    eventType: 'WorldMembershipRemovedV1',
    payload: { previousRole: 'observer', targetUserId: actorId },
  },
  {
    aggregateId: uuid(40),
    aggregateType: 'world_invitation',
    eventType: 'WorldInvitationCreatedV1',
    payload: { intendedRole: 'player', invitationId: uuid(40) },
  },
  {
    aggregateId: uuid(41),
    aggregateType: 'world_invitation',
    eventType: 'WorldInvitationRevokedV1',
    payload: { intendedRole: 'observer', invitationId: uuid(41) },
  },
  {
    aggregateId: uuid(42),
    aggregateType: 'world_invitation',
    eventType: 'WorldInvitationAcceptedV1',
    payload: { intendedRole: 'player', invitationId: uuid(42), targetUserId: actorId },
  },
  {
    aggregateId: actorId,
    aggregateType: 'world_membership',
    eventType: 'CreatorOverrideUsedV1',
    payload: {
      authorityRuleId: 'creator.override',
      commandType: 'UseCreatorOverrideV1',
      overrideId: uuid(43),
      reasonCode: 'CREATOR_OVERRIDE_USED',
      targetId: actorId,
      targetType: 'world_membership',
    },
  },
  {
    aggregateId: uuid(44),
    aggregateType: 'manifest_revision',
    eventType: 'ManifestRevisionCreatedV1',
    payload: {
      contentHash: hash,
      manifestSchemaVersion: 1,
      revisionId: uuid(44),
      revisionNumber: '2',
      source: 'manual',
    },
  },
  {
    aggregateId: uuid(44),
    aggregateType: 'manifest_revision',
    eventType: 'ManifestApprovedV1',
    payload: { contentHash: hash, manifestSchemaVersion: 1, revisionId: uuid(44) },
  },
] as const;

describe('world lifecycle event contracts', () => {
  it('validates, reduces and projects every allowlisted lifecycle event centrally', () => {
    const validator = createValidator<DomainEventEnvelopeV1>(DomainEventEnvelopeV1Schema);
    const registry = createDefaultEventRegistry();
    let projection: WorldProjectionV1 = {
      activeWorldVersionId: uuid(30),
      controllers: [],
      entities: [],
      projectionSchemaVersion: 1,
      relationships: [],
      stateRevision: '0',
      worldId,
      worldVersionNumber: '1',
    };
    for (const [index, fact] of lifecycleFacts.entries()) {
      const sequence = String(index + 1);
      const event = lifecycleEvent(fact, sequence);
      expect(validator.is(event), fact.eventType).toBe(true);
      projection = registry.apply(projection, event);
      expect(projection.stateRevision).toBe('0');
      const ledger = sealLedgerEntryV1({
        actor: { actorId, actorType: 'user' },
        commandId: event.commandId,
        entryId: uuid(200 + index),
        entryKind: fact.eventType === 'CreatorOverrideUsedV1' ? 'override' : 'domain_event',
        eventId: event.eventId,
        ledgerSchemaVersion: 1,
        ledgerSequence: sequence,
        previousHash: '0'.repeat(64),
        publicSummaryCode: 'LIFECYCLE_EVENT',
        recordedAt: at,
        redactedDetails: {},
        worldId,
      });
      const history = projectWorldHistoryEntryV1(event, ledger);
      expect(history.eventType).toBe(fact.eventType);
      expect(history.titleKey).toMatch(/^history\./u);
    }
  });

  it('rejects non-allowlisted invitation details at the contract boundary', () => {
    const validator = createValidator<DomainEventEnvelopeV1>(DomainEventEnvelopeV1Schema);
    const event = lifecycleEvent(lifecycleFacts[3], '1');
    expect(
      validator.is({ ...event, payload: { ...event.payload, email: 'private@example.test' } }),
    ).toBe(false);
  });
});

function lifecycleEvent(
  fact: (typeof lifecycleFacts)[number],
  sequence: string,
): DomainEventEnvelopeV1 {
  return sealDomainEventV1({
    aggregateId: fact.aggregateId,
    aggregateType: fact.aggregateType,
    aggregateVersion: '1',
    commandId: uuid(100 + Number(sequence)),
    eventId: uuid(150 + Number(sequence)),
    eventOrdinal: 0,
    eventSchemaVersion: 1,
    eventType: fact.eventType,
    metadata: {
      actor: { actorId, actorType: 'user' },
      authorizationRuleId: 'world.lifecycle.authorized',
      causationId: null,
      commandSchemaVersion: 1,
      commandType: 'AdaptLegacyMutationV1',
      correlationId: uuid(90),
      overrideId: fact.eventType === 'CreatorOverrideUsedV1' ? fact.payload.overrideId : null,
      payloadClassification: fact.eventType.includes('Invitation') ? 'private' : 'member',
    },
    occurredAt: at,
    payload: fact.payload,
    recordedAt: at,
    resultingStateRevision: sequence,
    worldEventSequence: sequence,
    worldId,
  } as never);
}

function uuid(value: number): string {
  return `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;
}
