import { ProtocolError } from '../contracts/errors.js';
import type { TaskState } from '../contracts/task.js';
import type { HubState } from './projection.js';

export const TASK_TRANSITIONS = {
  draft: ['assigned'],
  assigned: ['acknowledged', 'in_progress'],
  acknowledged: ['in_progress'],
  in_progress: ['self_reviewed', 'submitted'],
  self_reviewed: ['submitted'],
  submitted: ['under_review'],
  under_review: ['resolving', 'accepted'],
  resolving: ['under_review', 'accepted'],
  accepted: ['merged'],
  merged: [],
} as const satisfies Readonly<Record<TaskState, readonly TaskState[]>>;

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function validateTransition(taskId: string, to: TaskState, state: HubState): void {
  const task = state.tasks.get(taskId);
  if (!task) {
    throw new ProtocolError('UNKNOWN_TASK', `Unknown task: ${taskId}`);
  }

  if (!canTransition(task.state, to)) {
    throw new ProtocolError('ILLEGAL_TRANSITION', `Illegal task transition: ${task.state} -> ${to}`);
  }

  if (to === 'in_progress' && task.acknowledgement === undefined) {
    throw new ProtocolError('GATE_NOT_ACKNOWLEDGED', `Task ${taskId} must be acknowledged before work starts`);
  }

  if (to === 'submitted' && task.critique === undefined) {
    throw new ProtocolError('GATE_NOT_SELF_REVIEWED', `Task ${taskId} needs a critique record before submission`);
  }

  if (to === 'accepted' && hasUnresolvedClaims(taskId, state)) {
    throw new ProtocolError('UNRESOLVED_CLAIMS', `Task ${taskId} still has unresolved claims`);
  }
}

function hasUnresolvedClaims(taskId: string, state: HubState): boolean {
  return [...state.claims.values()].some((claim) => claim.taskId === taskId && claim.state !== 'resolved');
}
