import { canonicalJson, canonicalizeJson, type JsonValue } from '@worldgraph/contracts';

export type StructuralDiffEntry =
  | { after: JsonValue; kind: 'added'; pointer: string }
  | { before: JsonValue; kind: 'removed'; pointer: string }
  | { after: JsonValue; before: JsonValue; kind: 'changed'; pointer: string };

export interface StructuralDiff {
  counts: { added: number; changed: number; removed: number };
  entries: readonly StructuralDiffEntry[];
  truncated: boolean;
}

const MAX_DIFF_DEPTH = 20;
const KEYED_MANIFEST_COLLECTIONS: Readonly<Record<string, 'key' | 'ref'>> = {
  '/actors': 'key',
  '/connections': 'key',
  '/districts': 'key',
  '/institutions': 'key',
  '/organizations': 'key',
  '/primitiveRefs': 'ref',
  '/relationships': 'key',
};

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface KeyedValue {
  index: number;
  value: JsonValue;
}

function keyedValues(
  values: readonly JsonValue[],
  identityField: 'key' | 'ref',
): Map<string, KeyedValue> | null {
  const keyed = new Map<string, KeyedValue>();
  for (const [index, value] of values.entries()) {
    if (!isRecord(value) || typeof value[identityField] !== 'string') return null;
    const identity = value[identityField];
    if (keyed.has(identity)) return null;
    keyed.set(identity, { index, value });
  }
  return keyed;
}

export function structuralManifestDiff(beforeInput: unknown, afterInput: unknown): StructuralDiff {
  const before = canonicalizeJson(beforeInput);
  const after = canonicalizeJson(afterInput);
  const entries: StructuralDiffEntry[] = [];

  const add = (entry: StructuralDiffEntry): void => {
    entries.push(entry);
  };

  const compare = (left: JsonValue, right: JsonValue, pointer: string, depth: number): void => {
    if (canonicalJson(left) === canonicalJson(right)) return;
    if (depth >= MAX_DIFF_DEPTH) {
      add({ after: right, before: left, kind: 'changed', pointer });
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const identityField = KEYED_MANIFEST_COLLECTIONS[pointer];
      const leftByKey = identityField ? keyedValues(left, identityField) : null;
      const rightByKey = identityField ? keyedValues(right, identityField) : null;
      if (leftByKey && rightByKey) {
        const identities = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort();
        for (const identity of identities) {
          const leftEntry = leftByKey.get(identity);
          const rightEntry = rightByKey.get(identity);
          if (!leftEntry && rightEntry) {
            add({
              after: rightEntry.value,
              kind: 'added',
              pointer: `${pointer}/${rightEntry.index}`,
            });
          } else if (leftEntry && !rightEntry) {
            add({
              before: leftEntry.value,
              kind: 'removed',
              pointer: `${pointer}/${leftEntry.index}`,
            });
          } else if (leftEntry && rightEntry) {
            compare(leftEntry.value, rightEntry.value, `${pointer}/${rightEntry.index}`, depth + 1);
          }
        }
        return;
      }
      const shared = Math.min(left.length, right.length);
      for (let index = 0; index < shared; index += 1) {
        compare(left[index]!, right[index]!, `${pointer}/${index}`, depth + 1);
      }
      for (let index = shared; index < left.length; index += 1) {
        add({ before: left[index]!, kind: 'removed', pointer: `${pointer}/${index}` });
      }
      for (let index = shared; index < right.length; index += 1) {
        add({ after: right[index]!, kind: 'added', pointer: `${pointer}/${index}` });
      }
      return;
    }
    if (isRecord(left) && isRecord(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) {
        const childPointer = `${pointer}/${pointerToken(key)}`;
        if (!Object.prototype.hasOwnProperty.call(left, key)) {
          add({ after: right[key]!, kind: 'added', pointer: childPointer });
        } else if (!Object.prototype.hasOwnProperty.call(right, key)) {
          add({ before: left[key]!, kind: 'removed', pointer: childPointer });
        } else compare(left[key]!, right[key]!, childPointer, depth + 1);
      }
      return;
    }
    add({ after: right, before: left, kind: 'changed', pointer });
  };

  compare(before, after, '', 0);
  return {
    counts: {
      added: entries.filter((entry) => entry.kind === 'added').length,
      changed: entries.filter((entry) => entry.kind === 'changed').length,
      removed: entries.filter((entry) => entry.kind === 'removed').length,
    },
    entries,
    truncated: false,
  };
}
