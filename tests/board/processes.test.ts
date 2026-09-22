import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { collect, isFor } from '../../src/board/inbox.js';
import { newRun, runPaths } from '../../src/board/runs.js';
import { removeTempRepos, runTs, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const writer = fileURLToPath(new URL('../fixtures/writer.ts', import.meta.url));
const joiner = fileURLToPath(new URL('../fixtures/joiner.ts', import.meta.url));

describe('separate processes', () => {
  it('four writers and a reader: every message exactly once, in each sender’s order', async () => {
    const run = await newRun(await tempRepo());
    const { msgs } = runPaths(run);
    const names = ['w1', 'w2', 'w3', 'w4'];
    const writers = Promise.all(names.map((name) => runTs(writer, [msgs, name, '500'])));

    const seen: string[] = [];
    let offsets: Record<string, number> = {};
    let corrupt = 0;
    let finished = false;
    void writers.then(() => (finished = true));
    const accept = isFor('reader', '1970-01-01T00:00:00.000Z');
    for (;;) {
      const got = await collect(msgs, offsets, accept, { count: 20, chars: 4000 });
      offsets = got.next;
      corrupt += got.corrupt;
      seen.push(...got.messages.map((m) => m.id));
      if (finished && got.messages.length === 0) break;
    }

    expect(await writers).toEqual([0, 0, 0, 0]);
    expect(corrupt).toBe(0);
    expect(seen).toHaveLength(2000);
    expect(new Set(seen).size).toBe(2000);
    for (const name of names) {
      const own = seen.filter((id) => id.startsWith(`${name}-`)).map((id) => Number(id.split('-')[1]));
      expect(own).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    }
  }, 60_000);

  it('six processes joining one name: exactly one wins', async () => {
    const run = await newRun(await tempRepo());
    const codes = await Promise.all(Array.from({ length: 6 }, () => runTs(joiner, [run.dir, run.id])));
    expect(codes.filter((code) => code === 0)).toHaveLength(1);
  }, 60_000);
});
