import { describe, expect, it } from 'vitest';

import { unwrapPrimitive, type PrimitiveVersion } from './types';

const direct = {
  key: 'worldgraph.government.guild-council',
  version: '1.0.0',
} as PrimitiveVersion;

describe('unwrapPrimitive', () => {
  it('does not confuse a direct primitive SemVer string with an envelope', () => {
    expect(unwrapPrimitive(direct)).toBe(direct);
  });

  it('continues to accept legacy object envelopes', () => {
    expect(unwrapPrimitive({ primitive: direct })).toBe(direct);
    expect(unwrapPrimitive({ draft: direct })).toBe(direct);
    expect(unwrapPrimitive({ version: direct })).toBe(direct);
  });
});
