import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';

export type EconomyCursorResource =
  | 'assets'
  | 'businesses'
  | 'commerce-facilities'
  | 'commerce-inventories'
  | 'commerce-jobs'
  | 'commerce-listings'
  | 'commerce-offers'
  | 'commerce-recipes'
  | 'commerce-resources'
  | 'commerce-runs'
  | 'commerce-tax'
  | 'commerce-trades'
  | 'commerce-transactions'
  | 'commerce-workers'
  | 'employment-contracts'
  | 'offers'
  | 'transactions'
  | 'wallets';

export interface EconomyCursorPayload {
  filterHash: string;
  kind: 'economy-page-v1';
  position: string;
  resource: EconomyCursorResource;
  scopeHash: string;
  worldId: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function encodeEconomyCursor(payload: EconomyCursorPayload, secret: string): string {
  const encoded = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

export function decodeEconomyCursor(
  value: string,
  expected: Pick<EconomyCursorPayload, 'filterHash' | 'resource' | 'scopeHash' | 'worldId'>,
  secret: string,
): EconomyCursorPayload {
  if (value.length > 1_024) invalidCursor();
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) invalidCursor();
  const [encoded, signature] = parts as [string, string];
  const expectedSignature = createHmac('sha256', secret).update(encoded).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (
    supplied.toString('base64url') !== signature ||
    supplied.length !== expectedSignature.length ||
    !timingSafeEqual(supplied, expectedSignature)
  ) {
    invalidCursor();
  }
  let payload: unknown;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) invalidCursor();
    payload = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    invalidCursor();
  }
  if (!isPayload(payload)) invalidCursor();
  if (
    payload.filterHash !== expected.filterHash ||
    payload.resource !== expected.resource ||
    payload.scopeHash !== expected.scopeHash ||
    payload.worldId !== expected.worldId
  ) {
    invalidCursor();
  }
  return payload;
}

function isPayload(value: unknown): value is EconomyCursorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 6 &&
    candidate.kind === 'economy-page-v1' &&
    typeof candidate.filterHash === 'string' &&
    HASH.test(candidate.filterHash) &&
    typeof candidate.scopeHash === 'string' &&
    HASH.test(candidate.scopeHash) &&
    typeof candidate.worldId === 'string' &&
    UUID.test(candidate.worldId) &&
    typeof candidate.position === 'string' &&
    candidate.position.length >= 1 &&
    candidate.position.length <= 300 &&
    typeof candidate.resource === 'string' &&
    CURSOR_RESOURCES.has(candidate.resource)
  );
}

const CURSOR_RESOURCES: ReadonlySet<string> = new Set<EconomyCursorResource>([
  'assets',
  'businesses',
  'commerce-facilities',
  'commerce-inventories',
  'commerce-jobs',
  'commerce-listings',
  'commerce-offers',
  'commerce-recipes',
  'commerce-resources',
  'commerce-runs',
  'commerce-tax',
  'commerce-trades',
  'commerce-transactions',
  'commerce-workers',
  'employment-contracts',
  'offers',
  'transactions',
  'wallets',
]);

function invalidCursor(): never {
  throw new ApplicationError(
    'CURSOR_INVALID',
    'The economy cursor is invalid for this world, actor, resource, or filter.',
    400,
  );
}
