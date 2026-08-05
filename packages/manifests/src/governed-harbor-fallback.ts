import {
  GOVERNANCE_SEED_PLAN_SCHEMA_VERSION,
  MANIFEST_PROMPT_TEMPLATE_VERSION,
  canonicalizeJson,
  type JsonValue,
  type WorldManifestV1,
  type WorldgraphGovernanceExtensionV1,
} from '@worldgraph/contracts';

import { manifestContentHash, normalizeManifestPrompt, sha256 } from './canonical.js';
import type { ManifestPrimitiveDefinition } from './catalog.js';
import {
  WORLDGRAPH_GOVERNANCE_EXTENSION_KEY,
  assertWorldgraphGovernanceExtensionV1,
} from './governance-extension.js';
import {
  completeFallbackProvenance,
  DeterministicFallbackUnavailableError,
  type DeterministicFallbackInput,
  type DeterministicFallbackResult,
} from './fallback.js';
import { createDeterministicHarborCityFallback } from './harbor-fallback.js';
import { validateManifestGenerationEnvelope } from './validation.js';

export const GOVERNED_HARBOR_FALLBACK_TEMPLATE_VERSION = 1 as const;
export const GOVERNED_HARBOR_FALLBACK_PROVIDER_CONFIGURATION_ID =
  'deterministic-governed-harbor-fallback-v1' as const;

function cloneObject(input: Record<string, JsonValue>): Record<string, JsonValue> {
  const value = canonicalizeJson(input);
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new DeterministicFallbackUnavailableError('Primitive defaults are not a JSON object.');
  }
  return value;
}

function pluralityElection(input: DeterministicFallbackInput): ManifestPrimitiveDefinition {
  const candidates = input.catalog.primitives.filter(
    (entry) =>
      entry.key === 'worldgraph.election.council-ballot' &&
      entry.version === '1.1.0' &&
      entry.kind === 'election' &&
      entry.lifecycle === 'published',
  );
  if (candidates.length !== 1 || candidates[0]!.defaults.method !== 'plurality') {
    throw new DeterministicFallbackUnavailableError(
      'The governed Harbor fallback requires the exact published plurality council ballot.',
    );
  }
  return candidates[0]!;
}

const civicEligibility = {
  kind: 'any' as const,
  operands: [
    { kind: 'membership_role' as const, role: 'creator' },
    { kind: 'membership_role' as const, role: 'player' },
  ],
};

const inWorldPolicy = { kind: 'actor_mode' as const, mode: 'in_world' as const };
const councillorPolicy = {
  kind: 'holds_office' as const,
  officeKey: 'office:guild-council:councillor',
};

function governanceExtension(): WorldgraphGovernanceExtensionV1 {
  return {
    charter: {
      citizenEligibilityPolicy: civicEligibility,
      effectiveFromTick: '0',
      effectiveUntilTick: null,
      proposalRules: {
        approvalThresholdBps: 5_001,
        ballotPolicy: {
          ballotMode: 'public',
          disclosure: 'choice_totals',
          replacementAllowed: true,
        },
        debateTicks: '2',
        minimumSponsors: 0,
        quorumBps: 5_000,
        sponsorshipTicks: '2',
        votingTicks: '5',
      },
      stableKey: 'charter:harbor-city',
      summary:
        'A finite charter for citizen proposals, scoped council powers, public funds, and deterministic elections.',
      title: 'Harbor City Civic Charter',
    },
    electionPrimitiveRef: 'council-election',
    initialLaws: [
      {
        effectiveFromTick: '0',
        effectiveUntilTick: null,
        jurisdictionEntityKey: 'district:civic-platform',
        policy: civicEligibility,
        stableKey: 'law:civic-participation',
        summary: 'Active city members may participate in charter-defined civic processes.',
        title: 'Civic Participation',
      },
    ],
    institutions: [
      {
        displayName: 'Guild Council',
        institutionType: 'council',
        jurisdictionEntityKey: 'district:civic-platform',
        powers: [
          { action: 'governance.appoint', policy: councillorPolicy, resourceType: 'office' },
          { action: 'governance.enact', policy: inWorldPolicy, resourceType: 'proposal' },
          { action: 'governance.propose', policy: civicEligibility, resourceType: 'proposal' },
        ],
        stableKey: 'institution:guild-council',
        worldEntityKey: 'institution:guild-council',
      },
    ],
    offices: [
      {
        ballotPolicy: {
          ballotMode: 'secret',
          disclosure: 'aggregate_only',
          replacementAllowed: false,
        },
        displayName: 'Councillor',
        electionCadenceTicks: '48',
        eligibilityPolicy: civicEligibility,
        institutionKey: 'institution:guild-council',
        powers: [
          {
            action: 'governance.enact',
            delegatedOrganizationEntityKeys: [],
            policy: inWorldPolicy,
            resourceType: 'proposal',
          },
        ],
        seats: 7,
        stableKey: 'office:guild-council:councillor',
        termDurationTicks: '48',
        tieRule: 'stable_key',
        transitionDelayTicks: '0',
      },
      {
        ballotPolicy: {
          ballotMode: 'secret',
          disclosure: 'aggregate_only',
          replacementAllowed: false,
        },
        displayName: 'Treasurer',
        electionCadenceTicks: '48',
        eligibilityPolicy: civicEligibility,
        institutionKey: 'institution:guild-council',
        powers: [
          {
            action: 'economy.authorize-budget',
            delegatedOrganizationEntityKeys: ['organization:artisan-guild'],
            policy: inWorldPolicy,
            resourceType: 'treasury',
          },
        ],
        seats: 1,
        stableKey: 'office:guild-council:treasurer',
        termDurationTicks: '48',
        tieRule: 'vacancy',
        transitionDelayTicks: '0',
      },
    ],
    schemaVersion: GOVERNANCE_SEED_PLAN_SCHEMA_VERSION,
  };
}

/** Produces the reviewed M10 Harbor charter without mutating the sealed M09 fixture. */
export function createDeterministicGovernedHarborCityFallback(
  input: DeterministicFallbackInput,
): DeterministicFallbackResult {
  const providerConfigurationId =
    input.providerConfigurationId ?? GOVERNED_HARBOR_FALLBACK_PROVIDER_CONFIGURATION_ID;
  const base = createDeterministicHarborCityFallback({ ...input, providerConfigurationId });
  const manifest: WorldManifestV1 = structuredClone(base.envelope.manifest);
  const election = pluralityElection(input);
  const electionRefIndex = manifest.primitiveRefs.findIndex(
    (entry) => entry.ref === 'council-election',
  );
  if (electionRefIndex < 0) {
    throw new DeterministicFallbackUnavailableError('Council election reference is missing.');
  }
  manifest.primitiveRefs[electionRefIndex] = {
    contentHash: election.contentHash,
    key: election.key,
    kind: 'election',
    parameters: cloneObject(election.defaults),
    primitiveVersionId: election.versionId,
    ref: 'council-election',
    version: election.version,
  };
  for (const institution of manifest.institutions) {
    if (institution.primitiveRef === 'council-election') {
      institution.parameters = cloneObject(election.defaults);
    }
  }
  manifest.extensions[WORLDGRAPH_GOVERNANCE_EXTENSION_KEY] =
    canonicalizeJson(governanceExtension());
  assertWorldgraphGovernanceExtensionV1(manifest);

  const normalizedPrompt = normalizeManifestPrompt(input.prompt);
  const templateHash = sha256(
    `worldgraph-governed-harbor-fallback:${GOVERNED_HARBOR_FALLBACK_TEMPLATE_VERSION}`,
  );
  const provenance = completeFallbackProvenance(
    manifest,
    templateHash,
    sha256(normalizedPrompt),
    `governed-harbor-fallback-template-v${GOVERNED_HARBOR_FALLBACK_TEMPLATE_VERSION}`,
  );
  const envelope = {
    ...base.envelope,
    manifest,
    promptTemplateVersion: MANIFEST_PROMPT_TEMPLATE_VERSION,
    provenance,
    warnings: [
      ...base.envelope.warnings,
      {
        code: 'HARBOR_GOVERNANCE_INITIAL_CONDITIONS_REQUIRE_REVIEW',
        message:
          'Charter, institutional powers, founding law, offices, and ballot policy require explicit creator approval.',
        pointer: `/extensions/${WORLDGRAPH_GOVERNANCE_EXTENSION_KEY}`,
      },
    ],
  };
  const validation = validateManifestGenerationEnvelope(envelope, input.catalog);
  if (!validation.valid || !validation.contentHash) {
    throw new DeterministicFallbackUnavailableError(
      `Deterministic governed Harbor fallback did not validate: ${validation.diagnostics
        .map((entry) => `${entry.code}:${entry.pointer}:${entry.message}`)
        .join(',')}`,
    );
  }
  return {
    ...base,
    contentHash: manifestContentHash(manifest),
    envelope,
  };
}
