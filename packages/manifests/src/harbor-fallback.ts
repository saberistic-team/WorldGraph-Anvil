import {
  MANIFEST_PROMPT_TEMPLATE_VERSION,
  canonicalizeJson,
  type JsonValue,
  type WorldManifestV1,
} from '@worldgraph/contracts';

import { manifestContentHash, normalizeManifestPrompt, sha256 } from './canonical.js';
import type { ManifestPrimitiveDefinition } from './catalog.js';
import {
  WORLDGRAPH_ECONOMY_EXTENSION_KEY,
  WORLDGRAPH_ECONOMY_EXTENSION_SCHEMA_VERSION,
  assertWorldgraphEconomyExtensionV2,
  type WorldgraphEconomyExtensionV2,
} from './economy-extension.js';
import {
  completeFallbackProvenance,
  createDeterministicFallback,
  DeterministicFallbackUnavailableError,
  type DeterministicFallbackInput,
  type DeterministicFallbackResult,
} from './fallback.js';
import { validateManifestGenerationEnvelope } from './validation.js';

export const HARBOR_CITY_FALLBACK_TEMPLATE_VERSION = 2 as const;
export const HARBOR_CITY_FALLBACK_PROVIDER_CONFIGURATION_ID =
  'deterministic-harbor-fallback-v2' as const;

const HARBOR_KEYS = {
  ironOre: 'worldgraph.resource.iron-ore',
  metalPart: 'worldgraph.resource.metal-part',
  recipe: 'worldgraph.production-recipe.metal-part-fabrication',
} as const;

function cloneObject(input: Record<string, JsonValue>): Record<string, JsonValue> {
  const value = canonicalizeJson(input);
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new DeterministicFallbackUnavailableError('Primitive defaults are not a JSON object.');
  }
  return value;
}

function definition(
  input: DeterministicFallbackInput,
  key: string,
  kind: 'production_recipe' | 'resource',
): ManifestPrimitiveDefinition {
  const candidates = input.catalog.primitives.filter(
    (entry) => entry.key === key && entry.version === '1.0.0' && entry.kind === kind,
  );
  if (candidates.length !== 1 || candidates[0]!.lifecycle !== 'published') {
    throw new DeterministicFallbackUnavailableError(
      `The harbor fallback requires exact published primitive ${key}@1.0.0.`,
    );
  }
  return candidates[0]!;
}

function reference(
  primitive: ManifestPrimitiveDefinition,
  ref: string,
): WorldManifestV1['primitiveRefs'][number] {
  return {
    contentHash: primitive.contentHash,
    key: primitive.key,
    kind: primitive.kind,
    parameters: cloneObject(primitive.defaults),
    primitiveVersionId: primitive.versionId,
    ref,
    version: primitive.version,
  };
}

function harborEconomyExtension(): WorldgraphEconomyExtensionV2 {
  const workshopAsset = 'asset:facility:energy-harbor-workshop';
  return {
    businesses: [
      {
        displayName: 'Energy Harbor Works',
        organizationKey: 'energy-guild',
        stableKey: 'business:energy-guild',
        walletStableKey: 'wallet:organization:energy-guild:gcr',
      },
    ],
    employmentOffers: [
      {
        businessStableKey: 'business:energy-guild',
        cadenceTicks: '12',
        currencyStableKey: 'currency:gcr',
        maxPaymentsPerPeriod: 1,
        roleKey: 'metalworker',
        stableKey: 'employment-offer:energy-guild:metalworker',
        wageMinor: '100',
      },
    ],
    facilities: [
      {
        assetStableKey: workshopAsset,
        assetType: 'workshop',
        buildingPrimitiveRef: 'guild-hall',
        businessStableKey: 'business:energy-guild',
        displayName: 'Energy Harbor Workshop',
        initialOwnerOrganizationKey: 'energy-guild',
        recipeVersionStableKeys: ['recipe-version:metal-part-fabrication:1'],
        stableKey: 'facility:energy-harbor-workshop',
        transferable: true,
      },
    ],
    inventories: [
      {
        containerAssetStableKey: workshopAsset,
        ownerOrganizationKey: 'energy-guild',
        quantity: '100',
        resourceStableKey: 'resource:energy',
        stableKey: 'inventory:energy-harbor-workshop:energy',
      },
      {
        containerAssetStableKey: workshopAsset,
        ownerOrganizationKey: 'energy-guild',
        quantity: '100',
        resourceStableKey: 'resource:iron-ore',
        stableKey: 'inventory:energy-harbor-workshop:iron-ore',
      },
      {
        containerAssetStableKey: workshopAsset,
        ownerOrganizationKey: 'energy-guild',
        quantity: '0',
        resourceStableKey: 'resource:metal-part',
        stableKey: 'inventory:energy-harbor-workshop:metal-part',
      },
    ],
    recipes: [
      {
        primitiveRef: 'metal-part-fabrication',
        stableKey: 'recipe-version:metal-part-fabrication:1',
        version: 1,
      },
    ],
    resources: [
      {
        displayName: 'Energy',
        initialQuantity: '100',
        primitiveRef: 'energy',
        quantityScale: 0,
        stableKey: 'resource:energy',
        tags: ['energy', 'scarce'],
        unit: 'energy-unit',
      },
      {
        displayName: 'Iron Ore',
        initialQuantity: '100',
        primitiveRef: 'iron-ore',
        quantityScale: 0,
        stableKey: 'resource:iron-ore',
        tags: ['iron', 'ore'],
        unit: 'ore-unit',
      },
      {
        displayName: 'Metal Part',
        initialQuantity: '0',
        primitiveRef: 'metal-part',
        quantityScale: 0,
        stableKey: 'resource:metal-part',
        tags: ['manufactured', 'metal'],
        unit: 'part',
      },
    ],
    schemaVersion: WORLDGRAPH_ECONOMY_EXTENSION_SCHEMA_VERSION,
    taxPolicies: [
      {
        authorityInstitutionKey: 'guild-council',
        collectionMode: 'added_to_payer',
        effectiveFromTick: '0',
        effectiveUntilTick: null,
        fixedAmountMinor: '10',
        intervalTicks: '5',
        payerOrganizationKey: 'energy-guild',
        payerWalletStableKey: 'wallet:organization:energy-guild:gcr',
        primitiveRef: 'transaction-tax',
        roundingMode: 'floor',
        stableKey: 'tax-policy:guild-council:harbor-dues',
        taxType: 'periodic_flat',
        treasuryWalletStableKey: 'wallet:treasury:gcr',
      },
      {
        authorityInstitutionKey: 'guild-council',
        collectionMode: 'added_to_payer',
        effectiveFromTick: '0',
        effectiveUntilTick: null,
        primitiveRef: 'transaction-tax',
        roundingMode: 'floor',
        stableKey: 'tax-policy:guild-council:sales',
        taxType: 'sales',
        treasuryWalletStableKey: 'wallet:treasury:gcr',
      },
    ],
    treasury: {
      currencyStableKey: 'currency:gcr',
      institutionKey: 'guild-council',
      walletStableKey: 'wallet:treasury:gcr',
    },
    unconfiguredFacilityAssets: [
      {
        assetType: 'workshop',
        buildingPrimitiveRef: 'guild-hall',
        displayName: 'Energy Harbor Workshop Annex',
        initialOwnerOrganizationKey: 'energy-guild',
        stableKey: 'asset:facility:energy-harbor-annex',
        transferable: true,
      },
    ],
  };
}

/**
 * Produces the reviewed M09 harbor fixture without changing the legacy M04/M08
 * fallback. No runtime identity or mutable economy rows are created here.
 */
export function createDeterministicHarborCityFallback(
  input: DeterministicFallbackInput,
): DeterministicFallbackResult {
  const providerConfigurationId =
    input.providerConfigurationId ?? HARBOR_CITY_FALLBACK_PROVIDER_CONFIGURATION_ID;
  const base = createDeterministicFallback({ ...input, providerConfigurationId });
  const manifest = structuredClone(base.envelope.manifest);
  const ironOre = reference(definition(input, HARBOR_KEYS.ironOre, 'resource'), 'iron-ore');
  const metalPart = reference(definition(input, HARBOR_KEYS.metalPart, 'resource'), 'metal-part');
  const recipe = reference(
    definition(input, HARBOR_KEYS.recipe, 'production_recipe'),
    'metal-part-fabrication',
  );

  manifest.metadata = {
    ...manifest.metadata,
    description:
      'A bounded floating harbor city-state with guild production, employment, sales tax, and a closed-loop credit economy.',
    name: 'Harbor City',
  };
  manifest.assumptions = [
    ...manifest.assumptions,
    'Seeded wages, inventory, facility title, and sales tax are reviewed initial conditions.',
  ];
  manifest.primitiveRefs = [
    ...manifest.primitiveRefs.filter(
      (entry) => entry.key !== 'worldgraph.production-recipe.energy-reclamation',
    ),
    ironOre,
    metalPart,
    recipe,
  ].sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
  manifest.economy.productionPrimitiveRefs = ['metal-part-fabrication'];
  manifest.economy.resourcePrimitiveRefs = ['energy', 'iron-ore', 'metal-part'];
  manifest.extensions[WORLDGRAPH_ECONOMY_EXTENSION_KEY] = harborEconomyExtension();
  assertWorldgraphEconomyExtensionV2(manifest);

  const normalizedPrompt = normalizeManifestPrompt(input.prompt);
  const templateHash = sha256(
    `worldgraph-harbor-fallback:${HARBOR_CITY_FALLBACK_TEMPLATE_VERSION}`,
  );
  const provenance = completeFallbackProvenance(
    manifest,
    templateHash,
    sha256(normalizedPrompt),
    `harbor-fallback-template-v${HARBOR_CITY_FALLBACK_TEMPLATE_VERSION}`,
  );
  const envelope = {
    ...base.envelope,
    assumptions: [...manifest.assumptions],
    manifest,
    promptTemplateVersion: MANIFEST_PROMPT_TEMPLATE_VERSION,
    provenance,
    warnings: [
      ...base.envelope.warnings,
      {
        code: 'HARBOR_ECONOMY_INITIAL_CONDITIONS_REQUIRE_REVIEW',
        message:
          'Wage, inventory, facility ownership, and sales-tax initial conditions require explicit creator approval.',
        pointer: `/extensions/${WORLDGRAPH_ECONOMY_EXTENSION_KEY}`,
      },
    ],
  };
  const validation = validateManifestGenerationEnvelope(envelope, input.catalog);
  if (!validation.valid || !validation.contentHash) {
    throw new DeterministicFallbackUnavailableError(
      `Deterministic harbor fallback did not validate: ${validation.diagnostics.map((entry) => entry.code).join(',')}`,
    );
  }
  return {
    ...base,
    contentHash: manifestContentHash(manifest),
    envelope,
  };
}
