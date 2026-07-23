import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';

export interface HistoryCursorPayload {
  beforeLedgerSequence: string;
  filterHash: string;
  kind: 'world-history-v1';
  worldId: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SEQUENCE_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeHistoryCursor(payload: HistoryCursorPayload, secret: string): string {
  const encoded = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function decodeHistoryCursor(
  cursor: string,
  expectedWorldId: string,
  expectedFilterHash: string,
  secret: string,
): HistoryCursorPayload {
  if (cursor.length > 1_024) invalidCursor();
  const parts = cursor.split('.');
  const encoded = parts[0];
  const signature = parts[1];
  if (parts.length !== 2 || !encoded || !signature) invalidCursor();

  const expectedSignature = createHmac('sha256', secret).update(encoded).digest();
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(signature, 'base64url');
  } catch {
    invalidCursor();
  }
  if (
    suppliedSignature.toString('base64url') !== signature ||
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    invalidCursor();
  }

  let payload: unknown;
  try {
    const encodedPayload = Buffer.from(encoded, 'base64url');
    if (encodedPayload.toString('base64url') !== encoded) invalidCursor();
    payload = JSON.parse(encodedPayload.toString('utf8')) as unknown;
  } catch {
    invalidCursor();
  }
  if (!isHistoryCursorPayload(payload)) invalidCursor();
  if (payload.worldId !== expectedWorldId || payload.filterHash !== expectedFilterHash) {
    invalidCursor();
  }
  return payload;
}

function isHistoryCursorPayload(value: unknown): value is HistoryCursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 4 &&
    candidate.kind === 'world-history-v1' &&
    typeof candidate.worldId === 'string' &&
    UUID_PATTERN.test(candidate.worldId) &&
    typeof candidate.filterHash === 'string' &&
    HASH_PATTERN.test(candidate.filterHash) &&
    typeof candidate.beforeLedgerSequence === 'string' &&
    SEQUENCE_PATTERN.test(candidate.beforeLedgerSequence)
  );
}

function invalidCursor(): never {
  throw new ApplicationError(
    'CURSOR_INVALID',
    'The history cursor is invalid for this world or filter.',
    400,
  );
}
