import { createHash } from 'node:crypto';

import { ErrorCodes, canonicalJson } from '@worldgraph/contracts';

import { EconomyDomainError } from './errors.js';
import { multiplyQuantity } from './quantity.js';

export interface RecipeResourceAmount {
  quantityAtoms: bigint;
  resourceTypeId: string;
}

export interface ProductionRecipeVersionState {
  durationTicks: bigint;
  inputs: readonly RecipeResourceAmount[];
  outputs: readonly RecipeResourceAmount[];
  recipeId: string;
  version: number;
}

export interface ScaledRecipe {
  inputs: readonly RecipeResourceAmount[];
  outputs: readonly RecipeResourceAmount[];
}

export function assertProductionRecipeVersion(
  recipe: ProductionRecipeVersionState,
): ProductionRecipeVersionState {
  if (
    recipe.version < 1 ||
    !Number.isSafeInteger(recipe.version) ||
    recipe.durationTicks < 1n ||
    recipe.durationTicks > 1_000_000n ||
    recipe.outputs.length === 0 ||
    recipe.outputs.length > 32 ||
    recipe.inputs.length > 32
  ) {
    throw new EconomyDomainError(ErrorCodes.recipeInvalid, 'Recipe bounds are invalid.');
  }
  for (const side of [recipe.inputs, recipe.outputs]) {
    const seen = new Set<string>();
    for (const item of side) {
      if (item.quantityAtoms <= 0n || seen.has(item.resourceTypeId)) {
        throw new EconomyDomainError(
          ErrorCodes.recipeInvalid,
          'Recipe resources must be unique and have positive quantities.',
        );
      }
      seen.add(item.resourceTypeId);
    }
  }
  return recipe;
}

export function scaleProductionRecipe(
  recipe: ProductionRecipeVersionState,
  runQuantity: bigint,
): ScaledRecipe {
  assertProductionRecipeVersion(recipe);
  if (runQuantity < 1n || runQuantity > 1_000_000n) {
    throw new EconomyDomainError(ErrorCodes.quantityInvalid, 'Production run quantity is invalid.');
  }
  const scale = (item: RecipeResourceAmount): RecipeResourceAmount => ({
    quantityAtoms: multiplyQuantity(item.quantityAtoms, runQuantity),
    resourceTypeId: item.resourceTypeId,
  });
  return {
    inputs: recipe.inputs.map(scale),
    outputs: recipe.outputs.map(scale),
  };
}

export function productionRecipeChecksum(recipe: ProductionRecipeVersionState): string {
  assertProductionRecipeVersion(recipe);
  const encode = (items: readonly RecipeResourceAmount[]) =>
    items
      .map((item) => ({
        quantityAtoms: item.quantityAtoms.toString(),
        resourceTypeId: item.resourceTypeId,
      }))
      .sort((left, right) =>
        left.resourceTypeId < right.resourceTypeId
          ? -1
          : left.resourceTypeId > right.resourceTypeId
            ? 1
            : 0,
      );
  return createHash('sha256')
    .update(
      canonicalJson({
        domain: 'worldgraph.production-recipe.v1',
        durationTicks: recipe.durationTicks.toString(),
        inputs: encode(recipe.inputs),
        outputs: encode(recipe.outputs),
        recipeId: recipe.recipeId,
        version: recipe.version,
      }),
      'utf8',
    )
    .digest('hex');
}
