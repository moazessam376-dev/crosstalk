import type { Claim } from '../contracts/claim.js';
import type { CrosstalkEvent, DraftEvent } from '../contracts/events.js';
import type { ParticipantId } from '../contracts/participant.js';
import type { Task } from '../contracts/task.js';
import type { HubState } from '../core/projection.js';
import { branchSha } from '../workspace/git.js';
import { evaluateStaleness, evaluateTaskStaleness } from '../workspace/staleness.js';

/**
 * How often to re-measure against the main branch.
 *
 * Crosstalk does not own the user's git and cannot hook their merges, so a
 * poll is the only way it learns that one happened. Thirty seconds is cheap —
 * one `rev-parse` plus one `merge-base` per distinct sha — and the alternative
 * is evidence that stays green until somebody happens to look.
 */
export const STALENESS_POLL_MS = 30_000;

/** The slice of the daemon the sweep needs. Mirrors `LadderContext`. */
export interface StalenessContext {
  /** Absolute path to the repository the daemon was started on. */
  repo: string;
  /** `config.project.mainBranch`. Never HEAD — see `branchSha`. */
  mainBranch: string;
  /**
   * Stamped as `from` on everything this emits. The daemon is not a
   * participant, so the author is a choice rather than a fact; the leader is
   * who answers for a mechanical re-check of the record.
   */
  who: ParticipantId;
  state: HubState;
  append(draft: DraftEvent): Promise<CrosstalkEvent>;
}

/**
 * Re-evaluate the session against the head of the main branch (spec §5.4).
 *
 * Emits `evidence_stale` for every piece of claim evidence the main branch no
 * longer contains, and `rebase_notice` for every `submitted` task whose
 * submission evidence went the same way. Both consequences — a claim reopening,
 * a task returning to `in_progress` — are the projection's; this decides only
 * *that* they happened.
 *
 * Idempotent by construction, which is what makes it safe on a timer: the
 * `evidence_stale` it emits marks the evidence, and `evaluateStaleness` skips
 * what is already marked; the `rebase_notice` it emits moves the task out of
 * `submitted`, and only `submitted` tasks are swept.
 *
 * **Throws** if `mainBranch` is not a branch of this clone, or if git cannot
 * answer at all. A caller on a timer must catch — an unhandled rejection
 * inside `setInterval` takes the daemon down, and a misconfigured
 * `project.mainBranch` would do it on the first tick.
 */
export async function checkStaleness(ctx: StalenessContext): Promise<CrosstalkEvent[]> {
  const head = await branchSha(ctx.repo, ctx.mainBranch);
  const events: CrosstalkEvent[] = [];

  for (const { claimId, sha } of await evaluateStaleness(claimsToRecheck(ctx.state), head, ctx.repo)) {
    events.push(
      await ctx.append({
        kind: 'evidence_stale',
        from: ctx.who,
        // C-12. A roomless `evidence_stale` wakes nobody: the claim reopens in
        // silence and the participant who now owes a re-run is parked in
        // `await_turn` waiting for an event addressed to them.
        room: `dispute:${claimId}`,
        claimId,
        sha,
      }),
    );
  }

  const stale = await evaluateTaskStaleness(submittedTasks(ctx.state), head, ctx.repo);
  // One notice per task, however many of its shas moved: the notice says
  // "rebase and re-run", which does not get truer said twice.
  for (const taskId of new Set(stale.map((entry) => entry.taskId))) {
    events.push(
      await ctx.append({
        kind: 'rebase_notice',
        from: ctx.who,
        room: `task:${taskId}`,
        taskId,
        newBase: head,
      }),
    );
  }

  return events;
}

/**
 * Every claim whose `resolution` is not `withdrawn` or `superseded`.
 *
 * Scoped by resolution rather than by state, deliberately. "Open claims" is the
 * reading that makes the reopen rule dead code: a claim resolved `upheld` is
 * exactly the one that must be re-checked, because it is settled *on evidence*
 * and that evidence is what moved. The two excluded are the two that were not
 * settled by evidence at all — `withdrawn` was abandoned by whoever raised it,
 * and `superseded` has a successor claim carrying the argument. A rebase
 * changes neither.
 */
function claimsToRecheck(state: HubState): Claim[] {
  return [...state.claims.values()].filter(
    (claim) => claim.resolution !== 'withdrawn' && claim.resolution !== 'superseded',
  );
}

/**
 * §5.4 names one task state, and the restriction is doing work: `under_review`
 * and later belong to the reviewer, and a task already `in_progress` has
 * nowhere to be sent back to.
 */
function submittedTasks(state: HubState): Task[] {
  return [...state.tasks.values()].filter((task) => task.state === 'submitted');
}
