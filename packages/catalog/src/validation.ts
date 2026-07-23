import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';

import {
  PRIMITIVE_KINDS,
  canonicalJson,
  createValidator,
  PrimitiveDraftInputSchema,
  type PrimitiveDraftInput,
  type PrimitiveValidationIssue,
} from '@worldgraph/contracts';

import { isValidVersionRange, parseSemver } from './semver.js';

export const BEHAVIOR_REFS_BY_KIND = {
  building: null,
  currency: 'economy.closed_loop_currency',
  district: null,
  election: 'governance.council_ballot',
  event_template: 'simulation.scheduled_event',
  government: 'governance.council',
  legal_right: null,
  office: null,
  organization: null,
  player_role: null,
  production_recipe: 'economy.production_recipe',
  resource: 'world.resource_stock',
  simulation_rule: 'simulation.discrete_clock',
  tax: 'economy.flat_transaction_tax',
  terrain: null,
  visual_style: null,
} as const;

export const ALLOWED_BEHAVIOR_REFS = new Set(
  Object.values(BEHAVIOR_REFS_BY_KIND).filter((value) => value !== null) as string[],
);

const draftValidator = createValidator<PrimitiveDraftInput>(PrimitiveDraftInputSchema);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const URL_OR_HTML =
  /(?:<\/?[a-z][^>]*>|(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:[^\s)\]}]+|(?:^|[^a-z0-9])\/\/[^\s)\]}]+)/iu;
const TEMPLATE_EXECUTION = /(?:\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|<%[\s\S]*?%>|\$\{[\s\S]*?\})/u;
const MAX_DIAGNOSTICS = 128;

const SQL_IDENTIFIER = String.raw`(?:"[^"\r\n]{1,128}"|[a-z_][a-z0-9_$]{0,127}(?:\.[a-z_][a-z0-9_$]{0,127})?)`;
const SQL_STATEMENTS = [
  new RegExp(
    String.raw`^(?:abort|alter|analyze|begin|call|checkpoint|close|cluster|comment|commit|copy|create|deallocate|declare|delete|discard|do|drop|end|execute|explain|fetch|grant|import\s+foreign\s+schema|insert|listen|load|lock|merge|move|notify|prepare|reassign|refresh|reindex|release|reset|revoke|rollback|savepoint|security\s+label|select|set|show|start\s+transaction|truncate|unlisten|update|vacuum|values|with)\b[\s\S]{0,4000}?;?\s*$`,
    'iu',
  ),
  new RegExp(
    String.raw`^select\s+(?:\*|${SQL_IDENTIFIER}(?:\s*,\s*${SQL_IDENTIFIER})*)\s+from\s+${SQL_IDENTIFIER}(?:\s+(?:where|join|left\s+join|right\s+join|inner\s+join|order\s+by|group\s+by|limit|offset)\b[\s\S]*)?\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^select\s+(?:${SQL_IDENTIFIER}\s*\([\s\S]{0,3000}\)|(?:[-+]?\d+(?:\.\d+)?|'(?:''|[^'])*'|true|false|null)(?:\s*::\s*${SQL_IDENTIFIER})?)\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^select\s+(?:(?:current_(?:user|role|schema|catalog|date|time|timestamp)|session_user|system_user|user)|(?:[-+]?\d+(?:\.\d+)?|'(?:''|[^'])*')(?:\s*(?:\+|-|\*|\/|%|\|\||=|<>|<=|>=)\s*(?:[-+]?\d+(?:\.\d+)?|'(?:''|[^'])*'))+)\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^insert\s+into\s+${SQL_IDENTIFIER}(?:\s*\([^)]{1,2000}\))?\s+(?:values\s*\([\s\S]*\)|select\s+[\s\S]*)\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^update\s+${SQL_IDENTIFIER}\s+set\s+${SQL_IDENTIFIER}\s*=\s*[\s\S]+?\s*;?$`,
    'iu',
  ),
  new RegExp(String.raw`^delete\s+from\s+${SQL_IDENTIFIER}(?:\s+where\b[\s\S]*)?\s*;?$`, 'iu'),
  new RegExp(
    String.raw`^(?:create|alter|drop|truncate)\s+(?:table|schema|database|function|procedure|trigger|role|user|extension|index|view)\s+${SQL_IDENTIFIER}(?:\s+[\s\S]*)?;$`,
    'iu',
  ),
  new RegExp(String.raw`^(?:execute|call)\s+${SQL_IDENTIFIER}\s*\([\s\S]*\)\s*;?$`, 'iu'),
  new RegExp(
    String.raw`^with\s+(?:recursive\s+)?${SQL_IDENTIFIER}\s+as\s*\([\s\S]{1,3500}\)\s*(?:select|insert|update|delete|merge)\b[\s\S]*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^(?:grant|revoke)\s+[\s\S]{1,2000}\s+on\s+(?:(?:table|sequence|database|schema|function|procedure|type)\s+)?${SQL_IDENTIFIER}\s+(?:to|from)\s+(?:public|${SQL_IDENTIFIER})\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^copy\s+(?:${SQL_IDENTIFIER}|\([\s\S]{1,2000}\))\s+(?:to|from)\s+(?:program\s+)?(?:'(?:''|[^'])*'|stdin|stdout)(?:\s+with\b[\s\S]*)?\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^(?:begin|commit|rollback|abort|end)(?:\s+(?:work|transaction))?(?:\s+and\s+(?:no\s+)?chain)?\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^(?:vacuum|analyze)(?:\s*\([^)]{1,1000}\))?(?:\s+(?:full|freeze|verbose|analyze))*\s+${SQL_IDENTIFIER}(?:\s*\([^)]{1,1000}\))?\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^alter\s+system\s+(?:set\s+${SQL_IDENTIFIER}\s*(?:=|to)\s+[\s\S]+|reset\s+(?:${SQL_IDENTIFIER}|all))\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^drop\s+owned\s+by\s+${SQL_IDENTIFIER}(?:\s*,\s*${SQL_IDENTIFIER})*(?:\s+(?:cascade|restrict))?\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^drop\s+(?:table|schema|database|function|procedure|trigger|role|user|extension|index|view)\s+(?:if\s+exists\s+)?${SQL_IDENTIFIER}(?:\s*,\s*${SQL_IDENTIFIER})*(?:\s+(?:cascade|restrict))?\s*;?$`,
    'iu',
  ),
  new RegExp(String.raw`^notify\s+${SQL_IDENTIFIER}(?:\s*,\s*'(?:''|[^'])*')?\s*;?$`, 'iu'),
  new RegExp(
    String.raw`^truncate\s+(?:table\s+)?(?:only\s+)?${SQL_IDENTIFIER}(?:\s*,\s*(?:only\s+)?${SQL_IDENTIFIER})*(?:\s+(?:restart|continue)\s+identity)?(?:\s+(?:cascade|restrict))?\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^reindex\s+(?:index|table|schema|database|system)\s+(?:concurrently\s+)?${SQL_IDENTIFIER}\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^set\s+(?:(?:local|session)\s+)?(?:role|session\s+authorization)\s+(?:none|default|${SQL_IDENTIFIER})\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^lock\s+(?:table\s+)?${SQL_IDENTIFIER}(?:\s*,\s*${SQL_IDENTIFIER})*(?:\s+in\s+(?:access\s+share|row\s+share|row\s+exclusive|share\s+update\s+exclusive|share|share\s+row\s+exclusive|exclusive|access\s+exclusive)\s+mode)?(?:\s+nowait)?\s*;?$`,
    'iu',
  ),
  new RegExp(
    String.raw`^merge\s+into\s+${SQL_IDENTIFIER}\s+[\s\S]{1,3500}\bwhen\s+(?:matched|not\s+matched)\b[\s\S]+$`,
    'iu',
  ),
  new RegExp(String.raw`^values\s*\([\s\S]{1,3500}\)(?:\s*,\s*\([\s\S]*\))*\s*;?$`, 'iu'),
  new RegExp(String.raw`^show\s+(?:all|${SQL_IDENTIFIER})\s*;?$`, 'iu'),
  new RegExp(String.raw`^reset\s+(?:all|${SQL_IDENTIFIER})\s*;?$`, 'iu'),
  new RegExp(String.raw`^discard\s+(?:all|plans|sequences|temp|temporary)\s*;?$`, 'iu'),
];
const EMBEDDED_SQL_DDL = new RegExp(
  String.raw`(?:^|[;\n])\s*(?:create|alter|drop|truncate)\s+(?:table|schema|database|function|procedure|trigger|role|user|extension|index|view)\s+${SQL_IDENTIFIER}(?:\s+[^;\n]*)?\s*(?:;|$)`,
  'iu',
);

export interface BoundedJsonValidationOptions {
  pointer?: string;
  rejectExecutableContent?: boolean;
}

export interface BoundedJsonValidationResult {
  issues: PrimitiveValidationIssue[];
  valid: boolean;
}

function issue(code: string, pointer: string, message: string): PrimitiveValidationIssue {
  return { code, message, pointer };
}

function boundedIssues(issues: readonly PrimitiveValidationIssue[]): PrimitiveValidationIssue[] {
  const unique = new Map<string, PrimitiveValidationIssue>();
  for (const entry of issues) {
    unique.set(`${entry.code}\u0000${entry.pointer}\u0000${entry.message}`, entry);
    if (unique.size === MAX_DIAGNOSTICS) break;
  }
  return [...unique.values()];
}

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function hasForbiddenControl(value: string, allowTabAndLineFeed = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x7f ||
      (code <= 0x1f && !(allowTabAndLineFeed && (code === 0x09 || code === 0x0a)))
    ) {
      return true;
    }
  }
  return false;
}

function containsExecutableSql(value: string): boolean {
  if (EMBEDDED_SQL_DDL.test(value)) return true;
  const candidates = [value.trim()];
  for (const statement of value.matchAll(/(?:^|[\n;])\s*([^\n;]{1,4000};?)/gu)) {
    const candidate = statement[1]?.trim();
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates.some((candidate) => {
    const withoutLeadingComments = candidate
      .replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]{0,2000}?\*\/))+/u, '')
      .trim();
    return SQL_STATEMENTS.some((pattern) => pattern.test(withoutLeadingComments));
  });
}

function executableContentIssues(value: string, pointer: string): PrimitiveValidationIssue[] {
  const issues: PrimitiveValidationIssue[] = [];
  if (URL_OR_HTML.test(value)) {
    issues.push(
      issue(
        'REMOTE_OR_EXECUTABLE_CONTENT_FORBIDDEN',
        pointer,
        'Remote URLs, executable protocols, and raw HTML are forbidden.',
      ),
    );
  }
  if (containsExecutableSql(value)) {
    issues.push(
      issue(
        'EXECUTABLE_SQL_FORBIDDEN',
        pointer,
        'Executable SQL statements are forbidden in primitive data.',
      ),
    );
  }
  if (TEMPLATE_EXECUTION.test(value)) {
    issues.push(
      issue(
        'EXECUTABLE_TEMPLATE_FORBIDDEN',
        pointer,
        'Template execution delimiters are forbidden in primitive data.',
      ),
    );
  }
  return issues;
}

function inspectJson(
  value: unknown,
  pointer: string,
  state: { nodes: number; properties: number },
  depth: number,
  issues: PrimitiveValidationIssue[],
  options: BoundedJsonValidationOptions,
): void {
  if (state.nodes >= 2_000) {
    if (!issues.some((entry) => entry.code === 'JSON_NODE_LIMIT_EXCEEDED')) {
      issues.push(issue('JSON_NODE_LIMIT_EXCEEDED', pointer, 'JSON contains too many values.'));
    }
    return;
  }
  state.nodes += 1;
  if (depth > 12) {
    issues.push(issue('JSON_DEPTH_EXCEEDED', pointer, 'JSON depth cannot exceed 12.'));
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 32_000 || hasLoneSurrogate(value) || hasForbiddenControl(value)) {
      issues.push(
        issue('JSON_STRING_INVALID', pointer, 'JSON strings must be bounded printable text.'),
      );
    }
    if (options.rejectExecutableContent) {
      issues.push(...executableContentIssues(value, pointer));
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length > 200)
      issues.push(issue('JSON_ARRAY_LIMIT_EXCEEDED', pointer, 'Arrays cannot exceed 200 values.'));
    value
      .slice(0, 200)
      .forEach((item, index) =>
        inspectJson(item, `${pointer}/${index}`, state, depth + 1, issues, options),
      );
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const normalizedKeys = new Map<string, string>();
  state.properties += entries.length;
  if (state.properties > 500) {
    issues.push(
      issue('JSON_PROPERTY_LIMIT_EXCEEDED', pointer, 'JSON cannot exceed 500 properties.'),
    );
  }
  const remainingProperties = Math.max(0, 500 - (state.properties - entries.length));
  for (const [key, item] of entries.slice(0, remainingProperties)) {
    const child = `${pointer}/${pointerToken(key)}`;
    if (FORBIDDEN_KEYS.has(key)) {
      issues.push(
        issue('PROTOTYPE_KEY_FORBIDDEN', child, 'Prototype mutation keys are forbidden.'),
      );
    }
    const normalizedKey = key.normalize('NFC');
    if (normalizedKeys.has(normalizedKey) && normalizedKeys.get(normalizedKey) !== key) {
      issues.push(
        issue(
          'JSON_KEY_NORMALIZATION_COLLISION',
          child,
          'JSON keys collide after Unicode normalization.',
        ),
      );
    }
    normalizedKeys.set(normalizedKey, key);
    if (key.length > 160 || hasLoneSurrogate(key) || hasForbiddenControl(key)) {
      issues.push(issue('JSON_KEY_INVALID', child, 'JSON keys must be bounded printable text.'));
    }
    if (options.rejectExecutableContent) {
      issues.push(...executableContentIssues(key, child));
    }
    inspectJson(item, child, state, depth + 1, issues, options);
  }
}

export function validateBoundedJson(
  value: unknown,
  options: BoundedJsonValidationOptions = {},
): BoundedJsonValidationResult {
  const issues: PrimitiveValidationIssue[] = [];
  inspectJson(value, options.pointer ?? '', { nodes: 0, properties: 0 }, 0, issues, options);
  const bounded = boundedIssues(issues);
  return { issues: bounded, valid: bounded.length === 0 };
}

export function validateSafeJsonStructure(
  value: unknown,
  pointer: string,
  options: Omit<BoundedJsonValidationOptions, 'pointer'> = { rejectExecutableContent: true },
): PrimitiveValidationIssue[] {
  return validateBoundedJson(value, { ...options, pointer }).issues;
}

function inspectSchema(value: unknown, pointer: string, issues: PrimitiveValidationIssue[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectSchema(item, `${pointer}/${index}`, issues));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const child = `${pointer}/${pointerToken(key)}`;
    if (
      (key === '$ref' && (typeof item !== 'string' || !item.startsWith('#/$defs/'))) ||
      key === '$dynamicRef' ||
      key === '$dynamicAnchor' ||
      key === '$recursiveRef' ||
      key === '$recursiveAnchor' ||
      key === '$anchor' ||
      key === '$id'
    ) {
      issues.push(
        issue('REMOTE_REF_FORBIDDEN', child, 'Only local #/$defs references are allowed.'),
      );
    }
    if (key === 'pattern' || key === 'patternProperties') {
      issues.push(
        issue(
          'UNSAFE_REGEX',
          child,
          'Regular-expression schema keywords are forbidden in primitive schema v1.',
        ),
      );
    }
    if (
      key === 'format' &&
      typeof item === 'string' &&
      !['date', 'date-time', 'email', 'uuid'].includes(item)
    ) {
      issues.push(
        issue('SCHEMA_FORMAT_FORBIDDEN', child, 'That JSON Schema format is not allowlisted.'),
      );
    }
    inspectSchema(item, child, issues);
  }
}

function localRefGraph(schema: Record<string, unknown>, issues: PrimitiveValidationIssue[]): void {
  const definitions =
    schema.$defs && typeof schema.$defs === 'object' && !Array.isArray(schema.$defs)
      ? (schema.$defs as Record<string, unknown>)
      : {};
  const graph = new Map<string, Set<string>>();
  const collect = (value: unknown, owner: string, pointer: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => collect(item, owner, `${pointer}/${index}`));
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref') {
        const match =
          typeof item === 'string' ? /^#\/\$defs\/([A-Za-z0-9_-]{1,80})$/.exec(item) : null;
        if (!match) {
          issues.push(
            issue(
              'LOCAL_REF_MALFORMED',
              `${pointer}/$ref`,
              'Local references must target one direct #/$defs name.',
            ),
          );
        } else if (!(match[1]! in definitions)) {
          issues.push(
            issue('LOCAL_REF_MISSING', `${pointer}/$ref`, 'Local reference target does not exist.'),
          );
        } else {
          const edges = graph.get(owner) ?? new Set<string>();
          edges.add(match[1]!);
          graph.set(owner, edges);
        }
      }
      collect(item, owner, `${pointer}/${pointerToken(key)}`);
    }
  };
  for (const [name, definition] of Object.entries(definitions)) {
    graph.set(name, new Set());
    collect(definition, name, `/$defs/${pointerToken(name)}`);
  }
  collect(schema, '$root', '');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) {
      issues.push(
        issue(
          'LOCAL_REF_CYCLE',
          `/$defs/${pointerToken(name)}`,
          'Recursive local references are forbidden in primitive schema v1.',
        ),
      );
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const target of graph.get(name) ?? []) visit(target);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name);
}

function ajvIssues(errors: ErrorObject[] | null | undefined): PrimitiveValidationIssue[] {
  return (errors ?? []).map((error) =>
    issue(
      'DEFAULTS_SCHEMA_MISMATCH',
      error.instancePath || '/defaults',
      error.message ?? 'Defaults do not match the parameter schema.',
    ),
  );
}

export interface PrimitiveValidationResult {
  contentHash: string | null;
  issues: PrimitiveValidationIssue[];
  valid: boolean;
}

export function primitiveSemanticDocument(input: PrimitiveDraftInput): object {
  return {
    contract: 'WorldPrimitive',
    schemaVersion: 1,
    primitive: {
      behaviorRef: input.behaviorRef ?? null,
      compatibility: input.compatibility,
      defaults: input.defaults,
      dependencies: [...input.dependencies]
        .map((dependency) => ({
          key: dependency.key,
          parameterMapping: dependency.parameterMapping ?? {},
          required: dependency.required ?? true,
          versionRange: dependency.versionRange,
        }))
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
      displayName: input.displayName.normalize('NFC'),
      documentation: input.documentation.normalize('NFC'),
      key: input.key,
      kind: input.kind,
      parameterSchema: input.parameterSchema,
      primitiveSchemaVersion: input.primitiveSchemaVersion,
      provenance: input.provenance,
      tags: [...input.tags].sort(),
      version: input.version,
      visualHints: input.visualHints,
    },
  };
}

export function primitiveContentHash(input: PrimitiveDraftInput): string {
  return createHash('sha256')
    .update(canonicalJson(primitiveSemanticDocument(input)))
    .digest('hex');
}

export function validatePrimitive(input: unknown): PrimitiveValidationResult {
  const issues: PrimitiveValidationIssue[] = [];
  if (!draftValidator.is(input)) {
    return {
      contentHash: null,
      issues: boundedIssues(
        draftValidator
          .issues(input)
          .map((error) => issue('PRIMITIVE_META_SCHEMA_INVALID', error.path || '/', error.message)),
      ),
      valid: false,
    };
  }
  const primitive = input;
  for (const [pointer, value] of [
    ['/key', primitive.key],
    ['/version', primitive.version],
    ['/displayName', primitive.displayName],
    ['/documentation', primitive.documentation],
    ...primitive.tags.map((tag, index) => [`/tags/${index}`, tag] as const),
  ] as const) {
    if (hasLoneSurrogate(value) || hasForbiddenControl(value, pointer === '/documentation')) {
      issues.push(
        issue(
          'TEXT_INVALID',
          pointer,
          'Semantic text must not contain control characters or unpaired surrogates.',
        ),
      );
    }
  }
  if (primitive.displayName !== primitive.displayName.trim()) {
    issues.push(
      issue('TEXT_INVALID', '/displayName', 'Display name must be trimmed printable text.'),
    );
  }
  issues.push(...executableContentIssues(primitive.displayName, '/displayName'));
  if (!PRIMITIVE_KINDS.includes(primitive.kind)) {
    issues.push(issue('PRIMITIVE_KIND_UNKNOWN', '/kind', 'Primitive kind is not supported.'));
  }
  if (!parseSemver(primitive.version)) {
    issues.push(issue('SEMVER_INVALID', '/version', 'Version must be strict SemVer.'));
  }
  if ((primitive.behaviorRef ?? null) !== BEHAVIOR_REFS_BY_KIND[primitive.kind]) {
    issues.push(
      issue('BEHAVIOR_REF_NOT_ALLOWED', '/behaviorRef', 'Behavior reference is not allowlisted.'),
    );
  }
  if (URL_OR_HTML.test(primitive.documentation)) {
    issues.push(
      issue(
        'DOCUMENTATION_UNSAFE',
        '/documentation',
        'Raw HTML and remote or executable URLs are forbidden.',
      ),
    );
  }
  if (containsExecutableSql(primitive.documentation)) {
    issues.push(
      issue(
        'EXECUTABLE_SQL_FORBIDDEN',
        '/documentation',
        'Executable SQL statements are forbidden in primitive data.',
      ),
    );
  }
  if (TEMPLATE_EXECUTION.test(primitive.documentation)) {
    issues.push(
      issue(
        'EXECUTABLE_TEMPLATE_FORBIDDEN',
        '/documentation',
        'Template execution delimiters are forbidden in primitive data.',
      ),
    );
  }
  primitive.dependencies.forEach((dependency, index) => {
    if (dependency.key === primitive.key) {
      issues.push(
        issue(
          'DEPENDENCY_SELF_EDGE',
          `/dependencies/${index}/key`,
          'A primitive cannot depend on itself.',
        ),
      );
    }
    if (!isValidVersionRange(dependency.versionRange)) {
      issues.push(
        issue(
          'DEPENDENCY_RANGE_INVALID',
          `/dependencies/${index}/versionRange`,
          'Dependency range is invalid or unsupported.',
        ),
      );
    }
    if (hasLoneSurrogate(dependency.versionRange) || hasForbiddenControl(dependency.versionRange)) {
      issues.push(
        issue(
          'TEXT_INVALID',
          `/dependencies/${index}/versionRange`,
          'Dependency ranges must be printable text.',
        ),
      );
    }
    issues.push(
      ...validateBoundedJson(dependency.parameterMapping ?? {}, {
        pointer: `/dependencies/${index}/parameterMapping`,
        rejectExecutableContent: true,
      }).issues,
    );
  });
  if (
    new Set(primitive.dependencies.map((dependency) => dependency.key)).size !==
    primitive.dependencies.length
  ) {
    issues.push(
      issue(
        'DEPENDENCY_DUPLICATE',
        '/dependencies',
        'Each dependency family may appear only once.',
      ),
    );
  }
  const parameterInspectionStart = issues.length;
  issues.push(
    ...validateBoundedJson(primitive.parameterSchema, {
      pointer: '/parameterSchema',
      rejectExecutableContent: true,
    }).issues,
  );
  const parameterStructureUnsafe = issues
    .slice(parameterInspectionStart)
    .some((entry) =>
      [
        'JSON_ARRAY_LIMIT_EXCEEDED',
        'JSON_DEPTH_EXCEEDED',
        'JSON_NODE_LIMIT_EXCEEDED',
        'JSON_PROPERTY_LIMIT_EXCEEDED',
      ].includes(entry.code),
    );
  issues.push(
    ...validateBoundedJson(primitive.defaults, {
      pointer: '/defaults',
      rejectExecutableContent: true,
    }).issues,
  );
  issues.push(
    ...validateBoundedJson(primitive.compatibility, {
      pointer: '/compatibility',
      rejectExecutableContent: true,
    }).issues,
  );
  issues.push(
    ...validateBoundedJson(primitive.visualHints, {
      pointer: '/visualHints',
      rejectExecutableContent: true,
    }).issues,
  );
  issues.push(
    ...validateBoundedJson(primitive.provenance, {
      pointer: '/provenance',
      rejectExecutableContent: true,
    }).issues,
  );
  if (!parameterStructureUnsafe) {
    inspectSchema(primitive.parameterSchema, '/parameterSchema', issues);
    localRefGraph(primitive.parameterSchema, issues);
  }
  try {
    const semanticBytes = Buffer.byteLength(
      JSON.stringify(primitiveSemanticDocument(primitive)),
      'utf8',
    );
    if (semanticBytes > 128 * 1024)
      issues.push(
        issue('PRIMITIVE_TOO_LARGE', '/', 'Primitive semantic content cannot exceed 128 KiB.'),
      );
  } catch {
    issues.push(
      issue('CANONICALIZATION_FAILED', '/', 'Primitive content is not canonical JSON data.'),
    );
  }
  if (
    primitive.parameterSchema.type !== 'object' ||
    primitive.parameterSchema.additionalProperties !== false
  ) {
    issues.push(
      issue(
        'PARAMETER_SCHEMA_ROOT_INVALID',
        '/parameterSchema',
        'Parameter schema must be a closed object schema.',
      ),
    );
  }

  if (issues.length === 0) {
    try {
      const ajv = new Ajv2020({ allErrors: true, coerceTypes: false, strict: true });
      addFormats(ajv);
      const validate = ajv.compile(primitive.parameterSchema);
      if (!validate(primitive.defaults)) issues.push(...ajvIssues(validate.errors));
    } catch {
      issues.push(
        issue(
          'PARAMETER_SCHEMA_INVALID',
          '/parameterSchema',
          'Parameter schema could not be compiled safely.',
        ),
      );
    }
  }
  let contentHash: string | null = null;
  if (issues.length === 0) {
    try {
      contentHash = primitiveContentHash(primitive);
    } catch {
      issues.push(
        issue('CANONICALIZATION_FAILED', '/', 'Primitive content is not canonical JSON data.'),
      );
    }
  }
  return { contentHash, issues: boundedIssues(issues), valid: issues.length === 0 };
}
