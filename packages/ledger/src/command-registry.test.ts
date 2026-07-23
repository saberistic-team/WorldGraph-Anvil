import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { createDefaultCommandRegistry, EventRegistryV1 } from './registry.js';
import { decideRenameWorldEntityV1 } from './rename-world-entity.js';
import { createFixtureCommand, createFixtureProjection } from './test-fixture.js';

function decisionState() {
  const projection = createFixtureProjection();
  return {
    entity: projection.entities.find((entity) => entity.logicalKey === 'district:harbor'),
    stateRevision: projection.stateRevision,
    worldVersionNumber: projection.worldVersionNumber,
  };
}

describe('RenameWorldEntityV1 decision', () => {
  it('emits one deterministic, typed past-tense fact', () => {
    expect(decideRenameWorldEntityV1(createFixtureCommand(), decisionState())).toEqual({
      accepted: true,
      aggregateId: 'district:harbor',
      aggregateType: 'world_entity',
      eventSchemaVersion: 1,
      eventType: 'WorldEntityRenamedV1',
      payload: {
        entityKey: 'district:harbor',
        entityType: 'district',
        entityVersion: '2',
        newDisplayName: 'New Harbor',
        previousDisplayName: 'Old Harbor',
      },
    });
  });

  it.each([
    ['WORLD_VERSION_CONFLICT', { expectedWorldVersion: '2' }],
    ['REVISION_CONFLICT', { expectedStateRevision: '2' }],
    ['AGGREGATE_VERSION_CONFLICT', { expectedAggregateVersion: '2' }],
    ['ENTITY_NOT_FOUND', { payload: { entityKey: 'district:missing', newDisplayName: 'Missing' } }],
    [
      'DISPLAY_NAME_UNCHANGED',
      { payload: { entityKey: 'district:harbor', newDisplayName: 'Old Harbor' } },
    ],
    [
      'VALIDATION_FAILED',
      { payload: { entityKey: 'district:harbor', newDisplayName: ' New Harbor' } },
    ],
    [
      'VALIDATION_FAILED',
      { payload: { entityKey: 'district:harbor', newDisplayName: 'admin@example.com' } },
    ],
    [
      'VALIDATION_FAILED',
      { payload: { entityKey: 'district:harbor', newDisplayName: 'guild@例え.テスト' } },
    ],
    [
      'VALIDATION_FAILED',
      { payload: { entityKey: 'district:harbor', newDisplayName: 'Harbor 192.168.1.4' } },
    ],
    [
      'VALIDATION_FAILED',
      { payload: { entityKey: 'district:harbor', newDisplayName: 'prompt=hidden-city' } },
    ],
  ])('rejects %s without proposing an event', (rejectionCode, overrides) => {
    expect(
      decideRenameWorldEntityV1(createFixtureCommand(overrides), decisionState()),
    ).toMatchObject({ accepted: false, rejectionCode });
  });

  it('rejects entity types without an allowlisted name field', () => {
    const state = decisionState();
    state.entity = {
      entitySchemaVersion: 1,
      entityType: 'account_principal',
      entityVersion: '1',
      logicalKey: 'account:member-00000000000000000000000000000000',
      state: {
        membershipRole: 'creator',
        principalKey: 'member-00000000000000000000000000000000',
      },
    };
    expect(
      decideRenameWorldEntityV1(
        createFixtureCommand({
          payload: { entityKey: state.entity.logicalKey, newDisplayName: 'Forged Name' },
        }),
        state,
      ),
    ).toMatchObject({ accepted: false, rejectionCode: 'ENTITY_TYPE_NOT_RENAMEABLE' });
  });
});

describe('versioned registries and upcasters', () => {
  it('registers only the allowlisted public command and validates before decision', () => {
    const registry = createDefaultCommandRegistry();
    expect(registry.registeredCommands()).toEqual([
      { schemaVersion: 1, type: 'RenameWorldEntityV1' },
    ]);
    expect(registry.decide(createFixtureCommand(), decisionState())).toMatchObject({
      accepted: true,
      eventType: 'WorldEntityRenamedV1',
    });
    expect(() =>
      registry.decide({ ...createFixtureCommand(), type: 'ArbitraryPatchV1' }, decisionState()),
    ).toThrow('Invalid command envelope');
  });

  it('upcasts one immutable payload version at a time and validates the latest shape', () => {
    const registry = new EventRegistryV1()
      .register({
        eventSchemaVersion: 2,
        eventType: 'FixtureEvent',
        payloadSchema: Type.Object(
          { displayName: Type.String(), schemaTag: Type.Literal('v2') },
          { additionalProperties: false },
        ),
        reduce: (projection) => projection,
      })
      .registerUpcaster({
        eventType: 'FixtureEvent',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
        upcast: (payload) => ({
          displayName: (payload as { name: string }).name,
          schemaTag: 'v2',
        }),
      });
    expect(registry.upcastPayload('FixtureEvent', 1, { name: 'Harbor' })).toEqual({
      eventSchemaVersion: 2,
      eventType: 'FixtureEvent',
      payload: { displayName: 'Harbor', schemaTag: 'v2' },
    });
    expect(() => registry.upcastPayload('FixtureEvent', 3, {})).toThrow(
      'Unsupported future event schema',
    );
  });

  it('fails closed when an upcaster link is missing or skips a version', () => {
    const registry = new EventRegistryV1().register({
      eventSchemaVersion: 2,
      eventType: 'FixtureEvent',
      payloadSchema: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      reduce: (projection) => projection,
    });
    expect(() => registry.upcastPayload('FixtureEvent', 1, { value: 'x' })).toThrow(
      'Missing event upcaster',
    );
    expect(() =>
      registry.registerUpcaster({
        eventType: 'FixtureEvent',
        fromSchemaVersion: 0,
        toSchemaVersion: 2,
        upcast: (payload) => payload,
      }),
    ).toThrow('advance exactly one schema version');
  });
});
