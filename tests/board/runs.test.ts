import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BoardError } from '../../src/board/fsutil.js';
import { currentRun, ensureRun, findRoot, listRuns, newRun, openRun, runId, runPaths, stateDir } from '../../src/board/runs.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

describe('runId', () => {
  it('formats local time and an optional label', () => {
    const now = new Date(2026, 8, 22, 21, 5, 9);
    expect(runId(now)).toBe('20260922-210509');
    expect(runId(now, 'geekfarm')).toBe('20260922-210509-geekfarm');
  });
});

describe('runs', () => {
  it('newRun creates the run folders and points current at it', async () => {
    const root = await tempRepo();
    const run = await newRun(root, 'trial');
    const paths = runPaths(run);
    expect(existsSync(paths.msgs) && existsSync(paths.agents) && existsSync(paths.hooks)).toBe(true);
    expect((await currentRun(root))?.id).toBe(run.id);
  });

  it('gives two runs started in the same second different ids', async () => {
    const root = await tempRepo();
    const now = new Date(2026, 8, 22, 21, 5, 9);
    const a = await newRun(root, undefined, now);
    const b = await newRun(root, undefined, now);
    expect(a.id).toBe('20260922-210509');
    expect(b.id).toBe('20260922-210509-2');
    expect((await currentRun(root))?.id).toBe(b.id);
  });

  it('ensureRun called concurrently settles on one run', async () => {
    const root = await tempRepo();
    const runs = await Promise.all([ensureRun(root), ensureRun(root), ensureRun(root)]);
    expect(new Set(runs.map((run) => run.id)).size).toBe(1);
    expect(await readdir(join(stateDir(root), 'runs'))).toEqual([runs[0]!.id]);
  });

  it('ensureRun starts a fresh run when current points at a deleted one', async () => {
    const root = await tempRepo();
    const old = await newRun(root, 'old');
    await rm(old.dir, { recursive: true });
    const fresh = await ensureRun(root);
    expect(fresh.id).not.toBe(old.id);
    expect((await currentRun(root))?.id).toBe(fresh.id);
  });

  it('refuses a bad label and a run id that escapes the runs folder', async () => {
    const root = await tempRepo();
    await expect(newRun(root, 'Bad Label')).rejects.toThrow(BoardError);
    await expect(openRun(root, '../../etc')).rejects.toThrow(/not a run id/);
    await expect(openRun(root, '20990101-000000')).rejects.toThrow(/no run/);
  });

  it('listRuns is empty before any run and sorted after', async () => {
    const root = await tempRepo();
    expect(await listRuns(root)).toEqual([]);
    await newRun(root, 'b', new Date(2026, 0, 2));
    await newRun(root, 'a', new Date(2026, 0, 1));
    expect(await listRuns(root)).toEqual(['20260101-000000-a', '20260102-000000-b']);
  });
});

describe('findRoot', () => {
  it('walks up to the directory holding .git', async () => {
    const root = await tempRepo();
    const deep = join(root, 'src', 'game');
    await mkdir(deep, { recursive: true });
    expect(findRoot(deep)).toBe(root);
  });

  it('treats a .git file (a worktree) as a root too', async () => {
    const root = await tempRepo();
    const tree = join(root, 'wt');
    await mkdir(tree);
    await writeFile(join(tree, '.git'), 'gitdir: elsewhere\n');
    expect(findRoot(tree)).toBe(tree);
  });
});
