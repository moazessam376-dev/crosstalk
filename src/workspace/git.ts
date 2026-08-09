import { execFile as execFileCallback } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const GIT_DIR_PREFIX = 'refs/heads/';

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

function processExitCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'number' ? code : undefined;
}

export async function gitVersion(cwd: string): Promise<string> {
  return runGit(cwd, ['--version']);
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

export async function headSha(cwd: string): Promise<string> {
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

export async function isAncestor(sha: string, of: string, cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ['merge-base', '--is-ancestor', sha, of]);
    return true;
  } catch (error) {
    if (processExitCode(error) === 1) return false;
    throw error;
  }
}

export async function createWorktree(repo: string, id: string, branch: string): Promise<string> {
  const root = resolve(repo);
  const worktree = join(root, '.crosstalk', 'worktrees', id);
  await mkdir(dirname(worktree), { recursive: true });
  await runGit(root, ['worktree', 'add', '-b', branch, worktree]);
  return worktree;
}

export async function removeWorktree(repo: string, id: string): Promise<void> {
  const root = resolve(repo);
  const worktree = join(root, '.crosstalk', 'worktrees', id);
  await runGit(root, ['worktree', 'remove', worktree]);
}

export async function listWorktrees(repo: string): Promise<{ path: string; branch: string }[]> {
  const output = await runGit(resolve(repo), ['worktree', 'list', '--porcelain']);
  const worktrees: { path: string; branch: string }[] = [];
  let current: { path: string; branch: string } | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current !== undefined) worktrees.push(current);
      current = { path: line.slice('worktree '.length), branch: '' };
      continue;
    }
    if (current !== undefined && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith(GIT_DIR_PREFIX) ? ref.slice(GIT_DIR_PREFIX.length) : ref;
      continue;
    }
    if (current !== undefined && line === 'detached') current.branch = '';
  }

  if (current !== undefined) worktrees.push(current);
  return worktrees;
}
