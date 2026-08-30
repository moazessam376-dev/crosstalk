import type { Claim, Task } from '../contracts/index.js';
import { commitExists, isAncestor, isReachable } from './git.js';

export async function evaluateStaleness(
  claims: Claim[],
  head: string,
  cwd: string,
): Promise<{ claimId: string; sha: string }[]> {
  const ancestry = new AncestryCache(head, cwd);
  const reported = new Set<string>();
  const stale: { claimId: string; sha: string }[] = [];

  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      if (evidence.stale === true) continue;
      if (await ancestry.holds(evidence.sha)) continue;

      const key = `${claim.id}\u0000${evidence.sha}`;
      if (!reported.has(key)) {
        reported.add(key);
        stale.push({ claimId: claim.id, sha: evidence.sha });
      }
    }
  }

  return stale;
}

/**
 * The task-scoped half of §5.4: which of these tasks stands on evidence the
 * main branch no longer contains.
 *
 * `evaluateStaleness` is claim-scoped, so nothing in this repository could
 * decide that a *submitted task's* evidence had gone stale — which is what
 * `rebase_notice` is supposed to mean. **Submission evidence** is
 * `Task.critique.findings[].closedBy`: the only `Evidence` a `Task` reaches.
 *
 * Which tasks to pass is the caller's: the protocol rule is that only a
 * `submitted` task earns a notice, and that is a protocol fact rather than a
 * git one. Unlike the claim sweep this does not skip evidence already flagged
 * `stale` — nothing ever flags it, because `evidence_stale` carries a
 * `claimId` and cannot name a task. Not re-notifying is the caller's `submitted`
 * filter doing its job: the notice moves the task out of that state.
 */
export async function evaluateTaskStaleness(
  tasks: Task[],
  head: string,
  cwd: string,
): Promise<{ taskId: string; sha: string }[]> {
  const ancestry = new AncestryCache(head, cwd);
  const reported = new Set<string>();
  const stale: { taskId: string; sha: string }[] = [];

  for (const task of tasks) {
    for (const finding of task.critique?.findings ?? []) {
      for (const evidence of finding.closedBy) {
        if (await ancestry.holds(evidence.sha)) continue;

        const key = `${task.id}\u0000${evidence.sha}`;
        if (!reported.has(key)) {
          reported.add(key);
          stale.push({ taskId: task.id, sha: evidence.sha });
        }
      }
    }
  }

  return stale;
}

/** One `merge-base` per distinct sha; a session repeats the same handful. */
class AncestryCache {
  readonly #head: string;
  readonly #cwd: string;
  readonly #known = new Map<string, boolean>();

  constructor(head: string, cwd: string) {
    this.#head = head;
    this.#cwd = cwd;
  }

  /**
   * Whether the repository still stands behind `sha` — false means the
   * evidence is stale.
   *
   * Fresh when main contains the commit *or any local branch still reaches
   * it*. Ancestry-of-main alone flagged every unmerged worktree commit — the
   * normal home of honest evidence in a branch-per-task project — as stale on
   * the first sweep. Stale now means orphaned: rebased away, pruned, or never
   * in this repository, which is what §5.4's "the base moved out from under
   * it" actually describes.
   */
  async holds(sha: string): Promise<boolean> {
    const cached = this.#known.get(sha);
    if (cached !== undefined) return cached;

    const answer = await this.#ask(sha);
    this.#known.set(sha, answer);
    return answer;
  }

  async #ask(sha: string): Promise<boolean> {
    try {
      if (await isAncestor(sha, this.#head, this.#cwd)) return true;
    } catch (error) {
      // `merge-base --is-ancestor` exits 128 on an object the repository does
      // not hold, and `isAncestor` rethrows anything that is not a plain "no".
      // Evidence can name a commit that was never pushed here, or one pruned
      // since it was gathered; unverifiable is exactly what §5.4 calls stale,
      // and letting it throw would end the sweep on the first such sha and
      // leave every other claim unchecked.
      //
      // Guarded by `head` resolving, so a broken repository still raises rather
      // than reporting the entire session stale.
      if ((await commitExists(this.#head, this.#cwd)) && !(await commitExists(sha, this.#cwd))) {
        return false;
      }
      throw error;
    }
    return isReachable(sha, this.#cwd);
  }
}
