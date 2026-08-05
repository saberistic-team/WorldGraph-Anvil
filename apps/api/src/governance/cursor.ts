import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';

export type GovernanceCursorResource =
  | 'audit'
  | 'candidacies'
  | 'elections'
  | 'institutions'
  | 'laws'
  | 'offices'
  | 'proposals'
  | 'terms';

interface GovernanceCursorPayload {
  actorScopeHash: string;
  kind: 'governance-page-v1';
  position: string;
  resource: GovernanceCursorResource;
  worldId: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESOURCES = new Set<GovernanceCursorResource>([
  'audit',
  'candidacies',
  'elections',
  'institutions',
  'laws',
  'offices',
  'proposals',
  'terms',
]);

export function encodeGovernanceCursor(payload: GovernanceCursorPayload, secret: string): string {
  const encoded = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

export function decodeGovernanceCursor(
  value: string,
  expected: Omit<GovernanceCursorPayload, 'kind' | 'position'>,
  secret: string,
): GovernanceCursorPayload {
  if (value.length > 1_024) invalidCursor();
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra) invalidCursor();
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
    payload.actorScopeHash !== expected.actorScopeHash ||
    payload.resource !== expected.resource ||
    payload.worldId !== expected.worldId
  ) {
    invalidCursor();
  }
  return payload;
}

function isPayload(value: unknown): value is GovernanceCursorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).length === 5 &&
    item.kind === 'governance-page-v1' &&
    typeof item.actorScopeHash === 'string' &&
    HASH.test(item.actorScopeHash) &&
    typeof item.worldId === 'string' &&
    UUID.test(item.worldId) &&
    typeof item.position === 'string' &&
    UUID.test(item.position) &&
    typeof item.resource === 'string' &&
    RESOURCES.has(item.resource as GovernanceCursorResource)
  );
}

function invalidCursor(): never {
  throw new ApplicationError(
    'CURSOR_INVALID',
    'The governance cursor is invalid for this world, actor, or resource.',
    400,
  );
}
