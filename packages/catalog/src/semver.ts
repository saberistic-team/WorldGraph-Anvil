export interface Semver {
  build: string[];
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
  source: string;
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(source: string): Semver | null {
  if (source.length > 64) return null;
  const match = SEMVER.exec(source);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null;
  }
  return {
    build: match[5]?.split('.') ?? [],
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease,
    source,
  };
}

function compareNumeric(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

export function compareSemverPrecedence(leftSource: string, rightSource: string): number {
  const left = parseSemver(leftSource);
  const right = parseSemver(rightSource);
  if (!left || !right) throw new Error('INVALID_SEMVER');
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumeric(left[key], right[key]);
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** SemVer precedence with the complete source as a deterministic build-metadata tie-break. */
export function compareSemver(leftSource: string, rightSource: string): number {
  const precedence = compareSemverPrecedence(leftSource, rightSource);
  return precedence || (leftSource < rightSource ? -1 : leftSource > rightSource ? 1 : 0);
}

function comparatorSatisfied(version: string, comparator: string): boolean {
  const match = /^(<=|>=|<|>|=)?(.+)$/.exec(comparator);
  if (!match) return false;
  const target = match[2]!;
  if (!parseSemver(target)) return false;
  const comparison = compareSemverPrecedence(version, target);
  switch (match[1] ?? '=') {
    case '<':
      return comparison < 0;
    case '<=':
      return comparison <= 0;
    case '>':
      return comparison > 0;
    case '>=':
      return comparison >= 0;
    default:
      return comparison === 0;
  }
}

export function isValidVersionRange(range: string): boolean {
  if (range === '*') return true;
  if (!range || range.includes('||') || /(?:latest|git|file|workspace|https?:)/i.test(range))
    return false;
  if (/^[~^]/.test(range)) return parseSemver(range.slice(1)) !== null;
  const comparators = range.split(/\s+/).filter(Boolean);
  return (
    comparators.length > 0 &&
    comparators.every((value) => parseSemver(value.replace(/^(?:<=|>=|<|>|=)/, '')) !== null)
  );
}

function increment(value: string): string {
  return (BigInt(value) + 1n).toString();
}

function rangeTargets(range: string): Semver[] {
  if (range === '*') return [];
  const values = /^[~^]/.test(range)
    ? [range.slice(1)]
    : range
        .split(/\s+/)
        .filter(Boolean)
        .map((value) => value.replace(/^(?:<=|>=|<|>|=)/, ''));
  return values
    .map((value) => parseSemver(value))
    .filter((value): value is Semver => value !== null);
}

export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed || !isValidVersionRange(range)) return false;
  if (
    parsed.prerelease.length > 0 &&
    !rangeTargets(range).some(
      (target) =>
        target.prerelease.length > 0 &&
        target.major === parsed.major &&
        target.minor === parsed.minor &&
        target.patch === parsed.patch,
    )
  )
    return false;
  if (range === '*') return parsed.prerelease.length === 0;
  if (range.startsWith('^')) {
    const floor = parseSemver(range.slice(1))!;
    const ceiling =
      floor.major !== '0'
        ? `${increment(floor.major)}.0.0`
        : floor.minor !== '0'
          ? `0.${increment(floor.minor)}.0`
          : `0.0.${increment(floor.patch)}`;
    return (
      compareSemverPrecedence(version, floor.source) >= 0 &&
      compareSemverPrecedence(version, ceiling) < 0
    );
  }
  if (range.startsWith('~')) {
    const floor = parseSemver(range.slice(1))!;
    return (
      compareSemverPrecedence(version, floor.source) >= 0 &&
      compareSemverPrecedence(version, `${floor.major}.${increment(floor.minor)}.0`) < 0
    );
  }
  return range.split(/\s+/).every((comparator) => comparatorSatisfied(version, comparator));
}

export function highestSatisfying(versions: readonly string[], range: string): string | null {
  return (
    versions
      .filter((version) => satisfiesVersionRange(version, range))
      .sort((left, right) => compareSemver(right, left))[0] ?? null
  );
}
