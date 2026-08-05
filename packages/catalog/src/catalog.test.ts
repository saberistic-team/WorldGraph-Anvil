import { describe, expect, it } from 'vitest';

import type { PrimitiveDraftInput } from '@worldgraph/contracts';

import { resolveDependencies, type PublishedPrimitiveRef } from './dependencies.js';
import {
  assertEmbedding,
  createPrimitiveEmbeddingProfile,
  EmbeddingProviderError,
  LOCAL_HASH_EMBEDDING_CONFIGURATION_ID,
  LOCAL_HASH_EMBEDDING_MODEL,
  LOCAL_HASH_EMBEDDING_PROVIDER,
  localHashEmbeddingVector,
} from './embedding.js';
import { rankCandidates } from './retrieval.js';
import {
  highestSatisfying,
  isValidVersionRange,
  parseSemver,
  satisfiesVersionRange,
} from './semver.js';
import { assertHarborCityCatalogLock, HARBOR_CITY_ECONOMY_PRIMITIVES } from './harbor-seed.js';
import { assertGovernanceCatalogLock, GOVERNANCE_PRIMITIVES } from './governance-seed.js';
import { assertStarterCatalogLock, STARTER_PRIMITIVES } from './seed.js';
import {
  buildPrimitiveIndexDocument,
  primitiveTagFrequencies,
  scorePrimitiveIndex,
  scorePrimitiveTags,
} from './search.js';
import {
  primitiveContentHash,
  validateBoundedJson,
  validatePrimitive,
  validateSafeJsonStructure,
} from './validation.js';

function published(): PublishedPrimitiveRef[] {
  return STARTER_PRIMITIVES.map((entry) => ({
    contentHash: entry.contentHash,
    dependencies: entry.input.dependencies,
    key: entry.input.key,
    version: entry.input.version,
    versionId: entry.versionId,
  }));
}

describe('primitive catalog domain', () => {
  it('validates exactly one reviewed seed for all MVP kinds with stable hashes', () => {
    expect(STARTER_PRIMITIVES).toHaveLength(16);
    expect(() => assertStarterCatalogLock()).not.toThrow();
    expect(new Set(STARTER_PRIMITIVES.map((entry) => entry.input.kind)).size).toBe(16);
    expect(new Set(STARTER_PRIMITIVES.map((entry) => entry.familyId)).size).toBe(16);
    expect(new Set(STARTER_PRIMITIVES.map((entry) => entry.versionId)).size).toBe(16);
    for (const entry of STARTER_PRIMITIVES) {
      expect(validatePrimitive(entry.input)).toEqual({
        contentHash: entry.contentHash,
        issues: [],
        valid: true,
      });
      expect(primitiveContentHash(entry.input)).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(STARTER_PRIMITIVES[0]!.contentHash).toBe(
      'c065b367849253adc984cb037de346da9e2391cd4a5d468111e0c0d03776c99e',
    );
  });

  it('keeps the reviewed M09 harbor additions in a separate exact lock and search lane', () => {
    expect(STARTER_PRIMITIVES).toHaveLength(16);
    expect(HARBOR_CITY_ECONOMY_PRIMITIVES).toHaveLength(3);
    expect(() => assertStarterCatalogLock()).not.toThrow();
    expect(() => assertHarborCityCatalogLock()).not.toThrow();
    expect(
      HARBOR_CITY_ECONOMY_PRIMITIVES.map((entry) => [entry.input.key, entry.contentHash]),
    ).toEqual([
      [
        'worldgraph.resource.iron-ore',
        '6c8976b133e0c418c731548ad9ff2c7c5121abd87497184474e59f17410882dd',
      ],
      [
        'worldgraph.resource.metal-part',
        'c00ad09b7b07f808ddfd09161dbe97ce77b9dd3a0d5e71f8fde8ca4a39c2b402',
      ],
      [
        'worldgraph.production-recipe.metal-part-fabrication',
        '765af04e4cb2914f30ee2a306e8489384aa73557db8aad51e3c00841dfc4b626',
      ],
    ]);
    for (const entry of HARBOR_CITY_ECONOMY_PRIMITIVES) {
      expect(validatePrimitive(entry.input)).toEqual({
        contentHash: entry.contentHash,
        issues: [],
        valid: true,
      });
      expect(buildPrimitiveIndexDocument(entry.input).normalizedText).toContain('harbor');
      expect(
        scorePrimitiveIndex(
          'harbor iron ore metal part fabrication',
          buildPrimitiveIndexDocument(entry.input),
        ),
      ).toBeGreaterThan(0);
    }
    expect(
      HARBOR_CITY_ECONOMY_PRIMITIVES.find(
        (entry) => entry.input.kind === 'production_recipe',
      )?.input.dependencies.map((entry) => entry.key),
    ).toEqual([
      'worldgraph.resource.energy',
      'worldgraph.resource.iron-ore',
      'worldgraph.resource.metal-part',
      'worldgraph.building.modular-guild-hall',
      'worldgraph.simulation-rule.discrete-city-clock',
    ]);
  });

  it('publishes an immutable plurality election version without changing ranked choice 1.0', () => {
    expect(() => assertGovernanceCatalogLock()).not.toThrow();
    expect(GOVERNANCE_PRIMITIVES).toHaveLength(1);
    expect(GOVERNANCE_PRIMITIVES[0]).toMatchObject({
      contentHash: 'b30fb010b82c935206cb8128bdfd5a4e573e1cec01b2de708e2167f97bdb0bde',
      familyId: STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'election')?.familyId,
      input: {
        defaults: { method: 'plurality', votingTicks: 24 },
        key: 'worldgraph.election.council-ballot',
        kind: 'election',
        version: '1.1.0',
      },
    });
    const sealed = STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'election')!;
    expect(sealed.input).toMatchObject({
      defaults: { method: 'ranked-choice', votingTicks: 24 },
      key: 'worldgraph.election.council-ballot',
      version: '1.0.0',
    });
    expect(GOVERNANCE_PRIMITIVES[0]!.contentHash).not.toBe(sealed.contentHash);
  });

  it('implements full strict SemVer precedence, ranges, and deterministic build ties', () => {
    expect(parseSemver('1.0.0-01')).toBeNull();
    expect(parseSemver('1.0.0+build.7')).not.toBeNull();
    expect(highestSatisfying(['1.9.0', '1.10.0'], '>=1.0.0 <2.0.0')).toBe('1.10.0');
    expect(highestSatisfying(['1.0.0+alpha', '1.0.0+zeta'], '^1.0.0')).toBe('1.0.0+zeta');
    expect(satisfiesVersionRange('1.1.0-beta.999999999999999999999999', '^1.0.0')).toBe(false);
    expect(satisfiesVersionRange('1.1.0-beta.1', '^1.0.0-beta.1')).toBe(false);
    expect(satisfiesVersionRange('1.0.0-beta.2', '^1.0.0-beta.1')).toBe(true);
    expect(satisfiesVersionRange('1.0.1-beta.1', '~1.0.0-beta.1')).toBe(false);
    expect(satisfiesVersionRange('1.0.0-beta.2', '>=1.0.0-beta.1 <2.0.0')).toBe(true);
    expect(satisfiesVersionRange('1.1.0-beta.1', '>=1.0.0-beta.1 <2.0.0')).toBe(false);
    expect(isValidVersionRange('latest')).toBe(false);
    expect(isValidVersionRange('')).toBe(false);
    expect(isValidVersionRange('^1.0.0 || ^2.0.0')).toBe(false);
  });

  it('rejects remote refs, regex, prototype keys, unsafe docs, schema bombs and invalid defaults', () => {
    const base = structuredClone(STARTER_PRIMITIVES[0]!.input);
    const cases: [Partial<PrimitiveDraftInput>, string][] = [
      [
        { parameterSchema: { ...base.parameterSchema, $ref: 'https://attacker.invalid/schema' } },
        'REMOTE_REF_FORBIDDEN',
      ],
      [
        { parameterSchema: { ...base.parameterSchema, patternProperties: { '.*': {} } } },
        'UNSAFE_REGEX',
      ],
      [{ documentation: '<img src=x onerror=alert(1)>' }, 'DOCUMENTATION_UNSAFE'],
      [
        { defaults: JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown> },
        'PROTOTYPE_KEY_FORBIDDEN',
      ],
      [{ behaviorRef: 'simulation.discrete_clock' }, 'BEHAVIOR_REF_NOT_ALLOWED'],
      [
        { defaults: { quorumBps: 'many', seatCount: 7, termTicks: 720 } },
        'DEFAULTS_SCHEMA_MISMATCH',
      ],
      [
        {
          parameterSchema: {
            additionalProperties: false,
            $defs: { node: { $ref: '#/$defs/node' } },
            properties: {},
            type: 'object',
          },
        },
        'LOCAL_REF_CYCLE',
      ],
      [
        {
          parameterSchema: {
            additionalProperties: false,
            properties: { node: { $ref: '#/$defs/missing' } },
            type: 'object',
          },
        },
        'LOCAL_REF_MISSING',
      ],
    ];
    for (const [changes, code] of cases) {
      expect(
        validatePrimitive({ ...base, ...changes }).issues.map((entry) => entry.code),
      ).toContain(code);
    }
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 15; index += 1) nested = { next: nested };
    expect(
      validatePrimitive({ ...base, visualHints: nested }).issues.map((entry) => entry.code),
    ).toContain('JSON_DEPTH_EXCEEDED');

    const collidingMapping = JSON.parse('{"é":1,"é":2}') as Record<string, unknown>;
    expect(
      validatePrimitive({
        ...base,
        dependencies: [
          { key: 'worldgraph.test.target', parameterMapping: collidingMapping, versionRange: '*' },
        ],
      }).issues.map((entry) => entry.code),
    ).toContain('JSON_KEY_NORMALIZATION_COLLISION');
    expect(
      validatePrimitive({ ...base, documentation: '# Safe\r\nNot safe' }).issues.map(
        (entry) => entry.code,
      ),
    ).toContain('TEXT_INVALID');
    expect(
      validatePrimitive({
        ...base,
        documentation: '# Unsafe\n\n//attacker.invalid/path',
      }).issues.map((entry) => entry.code),
    ).toContain('DOCUMENTATION_UNSAFE');
    expect(
      validatePrimitive({
        ...base,
        documentation: '# Unsafe\n\n[link](HTTPS://attacker.invalid)',
      }).issues.map((entry) => entry.code),
    ).toContain('DOCUMENTATION_UNSAFE');
    expect(
      validatePrimitive({
        ...base,
        documentation: `# Unsafe\n\n${String.fromCharCode(0)}`,
      }).issues.map((entry) => entry.code),
    ).toContain('TEXT_INVALID');

    const excessive = structuredClone(base);
    excessive.visualHints = {
      payload: Object.fromEntries(
        Array.from({ length: 600 }, (_, index) => [`section-${index}`, index]),
      ),
      values: Array.from({ length: 500 }, (_, index) => index),
    };
    const excessiveResult = validatePrimitive(excessive);
    expect(excessiveResult.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['JSON_ARRAY_LIMIT_EXCEEDED', 'JSON_PROPERTY_LIMIT_EXCEEDED']),
    );
    expect(excessiveResult.issues.length).toBeLessThanOrEqual(128);

    const schemaBomb = structuredClone(base);
    schemaBomb.parameterSchema = {
      additionalProperties: false,
      properties: { payload: { enum: Array.from({ length: 10_000 }, (_, index) => index) } },
      type: 'object',
    };
    const schemaBombResult = validatePrimitive(schemaBomb);
    expect(schemaBombResult.issues.map((entry) => entry.code)).toContain(
      'JSON_ARRAY_LIMIT_EXCEEDED',
    );
    expect(schemaBombResult.issues.length).toBeLessThanOrEqual(128);

    expect(
      validatePrimitive({
        ...base,
        documentation: `# Broken ${String.fromCharCode(0xd800)}`,
      }).issues.map((entry) => entry.code),
    ).toContain('TEXT_INVALID');
    expect(
      validatePrimitive({
        ...base,
        visualHints: { [`broken${String.fromCharCode(0xd800)}`]: true },
      }).issues.map((entry) => entry.code),
    ).toContain('JSON_KEY_INVALID');
  });

  it('rejects executable SQL, template delimiters, and recursive or dynamic schema references without overmatching prose', () => {
    const base = structuredClone(STARTER_PRIMITIVES[0]!.input);
    const malicious: [Partial<PrimitiveDraftInput>, string][] = [
      [
        { compatibility: { payload: 'SELECT id FROM users WHERE admin = true' } },
        'EXECUTABLE_SQL_FORBIDDEN',
      ],
      [
        { defaults: { ...base.defaults, payload: "'; DROP TABLE primitive_versions;" } },
        'EXECUTABLE_SQL_FORBIDDEN',
      ],
      [
        { visualHints: { label: '{{ constructor.constructor("return process")() }}' } },
        'EXECUTABLE_TEMPLATE_FORBIDDEN',
      ],
      [
        { provenance: { source: '<%= globalThis.process.env %>' } },
        'EXECUTABLE_TEMPLATE_FORBIDDEN',
      ],
      [
        { parameterSchema: { ...base.parameterSchema, $recursiveRef: '#' } },
        'REMOTE_REF_FORBIDDEN',
      ],
      [
        { parameterSchema: { ...base.parameterSchema, $recursiveAnchor: true } },
        'REMOTE_REF_FORBIDDEN',
      ],
      [
        { parameterSchema: { ...base.parameterSchema, $dynamicRef: '#node' } },
        'REMOTE_REF_FORBIDDEN',
      ],
      [
        { parameterSchema: { ...base.parameterSchema, $dynamicAnchor: 'node' } },
        'REMOTE_REF_FORBIDDEN',
      ],
    ];
    for (const [changes, code] of malicious) {
      expect(
        validatePrimitive({ ...base, ...changes }).issues.map((entry) => entry.code),
      ).toContain(code);
    }

    for (const payload of [
      'GRANT ALL ON TABLE users TO public;',
      'REVOKE SELECT ON users FROM public;',
      'SELECT pg_sleep(10);',
      "COPY users TO PROGRAM 'curl';",
      'WITH doomed AS (SELECT id FROM users) DELETE FROM users;',
      '/* disguised */ SELECT 1',
      'VACUUM users',
      "ALTER SYSTEM SET log_statement = 'all'",
      'DROP OWNED BY current_user',
      "NOTIFY channel, 'payload'",
      'BEGIN',
      'COMMIT',
      'TRUNCATE users',
      'REINDEX TABLE users',
      'SET ROLE administrator',
      'LOCK TABLE users IN ACCESS EXCLUSIVE MODE',
      'MERGE INTO users USING updates ON users.id = updates.id WHEN MATCHED THEN DELETE',
      'SELECT current_user',
      'SELECT 1+1',
      'VALUES (1)',
      'SHOW search_path',
      'RESET ALL',
      'DISCARD ALL',
      'GRANT admin TO alice',
      'REVOKE admin FROM alice',
      'SET search_path TO evil',
      'CREATE TEMP TABLE x(id int)',
      'PREPARE x AS SELECT 1',
      'DEALLOCATE x',
      'LISTEN channel',
      'REFRESH MATERIALIZED VIEW x',
      'SECURITY LABEL ON TABLE x IS label',
      'COMMENT ON TABLE x IS note',
      'IMPORT FOREIGN SCHEMA x FROM SERVER y INTO z',
      'REASSIGN OWNED BY a TO b',
    ]) {
      expect(
        validateBoundedJson(
          { payload },
          { pointer: '/compatibility', rejectExecutableContent: true },
        ).issues,
      ).toContainEqual(expect.objectContaining({ code: 'EXECUTABLE_SQL_FORBIDDEN' }));
    }

    for (const payload of [
      'ftp://attacker.invalid/file',
      'ws://attacker.invalid/socket',
      'wss://attacker.invalid/socket',
      'blob:opaque-value',
      'tel:+15555550123',
      'ssh://attacker.invalid/repository',
      "See 'ftp://attacker.invalid/file'",
      'endpoint=ftp://attacker.invalid/file',
      'fetch("https://attacker.invalid")',
      '{ftp://attacker.invalid}',
      'x:payload',
    ]) {
      expect(
        validateBoundedJson({ payload }, { pointer: '/visualHints', rejectExecutableContent: true })
          .issues,
      ).toContainEqual(expect.objectContaining({ code: 'REMOTE_OR_EXECUTABLE_CONTENT_FORBIDDEN' }));
    }

    for (const [displayName, code] of [
      ['https://attacker.invalid', 'REMOTE_OR_EXECUTABLE_CONTENT_FORBIDDEN'],
      ['<img src=x>', 'REMOTE_OR_EXECUTABLE_CONTENT_FORBIDDEN'],
      ['{{execute}}', 'EXECUTABLE_TEMPLATE_FORBIDDEN'],
      ['DROP TABLE users;', 'EXECUTABLE_SQL_FORBIDDEN'],
    ] as const) {
      expect(
        validatePrimitive({ ...base, displayName }).issues.map((entry) => entry.code),
      ).toContain(code);
    }

    for (const [key, code] of [
      ['https://attacker.invalid', 'REMOTE_OR_EXECUTABLE_CONTENT_FORBIDDEN'],
      ['<img src=x>', 'REMOTE_OR_EXECUTABLE_CONTENT_FORBIDDEN'],
      ['{{execute}}', 'EXECUTABLE_TEMPLATE_FORBIDDEN'],
      ['DROP TABLE users;', 'EXECUTABLE_SQL_FORBIDDEN'],
    ] as const) {
      expect(
        validateBoundedJson(
          { [key]: 'safe' },
          { pointer: '/provenance', rejectExecutableContent: true },
        ).issues.map((entry) => entry.code),
      ).toContain(code);
    }

    expect(
      validatePrimitive({
        ...base,
        documentation:
          '# Council records\n\nA curator may select a council role from the available offices and drop table decorations near the entrance.',
        provenance: { note: 'The curator discussed SQL safety and template rendering in prose.' },
      }).valid,
    ).toBe(true);
  });

  it('exports stable bounded JSON inspection with executable checks explicitly selectable', () => {
    const first = validateBoundedJson(
      { z: { payload: 'SELECT * FROM users' }, a: '{{run}}' },
      {
        pointer: '/compatibility',
        rejectExecutableContent: true,
      },
    );
    const reordered = validateBoundedJson(
      { a: '{{run}}', z: { payload: 'SELECT * FROM users' } },
      {
        pointer: '/compatibility',
        rejectExecutableContent: true,
      },
    );
    expect(first).toEqual(reordered);
    expect(first.issues.map((entry) => entry.code)).toEqual([
      'EXECUTABLE_TEMPLATE_FORBIDDEN',
      'EXECUTABLE_SQL_FORBIDDEN',
    ]);
    expect(validateBoundedJson({ note: '{{literal}}' }, { pointer: '/compatibility' })).toEqual({
      issues: [],
      valid: true,
    });
    const excessive = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`field-${index}`, '{{execute}}']),
    );
    const bounded = validateBoundedJson(excessive, {
      pointer: '/compatibility',
      rejectExecutableContent: true,
    });
    expect(bounded.valid).toBe(false);
    expect(bounded.issues.length).toBeLessThanOrEqual(128);
  });

  it('bounds untrusted compatibility filters recursively', () => {
    const prototypeKey = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(validateSafeJsonStructure(prototypeKey, '/compatibility')).toContainEqual(
      expect.objectContaining({
        code: 'PROTOTYPE_KEY_FORBIDDEN',
        pointer: '/compatibility/__proto__',
      }),
    );

    let deeplyNested: Record<string, unknown> = {};
    for (let depth = 0; depth < 14; depth += 1) deeplyNested = { nested: deeplyNested };
    expect(validateSafeJsonStructure(deeplyNested, '/compatibility')).toContainEqual(
      expect.objectContaining({
        code: 'JSON_DEPTH_EXCEEDED',
      }),
    );

    expect(
      validateSafeJsonStructure({ values: Array<number>(201).fill(1) }, '/compatibility'),
    ).toContainEqual(expect.objectContaining({ code: 'JSON_ARRAY_LIMIT_EXCEEDED' }));
    expect(validateSafeJsonStructure({ 'bad\u0000key': true }, '/compatibility')).toContainEqual(
      expect.objectContaining({ code: 'JSON_KEY_INVALID' }),
    );
  });

  it('canonicalizes semantic object, dependency, tag, and Unicode ordering', () => {
    const base = structuredClone(
      STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'election')!.input,
    );
    const reordered = structuredClone(base);
    reordered.tags.reverse();
    reordered.dependencies.reverse();
    reordered.compatibility = Object.fromEntries(Object.entries(reordered.compatibility).reverse());
    expect(primitiveContentHash(reordered)).toBe(primitiveContentHash(base));

    const composed = { ...base, displayName: 'Café Council' };
    const decomposed = { ...base, displayName: 'Café Council' };
    expect(primitiveContentHash(decomposed)).toBe(primitiveContentHash(composed));
  });

  it('does not leak starter curation into future primitives of the same kind', () => {
    const resource = structuredClone(
      STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'resource')!.input,
    );
    const futureResource: PrimitiveDraftInput = {
      ...resource,
      displayName: 'Potable Water',
      documentation: '# Potable Water\n\nA bounded potable resource stock.',
      key: 'worldgraph.resource.potable-water',
      tags: ['potable', 'resource', 'water'],
      version: '1.1.0',
    };
    const district = structuredClone(
      STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'district')!.input,
    );
    const futureDistrict: PrimitiveDraftInput = {
      ...district,
      displayName: 'Ground Market',
      documentation: '# Ground Market\n\nA connected market district.',
      key: 'worldgraph.district.ground-market',
      tags: ['district', 'ground', 'market'],
      version: '1.1.0',
    };
    expect(buildPrimitiveIndexDocument(futureResource).normalizedText).not.toMatch(
      /\b(?:energy|scarce)\b/,
    );
    expect(buildPrimitiveIndexDocument(futureDistrict).normalizedText).not.toMatch(/\bfloating\b/);
  });

  it('resolves an immutable exact dependency closure and rejects cycles/conflicts', () => {
    const event = STARTER_PRIMITIVES.find((entry) => entry.input.kind === 'event_template')!;
    const resolved = resolveDependencies(event.input.key, event.input.dependencies, published());
    expect(resolved.issues).toEqual([]);
    expect(resolved.closure.map((entry) => entry.key)).toEqual([
      'worldgraph.government.guild-council',
      'worldgraph.office.councillor',
      'worldgraph.organization.guild',
      'worldgraph.simulation-rule.discrete-city-clock',
    ]);

    const cycleCatalog: PublishedPrimitiveRef[] = [
      {
        contentHash: 'a'.repeat(64),
        dependencies: [{ key: 'worldgraph.test.a', versionRange: '*' }],
        key: 'worldgraph.test.b',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000002',
      },
      {
        contentHash: 'b'.repeat(64),
        dependencies: [{ key: 'worldgraph.test.b', versionRange: '*' }],
        key: 'worldgraph.test.a',
        version: '1.0.0',
        versionId: '00000000-0000-4000-8000-000000000001',
      },
    ];
    expect(
      resolveDependencies('worldgraph.test.a', cycleCatalog[1]!.dependencies, cycleCatalog)
        .issues[0]?.code,
    ).toBe('DEPENDENCY_CYCLE');

    const x14 = {
      contentHash: 'c'.repeat(64),
      dependencies: [],
      key: 'worldgraph.test.x',
      version: '1.4.0',
      versionId: '00000000-0000-4000-8000-000000000014',
    };
    const x19 = {
      ...x14,
      contentHash: 'd'.repeat(64),
      version: '1.9.0',
      versionId: '00000000-0000-4000-8000-000000000019',
    };
    const a = {
      contentHash: 'e'.repeat(64),
      dependencies: [{ key: x14.key, versionRange: '<1.5.0' }],
      key: 'worldgraph.test.a',
      version: '1.0.0',
      versionId: '00000000-0000-4000-8000-000000000010',
    };
    const consistent = resolveDependencies(
      'worldgraph.test.root',
      [
        { key: a.key, versionRange: '*' },
        { key: x14.key, versionRange: '*' },
      ],
      [a, x14, x19],
    );
    expect(consistent.issues).toEqual([]);
    expect(consistent.resolved.find((entry) => entry.key === x14.key)?.resolvedVersion).toBe(
      '1.4.0',
    );
  });

  it('returns the seed-derived offline city-state golden order with fixed RRF semantics', () => {
    const golden = [
      'worldgraph.government.guild-council',
      'worldgraph.currency.closed-loop-credits',
      'worldgraph.resource.energy',
      'worldgraph.district.floating-mixed-use',
      'worldgraph.visual-style.low-poly-floating-city',
      'worldgraph.organization.guild',
      'worldgraph.terrain.floating-platform',
      'worldgraph.production-recipe.energy-reclamation',
    ];
    const frequencies = primitiveTagFrequencies(
      STARTER_PRIMITIVES.map((entry) => entry.input.tags),
    );
    const ranked = rankCandidates(
      'guild-led energy-scarce floating city with a council and closed-loop credits',
      STARTER_PRIMITIVES.map((entry) => ({
        id: entry.versionId,
        key: entry.input.key,
        kind: entry.input.kind,
        lexicalScore: scorePrimitiveIndex(
          'guild-led energy-scarce floating city with a council and closed-loop credits',
          buildPrimitiveIndexDocument(entry.input),
        ),
        normalizedText: buildPrimitiveIndexDocument(entry.input).normalizedText,
        tags: entry.input.tags,
        tagScore: scorePrimitiveTags(
          'guild-led energy-scarce floating city with a council and closed-loop credits',
          entry.input.tags,
          frequencies,
        ),
        version: entry.input.version,
      })),
    );
    expect(ranked.slice(0, 8).map((entry) => entry.key)).toEqual(golden);
    expect(ranked[0]?.matchedTerms).toContain('council');
  });

  it('fuses fixed semantic ranks without changing filters or validity', () => {
    const query = 'guild-led energy-scarce floating city with a council and closed-loop credits';
    const vectorOrder = [
      'worldgraph.district.floating-mixed-use',
      'worldgraph.terrain.floating-platform',
      'worldgraph.visual-style.low-poly-floating-city',
      'worldgraph.government.guild-council',
      'worldgraph.resource.energy',
      'worldgraph.currency.closed-loop-credits',
      'worldgraph.organization.guild',
      'worldgraph.production-recipe.energy-reclamation',
    ];
    const frequencies = primitiveTagFrequencies(
      STARTER_PRIMITIVES.map((entry) => entry.input.tags),
    );
    const ranked = rankCandidates(
      query,
      STARTER_PRIMITIVES.map((entry) => ({
        id: entry.versionId,
        key: entry.input.key,
        kind: entry.input.kind,
        lexicalScore: scorePrimitiveIndex(query, buildPrimitiveIndexDocument(entry.input)),
        normalizedText: buildPrimitiveIndexDocument(entry.input).normalizedText,
        tags: entry.input.tags,
        tagScore: scorePrimitiveTags(query, entry.input.tags, frequencies),
        vectorSimilarity: vectorOrder.includes(entry.input.key)
          ? 1 - vectorOrder.indexOf(entry.input.key) / 100
          : 0.01,
        version: entry.input.version,
      })),
    );
    expect(ranked.slice(0, 8).map((entry) => entry.key)).toEqual([
      'worldgraph.government.guild-council',
      'worldgraph.currency.closed-loop-credits',
      'worldgraph.resource.energy',
      'worldgraph.district.floating-mixed-use',
      'worldgraph.visual-style.low-poly-floating-city',
      'worldgraph.terrain.floating-platform',
      'worldgraph.organization.guild',
      'worldgraph.production-recipe.energy-reclamation',
    ]);
  });

  it('rejects nonfinite and wrong-dimension embeddings', () => {
    const invalid = {
      dimensions: 1536 as const,
      latencyMs: 1,
      model: 'fake-v1',
      provider: 'fake',
      tokenEstimate: 1,
      vector: [1],
    };
    expect(() => assertEmbedding(invalid)).toThrowError(EmbeddingProviderError);
    const base = {
      dimensions: 1536 as const,
      latencyMs: 1,
      model: 'fake-v1',
      provider: 'fake',
      tokenEstimate: 1,
    };
    expect(() => assertEmbedding({ ...base, vector: Array<number>(1536).fill(0) })).toThrowError(
      EmbeddingProviderError,
    );
    expect(() =>
      assertEmbedding({ ...base, vector: [Number.MAX_VALUE, ...Array<number>(1535).fill(1)] }),
    ).toThrowError(EmbeddingProviderError);
    expect(() =>
      assertEmbedding({ ...base, vector: [5e-324, ...Array<number>(1535).fill(0)] }),
    ).toThrowError(EmbeddingProviderError);
    expect(() =>
      assertEmbedding({ ...base, latencyMs: Number.NaN, vector: Array<number>(1536).fill(1) }),
    ).toThrowError(EmbeddingProviderError);
    expect(() =>
      assertEmbedding({ ...base, tokenEstimate: -1, vector: Array<number>(1536).fill(1) }),
    ).toThrowError(EmbeddingProviderError);
    expect(() =>
      assertEmbedding({ ...base, costEstimateMicrounits: -1, vector: Array<number>(1536).fill(1) }),
    ).toThrowError(EmbeddingProviderError);
    expect(() =>
      assertEmbedding({ ...base, provider: 'p'.repeat(121), vector: Array<number>(1536).fill(1) }),
    ).toThrowError(EmbeddingProviderError);
  });

  it('creates deterministic shared local-only 1536-dimension query/document embeddings at zero cost', async () => {
    const text = 'guild-led energy-scarce floating city council';
    const first = localHashEmbeddingVector(text);
    const second = localHashEmbeddingVector(text.normalize('NFKC'));
    expect(first).toEqual(second);
    expect(first).toHaveLength(1536);
    expect(first.some((value) => value !== 0)).toBe(true);
    expect(first.every(Number.isFinite)).toBe(true);

    const profile = createPrimitiveEmbeddingProfile('local_hash', 0);
    expect(profile).toMatchObject({
      configurationId: LOCAL_HASH_EMBEDDING_CONFIGURATION_ID,
      enabled: true,
      maximumCostMicrounits: 0,
      model: LOCAL_HASH_EMBEDDING_MODEL,
      provider: LOCAL_HASH_EMBEDDING_PROVIDER,
    });
    await expect(
      profile.embed(
        {
          contentHash: STARTER_PRIMITIVES[0]!.contentHash,
          normalizedText: text,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      costEstimateMicrounits: 0,
      dimensions: 1536,
      model: LOCAL_HASH_EMBEDDING_MODEL,
      provider: LOCAL_HASH_EMBEDDING_PROVIDER,
      vector: first,
    });
    expect(() => createPrimitiveEmbeddingProfile('local_hash', 1)).toThrow(
      'PRIMITIVE_EMBEDDING_COST_BUDGET_UNSUPPORTED',
    );
    expect(() => createPrimitiveEmbeddingProfile('remote' as 'local_hash', 0)).toThrow(
      'PRIMITIVE_SEMANTIC_PROFILE_UNSUPPORTED',
    );
  });
});
