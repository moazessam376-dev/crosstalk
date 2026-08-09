import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('UI fixture packaging', () => {
  it('serves only the fixture directory and uses its root URL', async () => {
    const config = await readFile(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    const app = await readFile(resolve(process.cwd(), 'src', 'ui', 'App.tsx'), 'utf8');

    expect(config).toContain("publicDir: resolve(projectRoot, 'tests', 'fixtures')");
    expect(config).not.toMatch(/publicDir:\s*resolve\(projectRoot,\s*'tests'\s*\)/);
    expect(app).toContain("path: '/session-dispute.jsonl'");
  });
});
