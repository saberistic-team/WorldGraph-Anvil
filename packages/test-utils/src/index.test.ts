import { describe, expect, it } from 'vitest';

import { FixedClock, SequenceIdGenerator, XorShift32 } from './index.js';

describe('deterministic test utilities', () => {
  it('controls time and identifiers', () => {
    const clock = new FixedClock(new Date('2026-07-21T00:00:00.000Z'));
    const ids = new SequenceIdGenerator(['first', 'second']);
    clock.advance(1_000);
    expect(clock.now().toISOString()).toBe('2026-07-21T00:00:01.000Z');
    expect([ids.next(), ids.next()]).toEqual(['first', 'second']);
  });

  it('uses a stable seeded random vector', () => {
    const random = new XorShift32(42);
    expect([random.next(), random.next(), random.next()]).toEqual([
      0.002643892541527748, 0.660311977379024, 0.11095708678476512,
    ]);
  });
});
