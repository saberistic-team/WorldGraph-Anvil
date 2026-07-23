const emailPattern =
  /(?:^|[\s(<[{])[^\s@<>()[\],;:"]{1,64}@[a-z0-9\p{L}](?:[a-z0-9\p{L}-]{0,61}[a-z0-9\p{L}])?(?:\.[a-z0-9\p{L}](?:[a-z0-9\p{L}-]{0,61}[a-z0-9\p{L}])?)+(?:$|[\s)>}\],.!?;:])/iu;
const credentialPattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bbearer\s+[A-Z0-9._~+/=-]{12,}|\beyJ[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}|\b(?:sk|pk)_(?:live|test)_[A-Z0-9_-]{8,}|\b(?:api[_-]?key|authorization|csrf(?:[_-]?token)?|invite(?:[_-]?(?:link|token|url))?|invitation(?:[_-]?(?:link|token|url))?|password|prompt(?:[_-]?text)?|raw[_-]?(?:model|provider)[_-]?response|raw[_-]?token|secret|session(?:[_-]?(?:id|token))?)\s*[:=]\s*\S{4,})/iu;
const invitationUrlPattern = /https?:\/\/\S*\/invitations?\/\S*(?:[#?&][^\s]*)?/iu;
const ipv4CandidatePattern = /(?:^|[^0-9])(\d{1,3}(?:\.\d{1,3}){3})(?![0-9])/gu;

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
  return compression >= 0
    ? segments.filter(Boolean).length < 8
    : segments.length === 8 && segments.every((segment) => segment.length > 0);
}

function containsIpv6(value: string): boolean {
  return value
    .split(/[^a-f0-9:]+/iu)
    .filter((candidate) => candidate.includes(':'))
    .some(isIpv6Candidate);
}

/** Prevents entity renames from introducing the private content forbidden at compilation. */
export function isLedgerPublicTextSafeV1(value: string): boolean {
  return (
    !emailPattern.test(` ${value} `) &&
    !containsIpv4(value) &&
    !containsIpv6(value) &&
    !credentialPattern.test(value) &&
    !invitationUrlPattern.test(value)
  );
}
