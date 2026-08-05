import { describe, expect, it } from 'vitest';

import {
  assertWorldgraphGovernanceExtensionV1,
  createDeterministicGovernedHarborCityFallback,
  createDeterministicHarborCityFallback,
  governedHarborCityManifestCatalog,
  harborCityManifestCatalog,
  parseWorldgraphGovernanceExtensionV1,
  validateWorldManifest,
} from './index.js';

const prompt = 'A governed harbor city-state with guilds and closed-loop credits.';

describe('worldgraph.governance Manifest V1 extension', () => {
  it('emits deterministic strict charter intent and pins the plurality primitive', () => {
    const catalog = governedHarborCityManifestCatalog();
    const first = createDeterministicGovernedHarborCityFallback({
      catalog,
      prompt,
      seed: 'demo-seed',
    });
    const reordered = createDeterministicGovernedHarborCityFallback({
      catalog: { primitives: [...catalog.primitives].reverse() },
      prompt: `  ${prompt.replaceAll(' ', '  ')}  `,
      seed: 'demo-seed',
    });

    expect(catalog.primitives).toHaveLength(20);
    expect(first.contentHash).toBe(
      '46411a632c79fab0671a1a084013ccdbdd95794038926c01fc52579d9121b956',
    );
    expect(reordered.contentHash).toBe(first.contentHash);
    expect(validateWorldManifest(first.envelope.manifest, catalog).valid).toBe(true);
    expect(
      first.envelope.manifest.primitiveRefs.find((entry) => entry.ref === 'council-election'),
    ).toMatchObject({
      key: 'worldgraph.election.council-ballot',
      parameters: { method: 'plurality', votingTicks: 24 },
      version: '1.1.0',
    });
    expect(assertWorldgraphGovernanceExtensionV1(first.envelope.manifest)).toMatchObject({
      charter: {
        proposalRules: {
          ballotPolicy: { ballotMode: 'public', disclosure: 'choice_totals' },
        },
        stableKey: 'charter:harbor-city',
      },
      electionPrimitiveRef: 'council-election',
      institutions: [{ stableKey: 'institution:guild-council' }],
      offices: [
        {
          ballotPolicy: { ballotMode: 'secret', disclosure: 'aggregate_only' },
          seats: 7,
          stableKey: 'office:guild-council:councillor',
        },
        {
          ballotPolicy: { ballotMode: 'secret', disclosure: 'aggregate_only' },
          seats: 1,
          stableKey: 'office:guild-council:treasurer',
        },
      ],
      schemaVersion: 1,
    });
  });

  it('leaves the sealed M09 Harbor manifest and ranked-choice primitive unchanged', () => {
    const catalog = harborCityManifestCatalog();
    const previous = createDeterministicHarborCityFallback({
      catalog,
      prompt,
      seed: 'demo-seed',
    });
    expect(previous.envelope.manifest.extensions).not.toHaveProperty('worldgraph.governance');
    expect(
      previous.envelope.manifest.primitiveRefs.find((entry) => entry.ref === 'council-election'),
    ).toMatchObject({ parameters: { method: 'ranked-choice', votingTicks: 24 }, version: '1.0.0' });
  });

  it('rejects malformed, ambiguous, and unresolved governance intent', () => {
    const catalog = governedHarborCityManifestCatalog();
    const fallback = createDeterministicGovernedHarborCityFallback({
      catalog,
      prompt,
      seed: 'governance-invalid',
    });
    const malformed = structuredClone(
      fallback.envelope.manifest.extensions['worldgraph.governance'],
    ) as Record<string, unknown>;
    malformed.executablePolicy = 'return true';
    expect(() => parseWorldgraphGovernanceExtensionV1(malformed)).toThrow(
      'MANIFEST_GOVERNANCE_EXTENSION_SCHEMA_INVALID',
    );

    const unresolved = structuredClone(fallback.envelope.manifest);
    const extension = unresolved.extensions['worldgraph.governance'] as {
      institutions: Array<{ jurisdictionEntityKey: string; stableKey: string }>;
      offices: Array<{ institutionKey: string; stableKey: string }>;
    };
    extension.institutions[0]!.jurisdictionEntityKey = 'district:missing';
    extension.offices[0]!.institutionKey = 'institution:missing';
    extension.offices[1]!.stableKey = extension.offices[0]!.stableKey;
    expect(
      validateWorldManifest(unresolved, catalog).diagnostics.map((entry) => entry.code),
    ).toEqual(
      expect.arrayContaining([
        'MANIFEST_GOVERNANCE_EXTENSION_DUPLICATE_KEY',
        'MANIFEST_GOVERNANCE_EXTENSION_INSTITUTION_UNKNOWN',
        'MANIFEST_GOVERNANCE_EXTENSION_JURISDICTION_UNKNOWN',
      ]),
    );
  });
});
