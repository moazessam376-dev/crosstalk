import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree } from '../../src/workspace/git.js';

const execFile = promisify(execFileCallback);
const temporaryRepositories: string[] = [];
const temporaryWorktrees: { repo: string; id: string }[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function tempRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'crosstalk-worktree-lock-'));
  temporaryRepositories.push(repo);

  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Crosstalk Tests']);
  await git(repo, ['config', 'user.email', 'tests@crosstalk.invalid']);
  await writeFile(join(repo, 'README.md'), 'first\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'first']);
  await git(repo, ['branch', '-M', 'main']);
  return repo;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

afterEach(async () => {
  for (const { repo, id } of temporaryWorktrees.splice(0)) {
    try {
      await execFile('git', ['worktree', 'remove', '--force', join(repo, '.crosstalk', 'worktrees', id)], {
        cwd: repo,
        windowsHide: true,
      });
    } catch {
      // The test may already have removed the worktree.
    }
  }
  while (temporaryRepositories.length > 0) {
    const repo = temporaryRepositories.pop();
    if (repo !== undefined) {
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}, 60_000);

describe('worktree removal retry', () => {
  it.skipIf(process.platform !== 'win32')('retries while a process holds the worktree cwd', async () => {
    const repo = await tempRepo();
    const worktree = await createWorktree(repo, 'held', 'ct/held');
    temporaryWorktrees.push({ repo, id: 'held' });

    const readyFile = join(repo, 'held-ready');
    const child = spawn(
      process.execPath,
      ['-e', "require('node:fs').writeFileSync(process.env.CROSSTALK_READY, 'ready'); setTimeout(() => process.exit(0), 300);"],
      {
        cwd: worktree,
        env: { ...process.env, CROSSTALK_READY: readyFile },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    const childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));

    try {
      await waitForFile(readyFile);
      await expect(removeWorktree(repo, 'held')).resolves.toBeUndefined();
      await expect(access(worktree)).rejects.toThrow();
      temporaryWorktrees.pop();
    } finally {
      await childClosed;
    }
  }, 60_000);
});
