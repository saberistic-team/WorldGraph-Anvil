import {
  canonicalJson,
  createValidator,
  type CompiledWorld,
  type EconomySeedPlanV2,
  type EconomySeedRecipeVersionV1,
  type EconomySeedTaxPolicyV1,
  type JsonValue,
  type WorldgraphEconomyExtensionV2,
  WorldgraphEconomyExtensionV2Schema,
  type EconomySeedPlanV1,
  type WorldEntityV1,
  type WorldRelationshipV1,
} from '@worldgraph/contracts';
import {
  EconomyDomainError,
  MAX_INT64,
  assertEconomySeedPlanV1,
  assertEconomySeedPlanV2,
  economySeedPlanHash,
  economyRecipeVersionChecksum,
  parseCanonicalAmount,
} from '@worldgraph/economy';

import { compilerDiagnostic } from './diagnostics.js';
import type { LoweredWorld, StageResult } from './types.js';

export const COMPILED_ECONOMY_SEED_ADAPTER_ID = 'CompiledEconomySeedAdapterV1' as const;
export const COMPILED_ECONOMY_SEED_ADAPTER_V2_ID = 'CompiledEconomySeedAdapterV2' as const;
export const LEGACY_ECONOMY_SEED_ADAPTER_ID = 'LegacyEconomySeedAdapterV1' as const;
export const ECONOMY_SEED_ADAPTER_VERSION = '1.0.0' as const;
export const CLOSED_LOOP_CURRENCY_PRIMITIVE_KEY =
  'worldgraph.currency.closed-loop-credits' as const;
export const CLOSED_LOOP_CURRENCY_PRIMITIVE_HASH =
  '38329b88b492eed14a9cfde37747d5d157cb2ba9471a393c87d9f84d6ffbbba5' as const;
export const INITIAL_PLAYER_BALANCE_MINOR = 10_000n;

interface SeedGraph {
  controllers: readonly {
    entityLogicalKey: string;
    principalKey: string;
  }[];
  entities: readonly WorldEntityV1[];
  relationships: readonly WorldRelationshipV1[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(code: string, pointer: string, message: string, keys: string[] = []) {
  return compilerDiagnostic('emit', code, pointer, message, { relatedKeys: keys });
}

class EconomyV2SeedDiagnosticError extends TypeError {
  public constructor(
    public readonly diagnosticCode: string,
    public readonly pointer: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reviewed semantic adapter shared by native V2 compilation and explicit V1
 * adoption. It depends only on the compiled graph and has no runtime fallback.
 */
export function deriveEconomySeedPlanV1(
  graph: SeedGraph,
): StageResult<{ hash: string; plan: EconomySeedPlanV1 }> {
  const entities = new Map(graph.entities.map((entity) => [entity.logicalKey, entity]));
  const currencyIntents = graph.entities.filter(
    (entity) => entity.entityType === 'currency_definition_intent',
  );
  if (currencyIntents.length !== 1) {
    return {
      diagnostics: [
        diagnostic(
          'ECONOMY_CURRENCY_INTENT_NOT_UNIQUE',
          '/entities',
          'Economy seed adaptation requires exactly one currency definition intent.',
          currencyIntents.map((entity) => entity.logicalKey),
        ),
      ],
      value: null,
    };
  }
  const currencyIntent = currencyIntents[0]!;
  const primitiveEdges = graph.relationships.filter(
    (relationship) =>
      relationship.relationshipType === 'uses_primitive' &&
      relationship.sourceLogicalKey === currencyIntent.logicalKey,
  );
  if (primitiveEdges.length !== 1) {
    return {
      diagnostics: [
        diagnostic(
          'ECONOMY_CURRENCY_PRIMITIVE_NOT_UNIQUE',
          '/relationships',
          'Currency intent must resolve to exactly one reviewed primitive.',
          [currencyIntent.logicalKey],
        ),
      ],
      value: null,
    };
  }
  const primitive = entities.get(primitiveEdges[0]!.targetLogicalKey);
  if (
    primitive?.entityType !== 'primitive_instance' ||
    primitive.state.behaviorRef !== 'economy.closed_loop_currency' ||
    primitive.state.kind !== 'currency' ||
    primitive.state.key !== CLOSED_LOOP_CURRENCY_PRIMITIVE_KEY ||
    primitive.state.contentHash !== CLOSED_LOOP_CURRENCY_PRIMITIVE_HASH ||
    primitive.state.parameters.cashOutAllowed !== false ||
    primitive.state.parameters.code !== 'GCR' ||
    primitive.state.parameters.initialSupplyPolicy !== 'per-capita-at-compile' ||
    primitive.state.parameters.minorUnitScale !== 2 ||
    primitive.state.parameters.noCashValue !== true ||
    typeof primitive.state.parameters.maxSupply !== 'string' ||
    canonicalJson(currencyIntent.state.parameters) !== canonicalJson(primitive.state.parameters)
  ) {
    return {
      diagnostics: [
        diagnostic(
          'ECONOMY_CURRENCY_PRIMITIVE_INCOMPATIBLE',
          `/entities/${currencyIntent.logicalKey}`,
          'Currency intent is not backed by the exact reviewed closed-loop credit primitive.',
          [currencyIntent.logicalKey, primitiveEdges[0]!.targetLogicalKey],
        ),
      ],
      value: null,
    };
  }

  const governingKeys = [
    ...new Set(
      graph.relationships
        .filter((relationship) => relationship.relationshipType === 'governs')
        .map((relationship) => relationship.sourceLogicalKey)
        .filter((key) => entities.get(key)?.entityType === 'institution'),
    ),
  ].sort(compareText);
  if (governingKeys.length !== 1) {
    return {
      diagnostics: [
        diagnostic(
          'ECONOMY_GOVERNING_INSTITUTION_NOT_UNIQUE',
          '/relationships',
          'Economy seed adaptation requires one unique governing institution.',
          governingKeys,
        ),
      ],
      value: null,
    };
  }

  const controlledCharacters = graph.controllers
    .map((controller) => entities.get(controller.entityLogicalKey))
    .filter(
      (entity): entity is Extract<WorldEntityV1, { entityType: 'player_character' }> =>
        entity?.entityType === 'player_character',
    );
  if (controlledCharacters.length !== graph.controllers.length) {
    return {
      diagnostics: [
        diagnostic(
          'ECONOMY_CONTROLLER_TARGET_INVALID',
          '/controllers',
          'Every economy wallet controller must target a compiled player character.',
        ),
      ],
      value: null,
    };
  }
  const creators = controlledCharacters.filter(
    (character) => character.state.membershipRole === 'creator',
  );
  if (creators.length !== 1) {
    return {
      diagnostics: [
        diagnostic(
          'ECONOMY_CREATOR_OWNER_NOT_UNIQUE',
          '/controllers',
          'The founding asset requires exactly one creator-controlled character.',
          creators.map((creator) => creator.logicalKey),
        ),
      ],
      value: null,
    };
  }

  try {
    const maxSupplyMinor = parseCanonicalAmount(
      primitive.state.parameters.maxSupply,
      primitive.state.parameters.minorUnitScale,
    );
    const wallets: EconomySeedPlanV1['wallets'] = [
      {
        initialBalanceMinor: '0',
        ownerEntityLogicalKey: governingKeys[0]!,
        stableKey: 'wallet:treasury:gcr',
        walletKind: 'treasury' as const,
        walletSchemaVersion: 1 as const,
      },
      ...controlledCharacters.map((character) => ({
        initialBalanceMinor: INITIAL_PLAYER_BALANCE_MINOR.toString(),
        ownerEntityLogicalKey: character.logicalKey,
        stableKey: `wallet:player:${character.logicalKey}:gcr`,
        walletKind: 'player' as const,
        walletSchemaVersion: 1 as const,
      })),
    ].sort((left, right) => compareText(left.stableKey, right.stableKey));
    const plan: EconomySeedPlanV1 = {
      assets: [
        {
          assetSchemaVersion: 1,
          assetType: 'founding_seal',
          initialOwnerEntityLogicalKey: creators[0]!.logicalKey,
          metadata: {
            displayName: 'Founding Seal',
            provenance: 'compiler-economy-adapter-v1',
          },
          stableKey: 'asset:founding-seal',
          transferable: true,
          worldEntityLogicalKey: null,
        },
      ],
      currency: {
        cashOutAllowed: false,
        code: 'GCR',
        currencySchemaVersion: 1,
        issuerEntityLogicalKey: governingKeys[0]!,
        maxSupplyMinor: maxSupplyMinor.toString(),
        minorUnitScale: 2,
        name: 'Guild Credits',
        noCashValue: true,
        stableKey: 'currency:gcr',
      },
      economySeedPlanSchemaVersion: 1,
      initialSupplyMinor: (
        INITIAL_PLAYER_BALANCE_MINOR * BigInt(controlledCharacters.length)
      ).toString(),
      wallets,
    };
    assertEconomySeedPlanV1(plan);
    return { diagnostics: [], value: { hash: economySeedPlanHash(plan), plan } };
  } catch (error) {
    return {
      diagnostics: [
        diagnostic(
          'ECONOMY_SEED_PLAN_INVALID',
          '/economySeedPlan',
          error instanceof EconomyDomainError
            ? error.message
            : 'Economy seed plan could not be derived.',
        ),
      ],
      value: null,
    };
  }
}

export function deriveLegacyEconomySeedPlanV1(
  world: CompiledWorld,
): StageResult<{ hash: string; plan: EconomySeedPlanV1 }> {
  return deriveEconomySeedPlanV1(world);
}

export function deriveLoweredEconomySeedPlanV1(
  lowered: LoweredWorld,
): StageResult<{ hash: string; plan: EconomySeedPlanV1 }> {
  return deriveEconomySeedPlanV1(lowered);
}

const economyExtensionValidator = createValidator<WorldgraphEconomyExtensionV2>(
  WorldgraphEconomyExtensionV2Schema,
);

function record(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object'
    ? value
    : null;
}

function recipeLines(
  value: JsonValue | undefined,
): Array<{ quantity: string; resourceKey: string }> {
  if (!Array.isArray(value)) throw new TypeError('Recipe lines must be an array.');
  return value.map((line) => {
    const candidate = record(line);
    if (
      !candidate ||
      typeof candidate.quantity !== 'string' ||
      typeof candidate.resourceKey !== 'string'
    ) {
      throw new TypeError('Recipe lines require canonical quantity and resource key strings.');
    }
    return { quantity: candidate.quantity, resourceKey: candidate.resourceKey };
  });
}

/**
 * Current M09 adapter. Value-bearing and asset initial conditions come only
 * from the typed, approved manifest extension. Zero-balance organization
 * wallets are mechanically derived from compiled controller affiliations so
 * every controlled organization has one runtime command prerequisite.
 * Primitive behavior supplies reviewed resource, recipe, and tax semantics.
 * No runtime or inferred fallback is permitted.
 */
export function deriveLoweredEconomySeedPlanV2(
  lowered: LoweredWorld,
): StageResult<{ hash: string; plan: EconomySeedPlanV2 }> {
  const rawExtension = lowered.normalized.manifest.extensions['worldgraph.economy'];
  if (!economyExtensionValidator.is(rawExtension)) {
    return {
      diagnostics: economyExtensionValidator
        .issues(rawExtension)
        .slice(0, 32)
        .map((issue) =>
          diagnostic(
            'ECONOMY_V2_EXTENSION_INVALID',
            `/manifest/extensions/worldgraph.economy${issue.path === '/' ? '' : issue.path}`,
            `The M09 economy extension is invalid: ${issue.message}`,
          ),
        ),
      value: null,
    };
  }
  const extension = rawExtension;
  const base = deriveEconomySeedPlanV1(lowered);
  if (!base.value) return { diagnostics: base.diagnostics, value: null };
  const entities = new Map(lowered.entities.map((entity) => [entity.logicalKey, entity]));
  const controlledOrganizationLogicalKeys = new Set(
    lowered.controllers
      .map((controller) => entities.get(controller.entityLogicalKey))
      .filter(
        (entity): entity is Extract<WorldEntityV1, { entityType: 'player_character' }> =>
          entity?.entityType === 'player_character',
      )
      .map((character) => character.state.organizationLogicalKey)
      .filter((key): key is string => key !== null),
  );
  const references = new Map(
    lowered.normalized.manifest.primitiveRefs.map((reference) => [reference.ref, reference]),
  );
  const exactById = new Map(
    lowered.normalized.orderedPrimitives.map((primitive) => [
      primitive.primitiveVersionId,
      primitive,
    ]),
  );
  const primitive = (ref: string, expectedKind: string) => {
    const reference = references.get(ref);
    const entity = entities.get(`primitive:${ref}`);
    const exact = reference ? exactById.get(reference.primitiveVersionId) : undefined;
    if (
      !reference ||
      entity?.entityType !== 'primitive_instance' ||
      entity.state.kind !== expectedKind ||
      !exact ||
      exact.contentHash !== entity.state.contentHash
    ) {
      throw new TypeError(`Primitive ${ref} is not an exact ${expectedKind} input.`);
    }
    return { entity, exact, reference };
  };
  const provenance = (ref: string, expectedKind: string) => {
    const resolved = primitive(ref, expectedKind);
    return {
      primitiveContentHash: resolved.entity.state.contentHash,
      primitiveKey: resolved.entity.state.key,
      primitiveRef: ref,
      primitiveVersion: resolved.entity.state.version,
      primitiveVersionId: resolved.reference.primitiveVersionId,
    };
  };

  try {
    const resources = extension.resources
      .map((intent) => {
        const resolved = primitive(intent.primitiveRef, 'resource');
        const configuredUnit = resolved.entity.state.parameters.unit;
        const configuredScale = resolved.entity.state.parameters.quantityScale;
        if (
          configuredUnit !== intent.unit ||
          (configuredScale !== undefined && configuredScale !== intent.quantityScale)
        ) {
          throw new TypeError(
            `Resource ${intent.stableKey} unit or scale differs from its primitive.`,
          );
        }
        return {
          displayName: intent.displayName,
          ...provenance(intent.primitiveRef, 'resource'),
          quantityScale: intent.quantityScale,
          resourceSchemaVersion: 1 as const,
          stableKey: intent.stableKey,
          tags: [...intent.tags].sort(compareText),
          unit: intent.unit,
        };
      })
      .sort((left, right) => compareText(left.stableKey, right.stableKey));
    const resourceByPrimitiveKey = new Map(
      resources.map((resource) => [resource.primitiveKey, resource]),
    );

    const recipeVersions = extension.recipes
      .map((intent): EconomySeedRecipeVersionV1 => {
        const resolved = primitive(intent.primitiveRef, 'production_recipe');
        const parameters = resolved.entity.state.parameters;
        const durationTicks = parameters.durationTicks;
        const facilityAssetType = parameters.facilityAssetType;
        if (
          typeof durationTicks !== 'number' ||
          !Number.isSafeInteger(durationTicks) ||
          durationTicks < 1 ||
          typeof facilityAssetType !== 'string'
        ) {
          throw new TypeError(
            `Recipe ${intent.stableKey} has invalid duration or facility intent.`,
          );
        }
        const convertLines = (value: JsonValue | undefined) =>
          recipeLines(value)
            .map((line) => {
              const resource = resourceByPrimitiveKey.get(line.resourceKey);
              if (!resource) throw new TypeError(`Recipe resource ${line.resourceKey} is absent.`);
              return { quantity: line.quantity, resourceStableKey: resource.stableKey };
            })
            .sort((left, right) => compareText(left.resourceStableKey, right.resourceStableKey));
        const body: Omit<EconomySeedRecipeVersionV1, 'checksum'> = {
          durationTicks: durationTicks.toString(),
          facilityAssetType,
          inputs: convertLines(parameters.inputs),
          outputs: convertLines(parameters.outputs),
          ...provenance(intent.primitiveRef, 'production_recipe'),
          recipeVersionSchemaVersion: 1,
          stableKey: intent.stableKey,
          version: intent.version,
        };
        return { ...body, checksum: economyRecipeVersionChecksum(body) };
      })
      .sort((left, right) => compareText(left.stableKey, right.stableKey));

    const businessWalletByOrganization = new Map(
      extension.businesses.map((business) => [
        `organization:${business.organizationKey}`,
        business.walletStableKey,
      ]),
    );
    const organizationWallets = [...controlledOrganizationLogicalKeys]
      .sort(compareText)
      .map((organizationEntityLogicalKey) => ({
        initialBalanceMinor: '0',
        ownerEntityLogicalKey: organizationEntityLogicalKey,
        stableKey:
          businessWalletByOrganization.get(organizationEntityLogicalKey) ??
          `wallet:${organizationEntityLogicalKey}:gcr`,
        walletKind: 'organization' as const,
        walletSchemaVersion: 1 as const,
      }));
    const businesses = extension.businesses
      .map((business, index) => {
        const organizationEntityLogicalKey = `organization:${business.organizationKey}`;
        if (entities.get(organizationEntityLogicalKey)?.entityType !== 'organization') {
          throw new TypeError(`Business organization ${business.organizationKey} is absent.`);
        }
        if (!controlledOrganizationLogicalKeys.has(organizationEntityLogicalKey)) {
          throw new EconomyV2SeedDiagnosticError(
            'ECONOMY_V2_ORGANIZATION_UNMANAGEABLE',
            `/manifest/extensions/worldgraph.economy/businesses/${index}/organizationKey`,
            `Business organization ${business.organizationKey} has no active controlled-character affiliation.`,
          );
        }
        return {
          businessSchemaVersion: 1 as const,
          displayName: business.displayName,
          organizationEntityLogicalKey,
          stableKey: business.stableKey,
          status: 'active' as const,
          walletStableKey: business.walletStableKey,
        };
      })
      .sort((left, right) => compareText(left.stableKey, right.stableKey));

    const workshopAssets = extension.facilities.map((facility) => {
      primitive(facility.buildingPrimitiveRef, 'building');
      const owner = `organization:${facility.initialOwnerOrganizationKey}`;
      if (entities.get(owner)?.entityType !== 'organization') {
        throw new TypeError(`Facility owner ${facility.initialOwnerOrganizationKey} is absent.`);
      }
      return {
        assetSchemaVersion: 1 as const,
        assetType: facility.assetType,
        initialOwnerEntityLogicalKey: owner,
        metadata: {
          displayName: facility.displayName,
          provenance: 'compiler-economy-adapter-v2',
        },
        stableKey: facility.assetStableKey,
        transferable: facility.transferable,
        worldEntityLogicalKey: null,
      };
    });
    const unconfiguredWorkshopAssets = extension.unconfiguredFacilityAssets.map(
      (facility, index) => {
        primitive(facility.buildingPrimitiveRef, 'building');
        const owner = `organization:${facility.initialOwnerOrganizationKey}`;
        if (entities.get(owner)?.entityType !== 'organization') {
          throw new TypeError(
            `Unconfigured facility owner ${facility.initialOwnerOrganizationKey} is absent.`,
          );
        }
        if (!controlledOrganizationLogicalKeys.has(owner)) {
          throw new EconomyV2SeedDiagnosticError(
            'ECONOMY_V2_ORGANIZATION_UNMANAGEABLE',
            `/manifest/extensions/worldgraph.economy/unconfiguredFacilityAssets/${index}/initialOwnerOrganizationKey`,
            `Unconfigured facility organization ${facility.initialOwnerOrganizationKey} has no active controlled-character affiliation.`,
          );
        }
        return {
          assetSchemaVersion: 1 as const,
          assetType: facility.assetType,
          initialOwnerEntityLogicalKey: owner,
          metadata: {
            displayName: facility.displayName,
            provenance: 'compiler-economy-adapter-v2',
          },
          stableKey: facility.stableKey,
          transferable: facility.transferable,
          worldEntityLogicalKey: null,
        };
      },
    );
    const facilities = extension.facilities
      .map((facility) => ({
        assetStableKey: facility.assetStableKey,
        businessStableKey: facility.businessStableKey,
        facilitySchemaVersion: 1 as const,
        recipeVersionStableKeys: [...facility.recipeVersionStableKeys].sort(compareText),
        stableKey: facility.stableKey,
        status: 'active' as const,
      }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey));
    const inventories = extension.inventories
      .map((inventory) => ({
        containerAssetStableKey: inventory.containerAssetStableKey,
        inventorySchemaVersion: 1 as const,
        ownerEntityLogicalKey: `organization:${inventory.ownerOrganizationKey}`,
        quantity: inventory.quantity,
        resourceStableKey: inventory.resourceStableKey,
        stableKey: inventory.stableKey,
      }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey));
    for (const resourceIntent of extension.resources) {
      const matches = extension.inventories.filter(
        (inventory) => inventory.resourceStableKey === resourceIntent.stableKey,
      );
      if (matches.length !== 1 || matches[0]!.quantity !== resourceIntent.initialQuantity) {
        throw new TypeError(
          `Resource ${resourceIntent.stableKey} must have one exact initial inventory.`,
        );
      }
    }
    const employmentOffers = extension.employmentOffers
      .map((offer) => ({
        ...offer,
        employmentOfferSchemaVersion: 1 as const,
        status: 'open' as const,
      }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey));
    const planWallets = [...base.value.plan.wallets, ...organizationWallets].sort((left, right) =>
      compareText(left.stableKey, right.stableKey),
    );
    const walletByStableKey = new Map(planWallets.map((wallet) => [wallet.stableKey, wallet]));
    if (extension.taxPolicies.filter((policy) => policy.taxType === 'periodic_flat').length > 15) {
      throw new TypeError('At most 15 periodic tax policies may be active at initialization.');
    }
    const taxPolicies = extension.taxPolicies
      .map((policy, index): EconomySeedTaxPolicyV1 => {
        const resolved = primitive(policy.primitiveRef, 'tax');
        const authorityEntityLogicalKey = `institution:${policy.authorityInstitutionKey}`;
        const authority = entities.get(authorityEntityLogicalKey);
        const treasuryWallet = walletByStableKey.get(policy.treasuryWalletStableKey);
        if (authority?.entityType !== 'institution') {
          throw new TypeError(`Tax authority ${policy.authorityInstitutionKey} is absent.`);
        }
        if (
          treasuryWallet?.walletKind !== 'treasury' ||
          treasuryWallet.ownerEntityLogicalKey !== authorityEntityLogicalKey
        ) {
          throw new TypeError(
            `Tax ${policy.stableKey} treasury wallet does not belong to its authority.`,
          );
        }
        const common = {
          authorityEntityLogicalKey,
          effectiveFromTick: policy.effectiveFromTick,
          effectiveUntilTick: policy.effectiveUntilTick,
          ...provenance(policy.primitiveRef, 'tax'),
          roundingMode: policy.roundingMode,
          stableKey: policy.stableKey,
          status: 'active' as const,
          taxPolicySchemaVersion: 1 as const,
          treasuryWalletStableKey: policy.treasuryWalletStableKey,
        };
        if (policy.taxType === 'periodic_flat') {
          const payerEntityLogicalKey = `organization:${policy.payerOrganizationKey}`;
          const payer = entities.get(payerEntityLogicalKey);
          const payerWallet = walletByStableKey.get(policy.payerWalletStableKey);
          if (payer?.entityType !== 'organization') {
            throw new TypeError(
              `Periodic-tax payer organization ${policy.payerOrganizationKey} is absent.`,
            );
          }
          if (!controlledOrganizationLogicalKeys.has(payerEntityLogicalKey)) {
            throw new EconomyV2SeedDiagnosticError(
              'ECONOMY_V2_ORGANIZATION_UNMANAGEABLE',
              `/manifest/extensions/worldgraph.economy/taxPolicies/${index}/payerOrganizationKey`,
              `Periodic-tax payer organization ${policy.payerOrganizationKey} has no active controlled-character affiliation.`,
            );
          }
          if (
            payerWallet?.walletKind !== 'organization' ||
            payerWallet.ownerEntityLogicalKey !== payerEntityLogicalKey
          ) {
            throw new TypeError(
              `Periodic-tax payer wallet ${policy.payerWalletStableKey} does not belong to ${policy.payerOrganizationKey}.`,
            );
          }
          if (
            BigInt(policy.fixedAmountMinor) > MAX_INT64 ||
            BigInt(policy.intervalTicks) > MAX_INT64
          ) {
            throw new TypeError(
              `Periodic tax ${policy.stableKey} amount and interval must fit signed 64-bit storage.`,
            );
          }
          return {
            ...common,
            collectionMode: policy.collectionMode,
            fixedAmountMinor: policy.fixedAmountMinor,
            intervalTicks: policy.intervalTicks,
            payerEntityLogicalKey,
            payerWalletStableKey: policy.payerWalletStableKey,
            taxType: policy.taxType,
          };
        }
        const rateBps = resolved.entity.state.parameters.rateBps;
        if (
          typeof rateBps !== 'number' ||
          !Number.isSafeInteger(rateBps) ||
          rateBps < 0 ||
          rateBps > 5_000
        ) {
          throw new TypeError(`Tax ${policy.stableKey} has no exact 0..5000 basis-point rate.`);
        }
        switch (policy.taxType) {
          case 'transaction':
            return {
              ...common,
              collectionMode: policy.collectionMode,
              rateBps,
              taxType: policy.taxType,
            };
          case 'sales':
            return {
              ...common,
              collectionMode: policy.collectionMode,
              rateBps,
              taxType: policy.taxType,
            };
          case 'payroll':
            return {
              ...common,
              collectionMode: policy.collectionMode,
              rateBps,
              taxType: policy.taxType,
            };
          case 'marketplace_fee':
            return {
              ...common,
              collectionMode: policy.collectionMode,
              rateBps,
              taxType: policy.taxType,
            };
        }
      })
      .sort((left, right) => compareText(left.stableKey, right.stableKey));
    const plan: EconomySeedPlanV2 = {
      assets: [...base.value.plan.assets, ...workshopAssets, ...unconfiguredWorkshopAssets].sort(
        (left, right) => compareText(left.stableKey, right.stableKey),
      ),
      businesses,
      currency: base.value.plan.currency,
      economySeedPlanSchemaVersion: 2,
      employmentOffers,
      facilities,
      initialSupplyMinor: base.value.plan.initialSupplyMinor,
      inventories,
      recipeVersions,
      resources,
      taxPolicies,
      treasury: {
        currencyStableKey: extension.treasury.currencyStableKey,
        institutionEntityLogicalKey: `institution:${extension.treasury.institutionKey}`,
        treasuryBindingSchemaVersion: 1,
        walletStableKey: extension.treasury.walletStableKey,
      },
      wallets: planWallets,
    };
    assertEconomySeedPlanV2(plan);
    return { diagnostics: [], value: { hash: economySeedPlanHash(plan), plan } };
  } catch (error) {
    if (error instanceof EconomyV2SeedDiagnosticError) {
      return {
        diagnostics: [diagnostic(error.diagnosticCode, error.pointer, error.message)],
        value: null,
      };
    }
    return {
      diagnostics: [
        diagnostic(
          'ECONOMY_V2_SEED_PLAN_INVALID',
          '/manifest/extensions/worldgraph.economy',
          error instanceof Error ? error.message : 'Economy V2 seed plan could not be derived.',
        ),
      ],
      value: null,
    };
  }
}
