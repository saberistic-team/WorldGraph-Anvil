import { describe, expect, it } from 'vitest';

import {
  API_VERSION,
  ApproveManifestRevisionRequestSchema,
  AuthorityActionSchema,
  COMPILER_VERSION,
  CONTRACT_SCHEMA_VERSION,
  MANIFEST_GENERATOR_SCHEMA_VERSION,
  MANIFEST_PROMPT_TEMPLATE_VERSION,
  MANIFEST_QUEUE_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_VALIDATOR_VERSION,
  ManifestGenerationEnvelopeV1Schema,
  ManifestGenerationRequestedSchema,
  ManifestJsonObjectSchema,
  PRIMITIVE_SCHEMA_VERSION,
  StartManifestGenerationRequestSchema,
  WorldManifestV1Schema,
  WorldSchema,
  createValidator,
} from './index.js';

const uuid = '018f8652-3cb6-7d52-904b-cce7901d7e25';
const hash = 'a'.repeat(64);

function manifestFixture(): Record<string, unknown> {
  const primitiveRefs = [
    ['government', 'government'],
    ['currency', 'currency'],
    ['resource', 'resource'],
    ['terrain', 'terrain'],
    ['district', 'district'],
    ['organization', 'organization'],
    ['player-role', 'player_role'],
    ['visual-style', 'visual_style'],
    ['simulation-rule', 'simulation_rule'],
  ].map(([ref, kind]) => ({
    contentHash: hash,
    key: `worldgraph.${kind!.replaceAll('_', '-')}.fixture`,
    kind,
    parameters: {},
    primitiveVersionId: uuid,
    ref,
    version: '1.0.0',
  }));
  return {
    actors: [
      {
        controller: 'player',
        homeDistrictKey: 'civic',
        key: 'citizen',
        name: 'Citizen',
        organizationKey: 'guild',
        parameters: {},
        rolePrimitiveRef: 'player-role',
      },
    ],
    assumptions: ['Creator review is required.'],
    connections: [
      { fromDistrictKey: 'civic', key: 'main-walkway', kind: 'walkway', toDistrictKey: 'harbor' },
    ],
    districts: [
      { key: 'civic', name: 'Civic', parameters: {}, primitiveRef: 'district' },
      { key: 'harbor', name: 'Harbor', parameters: {}, primitiveRef: 'district' },
    ],
    economy: {
      currencyPrimitiveRef: 'currency',
      productionPrimitiveRefs: [],
      resourcePrimitiveRefs: ['resource'],
      taxPrimitiveRefs: [],
    },
    extensions: { 'worldgraph.fixture': { reviewed: true } },
    institutions: [
      {
        districtKey: 'civic',
        key: 'council',
        name: 'Council',
        organizationKeys: ['guild'],
        parameters: {},
        primitiveRef: 'government',
      },
    ],
    manifestSchemaVersion: 1,
    metadata: { archetype: 'city-state', description: 'A bounded test city.', name: 'Test City' },
    organizations: [
      {
        homeDistrictKey: 'civic',
        key: 'guild',
        name: 'Guild',
        parameters: {},
        primitiveRef: 'organization',
      },
    ],
    primitiveRefs,
    relationships: [
      {
        key: 'citizen-guild',
        source: { key: 'citizen', kind: 'actor' },
        target: { key: 'guild', kind: 'organization' },
        type: 'member-of',
      },
    ],
    seed: 'fixture-seed',
    simulation: { eventPrimitiveRefs: [], rulePrimitiveRefs: ['simulation-rule'], settings: {} },
    visual: {
      direction: 'Readable geometry.',
      stylePrimitiveRef: 'visual-style',
      terrainPrimitiveRef: 'terrain',
    },
  };
}

describe('manifest v1 contracts', () => {
  it('preserves manifest v1 while M11 advances compiler and aggregate contracts', () => {
    expect({
      api: API_VERSION,
      compiler: COMPILER_VERSION,
      contracts: CONTRACT_SCHEMA_VERSION,
      generator: MANIFEST_GENERATOR_SCHEMA_VERSION,
      manifest: MANIFEST_SCHEMA_VERSION,
      primitive: PRIMITIVE_SCHEMA_VERSION,
      promptTemplate: MANIFEST_PROMPT_TEMPLATE_VERSION,
      queue: MANIFEST_QUEUE_SCHEMA_VERSION,
      validator: MANIFEST_VALIDATOR_VERSION,
    }).toEqual({
      api: 'v1',
      compiler: '1.4.0',
      contracts: 11,
      generator: 1,
      manifest: 1,
      primitive: 1,
      promptTemplate: 1,
      queue: 1,
      validator: 1,
    });
  });

  it('accepts a strict manifest and rejects executable/unknown generation fields', () => {
    const manifest = manifestFixture();
    expect(createValidator(WorldManifestV1Schema).is(manifest)).toBe(true);
    const envelope = {
      assumptions: manifest.assumptions,
      generatorSchemaVersion: 1,
      manifest,
      promptTemplateVersion: 1,
      provenance: [],
      suggestedFixes: [],
      unresolvedQuestions: [],
      warnings: [],
    };
    const validator = createValidator(ManifestGenerationEnvelopeV1Schema);
    expect(validator.is(envelope)).toBe(true);
    expect(validator.is({ ...envelope, tool: 'fetch-url' })).toBe(false);
    const unpinned = structuredClone(manifest);
    delete (unpinned.primitiveRefs as Record<string, unknown>[])[0]!.contentHash;
    expect(createValidator(WorldManifestV1Schema).is(unpinned)).toBe(false);
  });

  it('keeps JSON object property-name bounds without a redundant type annotation', () => {
    const validator = createValidator(ManifestJsonObjectSchema);
    expect(validator.is({ safe: true })).toBe(true);
    expect(validator.is(JSON.parse('{"__proto__":true}'))).toBe(false);
    expect(validator.is({ 'control\u0000character': true })).toBe(false);
  });

  it('keeps queue wakeups ID/hash-only and provider-config guarded', () => {
    const validator = createValidator(ManifestGenerationRequestedSchema);
    const message = {
      generatorSchemaVersion: 1,
      inputHash: hash,
      promptTemplateVersion: 1,
      providerConfigurationId: 'provider-disabled-v1',
      runId: uuid,
      schemaVersion: 1,
      type: 'ManifestGenerationRequested',
      validatorVersion: 1,
    };
    expect(validator.is(message)).toBe(true);
    expect(validator.is({ ...message, prompt: 'private creator prompt' })).toBe(false);
    expect(validator.is({ ...message, providerConfigurationId: null })).toBe(false);
  });

  it('bounds generation/approval inputs and models the world manifest pointer', () => {
    expect(
      createValidator(StartManifestGenerationRequestSchema).is({
        expectedParentContentHash: hash,
        parentRevisionId: uuid,
        prompt: 'A bounded floating guild city.',
        seed: 'test-seed',
      }),
    ).toBe(true);
    expect(
      createValidator(ApproveManifestRevisionRequestSchema).is({
        acknowledgedWarningCodes: ['HIGH_IMPACT_RULES_REQUIRE_REVIEW'],
        confirmationName: 'Test City',
        expectedContentHash: hash,
        expectedWorldVersion: 3,
      }),
    ).toBe(true);
    expect(
      createValidator(WorldSchema).is({
        activeWorldVersionId: null,
        createdAt: '2026-07-21T12:00:00.000Z',
        currentApprovedManifestRevisionId: null,
        id: uuid,
        lifecycle: 'draft',
        manifestSchemaVersion: null,
        name: 'Test City',
        role: 'creator',
        rowVersion: 1,
        slug: 'test-city',
        updatedAt: '2026-07-21T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(createValidator(AuthorityActionSchema).is('manifest.revision.approve')).toBe(true);
  });
});
