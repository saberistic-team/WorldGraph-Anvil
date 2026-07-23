import { createHash } from 'node:crypto';

import type { WorldRelationshipType } from '@worldgraph/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/u;

export function memberPrincipalKey(worldId: string, userId: string): string {
  if (!UUID.test(worldId) || !UUID.test(userId)) {
    throw new TypeError('World and user identifiers must be UUIDs.');
  }
  const digest = createHash('sha256')
    .update(`worldgraph-member-principal-v1\0${worldId.toLowerCase()}\0${userId.toLowerCase()}`)
    .digest('hex');
  return `member-${digest.slice(0, 32)}`;
}

export function stableLogicalKey(namespace: string, ...segments: readonly string[]): string {
  const values = [namespace, ...segments].map((value) => value.normalize('NFC'));
  if (values.length < 2 || values.some((value) => !SEGMENT.test(value))) {
    throw new TypeError('Logical key components must be lower-case stable identifiers.');
  }
  const key = values.join(':');
  if (key.length > 240) throw new TypeError('Logical key exceeds 240 characters.');
  return key;
}

export function stableRelationshipKey(type: WorldRelationshipType, semanticKey: string): string {
  return stableLogicalKey('rel', type, semanticKey);
}
