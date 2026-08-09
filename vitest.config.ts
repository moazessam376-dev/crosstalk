import { defineConfig } from 'vitest/config';

// UI tests opt into jsdom per-file with `// @vitest-environment jsdom`,
// so Track B never has to edit this file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    reporters: 'default',
  },
});
