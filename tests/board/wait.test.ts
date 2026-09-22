import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appendMessage } from '../../src/board/messages.js';
import { waitForChange } from '../../src/board/wait.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

async function msgsDir(): Promise<string> {
  const dir = join(await tempRepo(), 'msgs');
  await mkdir(dir);
  return dir;
}

describe('waitForChange', () => {
  it('returns soon after a message lands', async () => {
    const dir = await msgsDir();
    const started = Date.now();
    setTimeout(() => {
      void appendMessage(dir, { id: 'a-1', ts: new Date().toISOString(), from: 'a', to: ['b'], text: 'hi' });
    }, 200);
    await waitForChange(dir, 5000);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns at the timeout when nothing happens', async () => {
    const dir = await msgsDir();
    const started = Date.now();
    await waitForChange(dir, 300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('returns at once when aborted', async () => {
    const dir = await msgsDir();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await waitForChange(dir, 5000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
