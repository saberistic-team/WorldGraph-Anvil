import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['**/*.integration.test.ts'],
    pool: 'forks',
    reporters: ['default'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
