import { execFile as execFileCallback } from 'node:child_process';
import { realpath as realpathCallback } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
/** The OS view of a path: expands 8.3 short names, junctions and symlinks. */
const realpathNative = promisify(realpathCallback.native);
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

/**
 * The head of a named branch.
 *
 * Staleness is measured against `project.mainBranch` (spec §5.4), and `headSha`
 * answers about whatever happens to be checked out. Nothing pins the daemon's
 * checkout to the main branch, and inside one of the linked worktrees `init`
 * creates it is pinned to something else by construction — so `rev-parse HEAD`
 * compares every piece of evidence against the wrong commit.
 *
 * Resolved through `refs/heads/` rather than the bare name so a tag or a file
 * of the same name cannot answer for the branch.
 */
export async function branchSha(cwd: string, branch: string): Promise<string> {
  try {
    return await runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch (error) {
    throw new Error(
      `No local branch "${branch}" in ${cwd}. Set project.mainBranch in .crosstalk/config.yaml to a branch this clone has, or check it out.`,
      { cause: error },
    );
  }
}

/**
 * Whether `sha` names a commit this repository holds.
 *
 * Only ever asked after an ancestry check has already failed. Evidence can
 * name a commit that was never pushed, or one that has since been pruned, and
 * `merge-base --is-ancestor` exits 128 on an unknown object — indistinguishable
 * from a broken repository unless somebody asks this question.
 */
export async function commitExists(sha: string, cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The head of a branch, or `undefined` when this clone does not have it. */
export async function branchShaIfExists(cwd: string, branch: string): Promise<string | undefined> {
  try {
    return await runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch {
    return undefined;
  }
}

/**
 * Move a branch forward to a commit that already contains it.
 *
 * `-f` and not `merge --ff-only`, because the branch being moved is by
 * definition not checked out anywhere: git refuses to force a branch that a
 * worktree holds, and CT-12's whole shape is a branch whose worktree is gone.
 * The caller checks ancestry first — this function must never be asked to move
 * a branch sideways.
 */
export async function fastForwardBranch(cwd: string, branch: string, to: string): Promise<void> {
  await runGit(cwd, ['branch', '-f', branch, to]);
}

/**
 * Delete a branch, tolerating one that is already gone.
 *
 * `-D`, not `-d`: `down --purge` promises to remove what Crosstalk created, and
 * a `ct/<id>-base` holding commits that were never merged is exactly the case
 * `-d` refuses. Leaving it is what CT-12 is.
 */
export async function deleteBranch(cwd: string, branch: string): Promise<void> {
  await runGit(cwd, ['branch', '-D', branch]).catch(() => undefined);
}

/**
 * Whether any local branch can still reach `sha`.
 *
 * The staleness predicate used to be `isAncestor(sha, mainBranch)` alone, and
 * that misfires on this project's own workflow: work happens on branch-per-task
 * worktrees, so honest evidence gathered at a branch HEAD was *never* an
 * ancestor of main and the sweep flagged it stale within one tick — bouncing a
 * freshly submitted task back to `in_progress` and reopening claims that were
 * settled minutes earlier. Evidence goes stale when the commit it names is
 * *orphaned* — rebased away, pruned, or never in this repository — not when it
 * is simply unmerged.
 *
 * Local branches only (`--all` would count a remote ref the clone no longer
 * advances), which includes every worktree branch by construction.
 */
export async function isReachable(sha: string, cwd: string): Promise<boolean> {
  try {
    const holders = await runGit(cwd, ['branch', '--contains', sha, '--format=%(refname:short)']);
    return holders !== '';
  } catch {
    // `branch --contains` errors on an object the repository does not hold,
    // which is precisely "unreachable".
    return false;
  }
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

/**
 * Do two paths name the same directory?
 *
 * Canonicalised through `realpath.native` before comparing, because resolving
 * and case-folding is not enough: on a Windows machine with 8.3 generation on,
 * git reports a worktree's long path while Crosstalk constructs the short one,
 * and the two compare as different. That is not cosmetic — it made
 * `isRegisteredWorktree` answer "not registered" for a worktree that is, so
 * `removeWorktree`'s fallback deleted a worktree holding uncommitted work with
 * nobody having passed `force`. The same class covers junctions, symlinks and
 * `/private` on macOS.
 *
 * Exported so there is one comparator rather than a copy per caller; the copy
 * in `src/cli/init.ts` had the identical blind spot.
 */
export async function samePath(
  left: string,
  right: string,
  realpathOf: PathResolver = realpathNative,
): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonical(left, realpathOf),
    canonical(right, realpathOf),
  ]);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return canonicalLeft.toLowerCase() === canonicalRight.toLowerCase();
  }
  return canonicalLeft === canonicalRight;
}

/**
 * Injectable so the comparator can be tested against hard-coded short and long
 * spellings rather than a manufactured 8.3 alias. Modern Windows often disables
 * 8.3 generation on non-system volumes, which is exactly why this defect
 * survived three machines and only surfaced on CI. Track B's design; adopted
 * here so the two copies can become one.
 */
export type PathResolver = (path: string) => Promise<string>;

/** `realpath` throws on a path that does not exist, which is a legitimate state here. */
async function canonical(path: string, realpathOf: PathResolver): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpathOf(resolved);
  } catch {
    return resolved;
  }
}

async function isRegisteredWorktree(repo: string, worktree: string): Promise<boolean> {
  try {
    for (const entry of await listWorktrees(repo)) {
      if (await samePath(entry.path, worktree)) return true;
    }
    return false;
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

/**
 * Files a branch changed relative to where it left `base`.
 *
 * Three dots on purpose: `base...branch` is the branch's own work, so a branch
 * that is merely behind `main` does not appear to have touched everything that
 * landed on `main` while it was away. Two dots would report that, and the
 * no-shared-files gate would fail every seat the moment anyone merged.
 *
 * An unknown branch is an empty change set rather than a throw: a seat that has
 * not pushed yet has not collided with anyone.
 */
export async function changedFiles(cwd: string, base: string, branch: string): Promise<string[]> {
  try {
    const out = await runGit(cwd, ['diff', '--name-only', `${base}...${branch}`]);
    return out === '' ? [] : out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  } catch {
    return [];
  }
}
