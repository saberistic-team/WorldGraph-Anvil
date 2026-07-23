export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(input: unknown, ancestors: Set<object>): JsonValue {
  if (input === null || typeof input === 'boolean') {
    return input;
  }

  if (typeof input === 'string') return input.normalize('NFC');

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new TypeError('Canonical JSON does not support non-finite numbers.');
    }
    return Object.is(input, -0) ? 0 : input;
  }

  if (typeof input !== 'object') {
    throw new TypeError(`Canonical JSON does not support ${typeof input}.`);
  }

  if (ancestors.has(input)) {
    throw new TypeError('Canonical JSON does not support cyclic values.');
  }
  ancestors.add(input);

  try {
    if (Array.isArray(input)) {
      return input.map((value) => canonicalize(value, ancestors));
    }

    const prototype = Object.getPrototypeOf(input) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts only arrays and plain objects.');
    }

    const record = input as Record<string, unknown>;
    const normalizedKeys = Object.keys(record).map((key) => [key, key.normalize('NFC')] as const);
    if (new Set(normalizedKeys.map(([, key]) => key)).size !== normalizedKeys.length) {
      throw new TypeError('Canonical JSON object keys collide after Unicode normalization.');
    }
    return Object.fromEntries(
      normalizedKeys
        .sort((left, right) => (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0))
        .map(([sourceKey, normalizedKey]) => [
          normalizedKey,
          canonicalize(record[sourceKey], ancestors),
        ]),
    );
  } finally {
    ancestors.delete(input);
  }
}

export function canonicalizeJson(input: unknown): JsonValue {
  return canonicalize(input, new Set());
}

export function canonicalJson(input: unknown): string {
  const value = canonicalizeJson(input);

  function serialize(item: JsonValue): string {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map((entry) => serialize(entry)).join(',')}]`;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(item[key]!)}`)
      .join(',')}}`;
  }

  return serialize(value);
}

export async function canonicalJsonSha256(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
