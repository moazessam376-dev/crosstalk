import { describe, expect, it } from 'vitest';
import type { Claim, Evidence } from '../../src/contracts/claim.js';
import type { Task, TaskState, CritiqueRecord, Acknowledgement } from '../../src/contracts/task.js';
import { validateTransition } from '../../src/core/tasks.js';
import type { HubState } from '../../src/core/projection.js';

describe('task gates', () => {
  it('refuses assigned -> in_progress without an acknowledgement', () => {
    const state = stateWithTask('T-1', 'assigned');
    expect(() => validateTransition('T-1', 'in_progress', state)).toThrowError(
      expect.objectContaining({ code: 'GATE_NOT_ACKNOWLEDGED' }),
    );
  });

  it('allows assigned -> in_progress once acknowledged', () => {
    const state = stateWithTask('T-1', 'acknowledged', {
      acknowledgement: { restatement: 'build the log', ambiguities: [] },
    });
    expect(() => validateTransition('T-1', 'in_progress', state)).not.toThrow();
  });

  it('refuses in_progress -> submitted without a critique record', () => {
    const state = stateWithTask('T-1', 'in_progress');
    expect(() => validateTransition('T-1', 'submitted', state)).toThrowError(
      expect.objectContaining({ code: 'GATE_NOT_SELF_REVIEWED' }),
    );
  });

  it('permits a zero-finding critique record — legal, and recorded', () => {
    const state = stateWithTask('T-1', 'self_reviewed', {
      critique: { rounds: 1, findings: [], critic: 'codex subagent' },
    });
    expect(() => validateTransition('T-1', 'submitted', state)).not.toThrow();
  });

  it('refuses under_review -> accepted while any claim on the task is unresolved', () => {
    const state = stateWithTaskAndOpenClaim('T-1', 'under_review', 'C-9');
    expect(() => validateTransition('T-1', 'accepted', state)).toThrowError(
      expect.objectContaining({ code: 'UNRESOLVED_CLAIMS' }),
    );
  });

  it('rejects a transition not present in the table', () => {
    const state = stateWithTask('T-1', 'draft');
    expect(() => validateTransition('T-1', 'merged', state)).toThrowError(
      expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }),
    );
  });
});

function emptyState(): HubState {
  return {
    participants: new Map(),
    tasks: new Map(),
    claims: new Map(),
    decisions: new Map(),
    rungs: new Map(),
    messages: [],
    lastSeq: 0,
  };
}

function stateWithTask(
  id: string,
  state: TaskState,
  overrides: Partial<Pick<Task, 'acknowledgement' | 'critique'>> = {},
): HubState {
  const hubState = emptyState();
  hubState.tasks.set(id, task(id, state, overrides));
  return hubState;
}

function stateWithTaskAndOpenClaim(id: string, state: TaskState, claimId: string): HubState {
  const hubState = stateWithTask(id, state);
  hubState.claims.set(claimId, claim(claimId, id));
  return hubState;
}

function task(
  id: string,
  state: TaskState,
  overrides: Partial<Pick<Task, 'acknowledgement' | 'critique'>>,
): Task {
  return {
    id,
    title: 'Build the log',
    brief: 'Implement the append-only event log.',
    specRefs: ['§5.2'],
    assignee: 'codex',
    deps: [],
    acceptance: ['ledger appends by seq'],
    state,
    branch: 'track-a/core',
    ...overrides,
  };
}

function claim(id: string, taskId: string): Claim {
  return {
    id,
    raisedBy: 'leader',
    against: 'codex',
    target: 'src/core/tasks.ts:1',
    assertion: 'task still has an unresolved review finding',
    severity: 'defect',
    falsifier: 'if this task is actually ready, every claim tied to it would already be resolved in the state map',
    evidence: [evidence()],
    state: 'open',
    rounds: 0,
    taskId,
  };
}

function evidence(): Evidence {
  return {
    kind: 'command',
    command: 'npx vitest run tests/core/tasks.test.ts',
    output: 'review finding remains open',
    sha: 'abc1234',
    by: 'leader',
  };
}
