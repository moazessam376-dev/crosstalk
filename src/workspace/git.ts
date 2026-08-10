import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
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

/**
 * @param options.force  Pass `git worktree remove --force`, which is required
 *   for any worktree holding untracked files. Every worktree `init` creates
 *   holds one by construction — it writes the participant's brief inside it —
 *   so `down --purge` cannot remove its own output without this. Defaults to
 *   off: `down` on its own keeps everything, and `--purge` is the flag that
 *   already says destruction is intended.
 */
export async function removeWorktree(
  repo: string,
  id: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const root = resolve(repo);
  const worktree = join(root, '.crosstalk', 'worktrees', id);
  const existedBefore = await pathExists(worktree);
  const args = ['worktree', 'remove', ...(options.force === true ? ['--force'] : []), worktree];
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await runGit(root, args);
      return;
    } catch (error) {
      lastError = error;
      if (existedBefore && !(await isRegisteredWorktree(root, worktree))) {
        try {
          await rm(worktree, { recursive: true, force: true });
          return;
        } catch (cleanupError) {
          lastError = cleanupError;
        }
      }
      if (attempt === 2) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50 * 2 ** attempt));
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Unable to remove worktree "${worktree}" after retries: ${detail}`, { cause: lastError });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }
  return resolvedLeft === resolvedRight;
}

async function isRegisteredWorktree(repo: string, worktree: string): Promise<boolean> {
  try {
    return (await listWorktrees(repo)).some((entry) => samePath(entry.path, worktree));
  } catch {
    return true;
  }
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
