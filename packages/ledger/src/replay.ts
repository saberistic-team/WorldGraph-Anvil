import {
  LEDGER_SCHEMA_VERSION,
  canonicalJson,
  createValidator,
  DomainEventEnvelopeV1Schema,
  LedgerEntryV1Schema,
  type DomainEventEnvelopeV1,
  type LedgerEntryV1,
  type Validator,
} from '@worldgraph/contracts';

import {
  LEDGER_EXPORT_HASH_DOMAIN_V1,
  LEDGER_GENESIS_PREVIOUS_HASH,
  computeDomainEventHashV1,
  computeLedgerEntryHashV1,
  hashesEqual,
  sha256CanonicalV1,
} from './hash.js';
import { createDefaultEventRegistry, type EventRegistryV1 } from './registry.js';
import { computeWorldProjectionChecksumV1 } from './projection.js';
import type {
  LedgerExportV1,
  LedgerVerificationFailureV1,
  LedgerVerificationResultV1,
  ReplayWorldProjectionInputV1,
  ReplayWorldProjectionResultV1,
  WorldProjectionV1,
} from './types.js';

const eventValidator: Validator<DomainEventEnvelopeV1> = createValidator<DomainEventEnvelopeV1>(
  DomainEventEnvelopeV1Schema,
);
const entryValidator: Validator<LedgerEntryV1> =
  createValidator<LedgerEntryV1>(LedgerEntryV1Schema);

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function verificationFailure(
  worldId: string | null,
  sequence: string,
  code: LedgerVerificationFailureV1['code'],
  expected: string | null,
  actual: string | null,
  message: string,
): LedgerVerificationFailureV1 {
  return {
    actual,
    code,
    expected,
    firstBadLedgerSequence: sequence,
    message,
    valid: false,
    worldId,
  };
}

export function verifyLedgerChainV1(input: {
  entries: readonly LedgerEntryV1[];
  events?: readonly DomainEventEnvelopeV1[];
  expectedWorldId?: string;
  initialPreviousHash?: string;
  startLedgerSequence?: string;
}): LedgerVerificationResultV1 {
  const expectedWorldId = input.expectedWorldId ?? input.entries[0]?.worldId ?? null;
  const eventById = new Map<string, DomainEventEnvelopeV1>();
  for (const event of input.events ?? []) {
    if (eventById.has(event.eventId)) {
      return verificationFailure(
        expectedWorldId,
        '0',
        'EVENT_LINK_DUPLICATE',
        null,
        event.eventId,
        `Duplicate event ID ${event.eventId}.`,
      );
    }
    eventById.set(event.eventId, event);
  }

  let expectedSequence = BigInt(input.startLedgerSequence ?? '1');
  let previousHash = input.initialPreviousHash ?? LEDGER_GENESIS_PREVIOUS_HASH;
  let expectedEventSequence = 1n;
  const linkedEventIds = new Set<string>();

  for (const entry of input.entries) {
    const sequence = expectedSequence.toString();
    try {
      if (!entryValidator.is(entry)) throw new TypeError('Invalid ledger entry.');
    } catch {
      return verificationFailure(
        expectedWorldId,
        sequence,
        'ENTRY_HASH_MISMATCH',
        null,
        null,
        `Ledger entry at ${sequence} does not match schema v1.`,
      );
    }
    if (entry.ledgerSequence !== sequence) {
      return verificationFailure(
        expectedWorldId,
        sequence,
        'LEDGER_SEQUENCE_GAP',
        sequence,
        entry.ledgerSequence,
        `Expected ledger sequence ${sequence}.`,
      );
    }
    if (expectedWorldId !== null && entry.worldId !== expectedWorldId) {
      return verificationFailure(
        expectedWorldId,
        sequence,
        'WORLD_MISMATCH',
        expectedWorldId,
        entry.worldId,
        `Ledger entry ${sequence} belongs to another world.`,
      );
    }
    if (!hashesEqual(entry.previousHash, previousHash)) {
      return verificationFailure(
        expectedWorldId,
        sequence,
        'PREVIOUS_HASH_MISMATCH',
        previousHash,
        entry.previousHash,
        `Ledger previous hash diverges at ${sequence}.`,
      );
    }
    const expectedEntryHash = computeLedgerEntryHashV1(entry);
    if (!hashesEqual(entry.entryHash, expectedEntryHash)) {
      return verificationFailure(
        expectedWorldId,
        sequence,
        'ENTRY_HASH_MISMATCH',
        expectedEntryHash,
        entry.entryHash,
        `Ledger entry hash diverges at ${sequence}.`,
      );
    }

    if (entry.eventId !== null) {
      const event = eventById.get(entry.eventId);
      if (!event) {
        return verificationFailure(
          expectedWorldId,
          sequence,
          'EVENT_MISSING',
          entry.eventId,
          null,
          `Ledger event ${entry.eventId} is missing.`,
        );
      }
      if (linkedEventIds.has(event.eventId)) {
        return verificationFailure(
          expectedWorldId,
          sequence,
          'EVENT_LINK_DUPLICATE',
          null,
          event.eventId,
          `Event ${event.eventId} is linked more than once.`,
        );
      }
      linkedEventIds.add(event.eventId);
      if (event.worldId !== entry.worldId) {
        return verificationFailure(
          expectedWorldId,
          sequence,
          'EVENT_WORLD_MISMATCH',
          entry.worldId,
          event.worldId,
          `Event world scope diverges at ledger ${sequence}.`,
        );
      }
      if (event.worldEventSequence !== expectedEventSequence.toString()) {
        return verificationFailure(
          expectedWorldId,
          sequence,
          'EVENT_SEQUENCE_GAP',
          expectedEventSequence.toString(),
          event.worldEventSequence,
          `Event sequence diverges at ledger ${sequence}.`,
        );
      }
      const expectedEventHash = computeDomainEventHashV1(event);
      if (!hashesEqual(event.eventHash, expectedEventHash)) {
        return verificationFailure(
          expectedWorldId,
          sequence,
          'EVENT_HASH_MISMATCH',
          expectedEventHash,
          event.eventHash,
          `Event hash diverges at ledger ${sequence}.`,
        );
      }
      expectedEventSequence += 1n;
    }

    previousHash = entry.entryHash;
    expectedSequence += 1n;
  }

  const firstUnlinkedEvent = [...eventById.values()]
    .filter((event) => !linkedEventIds.has(event.eventId))
    .sort((left, right) => {
      const sequenceOrder = BigInt(left.worldEventSequence) - BigInt(right.worldEventSequence);
      if (sequenceOrder !== 0n) return sequenceOrder < 0n ? -1 : 1;
      return left.eventId.localeCompare(right.eventId);
    })[0];
  if (firstUnlinkedEvent) {
    const sequence = expectedSequence.toString();
    return verificationFailure(
      expectedWorldId,
      sequence,
      'EVENT_UNLINKED',
      null,
      firstUnlinkedEvent.eventId,
      `Event ${firstUnlinkedEvent.eventId} at world event sequence ${firstUnlinkedEvent.worldEventSequence} has no ledger entry.`,
    );
  }

  return {
    entryCount: input.entries.length,
    eventCount: linkedEventIds.size,
    lastEntryHash: previousHash,
    lastLedgerSequence: (expectedSequence - 1n).toString(),
    valid: true,
    worldId: expectedWorldId,
  };
}

function assertGenesisMatchesProjection(
  event: DomainEventEnvelopeV1,
  projection: WorldProjectionV1,
): void {
  if (event.eventType !== 'WorldStateImportedV1' && event.eventType !== 'WorldCompiledGenesisV1') {
    throw new Error('Replay must begin with an honest imported or compiled genesis event.');
  }
  if (event.worldId !== projection.worldId) throw new Error('Genesis world scope mismatch.');
  if (event.payload.activeWorldVersionId !== projection.activeWorldVersionId) {
    throw new Error('Genesis active world version mismatch.');
  }
  if (event.payload.worldVersionNumber !== projection.worldVersionNumber) {
    throw new Error('Genesis design version mismatch.');
  }
  if (event.resultingStateRevision !== projection.stateRevision) {
    throw new Error('Genesis state revision mismatch.');
  }
  if (
    event.payload.rowCounts.entities !== String(projection.entities.length) ||
    event.payload.rowCounts.relationships !== String(projection.relationships.length) ||
    event.payload.rowCounts.controllers !== String(projection.controllers.length)
  ) {
    throw new Error('Genesis projection row counts mismatch.');
  }
  const checksum = computeWorldProjectionChecksumV1(projection);
  if (!hashesEqual(checksum, event.payload.stateChecksum)) {
    throw new Error('Genesis projection checksum mismatch.');
  }
}

const MAX_EVENTS_PER_REPLAY_COMMAND = 64;

interface ReplayCommandEventGroupV1 {
  commandId: string;
  events: DomainEventEnvelopeV1[];
}

function validateAndGroupReplayEvents(
  events: readonly DomainEventEnvelopeV1[],
  worldId: string,
): ReplayCommandEventGroupV1[] {
  const groups: ReplayCommandEventGroupV1[] = [];
  const completedCommandIds = new Set<string>();
  let currentGroup: ReplayCommandEventGroupV1 | undefined;
  let expectedEventSequence = 1n;

  for (const event of events) {
    if (!eventValidator.is(event)) throw new TypeError('Invalid domain event.');
    if (event.worldId !== worldId) throw new Error('Replay event world scope mismatch.');
    if (event.worldEventSequence !== expectedEventSequence.toString()) {
      throw new Error(`Replay event sequence gap at ${expectedEventSequence}.`);
    }
    if (!hashesEqual(event.eventHash, computeDomainEventHashV1(event))) {
      throw new Error(`Replay event hash mismatch at ${event.worldEventSequence}.`);
    }

    if (!currentGroup || currentGroup.commandId !== event.commandId) {
      if (currentGroup) completedCommandIds.add(currentGroup.commandId);
      if (completedCommandIds.has(event.commandId)) {
        throw new Error(`Replay command events are not contiguous for command ${event.commandId}.`);
      }
      currentGroup = { commandId: event.commandId, events: [] };
      groups.push(currentGroup);
    }
    currentGroup.events.push(event);
    if (currentGroup.events.length > MAX_EVENTS_PER_REPLAY_COMMAND) {
      throw new Error(`Replay command ${event.commandId} exceeds the 64-event budget.`);
    }
    expectedEventSequence += 1n;
  }

  return groups;
}

function validateReplayCommandGroup(group: ReplayCommandEventGroupV1): string {
  const resultingStateRevision = group.events[0]!.resultingStateRevision;
  for (const [eventIndex, event] of group.events.entries()) {
    if (event.eventOrdinal !== eventIndex) {
      throw new Error(
        `Replay event ordinal mismatch for command ${group.commandId}: expected ${eventIndex}.`,
      );
    }
    if (event.resultingStateRevision !== resultingStateRevision) {
      throw new Error(
        `Replay command ${group.commandId} has inconsistent resulting state revisions.`,
      );
    }
  }
  return resultingStateRevision;
}

export function replayWorldProjectionV1(
  input: ReplayWorldProjectionInputV1,
  eventRegistry: EventRegistryV1 = createDefaultEventRegistry(),
): ReplayWorldProjectionResultV1 {
  if (input.events.length === 0) throw new Error('Replay requires a genesis event.');
  let projection = canonicalClone(input.genesisProjection);
  const groups = validateAndGroupReplayEvents(input.events, projection.worldId);

  for (const [groupIndex, group] of groups.entries()) {
    const resultingStateRevision = validateReplayCommandGroup(group);
    if (groupIndex === 0) {
      if (group.events.length !== 1) {
        throw new Error('Replay genesis command must contain exactly one event.');
      }
      assertGenesisMatchesProjection(group.events[0]!, projection);
    } else {
      const expectedStateRevision = (BigInt(projection.stateRevision) + 1n).toString();
      if (resultingStateRevision !== expectedStateRevision) {
        throw new Error(
          `Replay state revision mismatch for command ${group.commandId}: expected ${expectedStateRevision}.`,
        );
      }
      projection = { ...projection, stateRevision: resultingStateRevision };
    }

    for (const event of group.events) {
      projection = eventRegistry.apply(projection, event);
    }
  }

  return {
    checksum: computeWorldProjectionChecksumV1(projection),
    eventCount: input.events.length,
    lastEventSequence: input.events.at(-1)!.worldEventSequence,
    projection,
  };
}

export function exportLedgerV1(input: {
  entries: readonly LedgerEntryV1[];
  events: readonly DomainEventEnvelopeV1[];
  fromLedgerSequence?: string;
  toLedgerSequence?: string;
  worldId: string;
}): LedgerExportV1 {
  const from = BigInt(input.fromLedgerSequence ?? '1');
  const to = BigInt(
    input.toLedgerSequence ??
      input.entries.at(-1)?.ledgerSequence ??
      input.fromLedgerSequence ??
      '1',
  );
  if (from < 1n || to < from) throw new Error('Invalid ledger export range.');
  const entries = input.entries.filter((entry) => {
    const sequence = BigInt(entry.ledgerSequence);
    return entry.worldId === input.worldId && sequence >= from && sequence <= to;
  });
  const eventIds = new Set(entries.flatMap((entry) => (entry.eventId ? [entry.eventId] : [])));
  const events = input.events.filter((event) => eventIds.has(event.eventId));
  const material = {
    domain: LEDGER_EXPORT_HASH_DOMAIN_V1,
    entries,
    events,
    fromLedgerSequence: from.toString(),
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    toLedgerSequence: to.toString(),
    worldId: input.worldId,
  };
  return { ...material, exportHash: sha256CanonicalV1(material) };
}

export {
  canonicalWorldProjectionChecksumMaterialV1,
  compareWorldProjectionV1,
  computeWorldProjectionChecksumV1,
  createWorldProjectionV1,
} from './projection.js';
