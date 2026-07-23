import { describe, expect, it } from 'vitest';

import { memberPrincipalKey, stableLogicalKey } from './keys.js';
import { DeterministicPrng } from './prng.js';

describe('deterministic compiler primitives', () => {
  it('matches the documented xorshift32 integer vector', () => {
    const generator = new DeterministicPrng('vector-seed');
    expect(Array.from({ length: 6 }, () => generator.nextUint32())).toEqual([
      984257171, 2011175695, 3837388975, 3961580377, 3627928700, 1476257797,
    ]);
    const bounded = new DeterministicPrng('bounded-seed');
    expect(Array.from({ length: 8 }, () => bounded.nextInt(7))).toEqual([3, 2, 5, 0, 6, 1, 2, 0]);
  });

  it('creates stable world-local pseudonyms and strict logical keys', () => {
    expect(
      memberPrincipalKey(
        '018f8652-3cb6-7d52-904b-cce7901d7e25',
        '018f8652-3cb6-7d52-904b-cce7901d7e26',
      ),
    ).toBe('member-d17cbdd8aaf6d32a418836431df47829');
    expect(stableLogicalKey('district', 'civic-platform')).toBe('district:civic-platform');
    expect(() => stableLogicalKey('district', 'Civic Platform')).toThrow(/stable identifiers/u);
  });
});
