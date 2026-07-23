import { ErrorCodes } from '@worldgraph/contracts';

import { EconomyDomainError } from './errors.js';
import { addQuantity, subtractQuantity } from './quantity.js';

export interface InventoryState {
  id: string;
  quantityAtoms: bigint;
  reservedAtoms: bigint;
  rowVersion: bigint;
}

export interface InventoryMutation {
  quantityAtoms: bigint;
  reservedAtoms: bigint;
  rowVersion: bigint;
}

export function assertInventoryState(inventory: InventoryState): InventoryState {
  if (
    inventory.quantityAtoms < 0n ||
    inventory.reservedAtoms < 0n ||
    inventory.reservedAtoms > inventory.quantityAtoms ||
    inventory.rowVersion < 1n
  ) {
    throw new EconomyDomainError(
      ErrorCodes.insufficientInventory,
      'Inventory quantity, reservation, or version is invalid.',
    );
  }
  return inventory;
}

export function availableInventory(inventory: InventoryState): bigint {
  assertInventoryState(inventory);
  return inventory.quantityAtoms - inventory.reservedAtoms;
}

export function reserveInventory(
  inventory: InventoryState,
  quantityAtoms: bigint,
  expectedVersion: bigint,
): InventoryMutation {
  assertInventoryState(inventory);
  assertExpectedVersion(inventory, expectedVersion);
  if (quantityAtoms <= 0n || availableInventory(inventory) < quantityAtoms) {
    throw new EconomyDomainError(
      ErrorCodes.insufficientInventory,
      'The requested quantity is not available for reservation.',
    );
  }
  return {
    quantityAtoms: inventory.quantityAtoms,
    reservedAtoms: addQuantity(inventory.reservedAtoms, quantityAtoms),
    rowVersion: inventory.rowVersion + 1n,
  };
}

export function releaseInventoryReservation(
  inventory: InventoryState,
  quantityAtoms: bigint,
  expectedVersion: bigint,
): InventoryMutation {
  assertInventoryState(inventory);
  assertExpectedVersion(inventory, expectedVersion);
  if (quantityAtoms <= 0n || quantityAtoms > inventory.reservedAtoms) {
    throw new EconomyDomainError(
      ErrorCodes.conflict,
      'Reservation release exceeds the currently reserved quantity.',
    );
  }
  return {
    quantityAtoms: inventory.quantityAtoms,
    reservedAtoms: inventory.reservedAtoms - quantityAtoms,
    rowVersion: inventory.rowVersion + 1n,
  };
}

export function consumeReservedInventory(
  inventory: InventoryState,
  quantityAtoms: bigint,
  expectedVersion: bigint,
): InventoryMutation {
  assertInventoryState(inventory);
  assertExpectedVersion(inventory, expectedVersion);
  if (quantityAtoms <= 0n || quantityAtoms > inventory.reservedAtoms) {
    throw new EconomyDomainError(
      ErrorCodes.insufficientInventory,
      'Production or trade cannot consume an unreserved quantity.',
    );
  }
  return {
    quantityAtoms: subtractQuantity(inventory.quantityAtoms, quantityAtoms),
    reservedAtoms: inventory.reservedAtoms - quantityAtoms,
    rowVersion: inventory.rowVersion + 1n,
  };
}

export function creditInventory(
  inventory: InventoryState,
  quantityAtoms: bigint,
  expectedVersion: bigint,
): InventoryMutation {
  assertInventoryState(inventory);
  assertExpectedVersion(inventory, expectedVersion);
  if (quantityAtoms <= 0n) {
    throw new EconomyDomainError(ErrorCodes.quantityInvalid, 'Inventory credit must be positive.');
  }
  return {
    quantityAtoms: addQuantity(inventory.quantityAtoms, quantityAtoms),
    reservedAtoms: inventory.reservedAtoms,
    rowVersion: inventory.rowVersion + 1n,
  };
}

function assertExpectedVersion(inventory: InventoryState, expectedVersion: bigint): void {
  if (expectedVersion !== inventory.rowVersion) {
    throw new EconomyDomainError(ErrorCodes.staleVersion, 'Inventory version is stale.');
  }
}
