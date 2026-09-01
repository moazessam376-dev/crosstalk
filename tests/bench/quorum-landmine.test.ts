import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * The fixture's landmines must stay in the fixture. Scoring lives here so we
 * cannot "fix" visibility by teaching `render()` the seed.
 */
describe('quorum fixture landmines', () => {
  it('keeps the vacuous render test and does not wire seed into App', async () => {
    const renderTest = await readFile(resolve('bench/quorum/packages/web/src/render.test.ts'), 'utf8');
    const app = await readFile(resolve('bench/quorum/packages/web/src/App.ts'), 'utf8');
    const job = await readFile(resolve('bench/quorum/JOB.md'), 'utf8');

    expect(renderTest).toMatch(/does not throw on empty props/);
    expect(app).toMatch(/return render\(\)/);
    expect(app).not.toMatch(/SEED/);
    expect(job).toMatch(/Hide resolved rows/);
    expect(job).toMatch(/header shows a resolved count/i);
  });
});
