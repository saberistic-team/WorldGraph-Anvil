import { ErrorCodes } from '@worldgraph/contracts';

import { EconomyDomainError } from './errors.js';

export const MAX_INT64 = 9_223_372_036_854_775_807n;
export const MIN_INT64 = -9_223_372_036_854_775_808n;

const unsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/u;

export function assertInt64(value: bigint): bigint {
  if (value < MIN_INT64 || value > MAX_INT64) {
    throw new EconomyDomainError(
      ErrorCodes.economyIntegerOverflow,
      'Minor-unit value exceeds signed 64-bit range.',
    );
  }
  return value;
}

export function assertNonNegativeInt64(value: bigint): bigint {
  assertInt64(value);
  if (value < 0n) {
    throw new EconomyDomainError(
      ErrorCodes.invalidAmountFormat,
      'Minor-unit value must be nonnegative.',
    );
  }
  return value;
}

export function assertPositiveInt64(value: bigint): bigint {
  assertNonNegativeInt64(value);
  if (value === 0n) {
    throw new EconomyDomainError(
      ErrorCodes.invalidAmountFormat,
      'Amount must be greater than zero.',
    );
  }
  return value;
}

export function parseCanonicalAmount(value: string, minorUnitScale: number): bigint {
  if (!Number.isInteger(minorUnitScale) || minorUnitScale < 0 || minorUnitScale > 6) {
    throw new EconomyDomainError(
      ErrorCodes.invalidAmountFormat,
      'Currency minor-unit scale must be an integer from zero through six.',
    );
  }
  const parts = value.split('.');
  if (parts.length > 2) {
    throw new EconomyDomainError(ErrorCodes.invalidAmountFormat, 'Amount is not canonical.');
  }
  const whole = parts[0];
  const fraction = parts[1];
  const exactFraction =
    minorUnitScale === 0 ? fraction === undefined : fraction?.length === minorUnitScale;
  if (
    whole === undefined ||
    !unsignedIntegerPattern.test(whole) ||
    !exactFraction ||
    (fraction !== undefined && !/^[0-9]+$/u.test(fraction))
  ) {
    throw new EconomyDomainError(
      ErrorCodes.invalidAmountFormat,
      `Amount must use exactly ${minorUnitScale} fractional digits without a sign or exponent.`,
    );
  }
  const factor = 10n ** BigInt(minorUnitScale);
  const minor = BigInt(whole) * factor + BigInt(fraction ?? '0');
  return assertPositiveInt64(minor);
}

export function formatMinorAmount(value: bigint, minorUnitScale: number): string {
  assertNonNegativeInt64(value);
  if (!Number.isInteger(minorUnitScale) || minorUnitScale < 0 || minorUnitScale > 6) {
    throw new EconomyDomainError(
      ErrorCodes.invalidAmountFormat,
      'Currency minor-unit scale must be an integer from zero through six.',
    );
  }
  if (minorUnitScale === 0) return value.toString();
  const factor = 10n ** BigInt(minorUnitScale);
  const whole = value / factor;
  const fraction = (value % factor).toString().padStart(minorUnitScale, '0');
  return `${whole.toString()}.${fraction}`;
}
