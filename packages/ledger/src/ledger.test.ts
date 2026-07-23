import { describe, expect, it } from 'vitest';

import type { DomainEventEnvelopeV1, LedgerEntryV1 } from '@worldgraph/contracts';

import {
  canonicalDomainEventHashMaterialV1,
  canonicalLedgerEntryHashMaterialV1,
  computeDomainEventHashV1,
  computeLedgerEntryHashV1,
  sealDomainEventV1,
  sealLedgerEntryV1,
} from './hash.js';
import {
  compareWorldProjectionV1,
  computeWorldProjectionChecksumV1,
  exportLedgerV1,
  replayWorldProjectionV1,
  verifyLedgerChainV1,
} from './replay.js';
import {
  FIXTURE_WORLD_ID,
  createFixtureEvents,
  createFixtureLedger,
  createFixtureProjection,
} from './test-fixture.js';

describe('canonical M06 hashes and ledger verification', () => {
  it('pins domain-separated canonical hash material and golden identities', () => {
    const { entries, events } = createFixtureLedger();
    expect(canonicalDomainEventHashMaterialV1(events[0]!)).toMatchObject({
      domain: 'worldgraph.domain-event.v1',
      eventType: 'WorldStateImportedV1',
      resultingStateRevision: '0',
      worldEventSequence: '1',
    });
    expect(canonicalLedgerEntryHashMaterialV1(entries[0]!)).toMatchObject({
      domain: 'worldgraph.ledger-entry.v1',
      entryKind: 'domain_event',
      ledgerSchemaVersion: 1,
      ledgerSequence: '1',
    });
    expect(events.map((event) => event.eventHash)).toEqual([
      'faea0f28a9aa63b705828dc415a3f7a79292f9459d34f022bd1cbf5b98c561c0',
      '0524f334a3a015679b32f91c74ab188e48e5f20796b31c1ce1178a052491f91f',
    ]);
    expect(entries.map((entry) => entry.entryHash)).toEqual([
      '26e288085d139b051066eaa15aa8e3990c9d4a6492da36b1ba22a06ccbab3b88',
      '65114b18d452e65b81171c8e288e61cd18a4113fddebf041b22cdb68c22527ce',
      '4ce8d1f7586fa06154dc73d3dfb6f05a6af2718f68689627595a90de775356b8',
    ]);
    expect(computeWorldProjectionChecksumV1(createFixtureProjection())).toBe(
      '46bc6184f79a60ab90f7552244f7f77b605e8da0f06339078b92f862cdd1a397',
    );
  });

  it('is independent of object property insertion order', () => {
    const event = createFixtureEvents()[1]!;
    const reordered = Object.fromEntries(Object.entries(event).reverse()) as DomainEventEnvelopeV1;
    expect(computeDomainEventHashV1(reordered)).toBe(event.eventHash);

    const entry = createFixtureLedger().entries[2]!;
    const reorderedEntry = Object.fromEntries(
      Object.entries(entry).reverse(),
    ) as unknown as LedgerEntryV1;
    expect(computeLedgerEntryHashV1(reorderedEntry)).toBe(entry.entryHash);
  });

  it('verifies a valid world chain and linked event stream', () => {
    const fixture = createFixtureLedger();
    expect(verifyLedgerChainV1({ ...fixture, expectedWorldId: FIXTURE_WORLD_ID })).toEqual({
      entryCount: 3,
      eventCount: 2,
      lastEntryHash: fixture.entries[2]!.entryHash,
      lastLedgerSequence: '3',
      valid: true,
      worldId: FIXTURE_WORLD_ID,
    });
  });

  it.each([
    {
      code: 'LEDGER_SEQUENCE_GAP',
      mutate: (fixture: ReturnType<typeof createFixtureLedger>) => ({
        ...fixture,
        entries: [fixture.entries[0]!, fixture.entries[2]!],
      }),
      sequence: '2',
    },
    {
      code: 'ENTRY_HASH_MISMATCH',
      mutate: (fixture: ReturnType<typeof createFixtureLedger>) => ({
        ...fixture,
        entries: fixture.entries.map((entry, index) =>
          index === 1 ? { ...entry, redactedDetails: { commandType: 'Tampered' } } : entry,
        ),
      }),
      sequence: '2',
    },
    {
      code: 'PREVIOUS_HASH_MISMATCH',
      mutate: (fixture: ReturnType<typeof createFixtureLedger>) => ({
        ...fixture,
        entries: fixture.entries.map((entry, index) =>
          index === 1 ? { ...entry, previousHash: 'f'.repeat(64) } : entry,
        ),
      }),
      sequence: '2',
    },
    {
      code: 'EVENT_HASH_MISMATCH',
      mutate: (fixture: ReturnType<typeof createFixtureLedger>) => ({
        ...fixture,
        events: fixture.events.map((event, index) =>
          index === 1 && event.eventType === 'WorldEntityRenamedV1'
            ? { ...event, payload: { ...event.payload, newDisplayName: 'Corrupt Harbor' } }
            : event,
        ),
      }),
      sequence: '3',
    },
    {
      code: 'EVENT_MISSING',
      mutate: (fixture: ReturnType<typeof createFixtureLedger>) => ({
        ...fixture,
        events: [fixture.events[0]!],
      }),
      sequence: '3',
    },
  ])('detects $code at the exact first bad ledger position', ({ code, mutate, sequence }) => {
    const result = verifyLedgerChainV1(mutate(createFixtureLedger()));
    expect(result).toMatchObject({ code, firstBadLedgerSequence: sequence, valid: false });
  });

  it('detects an event sequence discontinuity even when each event hash is self-consistent', () => {
    const fixture = createFixtureLedger();
    const renamed = fixture.events[1]!;
    const moved = {
      ...renamed,
      eventHash: '',
      worldEventSequence: '3',
    } as DomainEventEnvelopeV1;
    moved.eventHash = computeDomainEventHashV1(moved);
    const result = verifyLedgerChainV1({
      entries: fixture.entries,
      events: [fixture.events[0]!, moved],
    });
    expect(result).toMatchObject({
      code: 'EVENT_SEQUENCE_GAP',
      firstBadLedgerSequence: '3',
      valid: false,
    });
  });

  it('rejects a stored event that is not linked by any ledger entry', () => {
    const fixture = createFixtureLedger();
    const result = verifyLedgerChainV1({
      entries: fixture.entries.slice(0, 1),
      events: fixture.events,
      expectedWorldId: FIXTURE_WORLD_ID,
    });

    expect(result).toMatchObject({
      actual: fixture.events[1]!.eventId,
      code: 'EVENT_UNLINKED',
      expected: null,
      firstBadLedgerSequence: '2',
      valid: false,
      worldId: FIXTURE_WORLD_ID,
    });
  });

  it('reports the first missing ledger position after intervening command entries', () => {
    const fixture = createFixtureLedger();
    const result = verifyLedgerChainV1({
      entries: fixture.entries.slice(0, 2),
      events: fixture.events,
      expectedWorldId: FIXTURE_WORLD_ID,
    });

    expect(result).toMatchObject({
      actual: fixture.events[1]!.eventId,
      code: 'EVENT_UNLINKED',
      firstBadLedgerSequence: '3',
      valid: false,
    });
  });

  it('supports bounded canonical export without mutating authority', () => {
    const fixture = createFixtureLedger();
    const exported = exportLedgerV1({
      ...fixture,
      fromLedgerSequence: '2',
      toLedgerSequence: '3',
      worldId: FIXTURE_WORLD_ID,
    });
    expect(exported.entries.map((entry) => entry.ledgerSequence)).toEqual(['2', '3']);
    expect(exported.events.map((event) => event.eventType)).toEqual(['WorldEntityRenamedV1']);
    expect(exported.exportHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('detects a rehashed downstream entry when its previous link was not repaired', () => {
    const fixture = createFixtureLedger();
    const corruptSecond = sealLedgerEntryV1({
      ...fixture.entries[1]!,
      entryHash: undefined,
      redactedDetails: { commandType: 'Tampered' },
    } as never);
    const entries = [
      fixture.entries[0]!,
      corruptSecond,
      fixture.entries[2]!,
    ] as readonly LedgerEntryV1[];
    expect(verifyLedgerChainV1({ entries, events: fixture.events })).toMatchObject({
      code: 'PREVIOUS_HASH_MISMATCH',
      firstBadLedgerSequence: '3',
      valid: false,
    });
  });
});

describe('projection replay', () => {
  it('replays honest genesis and rename into the same live checksum', () => {
    const projection = createFixtureProjection();
    const replayed = replayWorldProjectionV1({
      events: createFixtureEvents(),
      genesisProjection: projection,
    });
    const live = {
      ...projection,
      entities: projection.entities.map((entity) =>
        entity.logicalKey === 'district:harbor'
          ? {
              ...entity,
              entityVersion: '2',
              state: { ...entity.state, name: 'New Harbor' },
            }
          : entity,
      ) as typeof projection.entities,
      stateRevision: '1',
    };
    expect(replayed).toMatchObject({ eventCount: 2, lastEventSequence: '2' });
    expect(compareWorldProjectionV1(live, replayed.projection)).toEqual({
      equal: true,
      liveChecksum: replayed.checksum,
      replayChecksum: replayed.checksum,
    });
  });

  it('advances state revision once for a contiguous three-event command', () => {
    const genesisProjection = createFixtureProjection();
    const genesis = createFixtureEvents()[0]!;
    const commandEvents = createWorldRenamedReplayEvents(3);

    const replayed = replayWorldProjectionV1({
      events: [genesis, ...commandEvents],
      genesisProjection,
    });

    expect(replayed).toMatchObject({
      eventCount: 4,
      lastEventSequence: '4',
      projection: { stateRevision: '1' },
    });
    expect(replayed.checksum).toBe(
      computeWorldProjectionChecksumV1({ ...genesisProjection, stateRevision: '1' }),
    );
  });

  it('rejects a gap in command event ordinals', () => {
    const genesis = createFixtureEvents()[0]!;
    const commandEvents = createWorldRenamedReplayEvents(2, { eventOrdinals: [0, 2] });

    expect(() =>
      replayWorldProjectionV1({
        events: [genesis, ...commandEvents],
        genesisProjection: createFixtureProjection(),
      }),
    ).toThrow('Replay event ordinal mismatch');
  });

  it('keeps the genesis anchor as a singleton command', () => {
    const genesis = createFixtureEvents()[0]!;
    const commandEvents = createWorldRenamedReplayEvents(1, {
      commandIds: [genesis.commandId],
      eventOrdinals: [1],
      resultingStateRevisions: ['0'],
    });

    expect(() =>
      replayWorldProjectionV1({
        events: [genesis, ...commandEvents],
        genesisProjection: createFixtureProjection(),
      }),
    ).toThrow('Replay genesis command must contain exactly one event');
  });

  it('rejects inconsistent resulting revisions within one command', () => {
    const genesis = createFixtureEvents()[0]!;
    const commandEvents = createWorldRenamedReplayEvents(2, {
      resultingStateRevisions: ['1', '2'],
    });

    expect(() =>
      replayWorldProjectionV1({
        events: [genesis, ...commandEvents],
        genesisProjection: createFixtureProjection(),
      }),
    ).toThrow('has inconsistent resulting state revisions');
  });

  it('rejects a command that skips the next state revision', () => {
    const genesis = createFixtureEvents()[0]!;
    const commandEvents = createWorldRenamedReplayEvents(1, {
      resultingStateRevisions: ['2'],
    });

    expect(() =>
      replayWorldProjectionV1({
        events: [genesis, ...commandEvents],
        genesisProjection: createFixtureProjection(),
      }),
    ).toThrow('Replay state revision mismatch for command');
  });

  it('rejects a command ID that reappears after another command', () => {
    const genesis = createFixtureEvents()[0]!;
    const firstCommandId = replayUuid(400);
    const secondCommandId = replayUuid(401);
    const commandEvents = createWorldRenamedReplayEvents(3, {
      commandIds: [firstCommandId, secondCommandId, firstCommandId],
      eventOrdinals: [0, 0, 0],
      resultingStateRevisions: ['1', '2', '3'],
    });

    expect(() =>
      replayWorldProjectionV1({
        events: [genesis, ...commandEvents],
        genesisProjection: createFixtureProjection(),
      }),
    ).toThrow('Replay command events are not contiguous');
  });

  it('rejects commands with more than 64 events', () => {
    const genesis = createFixtureEvents()[0]!;
    const commandEvents = createWorldRenamedReplayEvents(65, {
      eventOrdinals: Array.from({ length: 65 }, (_, index) => Math.min(index, 63)),
    });

    expect(() =>
      replayWorldProjectionV1({
        events: [genesis, ...commandEvents],
        genesisProjection: createFixtureProjection(),
      }),
    ).toThrow('exceeds the 64-event budget');
  });

  it('rejects corrupt genesis state and event bytes without destructive repair', () => {
    const projection = createFixtureProjection();
    const corruptProjection = {
      ...projection,
      entities: projection.entities.map((entity) =>
        entity.logicalKey === 'district:harbor'
          ? { ...entity, state: { ...entity.state, name: 'Database Corruption' } }
          : entity,
      ) as typeof projection.entities,
    };
    expect(() =>
      replayWorldProjectionV1({
        events: createFixtureEvents(),
        genesisProjection: corruptProjection,
      }),
    ).toThrow('Genesis projection checksum mismatch');

    const events = createFixtureEvents();
    const corruptEvent = events[1]!;
    expect(() =>
      replayWorldProjectionV1({
        events: [
          events[0]!,
          corruptEvent.eventType === 'WorldEntityRenamedV1'
            ? { ...corruptEvent, payload: { ...corruptEvent.payload, newDisplayName: 'Corrupt' } }
            : corruptEvent,
        ],
        genesisProjection: projection,
      }),
    ).toThrow('Replay event hash mismatch at 2');
  });

  it('sorts projection rows bytewise so input order cannot change the checksum', () => {
    const projection = createFixtureProjection();
    const reversed = {
      ...projection,
      controllers: [...projection.controllers].reverse(),
      entities: [...projection.entities].reverse(),
      relationships: [...projection.relationships].reverse(),
    };
    expect(computeWorldProjectionChecksumV1(reversed)).toBe(
      computeWorldProjectionChecksumV1(projection),
    );
  });

  it('advances revision through an append-only repair anchor without changing entity data', () => {
    const genesisProjection = createFixtureProjection();
    const baseEvents = createFixtureEvents();
    const beforeRepair = replayWorldProjectionV1({
      events: baseEvents,
      genesisProjection,
    }).projection;
    const expectedAfterRepair = { ...beforeRepair, stateRevision: '2' };
    const toChecksum = computeWorldProjectionChecksumV1(expectedAfterRepair);
    const repair = sealDomainEventV1({
      aggregateId: 'worldgraph.projection',
      aggregateType: 'projection',
      aggregateVersion: '1',
      commandId: '018f8652-3cb6-7d52-904b-cce7901d7e35',
      eventId: '018f8652-3cb6-7d52-904b-cce7901d7e36',
      eventOrdinal: 0,
      eventSchemaVersion: 1,
      eventType: 'ProjectionRepairAnchoredV1',
      metadata: {
        actor: { actorId: 'worldgraph.projection-repair', actorType: 'system' },
        authorizationRuleId: 'operations.projection.repair',
        causationId: null,
        commandSchemaVersion: 1,
        commandType: 'RepairProjectionV1',
        correlationId: '018f8652-3cb6-7d52-904b-cce7901d7e35',
        overrideId: null,
        payloadClassification: 'private',
      },
      occurredAt: '2026-07-22T00:02:00.000Z',
      payload: {
        fromChecksum: 'f'.repeat(64),
        projectionName: 'world_graph',
        reasonCode: 'SHADOW_REPLAY_SWAP',
        toChecksum,
      },
      recordedAt: '2026-07-22T00:02:00.000Z',
      resultingStateRevision: '2',
      worldEventSequence: '3',
      worldId: FIXTURE_WORLD_ID,
    }) as DomainEventEnvelopeV1;
    const replayed = replayWorldProjectionV1({
      events: [...baseEvents, repair],
      genesisProjection,
    });
    expect(replayed.checksum).toBe(toChecksum);
    expect(replayed.projection.entities).toEqual(beforeRepair.entities);
    expect(replayed.projection.relationships).toEqual(beforeRepair.relationships);
    expect(replayed.projection.stateRevision).toBe('2');
  });
});

function createWorldRenamedReplayEvents(
  count: number,
  options: {
    commandIds?: readonly string[];
    eventOrdinals?: readonly number[];
    resultingStateRevisions?: readonly string[];
  } = {},
): readonly DomainEventEnvelopeV1[] {
  return Array.from({ length: count }, (_, index) => {
    const commandId = options.commandIds?.[index] ?? replayUuid(400);
    return sealDomainEventV1({
      aggregateId: FIXTURE_WORLD_ID,
      aggregateType: 'world',
      aggregateVersion: String(index + 1),
      commandId,
      eventId: replayUuid(500 + index),
      eventOrdinal: options.eventOrdinals?.[index] ?? index,
      eventSchemaVersion: 1,
      eventType: 'WorldRenamedV1',
      metadata: {
        actor: { actorId: 'worldgraph.replay-test', actorType: 'system' },
        authorizationRuleId: 'world.replay.test',
        causationId: null,
        commandSchemaVersion: 1,
        commandType: 'RenameWorldV1',
        correlationId: commandId,
        overrideId: null,
        payloadClassification: 'member',
      },
      occurredAt: '2026-07-22T00:03:00.000Z',
      payload: {
        newName: `Replay World ${index + 2}`,
        previousName: `Replay World ${index + 1}`,
      },
      recordedAt: '2026-07-22T00:03:00.000Z',
      resultingStateRevision: options.resultingStateRevisions?.[index] ?? '1',
      worldEventSequence: String(index + 2),
      worldId: FIXTURE_WORLD_ID,
    });
  });
}

function replayUuid(value: number): string {
  return `018f8652-3cb6-7d52-904b-${String(value).padStart(12, '0')}`;
}
