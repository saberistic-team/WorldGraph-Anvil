import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Node,
} from 'yaml';

import { canonicalizeJson, type JsonValue } from '@worldgraph/contracts';

export const MAX_MANIFEST_YAML_BYTES = 131_072 as const;
const MAX_YAML_DEPTH = 16;
const MAX_YAML_NODES = 5_000;
const MAX_YAML_PROPERTIES = 2_000;
const MAX_YAML_LINES = 10_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface SafeYamlLocation {
  column: number;
  endColumn: number | null;
  endLine: number | null;
  line: number;
}

export interface SafeYamlIssue {
  code: string;
  column: number;
  line: number;
  message: string;
  pointer: string;
}

export type SafeYamlParseResult =
  | {
      issues: readonly [];
      locations: ReadonlyMap<string, SafeYamlLocation>;
      ok: true;
      value: JsonValue;
    }
  | {
      issues: readonly SafeYamlIssue[];
      locations: ReadonlyMap<string, SafeYamlLocation>;
      ok: false;
    };

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function hasForbiddenControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f || (code <= 0x1f && code !== 0x09 && code !== 0x0a)) return true;
  }
  return false;
}

function locationAt(
  lineCounter: LineCounter,
  range: readonly number[] | null | undefined,
): SafeYamlLocation {
  const start = lineCounter.linePos(range?.[0] ?? 0);
  const end = range ? lineCounter.linePos(range[1] ?? range[0] ?? 0) : null;
  return {
    column: start.col,
    endColumn: end?.col ?? null,
    endLine: end?.line ?? null,
    line: start.line,
  };
}

function issue(
  code: string,
  message: string,
  pointer: string,
  location: SafeYamlLocation,
): SafeYamlIssue {
  return { code, column: location.column, line: location.line, message, pointer };
}

interface InspectionState {
  issues: SafeYamlIssue[];
  lineCounter: LineCounter;
  locations: Map<string, SafeYamlLocation>;
  nodes: number;
  properties: number;
}

function inspectNode(
  node: Node | null,
  pointer: string,
  depth: number,
  state: InspectionState,
): void {
  if (!node || state.issues.length >= 128) return;
  const location = locationAt(state.lineCounter, node.range);
  if (!state.locations.has(pointer)) state.locations.set(pointer, location);
  state.nodes += 1;
  if (state.nodes > MAX_YAML_NODES) {
    state.issues.push(
      issue('YAML_NODE_LIMIT_EXCEEDED', 'YAML contains too many values.', pointer, location),
    );
    return;
  }
  if (depth > MAX_YAML_DEPTH) {
    state.issues.push(
      issue(
        'YAML_DEPTH_EXCEEDED',
        `YAML depth cannot exceed ${MAX_YAML_DEPTH}.`,
        pointer,
        location,
      ),
    );
    return;
  }
  if (isAlias(node)) {
    state.issues.push(
      issue('YAML_ALIAS_FORBIDDEN', 'YAML aliases are forbidden.', pointer, location),
    );
    return;
  }
  if ('anchor' in node && typeof node.anchor === 'string') {
    state.issues.push(
      issue('YAML_ANCHOR_FORBIDDEN', 'YAML anchors are forbidden.', pointer, location),
    );
  }
  if (node.tag !== undefined) {
    state.issues.push(
      issue('YAML_TAG_FORBIDDEN', 'Explicit YAML tags are forbidden.', pointer, location),
    );
  }

  if (isScalar(node)) {
    if (typeof node.value === 'number' && !Number.isFinite(node.value)) {
      state.issues.push(
        issue('YAML_NON_JSON_VALUE', 'Non-finite numbers are forbidden.', pointer, location),
      );
    } else if (typeof node.value === 'string') {
      if (node.value.length > 32_000 || hasForbiddenControl(node.value)) {
        state.issues.push(
          issue(
            'YAML_STRING_INVALID',
            'YAML strings must be bounded printable text.',
            pointer,
            location,
          ),
        );
      }
    } else if (
      node.value !== null &&
      typeof node.value !== 'boolean' &&
      typeof node.value !== 'number'
    ) {
      state.issues.push(
        issue(
          'YAML_NON_JSON_VALUE',
          'Only JSON-compatible YAML values are allowed.',
          pointer,
          location,
        ),
      );
    }
    return;
  }

  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      if (item && typeof item === 'object' && 'key' in item) {
        state.issues.push(
          issue(
            'YAML_NON_JSON_VALUE',
            'Pairs cannot appear directly in YAML sequences.',
            `${pointer}/${index}`,
            location,
          ),
        );
        return;
      }
      inspectNode(item as Node | null, `${pointer}/${index}`, depth + 1, state);
    });
    return;
  }

  if (isMap(node)) {
    state.properties += node.items.length;
    if (state.properties > MAX_YAML_PROPERTIES) {
      state.issues.push(
        issue(
          'YAML_PROPERTY_LIMIT_EXCEEDED',
          'YAML contains too many object properties.',
          pointer,
          location,
        ),
      );
      return;
    }
    const normalized = new Map<string, string>();
    for (const pair of node.items) {
      const keyNode = pair.key;
      if (!isScalar(keyNode) || typeof keyNode.value !== 'string') {
        state.issues.push(
          issue(
            'YAML_NON_STRING_KEY',
            'YAML mapping keys must be strings.',
            pointer,
            locationAt(state.lineCounter, isScalar(keyNode) ? keyNode.range : node.range),
          ),
        );
        continue;
      }
      const key = keyNode.value;
      const normalizedKey = key.normalize('NFC');
      const childPointer = `${pointer}/${pointerToken(normalizedKey)}`;
      const keyLocation = locationAt(state.lineCounter, keyNode.range);
      state.locations.set(childPointer, keyLocation);
      if (key === '<<') {
        state.issues.push(
          issue(
            'YAML_MERGE_KEY_FORBIDDEN',
            'YAML merge keys are forbidden.',
            childPointer,
            keyLocation,
          ),
        );
      }
      if (FORBIDDEN_KEYS.has(key)) {
        state.issues.push(
          issue(
            'YAML_PROTOTYPE_KEY_FORBIDDEN',
            'Prototype mutation keys are forbidden.',
            childPointer,
            keyLocation,
          ),
        );
      }
      if (key.length > 160 || hasForbiddenControl(key)) {
        state.issues.push(
          issue(
            'YAML_KEY_INVALID',
            'YAML keys must be bounded printable text.',
            childPointer,
            keyLocation,
          ),
        );
      }
      const previous = normalized.get(normalizedKey);
      if (previous !== undefined) {
        state.issues.push(
          issue(
            previous === key ? 'YAML_DUPLICATE_KEY' : 'YAML_KEY_NORMALIZATION_COLLISION',
            'YAML mapping keys must remain unique after Unicode normalization.',
            childPointer,
            keyLocation,
          ),
        );
      }
      normalized.set(normalizedKey, key);
      inspectNode(pair.value as Node | null, childPointer, depth + 1, state);
    }
  }
}

function safeErrorCode(code: string): string {
  if (code === 'DUPLICATE_KEY') return 'YAML_DUPLICATE_KEY';
  if (code === 'MULTIPLE_DOCS') return 'YAML_MULTIPLE_DOCUMENTS_FORBIDDEN';
  if (code === 'RESOURCE_EXHAUSTION') return 'YAML_RESOURCE_LIMIT_EXCEEDED';
  return 'YAML_SYNTAX_INVALID';
}

export function parseSafeYaml(source: string): SafeYamlParseResult {
  const locations = new Map<string, SafeYamlLocation>();
  if (new TextEncoder().encode(source).byteLength > MAX_MANIFEST_YAML_BYTES) {
    return {
      issues: [
        {
          code: 'YAML_SIZE_LIMIT_EXCEEDED',
          column: 1,
          line: 1,
          message: `YAML cannot exceed ${MAX_MANIFEST_YAML_BYTES} bytes.`,
          pointer: '',
        },
      ],
      locations,
      ok: false,
    };
  }
  if (source.split('\n').length > MAX_YAML_LINES) {
    return {
      issues: [
        {
          code: 'YAML_LINE_LIMIT_EXCEEDED',
          column: 1,
          line: 1,
          message: `YAML cannot exceed ${MAX_YAML_LINES} lines.`,
          pointer: '',
        },
      ],
      locations,
      ok: false,
    };
  }

  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    customTags: [],
    intAsBigInt: false,
    lineCounter,
    merge: false,
    prettyErrors: false,
    resolveKnownTags: false,
    schema: 'json',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const parseIssues: SafeYamlIssue[] = [...document.errors, ...document.warnings].map((error) => ({
    code: safeErrorCode(error.code),
    column: error.linePos?.[0].col ?? 1,
    line: error.linePos?.[0].line ?? 1,
    message: 'YAML syntax is invalid or uses an unsupported feature.',
    pointer: '',
  }));
  const state: InspectionState = {
    issues: parseIssues,
    lineCounter,
    locations,
    nodes: 0,
    properties: 0,
  };
  inspectNode(document.contents, '', 0, state);
  if (state.issues.length > 0 || !document.contents) {
    if (!document.contents && state.issues.length === 0) {
      state.issues.push({
        code: 'YAML_EMPTY_DOCUMENT',
        column: 1,
        line: 1,
        message: 'YAML document cannot be empty.',
        pointer: '',
      });
    }
    return { issues: state.issues.slice(0, 128), locations, ok: false };
  }

  try {
    return {
      issues: [],
      locations,
      ok: true,
      value: canonicalizeJson(document.toJS({ mapAsMap: false, maxAliasCount: 0 })),
    };
  } catch {
    return {
      issues: [
        {
          code: 'YAML_NON_JSON_VALUE',
          column: 1,
          line: 1,
          message: 'YAML must contain only bounded JSON-compatible values.',
          pointer: '',
        },
      ],
      locations,
      ok: false,
    };
  }
}

export function projectSafeYaml(value: JsonValue): string {
  return stringify(canonicalizeJson(value), {
    aliasDuplicateObjects: false,
    blockQuote: false,
    collectionStyle: 'block',
    defaultStringType: 'QUOTE_DOUBLE',
    directives: false,
    doubleQuotedAsJSON: true,
    lineWidth: 0,
    schema: 'json',
    sortMapEntries: true,
    version: '1.2',
  });
}
