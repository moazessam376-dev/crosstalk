import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
