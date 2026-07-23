import { describe, expect, it } from 'vitest';

import { decodeEconomyCursor, encodeEconomyCursor } from './cursor.js';

const expected = {
  filterHash: 'a'.repeat(64),
  resource: 'transactions' as const,
  scopeHash: 'b'.repeat(64),
  worldId: '018f8652-3cb6-7d52-904b-cce7901d7e25',
};
const secret = 'economy-cursor-secret-at-least-32-characters';

describe('economy cursor privacy boundary', () => {
  it('round-trips only for the exact world, actor scope, resource, and filter', () => {
    const cursor = encodeEconomyCursor(
      { ...expected, kind: 'economy-page-v1', position: '2026-07-22T00:00:00.000Z|id' },
      secret,
    );
    expect(decodeEconomyCursor(cursor, expected, secret).position).toContain('|id');
    expect(() =>
      decodeEconomyCursor(cursor, { ...expected, scopeHash: 'c'.repeat(64) }, secret),
    ).toThrow('invalid');
    expect(() => decodeEconomyCursor(cursor, { ...expected, resource: 'assets' }, secret)).toThrow(
      'invalid',
    );
  });

  it('rejects tampering, malformed encodings, and oversized cursors', () => {
    const cursor = encodeEconomyCursor(
      { ...expected, kind: 'economy-page-v1', position: 'asset:founding-seal' },
      secret,
    );
    expect(() => decodeEconomyCursor(`${cursor}x`, expected, secret)).toThrow('invalid');
    expect(() => decodeEconomyCursor('not-a-cursor', expected, secret)).toThrow('invalid');
    expect(() => decodeEconomyCursor('x'.repeat(1_025), expected, secret)).toThrow('invalid');
  });
});
