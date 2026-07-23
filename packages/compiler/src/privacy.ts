import type { CompilerDiagnosticV1, CompilerStage } from '@worldgraph/contracts';

import { compilerDiagnostic, sortCompilerDiagnostics } from './diagnostics.js';

const forbiddenFieldNames = new Set([
  'actoruserid',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'csrf',
  'csrftoken',
  'email',
  'emailaddress',
  'invitationlink',
  'invitationtoken',
  'invitationurl',
  'invitelink',
  'invitetoken',
  'inviteurl',
  'ip',
  'ipaddress',
  'password',
  'passwordhash',
  'prompt',
  'prompttext',
  'providerpayload',
  'rawmodelresponse',
  'rawproviderresponse',
  'rawtoken',
  'requestedbyuserid',
  'secret',
  'session',
  'sessionid',
  'sessiontoken',
  'token',
  'useragent',
  'userid',
]);
const forbiddenFieldTokens = new Set([
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'csrf',
  'email',
  'invitation',
  'invite',
  'ip',
  'password',
  'prompt',
  'secret',
  'session',
  'token',
]);
const forbiddenNormalizedPrefixes = [
  'apikey',
  'csrf',
  'email',
  'invitation',
  'invite',
  'ipaddress',
  'password',
  'prompt',
  'providerpayload',
  'rawmodel',
  'rawprovider',
  'rawtoken',
  'secret',
  'session',
  'useragent',
  'userid',
] as const;
const forbiddenNormalizedSuffixes = ['credential', 'credentials', 'secret', 'token'] as const;

const credentialPattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bbearer\s+[A-Z0-9._~+/=-]{12,}|\beyJ[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}|\b(?:sk|pk)_(?:live|test)_[A-Z0-9_-]{8,}|\b(?:api[_-]?key|authorization|csrf(?:[_-]?token)?|invite(?:[_-]?(?:link|token|url))?|invitation(?:[_-]?(?:link|token|url))?|password|prompt(?:[_-]?text)?|raw[_-]?(?:model|provider)[_-]?response|raw[_-]?token|secret|session(?:[_-]?(?:id|token))?)\s*[:=]\s*\S{4,})/iu;
const invitationUrlPattern = /https?:\/\/\S*\/invitations?\/\S*(?:[#?&][^\s]*)?/iu;
const ipv4CandidatePattern = /(?:^|[^0-9])(\d{1,3}(?:\.\d{1,3}){3})(?![0-9])/gu;

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

function privateFieldName(value: string): boolean {
  const normalized = normalizedFieldName(value);
  if (
    forbiddenFieldNames.has(normalized) ||
    forbiddenNormalizedPrefixes.some((prefix) => normalized.startsWith(prefix)) ||
    forbiddenNormalizedSuffixes.some((suffix) => normalized.endsWith(suffix))
  ) {
    return true;
  }
  const tokens = value
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return (
    tokens.some((token) => forbiddenFieldTokens.has(token)) ||
    tokens.some((token, index) => token === 'api' && tokens[index + 1] === 'key') ||
    tokens.some((token, index) => token === 'user' && tokens[index + 1] === 'id')
  );
}

function isReviewedHashProvenanceField(key: string, value: unknown): boolean {
  return (
    normalizedFieldName(key) === 'prompthash' &&
    typeof value === 'string' &&
    /^[a-f0-9]{64}$/u.test(value)
  );
}

function isEmailLocalCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code > 32 && code !== 127 && value !== '@' && !'<>()[\\],;:"'.includes(value);
}

function isEmailDomainCharacter(value: string): boolean {
  return isEmailLocalCharacter(value) && !"!#$%&'*+/=?^_`{|}~".includes(value);
}

function containsEmail(value: string): boolean {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const at = value.indexOf('@', searchFrom);
    if (at < 0) return false;
    let localStart = at;
    while (
      localStart > 0 &&
      at - localStart < 64 &&
      isEmailLocalCharacter(value[localStart - 1]!)
    ) {
      localStart -= 1;
    }
    const local = value.slice(localStart, at);
    let domainEnd = at + 1;
    while (
      domainEnd < value.length &&
      domainEnd - at <= 255 &&
      isEmailDomainCharacter(value[domainEnd]!)
    ) {
      domainEnd += 1;
    }
    const domain = value.slice(at + 1, domainEnd);
    const labels = domain.split('.');
    if (
      local.length > 0 &&
      !local.startsWith('.') &&
      !local.endsWith('.') &&
      !local.includes('..') &&
      labels.length >= 2 &&
      labels.every(
        (label) =>
          label.length >= 1 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'),
      )
    ) {
      return true;
    }
    searchFrom = at + 1;
  }
  return false;
}

function containsIpv4(value: string): boolean {
  ipv4CandidatePattern.lastIndex = 0;
  for (const match of value.matchAll(ipv4CandidatePattern)) {
    const candidate = match[1];
    if (candidate?.split('.').every((part) => Number(part) <= 255)) return true;
  }
  return false;
}

function isIpv6Candidate(candidate: string): boolean {
  if (!candidate.includes(':') || candidate.length > 45) return false;
  const compression = candidate.indexOf('::');
  if (compression !== candidate.lastIndexOf('::')) return false;
  const segments = candidate.split(':');
  if (segments.some((segment) => segment.length > 4 || !/^[a-f0-9]*$/iu.test(segment))) {
    return false;
  }
  if (compression >= 0) {
    const populated = segments.filter(Boolean).length;
    return populated < 8;
  }
  return segments.length === 8 && segments.every((segment) => segment.length > 0);
}

function containsIpv6(value: string): boolean {
  return value
    .split(/[^a-f0-9:]+/iu)
    .filter((candidate) => candidate.includes(':'))
    .some(isIpv6Candidate);
}

function stringFinding(value: string): { code: string; message: string } | null {
  if (containsEmail(value)) {
    return {
      code: 'PRIVATE_EMAIL_DETECTED',
      message: 'Compiler input and artifacts cannot contain an email address.',
    };
  }
  if (containsIpv4(value) || containsIpv6(value)) {
    return {
      code: 'PRIVATE_NETWORK_ADDRESS_DETECTED',
      message: 'Compiler input and artifacts cannot contain an IP address.',
    };
  }
  if (credentialPattern.test(value) || invitationUrlPattern.test(value)) {
    return {
      code: 'PRIVATE_CREDENTIAL_CONTENT_DETECTED',
      message:
        'Compiler input and artifacts cannot contain credential, session, invitation, prompt, or provider payload material.',
    };
  }
  return null;
}

function inspect(
  value: unknown,
  pointer: string,
  stage: CompilerStage,
  diagnostics: CompilerDiagnosticV1[],
): void {
  if (diagnostics.length >= 128) return;
  if (typeof value === 'string') {
    const finding = stringFinding(value);
    if (finding)
      diagnostics.push(compilerDiagnostic(stage, finding.code, pointer, finding.message));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${pointer}/${index}`, stage, diagnostics));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value).sort()) {
    const childPointer = `${pointer}/${pointerToken(key)}`;
    const childValue = (value as Record<string, unknown>)[key];
    const keyFinding = stringFinding(key);
    const diagnosticPointer = keyFinding ? `${pointer}/<private-key>` : childPointer;
    if (keyFinding) {
      diagnostics.push(
        compilerDiagnostic(stage, keyFinding.code, diagnosticPointer, keyFinding.message),
      );
    }
    if (!isReviewedHashProvenanceField(key, childValue) && privateFieldName(key)) {
      diagnostics.push(
        compilerDiagnostic(
          stage,
          'PRIVATE_FIELD_NAME_DETECTED',
          diagnosticPointer,
          'Compiler input and artifacts cannot contain private or credential-bearing fields.',
        ),
      );
    }
    inspect(childValue, diagnosticPointer, stage, diagnostics);
    if (diagnostics.length >= 128) return;
  }
}

/** Deterministic, value-redacting privacy inspection shared by compile and verify boundaries. */
export function validateCompilerPrivateContent(
  value: unknown,
  pointer: string,
  stage: CompilerStage,
): CompilerDiagnosticV1[] {
  const diagnostics: CompilerDiagnosticV1[] = [];
  inspect(value, pointer, stage, diagnostics);
  return sortCompilerDiagnostics(diagnostics);
}
