import { describe, expect, it } from 'vitest';

import { sanitizedIndexError } from './diagnostics';

describe('primitive index diagnostics', () => {
  it('shows bounded stable codes and redacts arbitrary provider text', () => {
    expect(sanitizedIndexError('PROVIDER_TIMEOUT')).toBe('PROVIDER_TIMEOUT');
    expect(sanitizedIndexError('<img src=x onerror=alert(1)> provider secret')).toBe(
      'INDEX_FAILURE_REDACTED',
    );
    expect(sanitizedIndexError(null)).toBeNull();
  });
});
