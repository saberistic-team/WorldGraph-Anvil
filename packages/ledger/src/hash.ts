import { createHash, timingSafeEqual } from 'node:crypto';

import {
  canonicalJson,
  type DomainEventEnvelopeV1,
  type LedgerEntryV1,
} from '@worldgraph/contracts';

export const DOMAIN_EVENT_HASH_DOMAIN_V1 = 'worldgraph.domain-event.v1' as const;
export const LEDGER_ENTRY_HASH_DOMAIN_V1 = 'worldgraph.ledger-entry.v1' as const;
export const WORLD_PROJECTION_CHECKSUM_DOMAIN_V1 = 'worldgraph.projection.v1' as const;
export const LEDGER_EXPORT_HASH_DOMAIN_V1 = 'worldgraph.ledger-export.v1' as const;
export const LEDGER_GENESIS_PREVIOUS_HASH = '0'.repeat(64);

export type DomainEventHashInputV1 = Omit<DomainEventEnvelopeV1, 'eventHash'>;
export type LedgerEntryHashInputV1 = Omit<LedgerEntryV1, 'entryHash'>;

function sha256Canonical(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

export function canonicalDomainEventHashMaterialV1(
  event: DomainEventHashInputV1 | DomainEventEnvelopeV1,
) {
  return {
    aggregateId: event.aggregateId,
    aggregateType: event.aggregateType,
    aggregateVersion: event.aggregateVersion,
    commandId: event.commandId,
    domain: DOMAIN_EVENT_HASH_DOMAIN_V1,
    eventId: event.eventId,
    eventOrdinal: event.eventOrdinal,
    eventSchemaVersion: event.eventSchemaVersion,
    eventType: event.eventType,
    metadata: event.metadata,
    occurredAt: event.occurredAt,
    payload: event.payload,
    recordedAt: event.recordedAt,
    resultingStateRevision: event.resultingStateRevision,
    worldEventSequence: event.worldEventSequence,
    worldId: event.worldId,
  };
}

export function computeDomainEventHashV1(
  event: DomainEventHashInputV1 | DomainEventEnvelopeV1,
): string {
  return sha256Canonical(canonicalDomainEventHashMaterialV1(event));
}

export function sealDomainEventV1<T extends DomainEventHashInputV1>(
  event: T,
): T & { eventHash: string } {
  return { ...event, eventHash: computeDomainEventHashV1(event) };
}

export function canonicalLedgerEntryHashMaterialV1(entry: LedgerEntryHashInputV1 | LedgerEntryV1) {
  return {
    actorId: entry.actor.actorId,
    actorType: entry.actor.actorType,
    commandId: entry.commandId,
    domain: LEDGER_ENTRY_HASH_DOMAIN_V1,
    entryId: entry.entryId,
    entryKind: entry.entryKind,
    eventId: entry.eventId,
    ledgerSchemaVersion: entry.ledgerSchemaVersion,
    ledgerSequence: entry.ledgerSequence,
    previousHash: entry.previousHash,
    publicSummaryCode: entry.publicSummaryCode,
    recordedAt: entry.recordedAt,
    redactedDetails: entry.redactedDetails,
    worldId: entry.worldId,
  };
}

export function computeLedgerEntryHashV1(entry: LedgerEntryHashInputV1 | LedgerEntryV1): string {
  return sha256Canonical(canonicalLedgerEntryHashMaterialV1(entry));
}

export function sealLedgerEntryV1<T extends LedgerEntryHashInputV1>(
  entry: T,
): T & { entryHash: string } {
  return { ...entry, entryHash: computeLedgerEntryHashV1(entry) };
}

export function hashesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function sha256CanonicalV1(input: unknown): string {
  return sha256Canonical(input);
}
