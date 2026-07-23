import { ErrorCodes } from '@worldgraph/contracts';

import { assertPositiveInt64 } from './amount.js';
import { EconomyDomainError } from './errors.js';

/** PostgreSQL numeric(30,12) stores at most 30 decimal digits as scaled atoms. */
export const MAX_QUANTITY_ATOMS = 999_999_999_999_999_999_999_999_999_999n;
export const MAX_QUANTITY_SCALE = 12;

function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_QUANTITY_SCALE) {
    throw new EconomyDomainError(
      ErrorCodes.quantityInvalid,
      'Resource quantity scale must be an integer from zero through twelve.',
    );
  }
}

function assertQuantityRange(atoms: bigint): bigint {
  if (atoms < 0n || atoms > MAX_QUANTITY_ATOMS) {
    throw new EconomyDomainError(
      ErrorCodes.quantityInvalid,
      'Resource quantity is outside the supported fixed-precision range.',
    );
  }
  return atoms;
}

export function parseCanonicalQuantity(
  value: string,
  scale: number,
  options: { positive?: boolean } = {},
): bigint {
  assertScale(scale);
  const parts = value.split('.');
  const whole = parts[0];
  const fraction = parts[1];
  const fractionIsExact = scale === 0 ? fraction === undefined : fraction?.length === scale;
  if (
    parts.length > 2 ||
    whole === undefined ||
    !/^(?:0|[1-9][0-9]*)$/u.test(whole) ||
    !fractionIsExact ||
    (fraction !== undefined && !/^[0-9]+$/u.test(fraction))
  ) {
    throw new EconomyDomainError(
      ErrorCodes.quantityInvalid,
      `Quantity must use exactly ${String(scale)} fractional digits without a sign or exponent.`,
    );
  }
  const atoms = assertQuantityRange(BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction ?? '0'));
  if (options.positive && atoms === 0n) {
    throw new EconomyDomainError(ErrorCodes.quantityInvalid, 'Quantity must be greater than zero.');
  }
  return atoms;
}

export function formatQuantity(atoms: bigint, scale: number): string {
  assertScale(scale);
  assertQuantityRange(atoms);
  if (scale === 0) return atoms.toString();
  const factor = 10n ** BigInt(scale);
  return `${(atoms / factor).toString()}.${(atoms % factor).toString().padStart(scale, '0')}`;
}

export function addQuantity(left: bigint, right: bigint): bigint {
  return assertQuantityRange(left + right);
}

export function subtractQuantity(left: bigint, right: bigint): bigint {
  const result = left - right;
  if (result < 0n) {
    throw new EconomyDomainError(
      ErrorCodes.insufficientInventory,
      'Inventory quantity cannot become negative.',
    );
  }
  return assertQuantityRange(result);
}

export function multiplyQuantity(atoms: bigint, multiplier: bigint): bigint {
  if (atoms <= 0n || multiplier <= 0n) {
    throw new EconomyDomainError(
      ErrorCodes.quantityInvalid,
      'Quantity and multiplier must be positive.',
    );
  }
  return assertQuantityRange(atoms * multiplier);
}

/**
 * Prices are per display unit. Half-up rounding is the one authoritative
 * conversion from a fixed-scale quantity to integer minor units.
 */
export function priceQuantityMinor(
  quantityAtoms: bigint,
  quantityScale: number,
  unitPriceMinor: bigint,
): bigint {
  assertScale(quantityScale);
  if (quantityAtoms <= 0n) {
    throw new EconomyDomainError(ErrorCodes.quantityInvalid, 'Purchase quantity must be positive.');
  }
  assertPositiveInt64(unitPriceMinor);
  const factor = 10n ** BigInt(quantityScale);
  const numerator = quantityAtoms * unitPriceMinor;
  const rounded = (numerator + factor / 2n) / factor;
  return assertPositiveInt64(rounded);
}
