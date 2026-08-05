import { createHash } from 'node:crypto';

import {
  EconomySeedPlanV2Schema,
  EconomySeedPlanV1Schema,
  ErrorCodes,
  canonicalJson,
  createValidator,
  type EconomySeedPlan,
  type EconomySeedPlanV1,
  type EconomySeedPlanV2,
  type EconomySeedRecipeVersionV1,
  type EconomySeedTaxPolicyV1,
} from '@worldgraph/contracts';

import { MAX_INT64 } from './amount.js';
import { EconomyDomainError } from './errors.js';

const seedPlanValidator = createValidator<EconomySeedPlanV1>(EconomySeedPlanV1Schema);
const seedPlanV2Validator = createValidator<EconomySeedPlanV2>(EconomySeedPlanV2Schema);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function economySeedPlanHash(plan: EconomySeedPlan): string {
  const version = plan.economySeedPlanSchemaVersion;
  return createHash('sha256')
    .update(canonicalJson({ domain: `worldgraph.economy-seed-plan.v${version}`, plan }), 'utf8')
    .digest('hex');
}

export function economyRecipeVersionChecksum(
  recipe: Omit<EconomySeedRecipeVersionV1, 'checksum'>,
): string {
  return createHash('sha256')
    .update(canonicalJson({ domain: 'worldgraph.production-recipe-version.v1', recipe }), 'utf8')
    .digest('hex');
}

export function assertEconomySeedPlan(plan: unknown): EconomySeedPlan {
  if (seedPlanValidator.is(plan)) return assertEconomySeedPlanV1(plan);
  if (seedPlanV2Validator.is(plan)) return assertEconomySeedPlanV2(plan);
  throw new EconomyDomainError(ErrorCodes.seedPlanIncompatible, 'Economy seed plan is invalid.');
}

export function assertEconomySeedPlanV1(plan: EconomySeedPlanV1): EconomySeedPlanV1 {
  if (!seedPlanValidator.is(plan)) {
    throw new EconomyDomainError(ErrorCodes.seedPlanIncompatible, 'Economy seed plan is invalid.');
  }
  const walletKeys = plan.wallets.map((wallet) => wallet.stableKey);
  const assetKeys = plan.assets.map((asset) => asset.stableKey);
  if (
    new Set(walletKeys).size !== walletKeys.length ||
    new Set(assetKeys).size !== assetKeys.length ||
    walletKeys.some((key, index) => index > 0 && compareText(walletKeys[index - 1]!, key) > 0) ||
    assetKeys.some((key, index) => index > 0 && compareText(assetKeys[index - 1]!, key) > 0)
  ) {
    throw new EconomyDomainError(
      ErrorCodes.seedPlanIncompatible,
      'Economy seed wallet and asset keys must be unique and code-point sorted.',
    );
  }
  const treasury = plan.wallets.filter((wallet) => wallet.walletKind === 'treasury');
  const players = plan.wallets.filter((wallet) => wallet.walletKind === 'player');
  if (
    treasury.length !== 1 ||
    players.length < 1 ||
    treasury[0]!.ownerEntityLogicalKey !== plan.currency.issuerEntityLogicalKey ||
    treasury[0]!.initialBalanceMinor !== '0'
  ) {
    throw new EconomyDomainError(
      ErrorCodes.seedPlanIncompatible,
      'Seed plan requires one zero-balance treasury owned by the issuer.',
    );
  }
  const initialSupply = BigInt(plan.initialSupplyMinor);
  const maxSupply = BigInt(plan.currency.maxSupplyMinor);
  let distributed = 0n;
  for (const wallet of plan.wallets) distributed += BigInt(wallet.initialBalanceMinor);
  if (
    initialSupply !== distributed ||
    initialSupply > maxSupply ||
    initialSupply > MAX_INT64 ||
    maxSupply > MAX_INT64
  ) {
    throw new EconomyDomainError(
      ErrorCodes.seedPlanIncompatible,
      'Seed supply must equal wallet distribution and fit the configured cap.',
    );
  }
  return plan;
}

function assertSortedUnique(values: readonly string[], noun: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((key, index) => index > 0 && compareText(values[index - 1]!, key) > 0)
  ) {
    throw new EconomyDomainError(
      ErrorCodes.seedPlanIncompatible,
      `${noun} keys must be unique and code-point sorted.`,
    );
  }
}

function economySeedTaxPolicyScope(policy: EconomySeedTaxPolicyV1): string {
  return canonicalJson({
    applicability:
      policy.taxType === 'periodic_flat'
        ? {
            payerEntityLogicalKey: policy.payerEntityLogicalKey,
            payerWalletStableKey: policy.payerWalletStableKey,
          }
        : {},
    taxType: policy.taxType,
  });
}

function effectiveWindowsOverlap(
  left: EconomySeedTaxPolicyV1,
  right: EconomySeedTaxPolicyV1,
): boolean {
  const leftFrom = BigInt(left.effectiveFromTick);
  const leftUntil = left.effectiveUntilTick === null ? null : BigInt(left.effectiveUntilTick);
  const rightFrom = BigInt(right.effectiveFromTick);
  const rightUntil = right.effectiveUntilTick === null ? null : BigInt(right.effectiveUntilTick);
  return (
    (leftUntil === null || rightFrom < leftUntil) && (rightUntil === null || leftFrom < rightUntil)
  );
}

/**
 * A seed plan is already scoped to one world and currency. Percentage-policy
 * applicability is the empty document, while periodic applicability is the
 * payer entity/wallet tuple; cadence and policy terms do not create a new
 * taxable scope. Effective windows are half-open [from, until), with null as
 * infinity.
 */
export function assertNonOverlappingEconomySeedTaxPolicies(
  policies: readonly EconomySeedTaxPolicyV1[],
): void {
  const ordered = [...policies].sort((left, right) => compareText(left.stableKey, right.stableKey));
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex]!;
    const leftScope = economySeedTaxPolicyScope(left);
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex]!;
      if (leftScope === economySeedTaxPolicyScope(right) && effectiveWindowsOverlap(left, right)) {
        throw new EconomyDomainError(
          ErrorCodes.seedPlanIncompatible,
          `Active tax policies ${left.stableKey} and ${right.stableKey} overlap for one identical semantic scope.`,
        );
      }
    }
  }
}

export function assertEconomySeedPlanV2(plan: EconomySeedPlanV2): EconomySeedPlanV2 {
  if (!seedPlanV2Validator.is(plan)) {
    throw new EconomyDomainError(ErrorCodes.seedPlanIncompatible, 'Economy seed plan is invalid.');
  }
  assertSortedUnique(
    plan.assets.map((entry) => entry.stableKey),
    'Economy seed asset',
  );
  assertSortedUnique(
    plan.wallets.map((entry) => entry.stableKey),
    'Economy seed wallet',
  );
  for (const [noun, values] of [
    ['resource', plan.resources],
    ['recipe version', plan.recipeVersions],
    ['inventory', plan.inventories],
    ['business', plan.businesses],
    ['facility', plan.facilities],
    ['employment offer', plan.employmentOffers],
    ['tax policy', plan.taxPolicies],
  ] as const) {
    assertSortedUnique(
      values.map((entry) => entry.stableKey),
      `Economy seed ${noun}`,
    );
  }

  const treasuryWallets = plan.wallets.filter((wallet) => wallet.walletKind === 'treasury');
  const playerWallets = plan.wallets.filter((wallet) => wallet.walletKind === 'player');
  const treasuryWallet = plan.wallets.find(
    (wallet) => wallet.stableKey === plan.treasury.walletStableKey,
  );
  if (
    treasuryWallets.length !== 1 ||
    playerWallets.length < 1 ||
    !treasuryWallet ||
    treasuryWallet.walletKind !== 'treasury' ||
    treasuryWallet.initialBalanceMinor !== '0' ||
    treasuryWallet.ownerEntityLogicalKey !== plan.currency.issuerEntityLogicalKey ||
    plan.treasury.institutionEntityLogicalKey !== plan.currency.issuerEntityLogicalKey ||
    plan.treasury.currencyStableKey !== plan.currency.stableKey
  ) {
    throw new EconomyDomainError(
      ErrorCodes.seedPlanIncompatible,
      'Seed plan treasury binding must identify the single zero-balance issuer treasury.',
    );
  }
  const initialSupply = BigInt(plan.initialSupplyMinor);
  const maxSupply = BigInt(plan.currency.maxSupplyMinor);
  const distributed = plan.wallets.reduce(
    (total, wallet) => total + BigInt(wallet.initialBalanceMinor),
    0n,
  );
  if (
    initialSupply !== distributed ||
    initialSupply > maxSupply ||
    initialSupply > MAX_INT64 ||
    maxSupply > MAX_INT64
  ) {
    throw new EconomyDomainError(
      ErrorCodes.seedPlanIncompatible,
      'Seed supply must equal wallet distribution and fit the configured cap.',
    );
  }

  const resources = new Set(plan.resources.map((entry) => entry.stableKey));
  const recipes = new Set(plan.recipeVersions.map((entry) => entry.stableKey));
  const assets = new Map(plan.assets.map((entry) => [entry.stableKey, entry]));
  const wallets = new Map(plan.wallets.map((entry) => [entry.stableKey, entry]));
  const businesses = new Map(plan.businesses.map((entry) => [entry.stableKey, entry]));
  if (
    plan.assets.filter((entry) => entry.assetType === 'founding_seal').length !== 1 ||
    plan.assets.filter((entry) => entry.assetType === 'workshop').length < 1
  ) {
    throw new EconomyDomainError(
      ErrorCodes.seedPlanIncompatible,
      'Seed plan requires one founding seal and at least one workshop.',
    );
  }
  for (const resource of plan.resources) assertSortedUnique(resource.tags, 'Resource tag');
  for (const recipe of plan.recipeVersions) {
    assertSortedUnique(
      recipe.inputs.map((entry) => entry.resourceStableKey),
      'Recipe input resource',
    );
    assertSortedUnique(
      recipe.outputs.map((entry) => entry.resourceStableKey),
      'Recipe output resource',
    );
    if (
      [...recipe.inputs, ...recipe.outputs].some(
        (entry) => !resources.has(entry.resourceStableKey) || Number(entry.quantity) <= 0,
      ) ||
      economyRecipeVersionChecksum(
        Object.fromEntries(Object.entries(recipe).filter(([key]) => key !== 'checksum')) as Omit<
          EconomySeedRecipeVersionV1,
          'checksum'
        >,
      ) !== recipe.checksum
    ) {
      throw new EconomyDomainError(
        ErrorCodes.seedPlanIncompatible,
        'Recipe resources, quantities, and checksum must form an exact closed document.',
      );
    }
  }
  for (const business of plan.businesses) {
    const wallet = wallets.get(business.walletStableKey);
    if (
      !wallet ||
      wallet.walletKind !== 'organization' ||
      wallet.ownerEntityLogicalKey !== business.organizationEntityLogicalKey
    ) {
      throw new EconomyDomainError(
        ErrorCodes.seedPlanIncompatible,
        'Every seeded business requires its exact organization wallet.',
      );
    }
  }
  for (const facility of plan.facilities) {
    const business = businesses.get(facility.businessStableKey);
    const asset = assets.get(facility.assetStableKey);
    if (
      !business ||
      asset?.assetType !== 'workshop' ||
      asset.initialOwnerEntityLogicalKey !== business.organizationEntityLogicalKey ||
      facility.recipeVersionStableKeys.some((key) => !recipes.has(key))
    ) {
      throw new EconomyDomainError(
        ErrorCodes.seedPlanIncompatible,
        'Every facility must bind an organization-owned workshop to known recipe versions.',
      );
    }
  }
  for (const inventory of plan.inventories) {
    const container =
      inventory.containerAssetStableKey === null
        ? null
        : assets.get(inventory.containerAssetStableKey);
    if (
      !resources.has(inventory.resourceStableKey) ||
      (container !== null &&
        (!container || container.initialOwnerEntityLogicalKey !== inventory.ownerEntityLogicalKey))
    ) {
      throw new EconomyDomainError(
        ErrorCodes.seedPlanIncompatible,
        'Every inventory must reference a known resource and same-owner container.',
      );
    }
  }
  for (const offer of plan.employmentOffers) {
    if (
      !businesses.has(offer.businessStableKey) ||
      offer.currencyStableKey !== plan.currency.stableKey
    ) {
      throw new EconomyDomainError(
        ErrorCodes.seedPlanIncompatible,
        'Every employment offer must reference a known business and the world currency.',
      );
    }
  }
  if (plan.taxPolicies.filter((policy) => policy.taxType === 'periodic_flat').length > 15) {
    throw new EconomyDomainError(
      ErrorCodes.seedPlanIncompatible,
      'At most 15 periodic tax policies may be active at initialization.',
    );
  }
  for (const policy of plan.taxPolicies) {
    if (
      policy.authorityEntityLogicalKey !== plan.treasury.institutionEntityLogicalKey ||
      policy.treasuryWalletStableKey !== plan.treasury.walletStableKey ||
      BigInt(policy.effectiveFromTick) > MAX_INT64 ||
      (policy.effectiveUntilTick !== null && BigInt(policy.effectiveUntilTick) > MAX_INT64) ||
      (policy.effectiveUntilTick !== null &&
        BigInt(policy.effectiveUntilTick) <= BigInt(policy.effectiveFromTick))
    ) {
      throw new EconomyDomainError(
        ErrorCodes.seedPlanIncompatible,
        'Every tax policy must bind the treasury authority and a valid effective interval.',
      );
    }
    if (policy.taxType === 'periodic_flat') {
      const payerWallet = wallets.get(policy.payerWalletStableKey);
      if (
        payerWallet?.walletKind !== 'organization' ||
        payerWallet.ownerEntityLogicalKey !== policy.payerEntityLogicalKey ||
        BigInt(policy.fixedAmountMinor) > MAX_INT64 ||
        BigInt(policy.intervalTicks) > MAX_INT64
      ) {
        throw new EconomyDomainError(
          ErrorCodes.seedPlanIncompatible,
          'Every periodic tax must bind an exact organization wallet and fit signed 64-bit storage.',
        );
      }
    }
  }
  assertNonOverlappingEconomySeedTaxPolicies(plan.taxPolicies);
  return plan;
}
