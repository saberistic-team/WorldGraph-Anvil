const editorFields = new Set([
  'behaviorRef',
  'compatibility',
  'defaults',
  'displayName',
  'documentation',
  'key',
  'kind',
  'parameterSchema',
  'provenance',
  'tags',
  'version',
  'visualHints',
]);
const dependencyFields = new Set(['key', 'parameterMapping', 'required', 'versionRange']);

function decodePointerToken(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function fieldId(pointer: string): string {
  const tokens = pointer.split('/').slice(1).map(decodePointerToken);
  if (tokens[0] === 'draft') tokens.shift();
  if (tokens[0] === 'dependencies') {
    const index = tokens[1];
    const field = tokens[2];
    if (index && /^\d+$/u.test(index) && field && dependencyFields.has(field)) {
      return `dependency-${index}-${field}`;
    }
  }
  const root = tokens[0];
  return root && editorFields.has(root) ? `primitive-${root}` : 'primitive-editor';
}
