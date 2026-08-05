import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('production manifest generation wiring', () => {
  it('selects the reviewed plan-2 Harbor fallback for the disabled provider', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toContain('createDeterministicGovernedHarborCityFallback');
    expect(source).toContain('fallbackFactory: createDeterministicGovernedHarborCityFallback');
  });
});
