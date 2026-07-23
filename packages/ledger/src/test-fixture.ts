import type {
  DomainEventEnvelopeV1,
  LedgerEntryV1,
  WorldCommandEnvelopeV1,
} from '@worldgraph/contracts';

import { LEDGER_GENESIS_PREVIOUS_HASH, sealDomainEventV1, sealLedgerEntryV1 } from './hash.js';
import { computeWorldProjectionChecksumV1 } from './replay.js';
import type { WorldProjectionV1 } from './types.js';

export const FIXTURE_WORLD_ID = '018f8652-3cb6-7d52-904b-cce7901d7e25';
export const FIXTURE_WORLD_VERSION_ID = '018f8652-3cb6-7d52-904b-cce7901d7e27';
export const FIXTURE_ACTOR_ID = '018f8652-3cb6-7d52-904b-cce7901d7e26';
export const FIXTURE_COMMAND_ID = '018f8652-3cb6-7d52-904b-cce7901d7e28';
export const FIXTURE_GENESIS_COMMAND_ID = '018f8652-3cb6-7d52-904b-cce7901d7e29';

export function createFixtureProjection(): WorldProjectionV1 {
  return {
    activeWorldVersionId: FIXTURE_WORLD_VERSION_ID,
    controllers: [],
    entities: [
      {
        entitySchemaVersion: 1,
        entityType: 'district',
        entityVersion: '1',
        logicalKey: 'district:harbor',
        state: { name: 'Old Harbor', parameters: {}, primitiveRef: 'district-core' },
      },
      {
        entitySchemaVersion: 1,
        entityType: 'organization',
        entityVersion: '1',
        logicalKey: 'organization:pilots',
        state: {
          homeDistrictLogicalKey: 'district:harbor',
          name: 'Harbor Pilots',
          parameters: {},
          primitiveRef: 'organization-core',
        },
      },
    ],
    projectionSchemaVersion: 1,
    relationships: [
      {
        attributes: { manifestRelationshipKey: 'pilots-govern-harbor' },
        logicalKey: 'rel:pilots:govern:harbor',
        relationshipSchemaVersion: 1,
        relationshipType: 'governs',
        sourceLogicalKey: 'organization:pilots',
        targetLogicalKey: 'district:harbor',
      },
    ],
    stateRevision: '0',
    worldId: FIXTURE_WORLD_ID,
    worldVersionNumber: '1',
  };
}

export function createFixtureCommand(
  overrides: Partial<WorldCommandEnvelopeV1> = {},
): WorldCommandEnvelopeV1 {
  return {
    actor: { actorId: FIXTURE_ACTOR_ID, actorType: 'user' },
    causationId: null,
    commandId: FIXTURE_COMMAND_ID,
    correlationId: FIXTURE_COMMAND_ID,
    expectedAggregateVersion: '1',
    expectedStateRevision: '0',
    expectedWorldVersion: '1',
    idempotencyKey: 'rename-harbor-0001',
    overrideId: null,
    payload: { entityKey: 'district:harbor', newDisplayName: 'New Harbor' },
    schemaVersion: 1,
    type: 'RenameWorldEntityV1',
    worldId: FIXTURE_WORLD_ID,
    ...overrides,
  };
}

const userMetadata = {
  actor: { actorId: FIXTURE_ACTOR_ID, actorType: 'user' as const },
  authorizationRuleId: 'world.creator.entity.rename',
  causationId: null,
  commandSchemaVersion: 1 as const,
  commandType: 'RenameWorldEntityV1',
  correlationId: FIXTURE_COMMAND_ID,
  overrideId: null,
  payloadClassification: 'member' as const,
};

export function createFixtureEvents(): readonly DomainEventEnvelopeV1[] {
  const projection = createFixtureProjection();
  const genesis = sealDomainEventV1({
    aggregateId: FIXTURE_WORLD_ID,
    aggregateType: 'world',
    aggregateVersion: '1',
    commandId: FIXTURE_GENESIS_COMMAND_ID,
    eventId: '018f8652-3cb6-7d52-904b-cce7901d7e30',
    eventOrdinal: 0,
    eventSchemaVersion: 1,
    eventType: 'WorldStateImportedV1',
    metadata: {
      actor: { actorId: 'worldgraph.backfill', actorType: 'system' },
      authorizationRuleId: 'ledger.genesis.backfill',
      causationId: null,
      commandSchemaVersion: 1,
      commandType: 'AnchorWorldStateV1',
      correlationId: FIXTURE_GENESIS_COMMAND_ID,
      overrideId: null,
      payloadClassification: 'member',
    },
    occurredAt: '2026-07-22T00:00:00.000Z',
    payload: {
      activeWorldVersionId: FIXTURE_WORLD_VERSION_ID,
      artifactHash: 'a'.repeat(64),
      projectionSchemaVersions: {
        controllers: 1,
        entities: 1,
        relationships: 1,
        runtimeHead: 1,
      },
      rowCounts: { controllers: '0', entities: '2', relationships: '1' },
      stateChecksum: computeWorldProjectionChecksumV1(projection),
      worldVersionNumber: '1',
    },
    recordedAt: '2026-07-22T00:00:00.000Z',
    resultingStateRevision: '0',
    worldEventSequence: '1',
    worldId: FIXTURE_WORLD_ID,
  });
  const renamed = sealDomainEventV1({
    aggregateId: 'district:harbor',
    aggregateType: 'world_entity',
    aggregateVersion: '2',
    commandId: FIXTURE_COMMAND_ID,
    eventId: '018f8652-3cb6-7d52-904b-cce7901d7e31',
    eventOrdinal: 0,
    eventSchemaVersion: 1,
    eventType: 'WorldEntityRenamedV1',
    metadata: userMetadata,
    occurredAt: '2026-07-22T00:01:00.000Z',
    payload: {
      entityKey: 'district:harbor',
      entityType: 'district',
      entityVersion: '2',
      newDisplayName: 'New Harbor',
      previousDisplayName: 'Old Harbor',
    },
    recordedAt: '2026-07-22T00:01:00.000Z',
    resultingStateRevision: '1',
    worldEventSequence: '2',
    worldId: FIXTURE_WORLD_ID,
  });
  return [genesis, renamed] as readonly DomainEventEnvelopeV1[];
}

export function createFixtureLedger(): {
  entries: readonly LedgerEntryV1[];
  events: readonly DomainEventEnvelopeV1[];
} {
  const events = createFixtureEvents();
  const genesis = events[0]!;
  const renamed = events[1]!;
  const first = sealLedgerEntryV1({
    actor: genesis.metadata.actor,
    commandId: genesis.commandId,
    entryId: '018f8652-3cb6-7d52-904b-cce7901d7e32',
    entryKind: 'domain_event',
    eventId: genesis.eventId,
    ledgerSchemaVersion: 1,
    ledgerSequence: '1',
    previousHash: LEDGER_GENESIS_PREVIOUS_HASH,
    publicSummaryCode: 'WORLD_STATE_IMPORTED',
    recordedAt: genesis.recordedAt,
    redactedDetails: { eventType: genesis.eventType },
    worldId: FIXTURE_WORLD_ID,
  });
  const second = sealLedgerEntryV1({
    actor: userMetadata.actor,
    commandId: FIXTURE_COMMAND_ID,
    entryId: '018f8652-3cb6-7d52-904b-cce7901d7e33',
    entryKind: 'command_accepted',
    eventId: null,
    ledgerSchemaVersion: 1,
    ledgerSequence: '2',
    previousHash: first.entryHash,
    publicSummaryCode: 'COMMAND_ACCEPTED',
    recordedAt: renamed.recordedAt,
    redactedDetails: { commandType: 'RenameWorldEntityV1' },
    worldId: FIXTURE_WORLD_ID,
  });
  const third = sealLedgerEntryV1({
    actor: userMetadata.actor,
    commandId: FIXTURE_COMMAND_ID,
    entryId: '018f8652-3cb6-7d52-904b-cce7901d7e34',
    entryKind: 'domain_event',
    eventId: renamed.eventId,
    ledgerSchemaVersion: 1,
    ledgerSequence: '3',
    previousHash: second.entryHash,
    publicSummaryCode: 'WORLD_ENTITY_RENAMED',
    recordedAt: renamed.recordedAt,
    redactedDetails: { entityKey: 'district:harbor', eventType: renamed.eventType },
    worldId: FIXTURE_WORLD_ID,
  });
  return {
    entries: [first, second, third] as readonly LedgerEntryV1[],
    events,
  };
}
