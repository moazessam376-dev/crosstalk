import type { TaskState } from '../../contracts/task.js';

/**
 * How a task's pull request reads on GitHub.
 *
 * Derived from the task state rather than fetched, and that is a real
 * constraint rather than a shortcut: the mirror has no write path into the log
 * (`mirror/index.ts`), which is what makes "mirror failure never blocks the
 * protocol" structural. So the hub knows a PR number and the state of the work
 * attached to it, and does not know what GitHub currently says about the PR
 * itself. What is rendered is the honest reading of the former.
 *
 * The lifecycle it reads: the mirror opens a **draft** PR when a task starts,
 * the draft is marked ready when the seat submits, and the task reaches
 * `merged` when it lands.
 */
export type PullRequestState = 'draft' | 'open' | 'merged' | 'closed';

const READY: ReadonlySet<TaskState> = new Set<TaskState>([
  'submitted',
  'under_review',
  'resolving',
  'accepted',
]);

export function pullRequestState(task: TaskState): PullRequestState {
  if (task === 'merged') return 'merged';
  return READY.has(task) ? 'open' : 'draft';
}

/**
 * GitHub's own words for each state, so the label and the colour agree with
 * what the operator will see when they follow the link.
 */
export function pullRequestLabel(state: PullRequestState): string {
  return state;
}
