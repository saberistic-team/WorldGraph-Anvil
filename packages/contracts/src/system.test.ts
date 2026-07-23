import { describe, expect, it } from 'vitest';

import { ReadyResponseSchema, type ReadyResponse } from './system.js';
import { createValidator } from './validation.js';

describe('system contracts', () => {
  const validator = createValidator<ReadyResponse>(ReadyResponseSchema);

  it('accepts a complete ready response', () => {
    expect(
      validator.is({
        checkedAt: '2026-07-21T12:00:00.000Z',
        components: [
          { name: 'api', status: 'healthy' },
          { name: 'postgresql', status: 'healthy' },
          { name: 'redis', status: 'healthy' },
          { name: 'worker', status: 'healthy' },
        ],
        status: 'ready',
      }),
    ).toBe(true);
  });

  it('rejects unrecognized infrastructure detail', () => {
    expect(
      validator.is({
        checkedAt: '2026-07-21T12:00:00.000Z',
        components: [],
        host: 'postgres.internal',
        status: 'ready',
      }),
    ).toBe(false);
  });
});
