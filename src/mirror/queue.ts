import type { Claim } from '../contracts/claim.js';
import type { Decision } from '../contracts/decision.js';
import type { Task, TaskState } from '../contracts/task.js';
import type { GitHubTransport } from './github.js';
import { claimMarker, findMarkedComment, renderClaimComment } from './render.js';

/** Task lifecycle order, from `src/contracts/task.ts`. Compared by index. */
const TASK_ORDER: readonly TaskState[] = [
  'draft',
  'assigned',
  'acknowledged',
  'in_progress',
  'self_reviewed',
  'submitted',
  'under_review',
  'resolving',
  'accepted',
  'merged',
];

function atOrAfter(state: TaskState, mark: TaskState): boolean {
  return TASK_ORDER.indexOf(state) >= TASK_ORDER.indexOf(mark);
}

/**
 * Brings a task's pull request into line with the task's current state.
 *
 * Idempotent by construction: the pull request is located by the branch the
 * task already names, never by a stored number, so a mirror that has restarted
 * — or one that has been off for an hour — adopts what a previous run opened
 * instead of duplicating it. That is also what makes retry safe: replaying a
 * failed operation recomputes the same desired state rather than appending to
 * a queue of side effects.
 */
export async function reconcileTask(github: GitHubTransport, task: Task): Promise<void> {
  // `draft` is the leader still writing the brief. Publishing it would put work
  // nobody has been assigned in front of the repository.
  if (!atOrAfter(task.state, 'assigned')) return;

  const body = renderTaskBody(task);
  const existing = await github.findPullRequestByBranch(task.branch);
  const pull =
    existing ??
    (await github.createDraftPullRequest({
      branch: task.branch,
      title: `${task.id} — ${task.title}`,
      body,
    }));

  // The acknowledgement and the self-critique arrive long after the pull
  // request is opened. Without this the body freezes at whatever was known at
  // `assigned`, and the settled record the mirror exists to publish is the one
  // part of it that never settles. Skipped when nothing changed, so a poll tick
  // over a quiet task issues no write.
  if (existing !== undefined && existing.body !== undefined && existing.body !== body) {
    await github.updatePullRequestBody(pull.number, body);
  }

  if (atOrAfter(task.state, 'submitted') && pull.isDraft) {
    await github.markReady(pull.number);
  }
}

/** The settled record for a task: the brief, and the gates it has passed. */
export function renderTaskBody(task: Task): string {
  const lines = [
    `<!-- crosstalk:task:${task.id} -->`,
    `**Assignee** \`${task.assignee}\` · **State** ${task.state}`,
    '',
    task.brief,
    '',
    '### Acceptance',
    '',
    ...task.acceptance.map((item) => `- ${item}`),
  ];

  if (task.acknowledgement !== undefined) {
    lines.push('', '### Acknowledgement', '', task.acknowledgement.restatement);
    if (task.acknowledgement.ambiguities.length > 0) {
      lines.push('', ...task.acknowledgement.ambiguities.map((item) => `- ${item}`));
    }
  }

  if (task.critique !== undefined) {
    const { rounds, findings, critic } = task.critique;
    // "Zero findings is legal" — AGENTS.md. Rendering nothing for an empty
    // critique would make a run that found nothing look like one that never ran.
    const summary =
      findings.length === 0
        ? 'No findings.'
        : findings.map((finding) => `- ${finding.assertion}`).join('\n');
    lines.push('', `### Self-critique (${rounds} round(s), ${critic})`, '', summary);
  }

  return lines.join('\n');
}

/**
 * Brings a claim's comment into line with the claim's current state.
 *
 * One comment per claim, edited in place. The comment is found by the marker
 * in its own body rather than by a stored id, for the same restart reason as
 * `reconcileTask` — and a body that already matches is left alone, so a poll
 * loop over settled claims issues no writes at all.
 */
export async function reconcileClaim(
  github: GitHubTransport,
  claim: Claim,
  pullNumber: number,
  decision?: Decision,
): Promise<void> {
  const body = renderClaimComment(claim, decision);
  const comments = await github.listComments(pullNumber);
  const existing = findMarkedComment(comments, claimMarker(claim.id));

  if (existing === undefined) {
    await github.createComment(pullNumber, body);
    return;
  }

  if (existing.body === body) return;

  await github.updateComment(existing.id, body);
}

export type MirrorJob =
  | { kind: 'task'; task: Task }
  | { kind: 'claim'; claim: Claim; pullNumber: number; decision?: Decision };

export interface DrainResult {
  completed: number;
  retrying: number;
}

function keyOf(job: MirrorJob): string {
  return job.kind === 'task' ? `task:${job.task.id}` : `claim:${job.claim.id}`;
}

async function apply(github: GitHubTransport, job: MirrorJob): Promise<void> {
  if (job.kind === 'task') {
    await reconcileTask(github, job.task);
    return;
  }
  await reconcileClaim(github, job.claim, job.pullNumber, job.decision);
}

/**
 * The mirror's queue with retry.
 *
 * Three properties the protocol depends on, in the order they matter:
 *
 * 1. **It never throws at the caller.** A GitHub outage must cost a comment,
 *    not a claim. `drain` reports failures in its return value instead.
 * 2. **It is keyed, not appended.** One entry per task and per claim, latest
 *    state wins. A five-round dispute mirrors as five reconciles at most, and a
 *    burst of changes between drains collapses to one write — which is what
 *    keeps write volume far below the rate limit.
 * 3. **A failed job stays.** Because each job reconciles rather than applies a
 *    delta, replaying it is safe: the next drain recomputes the desired state
 *    from the payload it holds and converges.
 *
 * A queue with no transport — no remote, or no credential — accepts nothing and
 * does nothing, which is design §8's "degrades to nothing".
 */
export class MirrorQueue {
  readonly #github: GitHubTransport | undefined;
  readonly #jobs = new Map<string, MirrorJob>();

  /** The last failure, kept so a mirror that is quietly retrying can say why. */
  lastError: Error | undefined;

  constructor(github: GitHubTransport | undefined) {
    this.#github = github;
  }

  enqueue(job: MirrorJob): void {
    if (this.#github === undefined) return;
    this.#jobs.set(keyOf(job), job);
  }

  async drain(): Promise<DrainResult> {
    const github = this.#github;
    if (github === undefined) return { completed: 0, retrying: 0 };

    let completed = 0;
    let retrying = 0;

    for (const [key, job] of [...this.#jobs]) {
      try {
        await apply(github, job);
        // Only retire the exact job that ran. A newer state for the same key
        // may have been enqueued while this one was in flight, and deleting by
        // key alone would drop it unmirrored.
        if (this.#jobs.get(key) === job) this.#jobs.delete(key);
        completed += 1;
      } catch (error) {
        // Swallowed on purpose, and only here: this is the boundary between a
        // subsystem that fails for reasons outside this codebase and one that
        // must not. The job stays queued and the reason stays readable.
        this.lastError = error instanceof Error ? error : new Error(String(error));
        retrying += 1;
      }
    }

    return { completed, retrying };
  }

  get pending(): number {
    return this.#jobs.size;
  }
}
