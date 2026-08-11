import { describe, it, expect } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runInit, purgeWorkspaces } from '../../src/cli/init.js';

const execFile = promisify(execFileCallback);

/**
 * Real git, a dozen subprocesses per case — the same reason
 * `front-door.test.ts` raises its own ceiling. AGENTS.md forbids mocking git.
 */
const GIT_TEST_TIMEOUT = 45_000;

/**
 * CT-12, reproduced.
 *
 * `purgeWorkspaces` removes a worker's worktree and prunes the administrative
 * entry but leaves `ct/<id>-base` pointing at whatever it last held. A later
 * `init` finds the branch alive and its fallback checks a worktree out onto it —
 * at the old commit, silently, with `doctor` reporting nothing because the
 * config it validates is perfectly correct.
 *
 * On the machine where this was found the consequence was concrete: the stale
 * commit still carried the *old* tracked brief, so each worker worktree held two
 * briefs disagreeing about who the agent was, one of them saying it was the
 * leader.
 */
async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd: repo, windowsHide: true });
  return stdout.trim();
}

async function repoOn(branch: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-fresh-'));
  await git(repo, ['init', '-q', '-b', branch, '.']);
  await git(repo, ['config', 'user.email', 'test@crosstalk.invalid']);
  await git(repo, ['config', 'user.name', 'crosstalk test']);
  await writeFile(join(repo, 'FILE.md'), 'v1\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'initial']);
  return repo;
}

async function commitOnto(repo: string, content: string): Promise<string> {
  await writeFile(join(repo, 'FILE.md'), `${content}\n`, 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', `change ${content}`]);
  return git(repo, ['rev-parse', 'HEAD']);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

const WORKER = 'codex';

async function initialise(repo: string, force = false): ReturnType<typeof runInit> {
  return runInit({ repo, participants: [], force });
}

describe('init refuses to hand a worker a stale checkout', () => {
  it(
    'rebuilds the worktree at the main branch after a purge, not at the old base',
    async () => {
      const repo = await repoOn('main');
      await initialise(repo);
      await purgeWorkspaces(repo);

      // Main moves on while the worker's base branch stays where it was.
      await commitOnto(repo, 'v2');
      await commitOnto(repo, 'v3');
      const head = await commitOnto(repo, 'v4');

      await initialise(repo, true);

      const worktree = join(repo, '.crosstalk', 'worktrees', WORKER);
      expect(await git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
      // The commit is the mechanism; the file is what a worker actually reads.
      expect(await readFile(join(worktree, 'FILE.md'), 'utf8')).toContain('v4');
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    'refuses when the base branch has diverged, and keeps the work on it',
    async () => {
      // Built directly rather than via a purge: `down --purge` now deletes the
      // branch it created, so the diverged state has to arrive some other way —
      // a base branch left by an interrupted run, or one a worker pushed to.
      const repo = await repoOn('main');
      await git(repo, ['checkout', '-q', '-b', `ct/${WORKER}-base`]);
      const divergent = await commitOnto(repo, 'worker-only');
      await git(repo, ['checkout', '-q', 'main']);
      await commitOnto(repo, 'v2');

      await expect(initialise(repo)).rejects.toThrow(new RegExp(`ct/${WORKER}-base`));

      // Refusing is only correct if it actually refuses: the worktree must not
      // exist and the divergent commit must still be reachable.
      expect(await exists(join(repo, '.crosstalk', 'worktrees', WORKER))).toBe(false);
      expect(await git(repo, ['rev-parse', `ct/${WORKER}-base`])).toBe(divergent);
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    'writes nothing when it refuses, so init can be run again',
    async () => {
      // The refusal happens in the pre-write pass. `runInit` writes
      // crosstalk.yaml and mints tokens before it ever touches a worktree, so a
      // throw from the worktree stage would strand a repo that `init` then
      // refuses to re-enter without --force.
      const repo = await repoOn('main');
      await git(repo, ['branch', `ct/${WORKER}-base`]);
      await git(repo, ['checkout', '-q', `ct/${WORKER}-base`]);
      await commitOnto(repo, 'worker-only');
      await git(repo, ['checkout', '-q', 'main']);
      await commitOnto(repo, 'v2');

      await expect(initialise(repo)).rejects.toThrow(new RegExp(`ct/${WORKER}-base`));

      expect(await exists(join(repo, 'crosstalk.yaml'))).toBe(false);
      expect(await exists(join(repo, '.crosstalk', 'tokens'))).toBe(false);
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    'leaves no ct/*-base branch behind after down --purge',
    async () => {
      const repo = await repoOn('main');
      await initialise(repo);
      expect(await git(repo, ['branch', '--list', `ct/${WORKER}-base`])).not.toBe('');

      await purgeWorkspaces(repo);

      expect(await git(repo, ['branch', '--list', `ct/${WORKER}-base`])).toBe('');
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    'initialises a repository whose main branch is not called main',
    async () => {
      // `isAncestor` rethrows anything that is not exit code 1, and git exits
      // 128 for an unknown revision. Reaching for `main` on a `master` clone
      // would turn init into a raw stack trace.
      const repo = await repoOn('master');
      await expect(initialise(repo)).resolves.toBeDefined();
    },
    GIT_TEST_TIMEOUT,
  );
});
