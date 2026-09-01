import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * The fixture's landmines must stay in the fixture. Scoring lives here so we
 * cannot "fix" visibility by teaching `createScene()` to invent a boat.
 */
describe('leeward fixture landmines', () => {
  it('keeps the vacuous scene test and does not wire the school into the scene', async () => {
    const sceneTest = await readFile(resolve('bench/leeward/src/scene.test.ts'), 'utf8');
    const scene = await readFile(resolve('bench/leeward/src/scene.ts'), 'utf8');
    const main = await readFile(resolve('bench/leeward/src/main.ts'), 'utf8');
    const job = await readFile(resolve('bench/leeward/JOB.md'), 'utf8');

    expect(sceneTest).toMatch(/does not throw on an empty mount/);
    expect(scene).toMatch(/LANDMINE/);
    expect(scene).not.toMatch(/SCHOOL/);
    expect(scene).not.toMatch(/from ['"]\.\/school/);
    expect(main).toMatch(/createScene/);
    expect(job).toMatch(/camera is locked on the boat from the first frame/i);
    expect(job).toMatch(/still wide shot with no boat until the player/i);
    expect(job).toMatch(/Wind.*gust/i);
  });
});
