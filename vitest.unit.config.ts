import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    environment: 'node',
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/.next/**', '**/dist/**'],
    include: ['**/*.test.ts', '**/*.test.tsx'],
    passWithNoTests: false,
    reporters: ['default'],
    testTimeout: 30_000,
  },
});
