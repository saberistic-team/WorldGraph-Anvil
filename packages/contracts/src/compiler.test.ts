import { describe, expect, it } from 'vitest';

import {
  COMPILED_ARTIFACT_SCHEMA_VERSION,
  COMPILER_CONFIG_SCHEMA_VERSION,
  COMPILER_VERSION,
  CONTRACT_SCHEMA_VERSION,
  RUNTIME_SCHEMA_VERSION,
  PREVIOUS_COMPILER_VERSION,
  RETAINED_COMPILER_VERSION,
  WORLD_COMPILATION_QUEUE_SCHEMA_VERSION,
  WORLD_GRAPH_SCHEMA_VERSION,
  publicCompatibilityVersions,
} from './versions.js';
import { ApplicationNotificationSchema } from './commands.js';
import {
  RuntimeSummaryViewSchema,
  StartWorldCompilationRequestSchema,
  WorldEntityStatePairV1Validator,
  WorldEntityViewSchema,
  WorldNeighborResponseSchema,
  WorldCompilationRequestedQueueSchema,
  WorldRelationshipAttributesPairV1Validator,
  WorldRelationshipViewSchema,
} from './compiler.js';
import { SystemInfoSchema } from './system.js';
import { createValidator } from './validation.js';

const uuid = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const hash = 'a'.repeat(64);

describe('compiler and runtime contracts', () => {
  it('advances M11 compiler/artifact heads while retaining graph/config axes', () => {
    expect({
      artifact: COMPILED_ARTIFACT_SCHEMA_VERSION,
      compiler: COMPILER_VERSION,
      config: COMPILER_CONFIG_SCHEMA_VERSION,
      contracts: CONTRACT_SCHEMA_VERSION,
      queue: WORLD_COMPILATION_QUEUE_SCHEMA_VERSION,
      runtime: RUNTIME_SCHEMA_VERSION,
      worldGraph: WORLD_GRAPH_SCHEMA_VERSION,
    }).toEqual({
      artifact: 5,
      compiler: '1.4.0',
      config: 1,
      contracts: 11,
      queue: 1,
      runtime: 11,
      worldGraph: 1,
    });
  });

  it('exposes all sealed M04-M11 axes through public system metadata', () => {
    expect(
      createValidator(SystemInfoSchema).is({
        build: { api: 'test' },
        codename: 'Anvil',
        features: { operationalSmoke: false },
        name: 'WorldGraph',
        versions: publicCompatibilityVersions,
      }),
    ).toBe(true);
  });

  it('bounds start input and keeps queue wakeups ID/hash-only', () => {
    expect(
      createValidator(StartWorldCompilationRequestSchema).is({
        expectedManifestHash: hash,
        manifestRevisionId: uuid,
        seed: 'demo-seed',
      }),
    ).toBe(true);
    const queue = {
      compilerConfigVersion: 1,
      compilerVersion: '1.4.0',
      inputHash: hash,
      manifestRevisionId: uuid,
      runId: uuid,
      schemaVersion: 1,
      type: 'WorldCompilationRequested',
    };
    const validator = createValidator(WorldCompilationRequestedQueueSchema);
    expect(validator.is(queue)).toBe(true);
    expect(validator.is({ ...queue, compilerVersion: RETAINED_COMPILER_VERSION })).toBe(true);
    expect(validator.is({ ...queue, compilerVersion: PREVIOUS_COMPILER_VERSION })).toBe(true);
    expect(validator.is({ ...queue, compilerVersion: '1.3.0' })).toBe(true);
    expect(validator.is({ ...queue, compilerVersion: '1.0.0' })).toBe(false);
    expect(validator.is({ ...queue, manifest: { private: 'authority injection' } })).toBe(false);
  });

  it('validates ID/hash-only compilation lifecycle notifications', () => {
    const notification = {
      id: uuid,
      occurredAt: '2026-07-22T00:00:00.000Z',
      payload: {
        artifactHash: hash,
        inputHash: hash,
        runId: uuid,
        worldId: uuid,
        worldVersionId: uuid,
      },
      schemaVersion: 1,
      type: 'WorldCompilationSucceeded',
    };
    const validator = createValidator(ApplicationNotificationSchema);
    expect(validator.is(notification)).toBe(true);
    expect(
      validator.is({ ...notification, payload: { ...notification.payload, email: 'x@y.z' } }),
    ).toBe(false);
  });

  it('requires complete active-runtime revision metadata', () => {
    expect(
      createValidator(RuntimeSummaryViewSchema).is({
        activatedAt: '2026-07-22T00:00:00.000Z',
        activeWorldVersionId: uuid,
        artifactHash: hash,
        compilerConfigVersion: 1,
        compilerVersion: '1.0.0',
        controllerCount: 1,
        entityCount: 35,
        lastLedgerSequence: 0,
        lifecycle: 'active',
        manifestContentHash: hash,
        manifestRevisionId: uuid,
        manifestSchemaVersion: 1,
        relationshipCount: 40,
        seed: 'demo-seed',
        stateRevision: 0,
        worldGraphSchemaVersion: 1,
        worldId: uuid,
        worldVersionNumber: 1,
      }),
    ).toBe(true);
  });

  it('composes repeated entity and relationship views without duplicate schema identities', () => {
    expect(() => createValidator(WorldNeighborResponseSchema)).not.toThrow();
  });

  it('discriminates entity state by its schema-version-one entity type', () => {
    expect(
      WorldEntityStatePairV1Validator.is({
        entityType: 'district',
        state: { name: 'Civic Platform', parameters: {}, primitiveRef: 'civic-district' },
      }),
    ).toBe(true);
    expect(
      WorldEntityStatePairV1Validator.is({
        entityType: 'district',
        state: { membershipRole: 'creator', principalKey: `member-${'a'.repeat(32)}` },
      }),
    ).toBe(false);
    expect(
      WorldEntityStatePairV1Validator.is({
        entityType: 'account_principal',
        state: {
          membershipRole: 'observer',
          principalKey: `member-${'a'.repeat(32)}`,
        },
      }),
    ).toBe(false);
    expect(
      WorldEntityStatePairV1Validator.is({
        entityType: 'district',
        state: {
          name: 'Civic Platform',
          parameters: {},
          primitiveRef: 'civic-district',
          unexpected: true,
        },
      }),
    ).toBe(false);
  });

  it('discriminates relationship attributes and rejects untyped payload extension', () => {
    expect(
      WorldRelationshipAttributesPairV1Validator.is({
        attributes: { bidirectional: true, connectionKind: 'transit' },
        relationshipType: 'connected_to',
      }),
    ).toBe(true);
    expect(
      WorldRelationshipAttributesPairV1Validator.is({
        attributes: { manifestRelationshipKey: 'guild-governance' },
        relationshipType: 'governs',
      }),
    ).toBe(true);
    expect(
      WorldRelationshipAttributesPairV1Validator.is({
        attributes: { connectionKind: 'transit' },
        relationshipType: 'connected_to',
      }),
    ).toBe(false);
    expect(
      WorldRelationshipAttributesPairV1Validator.is({
        attributes: { arbitrary: 'payload' },
        relationshipType: 'uses_primitive',
      }),
    ).toBe(false);
  });

  it('carries the discriminated payload rules through runtime entity and relationship views', () => {
    const entity = {
      createdWorldVersionId: uuid,
      entitySchemaVersion: 1,
      entityType: 'district',
      logicalKey: 'district:civic-platform',
      retiredWorldVersionId: null,
      rowVersion: 0,
      state: { name: 'Civic Platform', parameters: {}, primitiveRef: 'civic-district' },
      worldId: uuid,
    };
    const entityValidator = createValidator(WorldEntityViewSchema);
    expect(entityValidator.is(entity)).toBe(true);
    expect(entityValidator.is({ ...entity, state: { arbitrary: true } })).toBe(false);

    const relationship = {
      attributes: {},
      createdWorldVersionId: uuid,
      logicalKey: 'rel:uses_primitive:civic-platform',
      relationshipSchemaVersion: 1,
      relationshipType: 'uses_primitive',
      retiredWorldVersionId: null,
      rowVersion: 0,
      sourceLogicalKey: 'district:civic-platform',
      targetLogicalKey: 'primitive:civic-district',
      worldId: uuid,
    };
    const relationshipValidator = createValidator(WorldRelationshipViewSchema);
    expect(relationshipValidator.is(relationship)).toBe(true);
    expect(relationshipValidator.is({ ...relationship, attributes: { arbitrary: true } })).toBe(
      false,
    );
  });
});
