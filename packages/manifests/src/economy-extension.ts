import {
  WorldgraphEconomyExtensionV2Schema,
  createValidator,
  type ValidationIssue,
  type WorldManifestV1,
  type WorldgraphEconomyExtensionV2,
} from '@worldgraph/contracts';

export { WorldgraphEconomyExtensionV2Schema } from '@worldgraph/contracts';
export type { WorldgraphEconomyExtensionV2 } from '@worldgraph/contracts';

export const WORLDGRAPH_ECONOMY_EXTENSION_KEY = 'worldgraph.economy' as const;
export const WORLDGRAPH_ECONOMY_EXTENSION_SCHEMA_VERSION = 2 as const;

export interface WorldgraphEconomyExtensionIssue {
  code: string;
  message: string;
  pointer: string;
  relatedPointers: string[];
}

export interface WorldgraphEconomyExtensionValidationResult {
  issues: readonly WorldgraphEconomyExtensionIssue[];
  valid: boolean;
  value: WorldgraphEconomyExtensionV2 | null;
}

const validateStructure = createValidator<WorldgraphEconomyExtensionV2>(
  WorldgraphEconomyExtensionV2Schema,
);

function issue(
  code: string,
  pointer: string,
  message: string,
  relatedPointers: string[] = [],
): WorldgraphEconomyExtensionIssue {
  return { code, message, pointer, relatedPointers };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableIssues<T extends { stableKey: string }>(
  values: readonly T[],
  pointer: string,
): WorldgraphEconomyExtensionIssue[] {
  const issues: WorldgraphEconomyExtensionIssue[] = [];
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const prior = seen.get(value.stableKey);
    if (prior !== undefined) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_DUPLICATE_KEY',
          `${pointer}/${index}/stableKey`,
          `Economy stable key ${value.stableKey} is duplicated.`,
          [`${pointer}/${prior}/stableKey`],
        ),
      );
    } else {
      seen.set(value.stableKey, index);
    }
    if (index > 0 && compareText(values[index - 1]!.stableKey, value.stableKey) > 0) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_NOT_SORTED',
          `${pointer}/${index}/stableKey`,
          'Economy intent arrays must be sorted by stable key.',
        ),
      );
    }
  });
  return issues;
}

function isCanonicalQuantity(value: string, scale: number): boolean {
  const escapedScale = scale === 0 ? '' : `\\.[0-9]{${scale}}`;
  return new RegExp(`^(?:0|[1-9][0-9]{0,18})${escapedScale}$`, 'u').test(value);
}

function scaledQuantity(value: string, scale: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
}

function structuralIssues(errors: readonly ValidationIssue[]) {
  return errors.map((error) =>
    issue(
      'MANIFEST_ECONOMY_EXTENSION_SCHEMA_INVALID',
      `/extensions/${WORLDGRAPH_ECONOMY_EXTENSION_KEY}${error.path === '/' ? '' : error.path}`,
      `Economy extension schema violation (${error.keyword}): ${error.message ?? 'invalid value'}.`,
    ),
  );
}

function semanticIssues(
  extension: WorldgraphEconomyExtensionV2,
  manifest: WorldManifestV1,
): WorldgraphEconomyExtensionIssue[] {
  const base = `/extensions/${WORLDGRAPH_ECONOMY_EXTENSION_KEY}`;
  const issues: WorldgraphEconomyExtensionIssue[] = [];
  issues.push(...stableIssues(extension.resources, `${base}/resources`));
  issues.push(...stableIssues(extension.recipes, `${base}/recipes`));
  issues.push(...stableIssues(extension.businesses, `${base}/businesses`));
  issues.push(...stableIssues(extension.facilities, `${base}/facilities`));
  issues.push(...stableIssues(extension.inventories, `${base}/inventories`));
  issues.push(...stableIssues(extension.employmentOffers, `${base}/employmentOffers`));
  issues.push(...stableIssues(extension.taxPolicies, `${base}/taxPolicies`));
  issues.push(
    ...stableIssues(extension.unconfiguredFacilityAssets, `${base}/unconfiguredFacilityAssets`),
  );

  const refs = new Map(manifest.primitiveRefs.map((entry) => [entry.ref, entry]));
  const economyResourceRefs = new Set(manifest.economy.resourcePrimitiveRefs);
  const economyRecipeRefs = new Set(manifest.economy.productionPrimitiveRefs);
  const economyTaxRefs = new Set(manifest.economy.taxPrimitiveRefs);
  const organizationKeys = new Set(manifest.organizations.map((entry) => entry.key));
  const institutionKeys = new Set(manifest.institutions.map((entry) => entry.key));
  const resources = new Map(extension.resources.map((entry) => [entry.stableKey, entry]));
  const recipes = new Map(extension.recipes.map((entry) => [entry.stableKey, entry]));
  const businesses = new Map(extension.businesses.map((entry) => [entry.stableKey, entry]));
  const facilitiesByAsset = new Map(
    extension.facilities.map((entry) => [entry.assetStableKey, entry]),
  );
  const unsafeDisplay =
    /(?:<[^>]*>|(?:https?|javascript|data|file):|\{\{|\{%|<%|\$\{|^(?:select|insert|update|delete|drop|alter|create)\b)/iu;
  for (const [pointer, value] of [
    ...extension.resources.map(
      (entry, index) => [`${base}/resources/${index}/displayName`, entry.displayName] as const,
    ),
    ...extension.businesses.map(
      (entry, index) => [`${base}/businesses/${index}/displayName`, entry.displayName] as const,
    ),
    ...extension.facilities.map(
      (entry, index) => [`${base}/facilities/${index}/displayName`, entry.displayName] as const,
    ),
    ...extension.unconfiguredFacilityAssets.map(
      (entry, index) =>
        [`${base}/unconfiguredFacilityAssets/${index}/displayName`, entry.displayName] as const,
    ),
  ]) {
    if (unsafeDisplay.test(value.trim())) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_CONTENT_UNSAFE',
          pointer,
          'Economy display text cannot contain remote, executable, template, or markup content.',
        ),
      );
    }
  }

  extension.resources.forEach((resource, index) => {
    const pointer = `${base}/resources/${index}`;
    const ref = refs.get(resource.primitiveRef);
    if (ref?.kind !== 'resource' || !economyResourceRefs.has(resource.primitiveRef)) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_RESOURCE_REF_INVALID',
          `${pointer}/primitiveRef`,
          `Resource primitive reference ${resource.primitiveRef} is not an economy resource pin.`,
        ),
      );
    }
    if (!isCanonicalQuantity(resource.initialQuantity, resource.quantityScale)) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_QUANTITY_INVALID',
          `${pointer}/initialQuantity`,
          `Initial quantity must use exactly ${resource.quantityScale} fractional digits.`,
        ),
      );
    }
    const parameters = ref?.parameters;
    if (
      parameters &&
      ((parameters.unit !== undefined && parameters.unit !== resource.unit) ||
        (parameters.quantityScale !== undefined &&
          parameters.quantityScale !== resource.quantityScale))
    ) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_RESOURCE_PARAMETERS_MISMATCH',
          pointer,
          'Resource unit and quantity scale must match the exact primitive parameters.',
        ),
      );
    }
    if (resource.tags.some((tag, tagIndex) => tagIndex > 0 && resource.tags[tagIndex - 1]! > tag)) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_NOT_SORTED',
          `${pointer}/tags`,
          'Resource tags must be code-point sorted.',
        ),
      );
    }
  });

  extension.recipes.forEach((recipe, index) => {
    const pointer = `${base}/recipes/${index}`;
    const ref = refs.get(recipe.primitiveRef);
    if (
      ref?.kind !== 'production_recipe' ||
      !economyRecipeRefs.has(recipe.primitiveRef) ||
      recipe.version !== 1
    ) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_RECIPE_REF_INVALID',
          `${pointer}/primitiveRef`,
          `Recipe ${recipe.stableKey} must pin an exact economy production primitive version.`,
        ),
      );
    }
    for (const direction of ['inputs', 'outputs'] as const) {
      const lines = ref?.parameters[direction];
      if (!Array.isArray(lines) || lines.length === 0) {
        issues.push(
          issue(
            'MANIFEST_ECONOMY_EXTENSION_RECIPE_PARAMETERS_INVALID',
            `${pointer}/primitiveRef`,
            `Recipe primitive parameters require a non-empty ${direction} array.`,
          ),
        );
        continue;
      }
      lines.forEach((line, lineIndex) => {
        if (line === null || Array.isArray(line) || typeof line !== 'object') {
          issues.push(
            issue(
              'MANIFEST_ECONOMY_EXTENSION_RECIPE_PARAMETERS_INVALID',
              `${pointer}/primitiveRef`,
              `Recipe ${direction} line ${lineIndex} is invalid.`,
            ),
          );
          return;
        }
        const candidate = line as Record<string, unknown>;
        const resource = extension.resources.find(
          (entry) => refs.get(entry.primitiveRef)?.key === candidate.resourceKey,
        );
        if (
          !resource ||
          typeof candidate.quantity !== 'string' ||
          !isCanonicalQuantity(candidate.quantity, resource.quantityScale)
        ) {
          issues.push(
            issue(
              'MANIFEST_ECONOMY_EXTENSION_RECIPE_RESOURCE_INVALID',
              `${pointer}/primitiveRef`,
              `Recipe ${direction} line ${lineIndex} must resolve to a resource with an exact-scale quantity.`,
            ),
          );
        }
      });
    }
    if (
      typeof ref?.parameters.durationTicks !== 'number' ||
      !Number.isSafeInteger(ref.parameters.durationTicks) ||
      ref.parameters.durationTicks < 1 ||
      ref.parameters.facilityAssetType !== 'workshop'
    ) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_RECIPE_PARAMETERS_INVALID',
          `${pointer}/primitiveRef`,
          'Recipe primitive parameters require bounded duration ticks and a facility capability.',
        ),
      );
    }
  });

  const walletKeys = new Set<string>();
  const businessWalletOwners = new Map<string, string>();
  const businessOrganizationIndexes = new Map<string, number>();
  extension.businesses.forEach((business, index) => {
    const pointer = `${base}/businesses/${index}`;
    if (!organizationKeys.has(business.organizationKey)) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_ORGANIZATION_UNKNOWN',
          `${pointer}/organizationKey`,
          `Business organization ${business.organizationKey} does not resolve.`,
        ),
      );
    }
    const priorOrganizationIndex = businessOrganizationIndexes.get(business.organizationKey);
    if (priorOrganizationIndex !== undefined) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_BUSINESS_ORGANIZATION_AMBIGUOUS',
          `${pointer}/organizationKey`,
          `Organization ${business.organizationKey} cannot back more than one seeded business.`,
          [`${base}/businesses/${priorOrganizationIndex}/organizationKey`],
        ),
      );
    } else {
      businessOrganizationIndexes.set(business.organizationKey, index);
    }
    if (walletKeys.has(business.walletStableKey)) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_WALLET_AMBIGUOUS',
          `${pointer}/walletStableKey`,
          `Wallet ${business.walletStableKey} is assigned to more than one business.`,
        ),
      );
    }
    walletKeys.add(business.walletStableKey);
    businessWalletOwners.set(business.walletStableKey, business.organizationKey);
  });

  extension.facilities.forEach((facility, index) => {
    const pointer = `${base}/facilities/${index}`;
    const business = businesses.get(facility.businessStableKey);
    const building = refs.get(facility.buildingPrimitiveRef);
    if (!business) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_BUSINESS_UNKNOWN',
          `${pointer}/businessStableKey`,
          `Facility business ${facility.businessStableKey} does not resolve.`,
        ),
      );
    }
    if (
      !organizationKeys.has(facility.initialOwnerOrganizationKey) ||
      (business && business.organizationKey !== facility.initialOwnerOrganizationKey)
    ) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_FACILITY_OWNER_INVALID',
          `${pointer}/initialOwnerOrganizationKey`,
          'Facility title must be seeded to its backing business organization.',
        ),
      );
    }
    if (building?.kind !== 'building') {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_BUILDING_REF_INVALID',
          `${pointer}/buildingPrimitiveRef`,
          `Facility building reference ${facility.buildingPrimitiveRef} is invalid.`,
        ),
      );
    }
    facility.recipeVersionStableKeys.forEach((key, keyIndex) => {
      if (!recipes.has(key)) {
        issues.push(
          issue(
            'MANIFEST_ECONOMY_EXTENSION_RECIPE_UNKNOWN',
            `${pointer}/recipeVersionStableKeys/${keyIndex}`,
            `Facility recipe version ${key} does not resolve.`,
          ),
        );
      }
    });
    if (
      facility.recipeVersionStableKeys.some(
        (key, keyIndex) => keyIndex > 0 && facility.recipeVersionStableKeys[keyIndex - 1]! > key,
      )
    ) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_NOT_SORTED',
          `${pointer}/recipeVersionStableKeys`,
          'Facility recipe version keys must be code-point sorted.',
        ),
      );
    }
  });

  const configuredAssetKeys = new Map(
    extension.facilities.map((facility, index) => [facility.assetStableKey, index]),
  );
  extension.unconfiguredFacilityAssets.forEach((asset, index) => {
    const pointer = `${base}/unconfiguredFacilityAssets/${index}`;
    const configuredIndex = configuredAssetKeys.get(asset.stableKey);
    if (configuredIndex !== undefined) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_ASSET_AMBIGUOUS',
          `${pointer}/stableKey`,
          `Asset ${asset.stableKey} cannot be both configured and unconfigured.`,
          [`${base}/facilities/${configuredIndex}/assetStableKey`],
        ),
      );
    }
    if (!organizationKeys.has(asset.initialOwnerOrganizationKey)) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_FACILITY_OWNER_INVALID',
          `${pointer}/initialOwnerOrganizationKey`,
          `Unconfigured facility owner ${asset.initialOwnerOrganizationKey} does not resolve.`,
        ),
      );
    }
    if (refs.get(asset.buildingPrimitiveRef)?.kind !== 'building') {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_BUILDING_REF_INVALID',
          `${pointer}/buildingPrimitiveRef`,
          `Unconfigured facility building reference ${asset.buildingPrimitiveRef} is invalid.`,
        ),
      );
    }
  });

  const inventoryTotals = new Map<string, bigint>();
  extension.inventories.forEach((inventory, index) => {
    const pointer = `${base}/inventories/${index}`;
    const resource = resources.get(inventory.resourceStableKey);
    const facility =
      inventory.containerAssetStableKey === null
        ? undefined
        : facilitiesByAsset.get(inventory.containerAssetStableKey);
    if (!resource) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_RESOURCE_UNKNOWN',
          `${pointer}/resourceStableKey`,
          `Inventory resource ${inventory.resourceStableKey} does not resolve.`,
        ),
      );
    } else if (!isCanonicalQuantity(inventory.quantity, resource.quantityScale)) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_QUANTITY_INVALID',
          `${pointer}/quantity`,
          `Inventory quantity must use exactly ${resource.quantityScale} fractional digits.`,
        ),
      );
    } else {
      inventoryTotals.set(
        resource.stableKey,
        (inventoryTotals.get(resource.stableKey) ?? 0n) +
          scaledQuantity(inventory.quantity, resource.quantityScale),
      );
    }
    if (
      !organizationKeys.has(inventory.ownerOrganizationKey) ||
      (inventory.containerAssetStableKey !== null &&
        (!facility || facility.initialOwnerOrganizationKey !== inventory.ownerOrganizationKey))
    ) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_INVENTORY_OWNER_INVALID',
          pointer,
          'Inventory container and owner must resolve to one seeded facility title.',
        ),
      );
    }
  });
  extension.resources.forEach((resource, index) => {
    if (
      isCanonicalQuantity(resource.initialQuantity, resource.quantityScale) &&
      (inventoryTotals.get(resource.stableKey) ?? 0n) !==
        scaledQuantity(resource.initialQuantity, resource.quantityScale)
    ) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_INITIAL_QUANTITY_MISMATCH',
          `${base}/resources/${index}/initialQuantity`,
          `Resource ${resource.stableKey} initial quantity must equal its seeded inventories.`,
        ),
      );
    }
  });

  extension.employmentOffers.forEach((offer, index) => {
    const pointer = `${base}/employmentOffers/${index}`;
    if (!businesses.has(offer.businessStableKey)) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_BUSINESS_UNKNOWN',
          `${pointer}/businessStableKey`,
          `Employment business ${offer.businessStableKey} does not resolve.`,
        ),
      );
    }
    if (offer.currencyStableKey !== extension.treasury.currencyStableKey) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_CURRENCY_MISMATCH',
          `${pointer}/currencyStableKey`,
          'Employment wages must use the world treasury currency.',
        ),
      );
    }
  });

  if (!institutionKeys.has(extension.treasury.institutionKey)) {
    issues.push(
      issue(
        'MANIFEST_ECONOMY_EXTENSION_TREASURY_INSTITUTION_UNKNOWN',
        `${base}/treasury/institutionKey`,
        `Treasury institution ${extension.treasury.institutionKey} does not resolve.`,
      ),
    );
  }
  if (walletKeys.has(extension.treasury.walletStableKey)) {
    issues.push(
      issue(
        'MANIFEST_ECONOMY_EXTENSION_WALLET_AMBIGUOUS',
        `${base}/treasury/walletStableKey`,
        'Treasury and business wallets must have distinct stable keys.',
      ),
    );
  }
  const periodicPolicyCount = extension.taxPolicies.filter(
    (policy) => policy.taxType === 'periodic_flat',
  ).length;
  if (periodicPolicyCount > 15) {
    issues.push(
      issue(
        'MANIFEST_ECONOMY_EXTENSION_PERIODIC_POLICY_LIMIT_EXCEEDED',
        `${base}/taxPolicies`,
        'At most 15 periodic tax policies may be active at initialization.',
      ),
    );
  }
  extension.taxPolicies.forEach((policy, index) => {
    const pointer = `${base}/taxPolicies/${index}`;
    const ref = refs.get(policy.primitiveRef);
    if (ref?.kind !== 'tax' || !economyTaxRefs.has(policy.primitiveRef)) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_TAX_REF_INVALID',
          `${pointer}/primitiveRef`,
          `Tax primitive reference ${policy.primitiveRef} is not an economy tax pin.`,
        ),
      );
    }
    if (policy.taxType !== 'periodic_flat') {
      const rateBps = ref?.parameters.rateBps;
      if (
        typeof rateBps !== 'number' ||
        !Number.isSafeInteger(rateBps) ||
        rateBps < 0 ||
        rateBps > 5_000
      ) {
        issues.push(
          issue(
            'MANIFEST_ECONOMY_EXTENSION_TAX_RATE_INVALID',
            `${pointer}/primitiveRef`,
            `Percentage tax primitive ${policy.primitiveRef} requires an exact 0..5000 basis-point rate.`,
          ),
        );
      }
    } else {
      const payerWalletOwner = businessWalletOwners.get(policy.payerWalletStableKey);
      if (!organizationKeys.has(policy.payerOrganizationKey)) {
        issues.push(
          issue(
            'MANIFEST_ECONOMY_EXTENSION_PERIODIC_PAYER_UNKNOWN',
            `${pointer}/payerOrganizationKey`,
            `Periodic-tax payer organization ${policy.payerOrganizationKey} does not resolve.`,
          ),
        );
      }
      if (payerWalletOwner !== policy.payerOrganizationKey) {
        issues.push(
          issue(
            'MANIFEST_ECONOMY_EXTENSION_PERIODIC_PAYER_WALLET_INVALID',
            `${pointer}/payerWalletStableKey`,
            'Periodic-tax payer wallet must be the seeded business wallet owned by the payer organization.',
          ),
        );
      }
    }
    if (
      policy.authorityInstitutionKey !== extension.treasury.institutionKey ||
      policy.treasuryWalletStableKey !== extension.treasury.walletStableKey
    ) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_TAX_TREASURY_MISMATCH',
          pointer,
          'Tax authority and settlement wallet must match the one manifest treasury binding.',
        ),
      );
    }
    if (
      policy.effectiveUntilTick !== null &&
      BigInt(policy.effectiveUntilTick) <= BigInt(policy.effectiveFromTick)
    ) {
      issues.push(
        issue(
          'MANIFEST_ECONOMY_EXTENSION_TAX_WINDOW_INVALID',
          `${pointer}/effectiveUntilTick`,
          'Tax policy end tick must be greater than its start tick.',
        ),
      );
    }
  });

  return issues;
}

export function validateWorldgraphEconomyExtensionV2(
  input: unknown,
  manifest?: WorldManifestV1,
): WorldgraphEconomyExtensionValidationResult {
  if (!validateStructure.is(input)) {
    return { issues: structuralIssues(validateStructure.issues(input)), valid: false, value: null };
  }
  const value = structuredClone(input);
  const issues = manifest ? semanticIssues(value, manifest) : [];
  return { issues, valid: issues.length === 0, value };
}

export function worldgraphEconomyExtensionIssues(
  manifest: WorldManifestV1,
): readonly WorldgraphEconomyExtensionIssue[] {
  if (
    !Object.prototype.hasOwnProperty.call(manifest.extensions, WORLDGRAPH_ECONOMY_EXTENSION_KEY)
  ) {
    return [];
  }
  const extension = manifest.extensions[WORLDGRAPH_ECONOMY_EXTENSION_KEY];
  if (
    extension !== null &&
    typeof extension === 'object' &&
    !Array.isArray(extension) &&
    extension.schemaVersion === 1
  ) {
    return [];
  }
  return validateWorldgraphEconomyExtensionV2(extension, manifest).issues;
}

export class WorldgraphEconomyExtensionError extends Error {
  public readonly code = 'WORLDGRAPH_ECONOMY_EXTENSION_INVALID' as const;

  public constructor(public readonly issues: readonly WorldgraphEconomyExtensionIssue[]) {
    super(issues.map((entry) => `${entry.code}:${entry.pointer}`).join(','));
    this.name = 'WorldgraphEconomyExtensionError';
  }
}

export function parseWorldgraphEconomyExtensionV2(input: unknown): WorldgraphEconomyExtensionV2 {
  const result = validateWorldgraphEconomyExtensionV2(input);
  if (!result.valid || !result.value) throw new WorldgraphEconomyExtensionError(result.issues);
  return result.value;
}

export function assertWorldgraphEconomyExtensionV2(
  manifest: WorldManifestV1,
): WorldgraphEconomyExtensionV2 {
  const input = manifest.extensions[WORLDGRAPH_ECONOMY_EXTENSION_KEY];
  const result = validateWorldgraphEconomyExtensionV2(input, manifest);
  if (!result.valid || !result.value) throw new WorldgraphEconomyExtensionError(result.issues);
  return result.value;
}
