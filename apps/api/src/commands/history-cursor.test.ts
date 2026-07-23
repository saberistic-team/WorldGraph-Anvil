import { describe, expect, it } from 'vitest';

import { decodeHistoryCursor, encodeHistoryCursor } from './history-cursor.js';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e22';
const filterHash = 'a'.repeat(64);
const secret = 'history-cursor-secret-at-least-32-characters';

describe('history cursor', () => {
  it('round-trips only for its exact world and normalized filter', () => {
    const cursor = encodeHistoryCursor(
      { beforeLedgerSequence: '42', filterHash, kind: 'world-history-v1', worldId },
      secret,
    );

    expect(decodeHistoryCursor(cursor, worldId, filterHash, secret)).toEqual({
      beforeLedgerSequence: '42',
      filterHash,
      kind: 'world-history-v1',
      worldId,
    });
    expect(() =>
      decodeHistoryCursor(cursor, '028f8652-3cb6-7d52-904b-cce7901d7e22', filterHash, secret),
    ).toThrow(/invalid/iu);
    expect(() => decodeHistoryCursor(cursor, worldId, 'b'.repeat(64), secret)).toThrow(/invalid/iu);
  });

  it('rejects tampering and malformed or oversized values', () => {
    const cursor = encodeHistoryCursor(
      { beforeLedgerSequence: '42', filterHash, kind: 'world-history-v1', worldId },
      secret,
    );
    const [body, signature] = cursor.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const finalSignatureCharacter = signature!.at(-1)!;
    const nonCanonicalAlias = `${signature!.slice(0, -1)}${
      alphabet[alphabet.indexOf(finalSignatureCharacter) ^ 1]
    }`;

    expect(() => decodeHistoryCursor(`${body}x.${signature}`, worldId, filterHash, secret)).toThrow(
      /invalid/iu,
    );
    expect(Buffer.from(nonCanonicalAlias, 'base64url')).toEqual(
      Buffer.from(signature!, 'base64url'),
    );
    expect(() =>
      decodeHistoryCursor(`${body}.${nonCanonicalAlias}`, worldId, filterHash, secret),
    ).toThrow(/invalid/iu);
    expect(() =>
      decodeHistoryCursor(`${body}.${signature}.extra`, worldId, filterHash, secret),
    ).toThrow(/invalid/iu);
    expect(() => decodeHistoryCursor('malformed', worldId, filterHash, secret)).toThrow(
      /invalid/iu,
    );
    expect(() => decodeHistoryCursor('x'.repeat(1_025), worldId, filterHash, secret)).toThrow(
      /invalid/iu,
    );
  });
});
