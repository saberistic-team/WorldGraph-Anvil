import { describe, expect, it } from 'vitest';

import { decodeGovernanceCursor, encodeGovernanceCursor } from './cursor.js';

const actorScopeHash = 'a'.repeat(64);
const worldId = '018f0000-0000-7000-8000-000000000001';
const position = '018f0000-0000-7000-8000-000000000002';

describe('governance page cursors', () => {
  it('round trips only for the exact actor, world, and resource scope', () => {
    const cursor = encodeGovernanceCursor(
      {
        actorScopeHash,
        kind: 'governance-page-v1',
        position,
        resource: 'proposals',
        worldId,
      },
      'cursor-secret',
    );

    expect(
      decodeGovernanceCursor(
        cursor,
        { actorScopeHash, resource: 'proposals', worldId },
        'cursor-secret',
      ),
    ).toMatchObject({ position });
    expect(() =>
      decodeGovernanceCursor(
        cursor,
        { actorScopeHash: 'b'.repeat(64), resource: 'proposals', worldId },
        'cursor-secret',
      ),
    ).toThrow(/invalid/u);
    expect(() =>
      decodeGovernanceCursor(
        cursor,
        { actorScopeHash, resource: 'elections', worldId },
        'cursor-secret',
      ),
    ).toThrow(/invalid/u);
  });

  it('rejects tampering and non-canonical encodings', () => {
    const cursor = encodeGovernanceCursor(
      {
        actorScopeHash,
        kind: 'governance-page-v1',
        position,
        resource: 'audit',
        worldId,
      },
      'cursor-secret',
    );
    expect(() =>
      decodeGovernanceCursor(
        `${cursor.slice(0, -1)}x`,
        { actorScopeHash, resource: 'audit', worldId },
        'cursor-secret',
      ),
    ).toThrow(/invalid/u);
    expect(() =>
      decodeGovernanceCursor(
        cursor,
        { actorScopeHash, resource: 'audit', worldId },
        'wrong-secret',
      ),
    ).toThrow(/invalid/u);
  });
});
