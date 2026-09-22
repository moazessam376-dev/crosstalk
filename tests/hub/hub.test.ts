import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { currentRun, runPaths } from '../../src/board/runs.js';
import { PAGE } from '../../src/hub/page.js';
import { startHub, type Hub } from '../../src/hub/server.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

const hubs: Hub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  await removeTempRepos();
});

async function open(): Promise<{ root: string; base: string; cookie: string }> {
  const root = await tempRepo();
  const hub = await startHub(root);
  hubs.push(hub);
  const login = await fetch(hub.url, { redirect: 'manual' });
  expect(login.status).toBe(302);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { root, base: new URL(hub.url).origin, cookie };
}

describe('hub', () => {
  it('refuses a browser without the token', async () => {
    const root = await tempRepo();
    const hub = await startHub(root);
    hubs.push(hub);
    const response = await fetch(new URL(hub.url).origin);
    expect(response.status).toBe(403);
  });

  it('streams messages as they are written', async () => {
    const { root, base, cookie } = await open();
    const board = new Board(root);
    await board.join('orchestrator');
    await board.send('orchestrator', 'all', 'before connecting');
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { headers: { cookie }, signal: controller.signal });
    const reader = response.body!.getReader();
    setTimeout(() => void board.send('orchestrator', 'all', 'after connecting'), 200);
    let seen = '';
    while (!seen.includes('after connecting')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(seen).toContain('"text":"before connecting"');
    expect(seen).toContain('"text":"after connecting"');
  });

  it('sends as human', async () => {
    const { root, base, cookie } = await open();
    const board = new Board(root);
    await board.join('builder-1');
    const response = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'builder-1', text: 'check the dock' }),
    });
    expect(response.status).toBe(200);
    const run = await currentRun(root);
    expect(await readFile(join(runPaths(run!).msgs, 'human.jsonl'), 'utf8')).toContain('check the dock');
    expect((await board.inbox('builder-1')).text).toMatch(/human: check the dock$/);
  });

  it('answers a bad send with the reason', async () => {
    const { base, cookie } = await open();
    const response = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'all, builder-1', text: 'x' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/not both/);
  });

  it('lists runs', async () => {
    const { root, base, cookie } = await open();
    await new Board(root).join('builder-1');
    const body = (await (await fetch(`${base}/api/runs`, { headers: { cookie } })).json()) as { current: string; runs: string[] };
    expect(body.runs).toEqual([body.current]);
  });

  it('renders message text as text, never as HTML', () => {
    expect(PAGE).toContain('textContent');
    expect(PAGE).not.toContain('innerHTML');
  });
});
