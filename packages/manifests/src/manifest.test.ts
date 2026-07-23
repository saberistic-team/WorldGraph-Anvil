import { describe, expect, it } from 'vitest';

import { MAX_MANIFEST_GENERATION_WARNINGS, canonicalJson } from '@worldgraph/contracts';

import {
  attachManifestGenerationWarnings,
  assertWorldgraphEconomyExtensionV2,
  createDeterministicHarborCityFallback,
  createDeterministicFallback,
  harborCityManifestCatalog,
  manifestContentHash,
  mergeManifestGenerationWarnings,
  parseWorldgraphEconomyExtensionV2,
  parseSafeYaml,
  projectSafeYaml,
  sha256,
  starterManifestCatalog,
  structuralManifestDiff,
  validateManifestGenerationEnvelope,
  validateWorldManifest,
} from './index.js';

const prompt =
  'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.';
const harborPrompt =
  'An energy-scarce floating harbor city-state governed by guilds with closed-loop credits.';

function leafPointers(value: unknown, pointer = ''): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [pointer];
    return value.flatMap((entry, index) => leafPointers(entry, `${pointer}/${index}`));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [pointer];
    return entries.flatMap(([key, entry]) =>
      leafPointers(entry, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`),
    );
  }
  return [pointer];
}

describe('WorldManifest v1 deterministic domain', () => {
  it('matches the reviewed fallback golden bytes and hashes', () => {
    const catalog = starterManifestCatalog();
    const first = createDeterministicFallback({
      catalog,
      prompt,
      providerConfigurationId: 'provider-v1',
      seed: 'demo-seed',
    });
    const reordered = createDeterministicFallback({
      catalog: { primitives: [...catalog.primitives].reverse() },
      prompt: `  ${prompt.replaceAll(' ', '  ')}  `,
      providerConfigurationId: 'provider-v1',
      seed: 'demo-seed',
    });

    expect(first.contentHash).toBe(
      'c3074930cc920b840e1ad5e1a8d338c621476771f2aa57e0e5c47d9904760174',
    );
    expect(first.requestHash).toBe(
      'be412d23469ab19631fbe8a611d50071930c3c4c06aaea7490a9438afedf2890',
    );
    expect(first.resolvedInputHash).toBe(
      '307c8563f0801084d08ddec44b0f83ce7511cc0777ab6e5cdcd293e343639f1c',
    );
    expect(canonicalJson(reordered.envelope.manifest)).toBe(canonicalJson(first.envelope.manifest));
    expect(reordered.contentHash).toBe(first.contentHash);
    expect(first.envelope.manifest.primitiveRefs).toHaveLength(16);
    expect(first.envelope.manifest.districts).toHaveLength(2);
    expect(first.envelope.manifest.organizations).toHaveLength(2);
    expect(first.envelope.assumptions).toEqual(first.envelope.manifest.assumptions);
    expect(validateWorldManifest(first.envelope.manifest, catalog)).toMatchObject({ valid: true });
  });

  it('builds a deterministic M09 harbor fixture without changing the legacy fallback', () => {
    const catalog = harborCityManifestCatalog();
    const first = createDeterministicHarborCityFallback({
      catalog,
      prompt: harborPrompt,
      seed: 'harbor-city-m09',
    });
    const reordered = createDeterministicHarborCityFallback({
      catalog: { primitives: [...catalog.primitives].reverse() },
      prompt: `  ${harborPrompt.replaceAll(' ', '  ')}  `,
      seed: 'harbor-city-m09',
    });
    const extension = assertWorldgraphEconomyExtensionV2(first.envelope.manifest);

    expect(catalog.primitives).toHaveLength(19);
    expect(starterManifestCatalog().primitives).toHaveLength(16);
    expect(first.contentHash).toBe(
      'd786c6439644f921d18ce7820031f588619d65e30435b4619d89c330a3bde983',
    );
    expect(reordered.contentHash).toBe(first.contentHash);
    expect(canonicalJson(reordered.envelope.manifest)).toBe(canonicalJson(first.envelope.manifest));
    expect(first.envelope.manifest.primitiveRefs).toHaveLength(18);
    expect(first.envelope.manifest.primitiveRefs.map((entry) => entry.key)).not.toContain(
      'worldgraph.production-recipe.energy-reclamation',
    );
    expect(extension).toMatchObject({
      businesses: [
        {
          organizationKey: 'energy-guild',
          stableKey: 'business:energy-guild',
        },
      ],
      employmentOffers: [{ cadenceTicks: '12', wageMinor: '100' }],
      inventories: [
        { quantity: '100', resourceStableKey: 'resource:energy' },
        { quantity: '100', resourceStableKey: 'resource:iron-ore' },
        { quantity: '0', resourceStableKey: 'resource:metal-part' },
      ],
      recipes: [{ stableKey: 'recipe-version:metal-part-fabrication:1', version: 1 }],
      schemaVersion: 2,
      taxPolicies: [
        {
          fixedAmountMinor: '10',
          intervalTicks: '5',
          payerOrganizationKey: 'energy-guild',
          taxType: 'periodic_flat',
        },
        { collectionMode: 'added_to_payer', roundingMode: 'floor', taxType: 'sales' },
      ],
      treasury: {
        institutionKey: 'guild-council',
        walletStableKey: 'wallet:treasury:gcr',
      },
      unconfiguredFacilityAssets: [
        {
          initialOwnerOrganizationKey: 'energy-guild',
          stableKey: 'asset:facility:energy-harbor-annex',
        },
      ],
    });
    expect(validateWorldManifest(first.envelope.manifest, catalog).valid).toBe(true);
    expect(first.envelope.provenance).toHaveLength(510);
    expect(
      first.envelope.provenance.find(
        (entry) => entry.pointer === '/extensions/worldgraph.economy/schemaVersion',
      ),
    ).toMatchObject({ sourceRef: 'harbor-fallback-template-v2', sourceType: 'fallback' });
    expect(
      leafPointers(first.envelope.manifest).filter(
        (pointer) => !first.envelope.provenance.some((entry) => entry.pointer === pointer),
      ),
    ).toEqual([]);
  });

  it('rejects malformed or semantically inconsistent harbor economy intent', () => {
    const catalog = harborCityManifestCatalog();
    const fallback = createDeterministicHarborCityFallback({
      catalog,
      prompt: harborPrompt,
      seed: 'harbor-validation-m09',
    });
    const malformed = structuredClone(
      fallback.envelope.manifest.extensions['worldgraph.economy'],
    ) as Record<string, unknown>;
    malformed.schemaVersion = 1;
    expect(() => parseWorldgraphEconomyExtensionV2(malformed)).toThrow(
      'MANIFEST_ECONOMY_EXTENSION_SCHEMA_INVALID',
    );

    const inconsistent = structuredClone(fallback.envelope.manifest);
    const extension = inconsistent.extensions['worldgraph.economy'] as {
      businesses: { organizationKey: string }[];
      resources: { initialQuantity: string }[];
    };
    extension.businesses[0]!.organizationKey = 'unknown-guild';
    extension.resources[0]!.initialQuantity = '101';
    const result = validateWorldManifest(inconsistent, catalog);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'MANIFEST_ECONOMY_EXTENSION_INITIAL_QUANTITY_MISMATCH',
        'MANIFEST_ECONOMY_EXTENSION_ORGANIZATION_UNKNOWN',
      ]),
    );

    const ambiguousAsset = structuredClone(fallback.envelope.manifest);
    const ambiguousExtension = ambiguousAsset.extensions['worldgraph.economy'] as {
      facilities: Array<{ assetStableKey: string }>;
      unconfiguredFacilityAssets: Array<{
        buildingPrimitiveRef: string;
        initialOwnerOrganizationKey: string;
        stableKey: string;
      }>;
    };
    ambiguousExtension.unconfiguredFacilityAssets[0]!.stableKey =
      ambiguousExtension.facilities[0]!.assetStableKey;
    ambiguousExtension.unconfiguredFacilityAssets[0]!.initialOwnerOrganizationKey = 'unknown-guild';
    ambiguousExtension.unconfiguredFacilityAssets[0]!.buildingPrimitiveRef = 'energy';
    expect(
      validateWorldManifest(ambiguousAsset, catalog).diagnostics.map((entry) => entry.code),
    ).toEqual(
      expect.arrayContaining([
        'MANIFEST_ECONOMY_EXTENSION_ASSET_AMBIGUOUS',
        'MANIFEST_ECONOMY_EXTENSION_BUILDING_REF_INVALID',
        'MANIFEST_ECONOMY_EXTENSION_FACILITY_OWNER_INVALID',
      ]),
    );
  });

  it('retains the sealed schema-1 economy lane while scanning its opaque data', () => {
    const catalog = starterManifestCatalog();
    const legacy = createDeterministicFallback({
      catalog,
      prompt,
      providerConfigurationId: 'disabled-v1',
      seed: 'legacy-economy-extension-v1',
    }).envelope.manifest;
    legacy.extensions['worldgraph.economy'] = {
      compatibilityNote: 'sealed compiler 1.1 input',
      schemaVersion: 1,
    };
    expect(validateWorldManifest(legacy, catalog).valid).toBe(true);

    legacy.extensions['worldgraph.economy'] = {
      remoteInstruction: 'https://attacker.invalid',
      schemaVersion: 1,
    };
    expect(validateWorldManifest(legacy, catalog).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'REMOTE_OR_EXECUTABLE_CONTENT_FORBIDDEN' }),
    );
  });

  it('accepts exact percentage and periodic tax variants and rejects unsafe pairings', () => {
    const fallback = createDeterministicHarborCityFallback({
      catalog: harborCityManifestCatalog(),
      prompt: harborPrompt,
      seed: 'harbor-tax-variants-m09',
    });
    const extension = structuredClone(
      fallback.envelope.manifest.extensions['worldgraph.economy'],
    ) as {
      taxPolicies: Record<string, unknown>[];
    } & Record<string, unknown>;
    const sales = extension.taxPolicies.find((policy) => policy.taxType === 'sales')!;
    const periodic = extension.taxPolicies.find((policy) => policy.taxType === 'periodic_flat')!;

    for (const policy of [
      sales,
      { ...sales, taxType: 'transaction' },
      { ...sales, collectionMode: 'withheld_from_recipient', taxType: 'payroll' },
      { ...sales, collectionMode: 'withheld_from_recipient', taxType: 'marketplace_fee' },
      periodic,
    ]) {
      expect(() =>
        parseWorldgraphEconomyExtensionV2({ ...extension, taxPolicies: [policy] }),
      ).not.toThrow();
    }
    expect(() =>
      parseWorldgraphEconomyExtensionV2({
        ...extension,
        taxPolicies: [{ ...sales, collectionMode: 'added_to_payer', taxType: 'payroll' }],
      }),
    ).toThrow('MANIFEST_ECONOMY_EXTENSION_SCHEMA_INVALID');
    expect(() =>
      parseWorldgraphEconomyExtensionV2({
        ...extension,
        taxPolicies: [{ ...periodic, rateBps: 250 }],
      }),
    ).toThrow('MANIFEST_ECONOMY_EXTENSION_SCHEMA_INVALID');
  });

  it('bounds periodic bootstrap events and resolves the payer wallet to its organization', () => {
    const fallback = createDeterministicHarborCityFallback({
      catalog: harborCityManifestCatalog(),
      prompt: harborPrompt,
      seed: 'harbor-periodic-guard-m09',
    });
    const invalidWallet = structuredClone(fallback.envelope.manifest);
    const invalidWalletPolicies = (
      invalidWallet.extensions['worldgraph.economy'] as {
        taxPolicies: Record<string, unknown>[];
      }
    ).taxPolicies;
    invalidWalletPolicies.find((policy) => policy.taxType === 'periodic_flat')![
      'payerWalletStableKey'
    ] = 'wallet:treasury:gcr';
    expect(validateWorldManifest(invalidWallet, harborCityManifestCatalog()).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MANIFEST_ECONOMY_EXTENSION_PERIODIC_PAYER_WALLET_INVALID',
        }),
      ]),
    );

    const tooMany = structuredClone(fallback.envelope.manifest);
    const extension = tooMany.extensions['worldgraph.economy'] as {
      taxPolicies: Record<string, unknown>[];
    };
    const periodic = extension.taxPolicies.find((policy) => policy.taxType === 'periodic_flat')!;
    extension.taxPolicies = Array.from({ length: 16 }, (_, index) => ({
      ...periodic,
      stableKey: `tax-policy:guild-council:dues-${index.toString().padStart(2, '0')}`,
    }));
    expect(validateWorldManifest(tooMany, harborCityManifestCatalog()).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MANIFEST_ECONOMY_EXTENSION_PERIODIC_POLICY_LIMIT_EXCEEDED',
        }),
      ]),
    );
  });

  it('records deterministic provenance for every fallback manifest field', () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({ catalog, prompt, seed: 'provenance-seed' });
    const provenance = new Map(fallback.envelope.provenance.map((entry) => [entry.pointer, entry]));

    expect(
      leafPointers(fallback.envelope.manifest).filter((pointer) => !provenance.has(pointer)),
    ).toEqual([]);
    expect(
      fallback.envelope.provenance.filter((entry) => entry.pointer === '/metadata/name'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: 'fallback' }),
        expect.objectContaining({
          sourceHash: sha256(prompt),
          sourceRef: `prompt:${sha256(prompt).slice(0, 32)}`,
          sourceType: 'prompt',
        }),
      ]),
    );
    expect(
      fallback.envelope.provenance.filter((entry) => entry.pointer === '/metadata/description'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: 'fallback' }),
        expect.objectContaining({ sourceHash: sha256(prompt), sourceType: 'prompt' }),
      ]),
    );
    expect(provenance.get('/assumptions/0')?.sourceType).toBe('fallback');
    expect(provenance.get('/districts/0')?.sourceType).toBe('fallback');
    expect(provenance.get('/districts/0/key')?.sourceType).toBe('fallback');
    expect(provenance.get('/institutions/0')?.sourceType).toBe('fallback');
    expect(provenance.get('/institutions/0/name')?.sourceType).toBe('fallback');
    expect(provenance.get('/organizations/0')?.sourceType).toBe('fallback');
    expect(provenance.get('/organizations/0/name')?.sourceType).toBe('fallback');
    expect(provenance.get('/actors/0')?.sourceType).toBe('fallback');
    expect(provenance.get('/actors/0/name')?.sourceType).toBe('fallback');
    expect(provenance.get('/relationships/0')?.sourceType).toBe('fallback');
    expect(provenance.get('/relationships/0/type')?.sourceType).toBe('fallback');
    expect(provenance.get('/economy/currencyPrimitiveRef')?.sourceType).toBe('primitive');
    expect(
      [...provenance.entries()].find(([pointer]) =>
        pointer.startsWith('/districts/0/parameters'),
      )?.[1].sourceType,
    ).toBe('primitive');
    expect(fallback.envelope.provenance).toEqual(
      createDeterministicFallback({
        catalog: { primitives: [...catalog.primitives].reverse() },
        prompt,
        seed: 'provenance-seed',
      }).envelope.provenance,
    );
  });

  it('projects generation warnings into the stable validation report', () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({ catalog, prompt, seed: 'warning-seed' });
    const first = validateManifestGenerationEnvelope(fallback.envelope, catalog);
    const reordered = validateManifestGenerationEnvelope(
      { ...fallback.envelope, warnings: [...fallback.envelope.warnings].reverse() },
      catalog,
    );

    expect(first.valid).toBe(true);
    expect(first.diagnostics.filter((entry) => entry.severity === 'warning')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FALLBACK_TEMPLATE_USED', pointer: '' }),
        expect.objectContaining({
          code: 'HIGH_IMPACT_RULES_REQUIRE_REVIEW',
          pointer: '/assumptions',
        }),
      ]),
    );
    expect(reordered.reportHash).toBe(first.reportHash);
  });

  it('attaches a stable immutable generation-warning set to later catalog validations', () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({
      catalog,
      prompt,
      seed: 'attached-warning-seed',
    });
    const requirements = [
      {
        code: 'FALLBACK_TEMPLATE_USED',
        message: 'The deterministic fallback was used.',
        pointer: '',
      },
      {
        code: 'HIGH_IMPACT_RULES_REQUIRE_REVIEW',
        message: 'High-impact rules require explicit review.',
        pointer: '/simulation',
      },
    ];
    const current = validateWorldManifest(fallback.envelope.manifest, {
      primitives: catalog.primitives.map((primitive) => ({
        ...primitive,
        lifecycle: primitive.kind === 'currency' ? ('deprecated' as const) : primitive.lifecycle,
      })),
    });
    const attached = attachManifestGenerationWarnings(current, requirements);
    const reordered = attachManifestGenerationWarnings(
      current,
      mergeManifestGenerationWarnings([...requirements].reverse(), requirements),
    );

    expect(attached.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FALLBACK_TEMPLATE_USED', severity: 'warning' }),
        expect.objectContaining({
          code: 'HIGH_IMPACT_RULES_REQUIRE_REVIEW',
          severity: 'warning',
        }),
        expect.objectContaining({ code: 'MANIFEST_PRIMITIVE_DEPRECATED', severity: 'warning' }),
      ]),
    );
    expect(reordered.reportHash).toBe(attached.reportHash);
  });

  it('enforces the shared immutable generation-warning ceiling', () => {
    const warnings = Array.from({ length: MAX_MANIFEST_GENERATION_WARNINGS }, (_, index) => ({
      code: `WARNING_${index}`,
      message: `Warning ${index}.`,
      pointer: '',
    }));

    expect(mergeManifestGenerationWarnings(warnings)).toHaveLength(
      MAX_MANIFEST_GENERATION_WARNINGS,
    );
    expect(() =>
      mergeManifestGenerationWarnings(warnings, [
        { code: 'WARNING_OVERFLOW', message: 'One warning too many.', pointer: '' },
      ]),
    ).toThrow('MANIFEST_GENERATION_WARNING_LIMIT');
  });

  it('round-trips a canonical safe YAML projection with source locations', () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({ catalog, prompt, seed: 'yaml-seed' });
    const yaml = projectSafeYaml(fallback.envelope.manifest);
    const parsed = parseSafeYaml(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(manifestContentHash(parsed.value as never)).toBe(fallback.contentHash);
    const keyLocation = parsed.locations.get('/districts/0/key');
    expect(typeof keyLocation?.column).toBe('number');
    expect(typeof keyLocation?.line).toBe('number');
    expect(structuralManifestDiff(fallback.envelope.manifest, parsed.value)).toEqual({
      counts: { added: 0, changed: 0, removed: 0 },
      entries: [],
      truncated: false,
    });
  });

  it('reports stable semantic pin, duplicate-key, dependency, and connectivity errors', () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({ catalog, prompt, seed: 'invalid-seed' });
    const invalid = structuredClone(fallback.envelope.manifest) as unknown as {
      connections: unknown[];
      districts: { key: string }[];
      primitiveRefs: { contentHash: string; kind: string }[];
    };
    invalid.connections = [];
    invalid.primitiveRefs.find((entry) => entry.kind === 'currency')!.contentHash = 'f'.repeat(64);
    const result = validateWorldManifest(invalid, catalog);
    const duplicate = structuredClone(fallback.envelope.manifest) as unknown as {
      districts: { key: string }[];
    };
    duplicate.districts[1]!.key = duplicate.districts[0]!.key;
    const codes = [
      ...result.diagnostics.map((entry) => entry.code),
      ...validateWorldManifest(duplicate, catalog).diagnostics.map((entry) => entry.code),
    ];
    expect(result.valid).toBe(false);
    expect(codes).toContain('MANIFEST_DUPLICATE_LOCAL_KEY');
    expect(codes).toContain('MANIFEST_PRIMITIVE_PIN_UNKNOWN');
    expect(codes).toContain('MANIFEST_DISTRICT_GRAPH_DISCONNECTED');
    expect(
      result.diagnostics.find((entry) => entry.code === 'MANIFEST_PRIMITIVE_PIN_UNKNOWN')?.fixes,
    ).toContainEqual(expect.objectContaining({ kind: 'select-primitive' }));
  });

  it('rejects invalid relationship endpoint/type tuples with a stable diagnostic', () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({ catalog, prompt, seed: 'tuple-seed' });
    const invalid = structuredClone(fallback.envelope.manifest);
    invalid.relationships[0]!.type = 'governs';

    const first = validateWorldManifest(invalid, catalog);
    const second = validateWorldManifest(structuredClone(invalid), catalog);
    expect(first.valid).toBe(false);
    expect(
      first.diagnostics.find((entry) => entry.code === 'MANIFEST_RELATIONSHIP_TUPLE_INVALID'),
    ).toMatchObject({
      message: 'Relationship type governs does not allow actor -> organization.',
      pointer: '/relationships/0/type',
      relatedPointers: ['/relationships/0/source', '/relationships/0/target'],
    });
    expect(second.reportHash).toBe(first.reportHash);
  });

  it('requires an essential actor and actual use of pinned critical mechanics', () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({ catalog, prompt, seed: 'critical-use-seed' });
    const invalid = structuredClone(fallback.envelope.manifest);
    invalid.actors = [];
    invalid.institutions = invalid.institutions.filter(
      (institution) => institution.primitiveRef !== 'government',
    );
    invalid.relationships = invalid.relationships.filter(
      (relationship) =>
        relationship.source.kind !== 'actor' && relationship.source.key !== 'guild-council',
    );

    const result = validateWorldManifest(invalid, catalog);
    const codes = result.diagnostics.map((entry) => entry.code);
    const unusedMessages = result.diagnostics
      .filter((entry) => entry.code === 'MANIFEST_CRITICAL_MECHANIC_UNUSED')
      .map((entry) => entry.message);
    expect(result.valid).toBe(false);
    expect(codes).toContain('MANIFEST_ESSENTIAL_ACTOR_MISSING');
    expect(unusedMessages.some((message) => message.includes('government'))).toBe(true);
    expect(unusedMessages.some((message) => message.includes('player_role'))).toBe(true);
  });

  it('returns a bounded structural diff without mutating either revision', () => {
    const fallback = createDeterministicFallback({
      catalog: starterManifestCatalog(),
      prompt,
      seed: 'diff-seed',
    });
    const before = structuredClone(fallback.envelope.manifest);
    const after = structuredClone(before);
    after.metadata.name = 'Revised Floating Guild City';
    after.assumptions.push('A fourth reviewed assumption.');
    const diff = structuralManifestDiff(before, after);
    expect(diff.counts).toEqual({ added: 1, changed: 1, removed: 0 });
    expect(diff.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'changed', pointer: '/metadata/name' }),
        expect.objectContaining({ kind: 'added', pointer: '/assumptions/3' }),
      ]),
    );
    expect(before.metadata.name).toBe('Floating Guild City');
  });

  it('returns every contract-bounded change beyond one response page without truncation', () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({
      catalog,
      prompt,
      seed: 'large-diff-seed',
    });
    const before = structuredClone(fallback.envelope.manifest);
    const after = structuredClone(before);
    before.extensions['worldgraph.diff-fixture'] = Array.from({ length: 7 }, () =>
      Array.from({ length: 200 }, () => 0),
    );
    after.extensions['worldgraph.diff-fixture'] = Array.from({ length: 7 }, () =>
      Array.from({ length: 200 }, () => 1),
    );

    expect(validateWorldManifest(before, catalog).valid).toBe(true);
    expect(validateWorldManifest(after, catalog).valid).toBe(true);
    const diff = structuralManifestDiff(before, after);
    expect(diff).toMatchObject({
      counts: { added: 0, changed: 1_400, removed: 0 },
      truncated: false,
    });
    expect(diff.entries).toHaveLength(1_400);
    expect(diff.entries[0]).toMatchObject({
      kind: 'changed',
      pointer: '/extensions/worldgraph.diff-fixture/0/0',
    });
    expect(diff.entries.at(-1)).toMatchObject({
      kind: 'changed',
      pointer: '/extensions/worldgraph.diff-fixture/6/199',
    });
  });

  it('matches manifest keyed collections by identity instead of array position', () => {
    const fallback = createDeterministicFallback({
      catalog: starterManifestCatalog(),
      prompt,
      seed: 'keyed-diff-seed',
    });
    const before = structuredClone(fallback.envelope.manifest);
    const reordered = structuredClone(before);
    reordered.districts.reverse();
    reordered.primitiveRefs.reverse();
    expect(structuralManifestDiff(before, reordered)).toEqual({
      counts: { added: 0, changed: 0, removed: 0 },
      entries: [],
      truncated: false,
    });

    const after = structuredClone(before);
    const inserted = {
      ...structuredClone(after.districts[0]!),
      key: 'market-platform',
      name: 'Market Platform',
    };
    after.districts = [inserted, after.districts[1]!, after.districts[0]!];
    after.districts[2] = {
      ...after.districts[2]!,
      name: 'Revised Civic Platform',
    };
    const diff = structuralManifestDiff(before, after);
    expect(diff.counts).toEqual({ added: 1, changed: 1, removed: 0 });
    expect(diff.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'added', pointer: '/districts/0' }),
        expect.objectContaining({ kind: 'changed', pointer: '/districts/2/name' }),
      ]),
    );
  });
});
