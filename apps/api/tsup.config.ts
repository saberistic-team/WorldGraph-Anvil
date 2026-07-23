import { defineConfig } from 'tsup';

export default defineConfig({
  banner: {
    js: "import { createRequire as __worldgraphCreateRequire } from 'node:module'; const require = __worldgraphCreateRequire(import.meta.url);",
  },
  clean: true,
  entry: ['src/index.ts'],
  format: ['esm'],
  noExternal: [/^@worldgraph\//],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
});
