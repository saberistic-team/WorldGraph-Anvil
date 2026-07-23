import { describe, expect, it } from 'vitest';

import { normalizeCreatorOverrideReason } from './validation.js';

describe('creator override validation', () => {
  it('trims a printable bounded reason', () => {
    expect(normalizeCreatorOverrideReason('  Administrator access was removed.  ')).toBe(
      'Administrator access was removed.',
    );
  });

  it.each(['          ', '   short   ', 'Valid reason\nwith a control'])(
    'rejects a non-printable or too-short reason: %j',
    (reason) => {
      expect(() => normalizeCreatorOverrideReason(reason)).toThrowError(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          statusCode: 400,
        }),
      );
    },
  );
});
