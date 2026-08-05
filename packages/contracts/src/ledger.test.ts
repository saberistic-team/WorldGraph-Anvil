import { describe, expect, it } from 'vitest';

import {
  AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
  CONTRACT_SCHEMA_VERSION,
  DOMAIN_EVENT_SCHEMA_VERSION,
  HISTORY_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  OUTBOX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  RUNTIME_SCHEMA_VERSION,
  publicCompatibilityVersions,
} from './versions.js';
import {
  DomainEventEnvelopeV1Schema,
  LedgerEntryV1Schema,
  WorldCommandRequestV1Schema,
  WorldCommandResultV1Schema,
  WorldHistoryEntryV1Schema,
} from './ledger.js';
import { createValidator } from './validation.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const actorId = '018f8652-3cb6-7d52-904b-cce7901d7e26';
const commandId = '018f8652-3cb6-7d52-904b-cce7901d7e28';
const eventId = '018f8652-3cb6-7d52-904b-cce7901d7e31';
const at = '2026-07-22T00:01:00.000Z';
const hash = 'a'.repeat(64);

describe('ledger contracts', () => {
  it('advances runtime compatibility without coupling the six ledger axes', () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe(10);
    expect(RUNTIME_SCHEMA_VERSION).toBe(10);
    expect({
      command: AUTHORITATIVE_COMMAND_SCHEMA_VERSION,
      event: DOMAIN_EVENT_SCHEMA_VERSION,
      history: HISTORY_SCHEMA_VERSION,
      ledger: LEDGER_SCHEMA_VERSION,
      outbox: OUTBOX_SCHEMA_VERSION,
      projection: PROJECTION_SCHEMA_VERSION,
    }).toEqual({ command: 1, event: 1, history: 1, ledger: 1, outbox: 1, projection: 1 });
    expect(publicCompatibilityVersions).toMatchObject({
      authoritativeCommandSchema: 1,
      domainEventSchema: 1,
      historySchema: 1,
      ledgerSchema: 1,
      outboxSchema: 1,
      projectionSchema: 1,
    });
  });

  it('accepts only the registered public RenameWorldEntity body and decimal bigint strings', () => {
    const validator = createValidator(WorldCommandRequestV1Schema);
    const request = {
      commandId,
      expectedAggregateVersion: '1',
      expectedStateRevision: '0',
      expectedWorldVersion: '1',
      idempotencyKey: 'rename-harbor-0001',
      payload: { entityKey: 'district:harbor', newDisplayName: 'New Harbor' },
      schemaVersion: 1,
      type: 'RenameWorldEntityV1',
    };
    expect(validator.is(request)).toBe(true);
    expect(validator.is({ ...request, expectedStateRevision: 0 })).toBe(false);
    expect(validator.is({ ...request, actor: { actorId, actorType: 'user' } })).toBe(false);
    expect(validator.is({ ...request, type: 'ArbitraryJsonPatchV1' })).toBe(false);
    expect(
      validator.is({ ...request, payload: { ...request.payload, entityKey: 'another-world-id' } }),
    ).toBe(false);
  });

  it('strictly discriminates accepted and rejected command results', () => {
    const validator = createValidator(WorldCommandResultV1Schema);
    expect(
      validator.is({
        commandId,
        eventIds: [eventId],
        eventSequenceRange: { from: '2', to: '2' },
        ledgerSequenceRange: { from: '2', to: '3' },
        resultingStateRevision: '1',
        schemaVersion: 1,
        status: 'accepted',
      }),
    ).toBe(true);
    expect(
      validator.is({
        commandId,
        currentStateRevision: '3',
        eventIds: [],
        rejectionCode: 'REVISION_CONFLICT',
        schemaVersion: 1,
        status: 'rejected',
      }),
    ).toBe(true);
    expect(
      validator.is({
        commandId,
        eventIds: [eventId],
        rejectionCode: 'REVISION_CONFLICT',
        schemaVersion: 1,
        status: 'rejected',
      }),
    ).toBe(false);
  });

  it('binds a strict event type to its matching payload and canonical UTC time', () => {
    const validator = createValidator(DomainEventEnvelopeV1Schema);
    const event = {
      aggregateId: 'district:harbor',
      aggregateType: 'world_entity',
      aggregateVersion: '2',
      commandId,
      eventHash: hash,
      eventId,
      eventOrdinal: 0,
      eventSchemaVersion: 1,
      eventType: 'WorldEntityRenamedV1',
      metadata: {
        actor: { actorId, actorType: 'user' },
        authorizationRuleId: 'world.creator.entity.rename',
        causationId: null,
        commandSchemaVersion: 1,
        commandType: 'RenameWorldEntityV1',
        correlationId: commandId,
        overrideId: null,
        payloadClassification: 'member',
      },
      occurredAt: at,
      payload: {
        entityKey: 'district:harbor',
        entityType: 'district',
        entityVersion: '2',
        newDisplayName: 'New Harbor',
        previousDisplayName: 'Old Harbor',
      },
      recordedAt: at,
      resultingStateRevision: '1',
      worldEventSequence: '2',
      worldId,
    };
    expect(validator.is(event)).toBe(true);
    expect(validator.is({ ...event, occurredAt: '2026-07-22T00:01:00Z' })).toBe(false);
    expect(
      validator.is({ ...event, payload: { activeWorldVersionId: worldId, artifactHash: hash } }),
    ).toBe(false);
    expect(validator.is({ ...event, eventType: 'UnknownEventV1' })).toBe(false);
  });

  it('enforces ledger link semantics and bounded history fields', () => {
    const ledgerValidator = createValidator(LedgerEntryV1Schema);
    const entry = {
      actor: { actorId, actorType: 'user' },
      commandId,
      entryHash: hash,
      entryId: '018f8652-3cb6-7d52-904b-cce7901d7e32',
      entryKind: 'domain_event',
      eventId,
      ledgerSchemaVersion: 1,
      ledgerSequence: '2',
      previousHash: '0'.repeat(64),
      publicSummaryCode: 'WORLD_ENTITY_RENAMED',
      recordedAt: at,
      redactedDetails: { entityKey: 'district:harbor' },
      worldId,
    };
    expect(ledgerValidator.is(entry)).toBe(true);
    expect(ledgerValidator.is({ ...entry, entryKind: 'command_rejected', eventId })).toBe(false);

    const historyValidator = createValidator(WorldHistoryEntryV1Schema);
    expect(
      historyValidator.is({
        actor: entry.actor,
        category: 'entity',
        commandId,
        correlationId: commandId,
        eventId,
        eventType: 'WorldEntityRenamedV1',
        historySchemaVersion: 1,
        ledgerSequence: '2',
        occurredAt: at,
        resultingStateRevision: '1',
        summaryArgs: { entityKey: 'district:harbor' },
        targetId: 'district:harbor',
        targetType: 'world_entity',
        titleKey: 'history.entity.renamed',
        visibility: 'member',
        worldId,
      }),
    ).toBe(true);
  });
});
