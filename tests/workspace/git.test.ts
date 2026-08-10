import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  branchSha,
  commitExists,
  createWorktree,
  gitVersion,
  headSha,
  isAncestor,
  isRepo,
  listWorktrees,
  removeWorktree,
} from '../../src/workspace/git.js';

const execFile = promisify(execFileCallback);
const temporaryRepositories: string[] = [];
const temporaryWorktrees: { repo: string; id: string }[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function tempRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'crosstalk-git-'));
  temporaryRepositories.push(repo);

  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Crosstalk Tests']);
  await git(repo, ['config', 'user.email', 'tests@crosstalk.invalid']);
  await writeFile(join(repo, 'README.md'), 'first\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'first']);
  await git(repo, ['branch', '-M', 'main']);
  await writeFile(join(repo, 'README.md'), 'second\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'second']);

  return repo;
}

async function commitEmpty(repo: string, message: string): Promise<void> {
  await git(repo, ['commit', '--allow-empty', '-m', message]);
}

async function commitOnOrphanBranch(repo: string): Promise<string> {
  await git(repo, ['checkout', '--orphan', 'orphan']);
  await git(repo, ['read-tree', '--empty']);
  await writeFile(join(repo, 'orphan.txt'), 'orphan\n', 'utf8');
  await git(repo, ['add', 'orphan.txt']);
  await git(repo, ['commit', '-m', 'orphan']);
  const orphan = await git(repo, ['rev-parse', 'HEAD']);
  await rm(join(repo, 'README.md'), { force: true });
  await git(repo, ['checkout', 'main']);
  return orphan;
}

afterEach(async () => {
  for (const { repo, id } of temporaryWorktrees.splice(0)) {
    try {
      await removeWorktree(repo, id);
    } catch {
      // The worktree may not have been created, or the test may have removed it.
    }
  }
  while (temporaryRepositories.length > 0) {
    const repo = temporaryRepositories.pop();
    if (repo !== undefined) {
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}, 60_000);

describe('git workspace lifecycle', () => {
  it('creates a worktree at the expected path and branch', async () => {
    const repo = await tempRepo();
    const worktree = await createWorktree(repo, 'codex', 'ct/T-1-log');
    temporaryWorktrees.push({ repo, id: 'codex' });

    expect(await gitVersion(repo)).toMatch(/^git version /);
    expect(await isRepo(worktree)).toBe(true);
    expect((await listWorktrees(repo)).some((w) => w.branch === 'ct/T-1-log')).toBe(true);
    expect((await readFile(join(worktree, 'README.md'), 'utf8')).replaceAll('\r\n', '\n')).toBe('second\n');
  }, 60_000);

  it('removes a worktree it created', async () => {
    const repo = await tempRepo();
    await createWorktree(repo, 'codex', 'ct/T-1-log');
    temporaryWorktrees.push({ repo, id: 'codex' });

    await removeWorktree(repo, 'codex');
    temporaryWorktrees.pop();

    expect((await listWorktrees(repo)).some((w) => w.path.includes('codex'))).toBe(false);
  }, 60_000);

  it('detects a non-ancestor sha after a divergent commit', async () => {
    const repo = await tempRepo();
    const old = await headSha(repo);
    await commitEmpty(repo, 'second');

    expect(await isAncestor(old, await headSha(repo), repo)).toBe(true);

    const orphan = await commitOnOrphanBranch(repo);
    expect(await isAncestor(orphan, await headSha(repo), repo)).toBe(false);
  }, 60_000);
});

/**
 * A5: staleness is measured against the head of `project.mainBranch`, and
 * `headSha` answers about whatever is checked out. The daemon runs from the
 * repository root, but nothing pins that checkout to the main branch — and on
 * a linked worktree it is guaranteed not to be — so `rev-parse HEAD` compares
 * evidence against the wrong commit.
 */
describe('branchSha', () => {
  it('answers for the named branch, not for whatever is checked out', async () => {
    const repo = await tempRepo();
    const mainTip = await git(repo, ['rev-parse', 'main']);
    await git(repo, ['checkout', '-b', 'work']);
    await commitEmpty(repo, 'work in progress');
    const workTip = await git(repo, ['rev-parse', 'HEAD']);

    // The setup is only meaningful while the two disagree.
    expect(workTip).not.toBe(mainTip);
    expect(await headSha(repo)).toBe(workTip);
    expect(await branchSha(repo, 'main')).toBe(mainTip);
  }, 60_000);

  it('names the branch it could not find', async () => {
    const repo = await tempRepo();
    await expect(branchSha(repo, 'trunk')).rejects.toThrow(/trunk/);
  }, 60_000);
});

describe('commitExists', () => {
  it('separates a commit this repository has from one it has never heard of', async () => {
    const repo = await tempRepo();

    expect(await commitExists(await headSha(repo), repo)).toBe(true);
    // Well-formed, and not an object here: the shape a pruned or
    // never-pushed evidence sha has by the time the daemon re-checks it.
    expect(await commitExists('0123456789abcdef0123456789abcdef01234567', repo)).toBe(false);
  }, 60_000);
});

/**
 * B-1: every worktree `init` creates carries an untracked file by construction
 * — `init` writes the participant's brief into it, and B3 adds `.mcp.json`.
 * `git worktree remove` refuses those without `--force`, so `down --purge`
 * could not remove a single worktree the product had made.
 */
describe('removeWorktree and untracked files', () => {
  it('refuses a worktree holding an untracked file, without force', async () => {
    const repo = await tempRepo();
    const worktree = await createWorktree(repo, 'codex', 'ct/codex-base');
    temporaryWorktrees.push({ repo, id: 'codex' });
    await writeFile(join(worktree, 'AGENTS.md'), 'the brief init wrote\n', 'utf8');

    await expect(removeWorktree(repo, 'codex')).rejects.toThrow();
    // Still there — this is the half that made `down --purge` a no-op.
    expect((await listWorktrees(repo)).some((w) => w.path.includes('codex'))).toBe(true);
  }, 60_000);

  it('removes that same worktree with force', async () => {
    const repo = await tempRepo();
    const worktree = await createWorktree(repo, 'codex', 'ct/codex-base');
    temporaryWorktrees.push({ repo, id: 'codex' });
    await writeFile(join(worktree, 'AGENTS.md'), 'the brief init wrote\n', 'utf8');

    await removeWorktree(repo, 'codex', { force: true });
    temporaryWorktrees.pop();

    expect((await listWorktrees(repo)).some((w) => w.path.includes('codex'))).toBe(false);
  }, 60_000);
});
