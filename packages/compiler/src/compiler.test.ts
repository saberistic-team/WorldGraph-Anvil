import { describe, expect, it, vi } from 'vitest';

import { primitiveContentHash, primitiveSemanticDocument } from '@worldgraph/catalog';
import {
  WorldEntityStatePairV1Validator,
  WorldRelationshipAttributesPairV1Validator,
  canonicalJson,
  type CompiledArtifactV4,
  type CompilerInputBundleV1,
} from '@worldgraph/contracts';
import { economySeedPlanHash } from '@worldgraph/economy';
import { governanceSeedPlanHashV1 } from '@worldgraph/governance';

import { compilerAdapterFor } from './adapters.js';
import {
  compileLegacyArtifactForCompatibility,
  compilePreviousArtifactForCompatibility,
  compileRetainedArtifactForCompatibility,
} from './compatibility.js';
import { emitCompiledArtifact } from './emit.js';
import { deriveLoweredEconomySeedPlanV2 } from './economy-seed.js';
import { deriveLoweredGovernanceSeedPlanV1 } from './governance-seed.js';
import { compilerInputHash, sha256Utf8, verifyCompiledArtifact } from './hash.js';
import { createCompilerInputBundle } from './input.js';
import { memberPrincipalKey } from './keys.js';
import { linkLoweredWorld } from './link.js';
import { lowerNormalizedInput } from './lower.js';
import { normalizeCompilerInput } from './normalize.js';
import { compileWorld } from './pipeline.js';
import { resolveCompilerInput } from './resolve.js';
import {
  createGoldenCompilerInput,
  createLegacyGoldenCompilerInput,
  createPreviousGoldenCompilerInput,
  createRetainedGoldenCompilerInput,
} from './test-fixture.js';
import { validateResolvedInput } from './validate.js';
import retainedGolden from './fixtures/floating-guild-city.m8.golden.json';
import legacyGolden from './fixtures/floating-guild-city.golden.json';
import previousGolden from './fixtures/harbor-city.m9.golden.json';
import currentGolden from './fixtures/harbor-city.m10.golden.json';

function goldenStages() {
  const resolved = resolveCompilerInput(createGoldenCompilerInput());
  expect(resolved.value).not.toBeNull();
  const validated = validateResolvedInput(resolved.value!);
  expect(validated.value).not.toBeNull();
  const normalized = normalizeCompilerInput(validated.value!);
  expect(normalized.value).not.toBeNull();
  const lowered = lowerNormalizedInput(normalized.value!);
  expect(lowered.value).not.toBeNull();
  const linked = linkLoweredWorld(lowered.value!);
  expect(linked.value).not.toBeNull();
  return { linked: linked.value!, lowered: lowered.value!, normalized: normalized.value! };
}

function resignArtifact(artifact: CompiledArtifactV4): CompiledArtifactV4 {
  artifact.canonicalBytes = canonicalJson(artifact.world);
  artifact.contentHash = sha256Utf8(artifact.canonicalBytes);
  return artifact;
}

describe('pure deterministic compiler', () => {
  it('preserves the exact reviewed compiler 1.0/artifact 1 golden', () => {
    const result = compileLegacyArtifactForCompatibility(createLegacyGoldenCompilerInput());
    expect(result.diagnostics).toEqual([]);
    expect(result.artifact).not.toBeNull();
    expect({
      artifactHash: result.artifact?.contentHash,
      canonicalByteLength:
        result.artifact && Buffer.byteLength(result.artifact.canonicalBytes, 'utf8'),
      compilerConfigVersion: result.artifact?.world.compilerConfigVersion,
      compilerVersion: result.artifact?.world.compilerVersion,
      counts: result.artifact?.world.counts,
      inputHash: result.inputHash,
      manifestContentHash: result.artifact?.world.manifestContentHash,
      worldGraphSchemaVersion: result.artifact?.world.worldGraphSchemaVersion,
    }).toEqual(legacyGolden);
    expect(verifyCompiledArtifact(result.artifact).valid).toBe(true);
  });

  it('preserves the exact reviewed compiler 1.1/artifact 2 golden', () => {
    const result = compileRetainedArtifactForCompatibility(createRetainedGoldenCompilerInput());
    expect(result.diagnostics).toEqual([]);
    expect(result.artifact).not.toBeNull();
    expect({
      artifactHash: result.artifact?.contentHash,
      artifactSchemaVersion: result.artifact?.artifactSchemaVersion,
      canonicalByteLength:
        result.artifact && Buffer.byteLength(result.artifact.canonicalBytes, 'utf8'),
      compilerConfigVersion: result.artifact?.world.compilerConfigVersion,
      compilerVersion: result.artifact?.world.compilerVersion,
      counts: result.artifact?.world.counts,
      economySeedPlanHash: result.artifact?.world.economySeedPlanHash,
      inputHash: result.inputHash,
      manifestContentHash: result.artifact?.world.manifestContentHash,
      worldGraphSchemaVersion: result.artifact?.world.worldGraphSchemaVersion,
    }).toEqual(retainedGolden);
    expect(verifyCompiledArtifact(result.artifact).valid).toBe(true);
  });

  it('preserves the exact reviewed compiler 1.2/artifact 3 golden', () => {
    const result = compilePreviousArtifactForCompatibility(createPreviousGoldenCompilerInput());
    expect(result.diagnostics).toEqual([]);
    expect(result.artifact).not.toBeNull();
    expect({
      artifactHash: result.artifact?.contentHash,
      artifactSchemaVersion: result.artifact?.artifactSchemaVersion,
      canonicalByteLength:
        result.artifact && Buffer.byteLength(result.artifact.canonicalBytes, 'utf8'),
      compilerConfigVersion: result.artifact?.world.compilerConfigVersion,
      compilerVersion: result.artifact?.world.compilerVersion,
      counts: result.artifact?.world.counts,
      economySeedPlanHash: result.artifact?.world.economySeedPlanHash,
      inputHash: result.inputHash,
      manifestContentHash: result.artifact?.world.manifestContentHash,
      worldGraphSchemaVersion: result.artifact?.world.worldGraphSchemaVersion,
    }).toEqual(previousGolden);
    expect(verifyCompiledArtifact(result.artifact).valid).toBe(true);
  });

  it('runs resolve → validate → normalize → lower → link → emit', () => {
    const input = createGoldenCompilerInput();
    const resolved = resolveCompilerInput(input);
    expect(resolved.diagnostics).toEqual([]);
    const primitiveOrder = new Map(
      resolved.value!.orderedPrimitives.map((primitive, index) => [
        primitive.definition.key,
        index,
      ]),
    );
    for (const primitive of resolved.value!.orderedPrimitives) {
      for (const dependency of primitive.definition.dependencies) {
        expect(primitiveOrder.get(dependency.key)).toBeLessThan(
          primitiveOrder.get(primitive.definition.key)!,
        );
      }
    }
    const validated = validateResolvedInput(resolved.value!);
    expect(validated.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    const normalized = normalizeCompilerInput(validated.value!);
    const lowered = lowerNormalizedInput(normalized.value!);
    const linked = linkLoweredWorld(lowered.value!);
    const emitted = emitCompiledArtifact(linked.value!);
    expect(emitted.value?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(verifyCompiledArtifact(emitted.value!)).toMatchObject({ valid: true });
  });

  it('compiles the approved M10 governed harbor city with closed economy and charter seeds', () => {
    const result = compileWorld(createGoldenCompilerInput());
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(result.successfulStage).toBe('emit');
    expect(result.artifact?.world.entities.some((entity) => entity.entityType === 'district')).toBe(
      true,
    );
    expect(
      result.artifact?.world.entities.some(
        (entity) =>
          entity.entityType === 'institution' && entity.logicalKey === 'institution:guild-council',
      ),
    ).toBe(true);
    expect(result.artifact?.world.economySeedPlan).toMatchObject({
      businesses: [
        {
          organizationEntityLogicalKey: 'organization:energy-guild',
          stableKey: 'business:energy-guild',
        },
      ],
      currency: {
        code: 'GCR',
        issuerEntityLogicalKey: 'institution:guild-council',
        maxSupplyMinor: '10000000000',
        minorUnitScale: 2,
      },
      economySeedPlanSchemaVersion: 2,
      initialSupplyMinor: '30000',
      recipeVersions: [
        {
          durationTicks: '12',
          stableKey: 'recipe-version:metal-part-fabrication:1',
        },
      ],
      taxPolicies: [
        {
          collectionMode: 'added_to_payer',
          fixedAmountMinor: '10',
          intervalTicks: '5',
          payerEntityLogicalKey: 'organization:energy-guild',
          payerWalletStableKey: 'wallet:organization:energy-guild:gcr',
          stableKey: 'tax-policy:guild-council:harbor-dues',
          taxType: 'periodic_flat',
        },
        {
          collectionMode: 'added_to_payer',
          rateBps: 250,
          stableKey: 'tax-policy:guild-council:sales',
          taxType: 'sales',
        },
      ],
    });
    expect(result.artifact?.world.governanceSeedPlan).toMatchObject({
      charter: {
        proposalRules: {
          approvalThresholdBps: 5_001,
          ballotPolicy: {
            ballotMode: 'public',
            disclosure: 'choice_totals',
            replacementAllowed: true,
          },
          quorumBps: 5_000,
        },
        stableKey: 'charter:harbor-city',
      },
      governanceSeedPlanSchemaVersion: 1,
      initialLaws: [{ stableKey: 'law:civic-participation' }],
      institutions: [{ stableKey: 'institution:guild-council' }],
      offices: [
        {
          ballotPolicy: {
            ballotMode: 'secret',
            disclosure: 'aggregate_only',
            replacementAllowed: false,
          },
          seats: 7,
          stableKey: 'office:guild-council:councillor',
        },
        {
          ballotPolicy: {
            ballotMode: 'secret',
            disclosure: 'aggregate_only',
            replacementAllowed: false,
          },
          seats: 1,
          stableKey: 'office:guild-council:treasurer',
        },
      ],
    });
    expect(
      result.artifact?.world.economySeedPlan.assets.find(
        (asset) => asset.stableKey === 'asset:founding-seal',
      ),
    ).toMatchObject({
      assetType: 'founding_seal',
      initialOwnerEntityLogicalKey: 'character:member-d17cbdd8aaf6d32a418836431df47829',
    });
    expect(result.artifact?.world.economySeedPlan.wallets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          initialBalanceMinor: '0',
          ownerEntityLogicalKey: 'organization:artisan-guild',
          stableKey: 'wallet:organization:artisan-guild:gcr',
          walletKind: 'organization',
        }),
        expect.objectContaining({
          initialBalanceMinor: '0',
          ownerEntityLogicalKey: 'organization:energy-guild',
          stableKey: 'wallet:organization:energy-guild:gcr',
          walletKind: 'organization',
        }),
      ]),
    );
    expect(result.artifact?.world.economySeedPlan.wallets).toHaveLength(6);
    expect(
      result.artifact?.world.economySeedPlan.assets.find(
        (asset) => asset.stableKey === 'asset:facility:energy-harbor-annex',
      ),
    ).toMatchObject({
      assetType: 'workshop',
      initialOwnerEntityLogicalKey: 'organization:energy-guild',
      metadata: { displayName: 'Energy Harbor Workshop Annex' },
    });
    expect(
      result.artifact?.world.economySeedPlan.facilities.some(
        (facility) => facility.assetStableKey === 'asset:facility:energy-harbor-annex',
      ),
    ).toBe(false);
    expect(
      result.artifact?.world.economySeedPlan.resources.map((entry) => entry.stableKey),
    ).toEqual(['resource:energy', 'resource:iron-ore', 'resource:metal-part']);
    expect(
      result.artifact?.world.entities.some(
        (entity) => entity.entityType === 'currency_definition_intent',
      ),
    ).toBe(true);
    expect(
      result.artifact?.world.entities.some(
        (entity) =>
          entity.entityType === 'player_character' && entity.state.name === 'Creator Character',
      ),
    ).toBe(true);
    expect(
      result.artifact?.world.entities.some(
        (entity) =>
          entity.entityType === 'player_character' &&
          entity.state.organizationLogicalKey === 'organization:energy-guild',
      ),
    ).toBe(true);
    for (const type of ['located_in', 'governs', 'member_of', 'account_controls']) {
      expect(
        result.artifact?.world.relationships.some(
          (relationship) => relationship.relationshipType === type,
        ),
      ).toBe(true);
    }
    expect({
      artifactHash: result.artifact?.contentHash,
      canonicalByteLength:
        result.artifact && Buffer.byteLength(result.artifact.canonicalBytes, 'utf8'),
      compilerConfigVersion: result.artifact?.world.compilerConfigVersion,
      compilerVersion: result.artifact?.world.compilerVersion,
      counts: result.artifact?.world.counts,
      inputHash: result.inputHash,
      manifestContentHash: result.artifact?.world.manifestContentHash,
      worldGraphSchemaVersion: result.artifact?.world.worldGraphSchemaVersion,
      artifactSchemaVersion: result.artifact?.world.artifactSchemaVersion,
      economySeedPlanHash: result.artifact?.world.economySeedPlanHash,
      governanceSeedPlanHash: result.artifact?.world.governanceSeedPlanHash,
    }).toEqual(currentGolden);
    expect(result.artifact?.canonicalBytes).not.toContain('018f8652-3cb6-7d52-904b-cce7901d7e26');
    expect(result.artifact?.canonicalBytes).not.toContain(
      'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.',
    );
    expect(result.artifact?.canonicalBytes).not.toMatch(
      /"(?:email|password|passwordHash|promptText|sessionId)"\s*:/iu,
    );
    expect(
      result.artifact?.world.entities.every((entity) =>
        WorldEntityStatePairV1Validator.is({
          entityType: entity.entityType,
          state: entity.state,
        }),
      ),
    ).toBe(true);
    expect(
      result.artifact?.world.relationships.every((relationship) =>
        WorldRelationshipAttributesPairV1Validator.is({
          attributes: relationship.attributes,
          relationshipType: relationship.relationshipType,
        }),
      ),
    ).toBe(true);
  });

  it('fails closed when a periodic-tax payer wallet does not belong to its organization', () => {
    const { lowered } = goldenStages();
    const invalid = structuredClone(lowered);
    const extension = invalid.normalized.manifest.extensions['worldgraph.economy'] as {
      taxPolicies: Record<string, unknown>[];
    };
    extension.taxPolicies.find((policy) => policy.taxType === 'periodic_flat')![
      'payerWalletStableKey'
    ] = 'wallet:treasury:gcr';

    const result = deriveLoweredEconomySeedPlanV2(invalid);
    expect(result.value).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('ECONOMY_V2_SEED_PLAN_INVALID');
    expect(result.diagnostics[0]?.message).toContain('does not belong to energy-guild');
  });

  it('fails closed when active tax-policy windows overlap for one semantic scope', () => {
    const { lowered } = goldenStages();
    const invalid = structuredClone(lowered);
    const extension = invalid.normalized.manifest.extensions['worldgraph.economy'] as {
      taxPolicies: Record<string, unknown>[];
    };
    const sales = extension.taxPolicies.find((policy) => policy.taxType === 'sales')!;
    extension.taxPolicies.push({
      ...sales,
      effectiveFromTick: '5',
      effectiveUntilTick: '10',
      stableKey: 'tax-policy:guild-council:sales-overlap',
    });

    const result = deriveLoweredEconomySeedPlanV2(invalid);
    expect(result.value).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('ECONOMY_V2_SEED_PLAN_INVALID');
    expect(result.diagnostics[0]?.message).toContain('overlap for one identical semantic scope');
  });

  it('rejects a seeded business with no active controlled-character affiliation', () => {
    const { lowered } = goldenStages();
    const invalid = structuredClone(lowered);
    for (const entity of invalid.entities) {
      if (
        entity.entityType === 'player_character' &&
        entity.state.organizationLogicalKey === 'organization:energy-guild'
      ) {
        entity.state.organizationLogicalKey = 'organization:artisan-guild';
      }
    }

    const result = deriveLoweredEconomySeedPlanV2(invalid);
    expect(result.value).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'ECONOMY_V2_ORGANIZATION_UNMANAGEABLE',
        pointer: '/manifest/extensions/worldgraph.economy/businesses/0/organizationKey',
      }),
    ]);
  });

  it('fails closed when the current manifest omits its typed economy extension', () => {
    const input = structuredClone(createGoldenCompilerInput());
    delete input.manifest.extensions['worldgraph.economy'];
    input.manifestCanonicalBytes = canonicalJson(input.manifest);
    input.manifestContentHash = sha256Utf8(input.manifestCanonicalBytes);
    input.inputHash = compilerInputHash(input);

    const result = compileWorld(input);

    expect(result.artifact).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain('ECONOMY_V2_EXTENSION_INVALID');
  });

  it('fails closed without strict governance intent and never infers it from institutions', () => {
    const input = structuredClone(createGoldenCompilerInput());
    delete input.manifest.extensions['worldgraph.governance'];
    input.manifestCanonicalBytes = canonicalJson(input.manifest);
    input.manifestContentHash = sha256Utf8(input.manifestCanonicalBytes);
    input.inputHash = compilerInputHash(input);

    const result = compileWorld(input);

    expect(result.artifact).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      'GOVERNANCE_V1_EXTENSION_INVALID',
    );
  });

  it('rejects governance intent whose jurisdiction is not in the compiled graph', () => {
    const { lowered } = goldenStages();
    const invalid = structuredClone(lowered);
    const extension = invalid.normalized.manifest.extensions['worldgraph.governance'] as {
      institutions: Array<{ jurisdictionEntityKey: string }>;
    };
    extension.institutions[0]!.jurisdictionEntityKey = 'district:missing';

    const result = deriveLoweredGovernanceSeedPlanV1(invalid);

    expect(result.value).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'GOVERNANCE_JURISDICTION_ENTITY_INVALID',
        pointer: '/manifest/extensions/worldgraph.governance/institutions/0/jurisdictionEntityKey',
      }),
    ]);
  });

  it('fails emission when a lowered graph payload does not match its discriminator', () => {
    const { linked } = goldenStages();
    const invalidEntityState = structuredClone(linked);
    const district = invalidEntityState.entities.find(
      (entity) => entity.entityType === 'district',
    )!;
    (district.state as Record<string, unknown>).unexpected = true;
    const invalidEntityResult = emitCompiledArtifact(invalidEntityState);
    expect(invalidEntityResult.value).toBeNull();
    expect(invalidEntityResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'COMPILED_ENTITY_STATE_INVALID',
    );

    const invalidRelationshipAttributes = structuredClone(linked);
    const primitiveUse = invalidRelationshipAttributes.relationships.find(
      (relationship) => relationship.relationshipType === 'uses_primitive',
    )!;
    (primitiveUse.attributes as Record<string, unknown>).unexpected = true;
    const invalidRelationshipResult = emitCompiledArtifact(invalidRelationshipAttributes);
    expect(invalidRelationshipResult.value).toBeNull();
    expect(invalidRelationshipResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'COMPILED_RELATIONSHIP_ATTRIBUTES_INVALID',
    );
  }, 20_000);

  it('is byte-identical for shuffled primitive/member insertion order', () => {
    const original = createGoldenCompilerInput();
    const shuffled = createCompilerInputBundle({
      activeMembers: [...original.activeMembers].reverse(),
      compilerConfig: original.compilerConfig,
      manifest: structuredClone(original.manifest),
      primitives: [...original.primitives].reverse(),
      seed: original.seed,
    });
    const first = compileWorld(original).artifact!;
    const second = compileWorld(shuffled).artifact!;
    expect(shuffled.inputHash).toBe(original.inputHash);
    expect(second.canonicalBytes).toBe(first.canonicalBytes);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('does not grant observer memberships a character or controller', () => {
    const original = createGoldenCompilerInput();
    const observerPrincipal = memberPrincipalKey(
      '018f8652-3cb6-7d52-904b-cce7901d7e25',
      '018f8652-3cb6-7d52-904b-cce7901d7e29',
    );
    const withObserver = createCompilerInputBundle({
      activeMembers: [
        ...original.activeMembers,
        { principalKey: observerPrincipal, role: 'observer' },
      ],
      compilerConfig: original.compilerConfig,
      manifest: original.manifest,
      primitives: original.primitives,
      seed: original.seed,
    });
    const artifact = compileWorld(withObserver).artifact!;
    expect(
      artifact.world.controllers.some((entry) => entry.principalKey === observerPrincipal),
    ).toBe(false);
    expect(
      artifact.world.entities.some((entry) => entry.logicalKey.endsWith(observerPrincipal)),
    ).toBe(false);
  });

  it('changes input and artifact identity when the explicit seed changes', () => {
    const original = createGoldenCompilerInput();
    const changed = createCompilerInputBundle({
      activeMembers: original.activeMembers,
      compilerConfig: original.compilerConfig,
      manifest: original.manifest,
      primitives: original.primitives,
      seed: 'different-seed',
    });
    expect(changed.inputHash).not.toBe(original.inputHash);
    expect(compileWorld(changed).artifact?.contentHash).not.toBe(
      compileWorld(original).artifact?.contentHash,
    );
    const futureCompiler = {
      ...original,
      compilerVersion: '1.0.1',
    } as unknown as CompilerInputBundleV1;
    expect(compilerInputHash(futureCompiler)).not.toBe(original.inputHash);
    expect(compileWorld(futureCompiler).diagnostics.map((entry) => entry.code)).toContain(
      'COMPILER_INPUT_SCHEMA_INVALID',
    );
  }, 20_000);

  it('refuses changed hashes, unsupported adapters, dependency cycles, and unsafe numbers', () => {
    const hashTamper = structuredClone(createGoldenCompilerInput());
    hashTamper.manifestContentHash = 'f'.repeat(64);
    expect(compileWorld(hashTamper).diagnostics.map((entry) => entry.code)).toContain(
      'MANIFEST_HASH_MISMATCH',
    );

    const definition = structuredClone(createGoldenCompilerInput().primitives[0]!.definition);
    definition.behaviorRef = 'unreviewed.execute';
    expect(compilerAdapterFor(definition)).toBeNull();
    const unsupported = createGoldenCompilerInput();
    unsupported.primitives[0]!.definition = definition;
    unsupported.primitives[0]!.canonicalBytes = canonicalJson(
      primitiveSemanticDocument(definition),
    );
    unsupported.primitives[0]!.contentHash = primitiveContentHash(definition);
    const unsupportedReference = unsupported.manifest.primitiveRefs.find(
      (reference) => reference.primitiveVersionId === unsupported.primitives[0]!.primitiveVersionId,
    )!;
    unsupportedReference.contentHash = unsupported.primitives[0]!.contentHash;
    unsupported.manifestCanonicalBytes = canonicalJson(unsupported.manifest);
    unsupported.manifestContentHash = sha256Utf8(unsupported.manifestCanonicalBytes);
    unsupported.inputHash = compilerInputHash(unsupported);
    expect(resolveCompilerInput(unsupported).diagnostics.map((entry) => entry.code)).toContain(
      'UNSUPPORTED_PRIMITIVE_BEHAVIOR',
    );

    const cycleSource = createGoldenCompilerInput();
    const firstPrimitive = structuredClone(cycleSource.primitives[0]!);
    firstPrimitive.definition.dependencies = [
      {
        key: firstPrimitive.definition.key,
        required: true,
        versionRange: firstPrimitive.definition.version,
      },
    ];
    firstPrimitive.canonicalBytes = canonicalJson(
      primitiveSemanticDocument(firstPrimitive.definition),
    );
    firstPrimitive.contentHash = primitiveContentHash(firstPrimitive.definition);
    const cycle = createCompilerInputBundle({
      activeMembers: cycleSource.activeMembers,
      manifest: cycleSource.manifest,
      primitives: [firstPrimitive, ...cycleSource.primitives.slice(1)],
      seed: cycleSource.seed,
    });
    expect(resolveCompilerInput(cycle).diagnostics.map((entry) => entry.code)).toContain(
      'PRIMITIVE_DEPENDENCY_CYCLE',
    );

    const missingSource = createGoldenCompilerInput();
    const missingPrimitive = structuredClone(missingSource.primitives[0]!);
    missingPrimitive.definition.dependencies = [
      {
        key: 'worldgraph.missing.required-dependency',
        required: true,
        versionRange: '1.0.0',
      },
    ];
    missingPrimitive.canonicalBytes = canonicalJson(
      primitiveSemanticDocument(missingPrimitive.definition),
    );
    missingPrimitive.contentHash = primitiveContentHash(missingPrimitive.definition);
    const missing = createCompilerInputBundle({
      activeMembers: missingSource.activeMembers,
      manifest: missingSource.manifest,
      primitives: [missingPrimitive, ...missingSource.primitives.slice(1)],
      seed: missingSource.seed,
    });
    expect(resolveCompilerInput(missing).diagnostics.map((entry) => entry.code)).toContain(
      'PRIMITIVE_DEPENDENCY_MISSING',
    );

    const numeric = createGoldenCompilerInput();
    numeric.manifest.districts[0]!.parameters.capacity = 1.5;
    numeric.manifestCanonicalBytes = canonicalJson(numeric.manifest);
    numeric.manifestContentHash = sha256Utf8(numeric.manifestCanonicalBytes);
    numeric.inputHash = compilerInputHash(numeric);
    const numericResolved = resolveCompilerInput(numeric);
    expect(numericResolved.value).not.toBeNull();
    expect(
      validateResolvedInput(numericResolved.value!).diagnostics.map((entry) => entry.code),
    ).toContain('UNSAFE_NUMERIC_INPUT');
  }, 20_000);

  it('rejects dangling and cross-type edges and detects artifact tampering', () => {
    const { lowered } = goldenStages();
    const dangling = structuredClone(lowered);
    dangling.relationships[0]!.targetLogicalKey = 'district:does-not-exist';
    expect(linkLoweredWorld(dangling).diagnostics.map((entry) => entry.code)).toContain(
      'DANGLING_RELATIONSHIP_ENDPOINT',
    );
    const duplicate = structuredClone(lowered);
    duplicate.entities.push(structuredClone(duplicate.entities[0]!));
    expect(linkLoweredWorld(duplicate).diagnostics.map((entry) => entry.code)).toContain(
      'DUPLICATE_ENTITY_LOGICAL_KEY',
    );
    const wrongType = structuredClone(lowered);
    const control = wrongType.relationships.find(
      (relationship) => relationship.relationshipType === 'account_controls',
    )!;
    control.targetLogicalKey = 'district:civic-platform';
    expect(linkLoweredWorld(wrongType).diagnostics.map((entry) => entry.code)).toContain(
      'RELATIONSHIP_ENDPOINT_TYPE_INVALID',
    );

    const artifact = compileWorld(createGoldenCompilerInput()).artifact!;
    const tampered = structuredClone(artifact);
    tampered.world.metadata.name = 'Tampered City';
    expect(verifyCompiledArtifact(tampered).valid).toBe(false);
  });

  it('rejects re-hashed artifacts whose compiled graph violates semantic invariants', () => {
    const artifact = compileWorld(createGoldenCompilerInput()).artifact!;
    const diagnosticCodes = (changed: CompiledArtifactV4): string[] =>
      verifyCompiledArtifact(resignArtifact(changed)).diagnostics.map((entry) => entry.code);

    const dangling = structuredClone(artifact);
    dangling.world.relationships[0]!.targetLogicalKey = 'district:missing';
    expect(diagnosticCodes(dangling)).toContain('DANGLING_RELATIONSHIP_ENDPOINT');

    const duplicate = structuredClone(artifact);
    duplicate.world.entities.push(structuredClone(duplicate.world.entities[0]!));
    duplicate.world.counts.entities = duplicate.world.entities.length;
    expect(diagnosticCodes(duplicate)).toContain('DUPLICATE_ENTITY_LOGICAL_KEY');

    const wrongType = structuredClone(artifact);
    const accountControl = wrongType.world.relationships.find(
      (relationship) => relationship.relationshipType === 'account_controls',
    )!;
    accountControl.targetLogicalKey = 'district:civic-platform';
    expect(diagnosticCodes(wrongType)).toContain('RELATIONSHIP_ENDPOINT_TYPE_INVALID');

    const wrongCount = structuredClone(artifact);
    wrongCount.world.counts.relationships -= 1;
    expect(diagnosticCodes(wrongCount)).toContain('COMPILED_COUNTS_MISMATCH');

    const missingController = structuredClone(artifact);
    missingController.world.controllers.pop();
    missingController.world.counts.controllers = missingController.world.controllers.length;
    expect(diagnosticCodes(missingController)).toContain('ACCOUNT_CONTROL_CONTROLLER_MISSING');

    const missingCompleteBinding = structuredClone(artifact);
    missingCompleteBinding.world.controllers = [];
    missingCompleteBinding.world.relationships = missingCompleteBinding.world.relationships.filter(
      (relationship) => relationship.relationshipType !== 'account_controls',
    );
    missingCompleteBinding.world.counts.controllers = 0;
    missingCompleteBinding.world.counts.relationships =
      missingCompleteBinding.world.relationships.length;
    expect(diagnosticCodes(missingCompleteBinding)).toContain('ACCOUNT_CONTROL_BINDING_INCOMPLETE');
  }, 20_000);

  it('rejects a re-hashed M10 artifact whose production recipe checksum is invalid', () => {
    const artifact = structuredClone(compileWorld(createGoldenCompilerInput()).artifact!);
    artifact.world.economySeedPlan.recipeVersions[0]!.checksum = 'f'.repeat(64);
    artifact.world.economySeedPlanHash = economySeedPlanHash(artifact.world.economySeedPlan);

    const verification = verifyCompiledArtifact(resignArtifact(artifact));

    expect(verification.diagnostics.map((entry) => entry.code)).toContain(
      'ECONOMY_SEED_PLAN_INVALID',
    );
  }, 20_000);

  it('rejects a re-hashed M10 artifact whose governance plan or hash is invalid', () => {
    const artifact = structuredClone(compileWorld(createGoldenCompilerInput()).artifact!);
    artifact.world.governanceSeedPlan.offices[0]!.institutionKey = 'institution:missing';
    artifact.world.governanceSeedPlanHash = governanceSeedPlanHashV1(
      artifact.world.governanceSeedPlan,
    );
    expect(
      verifyCompiledArtifact(resignArtifact(artifact)).diagnostics.map((entry) => entry.code),
    ).toContain('GOVERNANCE_SEED_PLAN_INVALID');

    const hashMismatch = structuredClone(compileWorld(createGoldenCompilerInput()).artifact!);
    hashMismatch.world.governanceSeedPlanHash = 'f'.repeat(64);
    expect(
      verifyCompiledArtifact(resignArtifact(hashMismatch)).diagnostics.map((entry) => entry.code),
    ).toContain('GOVERNANCE_SEED_PLAN_HASH_MISMATCH');
  }, 20_000);

  it('binds each controller to the character derived from the same principal', () => {
    const original = createGoldenCompilerInput();
    const firstPlayerPrincipal = memberPrincipalKey(
      '018f8652-3cb6-7d52-904b-cce7901d7e25',
      '018f8652-3cb6-7d52-904b-cce7901d7e29',
    );
    const secondPlayerPrincipal = memberPrincipalKey(
      '018f8652-3cb6-7d52-904b-cce7901d7e25',
      '018f8652-3cb6-7d52-904b-cce7901d7e30',
    );
    const input = createCompilerInputBundle({
      activeMembers: [
        ...original.activeMembers,
        { principalKey: firstPlayerPrincipal, role: 'player' },
        { principalKey: secondPlayerPrincipal, role: 'player' },
      ],
      compilerConfig: original.compilerConfig,
      manifest: original.manifest,
      primitives: original.primitives,
      seed: original.seed,
    });
    const artifact = structuredClone(compileWorld(input).artifact!);
    const first = artifact.world.controllers.find(
      (controller) => controller.principalKey === firstPlayerPrincipal,
    );
    const second = artifact.world.controllers.find(
      (controller) => controller.principalKey === secondPlayerPrincipal,
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const firstCharacter = first!.entityLogicalKey;
    first!.entityLogicalKey = second!.entityLogicalKey;
    second!.entityLogicalKey = firstCharacter;
    for (const controller of artifact.world.controllers) {
      const edge = artifact.world.relationships.find(
        (relationship) =>
          relationship.relationshipType === 'account_controls' &&
          relationship.sourceLogicalKey === `account:${controller.principalKey}`,
      );
      expect(edge).toBeDefined();
      edge!.targetLogicalKey = controller.entityLogicalKey;
    }

    expect(
      verifyCompiledArtifact(resignArtifact(artifact)).diagnostics.map((entry) => entry.code),
    ).toContain('CONTROLLER_CHARACTER_IDENTITY_MISMATCH');
  }, 20_000);

  it('does not use fetch, wall time, or ambient randomness', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled'));
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('wall clock forbidden');
    });
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('ambient random forbidden');
    });
    try {
      expect(compileWorld(createGoldenCompilerInput()).artifact).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dateSpy).not.toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      dateSpy.mockRestore();
      randomSpy.mockRestore();
    }
  }, 20_000);
});
