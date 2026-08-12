import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { commitOwnedPaths } from '../../src/workspace/submit.js';

/**
 * Approach C: agents edit in the repository root, and a submit is committed
 * through a throwaway worktree holding only the paths that agent owns.
 *
 * This is what makes one shared folder safe. Three agents in one working tree
 * share one `.git/index` and one `HEAD`, so if each ran `git commit` directly
 * they would race on both — and branch-per-task, which the review protocol and
 * the whole GitHub mirror are built on, would have to go. Committing somewhere
 * else keeps every one of those and confines the change to where a commit
 * physically happens.
 */

const execFile = promisify(execFileCallback);
const dirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function repoWithCommit(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-submit-'));
  dirs.push(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@crosstalk.invalid']);
  await git(repo, ['config', 'user.name', 'crosstalk test']);
  await writeFile(join(repo, 'README.md'), '# submit\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'initial']);
  return repo;
}

async function edit(repo: string, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), body, 'utf8');
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);

describe('committing a submit from a shared root', { timeout: 90_000 }, () => {
  it('commits the owned paths onto the task branch', async () => {
    const repo = await repoWithCommit();
    await edit(repo, 'src/metrics/collect.ts', 'export const collect = () => 1;\n');

    const result = await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    expect(result).toMatchObject({ files: ['src/metrics/collect.ts'] });
    expect(await git(repo, ['show', '--name-only', '--format=', 'ct/T-01-metrics']))
      .toContain('src/metrics/collect.ts');
  });

  it('leaves the shared working tree on its own branch, with its files intact', async () => {
    // The property the whole approach was chosen for: two agents submitting at
    // once must not move each other's HEAD or revert each other's edits. If
    // this fails, shared root is not safe and nothing else here matters.
    const repo = await repoWithCommit();
    const before = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    await edit(repo, 'src/metrics/collect.ts', 'export const collect = () => 1;\n');

    await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    expect(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(before);
    // Still present and still uncommitted in the root: the agent keeps working.
    expect(await readFile(join(repo, 'src/metrics/collect.ts'), 'utf8')).toContain('collect');
  });

  it('refuses and names the paths when the agent wrote outside its subtree', async () => {
    // Silently dropping them is the failure mode approach C was chosen against:
    // the agent believes it submitted and the work is nowhere.
    const repo = await repoWithCommit();
    await edit(repo, 'src/metrics/collect.ts', 'export const collect = () => 1;\n');
    await edit(repo, 'src/skeleton/frame.ts', 'export const frame = () => 2;\n');

    const result = await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    expect(result).toEqual({ refused: ['src/skeleton/frame.ts'] });
    // And nothing was committed — a refusal that half-commits is worse than
    // either outcome on its own.
    await expect(git(repo, ['rev-parse', '--verify', 'ct/T-01-metrics'])).rejects.toThrow();
  });

  it('carries a deletion, not only an edit', async () => {
    // An agent removing a file it owns is ordinary work. Copying only files
    // that exist would leave the deletion uncommitted and the branch wrong,
    // while reporting success.
    const repo = await repoWithCommit();
    await edit(repo, 'src/metrics/old.ts', 'export const old = () => 0;\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-qm', 'add old']);

    await rm(join(repo, 'src/metrics/old.ts'));

    const result = await commitOwnedPaths({
      repo, branch: 'ct/T-02-metrics', worktreeId: 'T-02',
      owns: ['src/metrics/'], message: 'T-02 remove old',
    });

    expect(result).toMatchObject({ files: ['src/metrics/old.ts'] });
    expect(await git(repo, ['show', '--name-status', '--format=', 'ct/T-02-metrics'])).toMatch(/^D\s+src\/metrics\/old\.ts/m);
  });

  it('adds to a branch that already exists rather than demanding a fresh one', async () => {
    // A task is submitted more than once — resubmission after review is the
    // normal path, not an edge case.
    const repo = await repoWithCommit();
    await edit(repo, 'src/metrics/collect.ts', 'first\n');
    await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'T-01',
      owns: ['src/metrics/'], message: 'first',
    });

    await edit(repo, 'src/metrics/collect.ts', 'second\n');
    const again = await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'T-01',
      owns: ['src/metrics/'], message: 'second',
    });

    expect(again).toMatchObject({ files: ['src/metrics/collect.ts'] });
    expect(await git(repo, ['log', '--format=%s', 'ct/T-01-metrics'])).toContain('second');
  });

  it('removes the throwaway worktree afterwards, including on refusal', async () => {
    const repo = await repoWithCommit();
    await edit(repo, 'src/skeleton/frame.ts', 'export const frame = () => 2;\n');

    await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    expect(await git(repo, ['worktree', 'list'])).not.toContain('T-01');
  });

  it('ignores Crosstalk\'s own state directory', async () => {
    // `.crosstalk/` holds the event log, the tokens and the lock, all churning
    // while the daemon runs and owned by nobody. Counting them as changed paths
    // put every submit outside every declaration and refused all of them — for
    // files the agent never touched.
    const repo = await repoWithCommit();
    await edit(repo, '.crosstalk/events.jsonl', '{"seq":1}\n');
    await edit(repo, '.crosstalk/tokens/codex', 'secret\n');
    await edit(repo, 'src/metrics/collect.ts', 'export const collect = () => 1;\n');

    const result = await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    expect(result).toMatchObject({ files: ['src/metrics/collect.ts'] });
  });

  it('commits nothing and refuses nothing when the agent changed no owned file', async () => {
    const repo = await repoWithCommit();

    const result = await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    expect(result).toMatchObject({ files: [] });
  });
});
