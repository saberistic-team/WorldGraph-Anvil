import type { SimulationWorldTimeV1 } from '@worldgraph/contracts';

import { SimulationDomainError } from './errors.js';

export const SIGNED_INT64_MIN = -9_223_372_036_854_775_808n;
export const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n;

const SIGNED_CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/u;
const UNSIGNED_CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const CANONICAL_TIMESTAMP =
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})T(?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})\.(?<millisecond>[0-9]{3})Z$/u;

function overflow(label: string): never {
  throw new SimulationDomainError(
    'SIMULATION_INTEGER_OVERFLOW',
    `${label} is outside the signed 64-bit integer range.`,
  );
}

export function assertSignedInt64V1(value: bigint, label = 'value'): bigint {
  if (value < SIGNED_INT64_MIN || value > SIGNED_INT64_MAX) overflow(label);
  return value;
}

export function parseSignedInt64V1(value: string | bigint, label = 'value'): bigint {
  if (typeof value === 'bigint') return assertSignedInt64V1(value, label);
  if (!SIGNED_CANONICAL_INTEGER.test(value)) overflow(label);
  return assertSignedInt64V1(BigInt(value), label);
}

export function parseNonNegativeInt64V1(value: string | bigint, label = 'value'): bigint {
  if (typeof value === 'string' && !UNSIGNED_CANONICAL_INTEGER.test(value)) overflow(label);
  const parsed = parseSignedInt64V1(value, label);
  if (parsed < 0n) overflow(label);
  return parsed;
}

export function parsePositiveInt64V1(value: string | bigint, label = 'value'): bigint {
  const parsed = parseNonNegativeInt64V1(value, label);
  if (parsed === 0n) overflow(label);
  return parsed;
}

export function checkedAddInt64V1(left: bigint, right: bigint, label = 'sum'): bigint {
  return assertSignedInt64V1(left + right, label);
}

export function checkedMultiplyInt64V1(left: bigint, right: bigint, label = 'product'): bigint {
  return assertSignedInt64V1(left * right, label);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  return remainder < 0n ? quotient - 1n : quotient;
}

function daysFromCivil(year: bigint, month: bigint, day: bigint): bigint {
  const adjustedYear = year - (month <= 2n ? 1n : 0n);
  const era = floorDiv(adjustedYear, 400n);
  const yearOfEra = adjustedYear - era * 400n;
  const adjustedMonth = month + (month > 2n ? -3n : 9n);
  const dayOfYear = (153n * adjustedMonth + 2n) / 5n + day - 1n;
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

export function canonicalTimestampToUnixMillisecondsV1(timestamp: string): bigint {
  const match = CANONICAL_TIMESTAMP.exec(timestamp);
  if (!match?.groups) {
    throw new RangeError('Epoch must be a canonical UTC timestamp with millisecond precision.');
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second = Number(match.groups.second);
  const millisecond = Number(match.groups.millisecond);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new RangeError('Epoch is not a valid canonical UTC timestamp.');
  }
  const days = daysFromCivil(BigInt(year), BigInt(month), BigInt(day));
  const dayMilliseconds =
    BigInt(hour) * 3_600_000n +
    BigInt(minute) * 60_000n +
    BigInt(second) * 1_000n +
    BigInt(millisecond);
  return assertSignedInt64V1(days * 86_400_000n + dayMilliseconds, 'epoch');
}

function pad(value: bigint, length: number): string {
  return value.toString().padStart(length, '0');
}

export function unixMillisecondsToCanonicalTimestampV1(input: string | bigint): string {
  const milliseconds = parseSignedInt64V1(input, 'world time');
  const days = floorDiv(milliseconds, 86_400_000n);
  let withinDay = milliseconds - days * 86_400_000n;
  const shiftedDays = days + 719_468n;
  const era = floorDiv(shiftedDays, 146_097n);
  const dayOfEra = shiftedDays - era * 146_097n;
  const yearOfEra =
    (dayOfEra - dayOfEra / 1_460n + dayOfEra / 36_524n - dayOfEra / 146_096n) / 365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = dayOfYear - (153n * monthPrime + 2n) / 5n + 1n;
  const month = monthPrime + (monthPrime < 10n ? 3n : -9n);
  year += month <= 2n ? 1n : 0n;
  if (year < 1n || year > 9_999n) {
    overflow('world time');
  }
  const hour = withinDay / 3_600_000n;
  withinDay %= 3_600_000n;
  const minute = withinDay / 60_000n;
  withinDay %= 60_000n;
  const second = withinDay / 1_000n;
  const millisecond = withinDay % 1_000n;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millisecond, 3)}Z`;
}

export function deriveWorldTimeV1(
  epochAt: string,
  tick: string | bigint,
  worldMillisecondsPerTick: number | bigint,
): SimulationWorldTimeV1 {
  const epochMilliseconds = canonicalTimestampToUnixMillisecondsV1(epochAt);
  const parsedTick = parseNonNegativeInt64V1(tick, 'tick');
  const duration = parsePositiveInt64V1(
    typeof worldMillisecondsPerTick === 'number'
      ? worldMillisecondsPerTick.toString()
      : worldMillisecondsPerTick,
    'tick duration',
  );
  const elapsed = checkedMultiplyInt64V1(parsedTick, duration, 'elapsed world time');
  const worldTime = checkedAddInt64V1(epochMilliseconds, elapsed, 'world time');
  return {
    epochAt,
    tick: parsedTick.toString(),
    worldTimeAt: unixMillisecondsToCanonicalTimestampV1(worldTime),
    worldTimeUnixMilliseconds: worldTime.toString(),
  };
}
