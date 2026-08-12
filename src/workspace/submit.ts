import { execFile as execFileCallback } from 'node:child_process';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { isWithinPrefix, outsideOwnership } from './ownership.js';

const execFile = promisify(execFileCallback);

/** Crosstalk's own state directory, excluded from everything below. */
const STATE_DIR = '.crosstalk/';

/**
 * Committing a submit when every agent shares the repository root.
 *
 * Three agents in one working tree share one `.git/index` and one `HEAD`. If
 * each ran `git commit` directly they would race on both, and branch-per-task
 * — which the review protocol, merge order and the entire GitHub mirror are
 * built on — would have to go with it. So the edit happens in the shared root
 * and the *commit* happens somewhere else: a throwaway worktree checked out on
 * the task's branch, holding only the paths that agent owns.
 *
 * The shared tree is never touched. Its `HEAD` does not move, its index is
 * never staged, and the agent's files stay exactly where they were — it goes on
 * working while the commit lands on the branch.
 */

export interface CommitOwnedPathsOptions {
  /** The shared working tree every agent edits in. */
  repo: string;
  /** The task's branch. Created if it does not exist, added to if it does. */
  branch: string;
  /** Names the throwaway worktree. The task id is the natural choice. */
  worktreeId: string;
  /** The submitting participant's declared prefixes. */
  owns: readonly string[];
  message: string;
}

export type CommitOwnedPathsResult =
  /** Committed. `files` is empty when the agent had changed nothing it owns. */
  | { sha: string; files: string[] }
  /**
   * Nothing was committed, because the agent changed paths it does not own.
   *
   * Refusing is the point. Committing only the owned subset would silently drop
   * the rest while reporting success, which is the failure mode approach C was
   * chosen against; and committing all of it would overwrite whichever agent
   * actually owns those paths, which is the failure worktrees existed to
   * prevent.
   */
  | { refused: string[] };

export function wasRefused(result: CommitOwnedPathsResult): result is { refused: string[] } {
  return 'refused' in result;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

/**
 * Every path git reports as changed, tracked or not.
 *
 * `-z` because `--porcelain` quotes and escapes any path containing a space or
 * a non-ASCII byte, and unquoting that by hand is a second parser to get wrong.
 * `--untracked-files=all` because a new file in a new directory is reported as
 * the *directory* otherwise, and a directory is not something to copy or to
 * check against a prefix.
 */
async function changedPaths(repo: string): Promise<string[]> {
  // Deliberately not through `git()`, which trims. A porcelain record's status
  // field is two columns and the first is a space for anything unstaged — a
  // deletion is ` D <path>` — so trimming the output eats that space and every
  // subsequent `slice(3)` takes a character off the front of the path.
  // `src/metrics/old.ts` arrived as `rc/metrics/old.ts`, was outside the
  // declared prefix, and the submit was refused for a path the agent owned.
  const { stdout: raw } = await execFile(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: repo, windowsHide: true },
  );
  const paths: string[] = [];
  // Records are NUL-terminated `XY <path>`; a rename adds a second NUL-separated
  // field for the original name, which `R` marks.
  const records = raw.split('\0').filter((record) => record !== '');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    // The rename's source name follows as its own record and is not a status
    // line; consume it so it is not read as one.
    if (status.startsWith('R') || status.startsWith('C')) {
      const source = records[index + 1];
      if (source !== undefined) {
        paths.push(source);
        index += 1;
      }
    }
  }
  // Crosstalk's own state is never a participant's work. `.crosstalk/` holds
  // the event log, the tokens, `daemon.json` and the lock, all of which churn
  // while the daemon is running and none of which any agent owns — so without
  // this every submit is refused for files the protocol itself wrote.
  //
  // `init` does gitignore this directory, which would hide it from `git status`
  // anyway. Not relied on: the ignore can be absent on a repository initialised
  // by hand or edited since, and the failure it produces — every submit refused
  // for paths the agent never touched — is opaque from the agent's side.
  return [...new Set(paths)].filter((path) => !isWithinPrefix(path, STATE_DIR));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function commitOwnedPaths(
  options: CommitOwnedPathsOptions,
): Promise<CommitOwnedPathsResult> {
  const repo = resolve(options.repo);
  const changed = await changedPaths(repo);

  const outside = outsideOwnership(changed, options.owns);
  if (outside.length > 0) return { refused: outside };

  // Nothing to commit, and nothing to refuse. Building a worktree to produce an
  // empty commit would leave a branch whose history says work happened.
  if (changed.length === 0) {
    return { sha: await git(repo, ['rev-parse', 'HEAD']), files: [] };
  }

  // Not under `.crosstalk/worktrees/`: that directory holds participant
  // workspaces, `purgeWorkspaces` walks it, and a submit worktree sitting there
  // reads as an agent that nobody configured.
  const worktree = join(repo, '.crosstalk', 'submit', options.worktreeId);
  await mkdir(dirname(worktree), { recursive: true });
  await rm(worktree, { recursive: true, force: true });

  // Resubmission after review is the normal path, so an existing branch is
  // added to rather than refused.
  const branchExists = await git(repo, ['branch', '--list', options.branch]) !== '';
  await git(repo, [
    'worktree', 'add', '--quiet',
    ...(branchExists ? [] : ['-b', options.branch]),
    worktree,
    ...(branchExists ? [options.branch] : []),
  ]);

  try {
    const present: string[] = [];
    for (const path of changed) {
      const from = join(repo, path);
      const to = join(worktree, path);
      if (await exists(from)) {
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
        present.push(path);
      } else {
        // A deletion. `git rm` both removes the worktree copy and stages the
        // removal, so this path must not go on to `git add` — the pathspec no
        // longer matches anything and git fails the whole command rather than
        // skipping it.
        await git(worktree, ['rm', '--quiet', '--ignore-unmatch', '--', path]);
      }
    }

    if (present.length > 0) await git(worktree, ['add', '--all', '--', ...present]);
    await git(worktree, ['commit', '--quiet', '-m', options.message]);
    const sha = await git(worktree, ['rev-parse', 'HEAD']);
    return { sha, files: changed };
  } finally {
    // `--force`: the copies above are untracked until staged, and a failure
    // between them and the commit would otherwise leave the worktree behind
    // for `git worktree list` to trip over on the next submit.
    await git(repo, ['worktree', 'remove', '--force', worktree]).catch(async () => {
      await rm(worktree, { recursive: true, force: true });
      await git(repo, ['worktree', 'prune']).catch(() => {});
    });
  }
}
