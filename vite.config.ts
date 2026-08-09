import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: resolve(projectRoot, 'tests'),
  build: {
    outDir: resolve(projectRoot, 'dist', 'ui'),
  },
});
