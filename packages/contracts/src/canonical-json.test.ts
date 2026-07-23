import { describe, expect, it } from 'vitest';

import { canonicalJson, canonicalJsonSha256 } from './canonical-json.js';

describe('canonical JSON', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"z":1}');
  });

  it('uses a stable SHA-256 vector', async () => {
    await expect(canonicalJsonSha256({ b: 2, a: 1 })).resolves.toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
  });

  it('sorts integer-like keys lexically and normalizes Unicode', () => {
    expect(canonicalJson({ 2: 'e\u0301', 10: 'ten' })).toBe('{"10":"ten","2":"é"}');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n])(
    'rejects non-JSON value %s',
    (value) => {
      expect(() => canonicalJson({ value })).toThrow(TypeError);
    },
  );
});
