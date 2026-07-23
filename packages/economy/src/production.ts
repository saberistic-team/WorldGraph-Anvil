import { ErrorCodes } from '@worldgraph/contracts';

import { EconomyDomainError } from './errors.js';
import { availableInventory, type InventoryState } from './inventory.js';
import {
  scaleProductionRecipe,
  type ProductionRecipeVersionState,
  type RecipeResourceAmount,
} from './recipe.js';

export type ProductionRunStatus =
  'scheduled' | 'reserving' | 'ready' | 'completed' | 'failed' | 'cancelled';

export interface ProductionReservationDecision {
  dueTick: bigint;
  inputs: readonly RecipeResourceAmount[];
  outputs: readonly RecipeResourceAmount[];
  status: 'ready';
}

export function assertProductionRunTransition(
  current: ProductionRunStatus,
  target: ProductionRunStatus,
): void {
  const allowed: Readonly<Record<ProductionRunStatus, readonly ProductionRunStatus[]>> = {
    cancelled: [],
    completed: [],
    failed: [],
    ready: ['completed', 'failed', 'cancelled'],
    reserving: ['ready', 'failed', 'cancelled'],
    scheduled: ['reserving', 'cancelled'],
  };
  if (!allowed[current].includes(target)) {
    throw new EconomyDomainError(
      ErrorCodes.productionStateInvalid,
      `Production run cannot transition from ${current} to ${target}.`,
    );
  }
}

export function decideProductionReservation(input: {
  currentTick: bigint;
  inputInventories: ReadonlyMap<string, InventoryState>;
  recipe: ProductionRecipeVersionState;
  runQuantity: bigint;
}): ProductionReservationDecision {
  const scaled = scaleProductionRecipe(input.recipe, input.runQuantity);
  for (const requirement of scaled.inputs) {
    const inventory = input.inputInventories.get(requirement.resourceTypeId);
    if (!inventory || availableInventory(inventory) < requirement.quantityAtoms) {
      throw new EconomyDomainError(
        ErrorCodes.insufficientInventory,
        `Insufficient free inventory for ${requirement.resourceTypeId}.`,
      );
    }
  }
  return {
    dueTick: input.currentTick + input.recipe.durationTicks,
    inputs: scaled.inputs,
    outputs: scaled.outputs,
    status: 'ready',
  };
}

export function decideProductionCompletion(input: {
  currentTick: bigint;
  dueTick: bigint;
  status: ProductionRunStatus;
}): { status: 'completed' } {
  if (input.status !== 'ready') {
    throw new EconomyDomainError(
      ErrorCodes.productionStateInvalid,
      'Only a ready production run can complete.',
    );
  }
  if (input.currentTick < input.dueTick) {
    throw new EconomyDomainError(ErrorCodes.conflict, 'Production run is not due yet.');
  }
  return { status: 'completed' };
}
