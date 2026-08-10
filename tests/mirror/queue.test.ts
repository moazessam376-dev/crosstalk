import { describe, it, expect } from 'vitest';

import { FakeGitHub } from './fake-github.js';
import { MirrorQueue } from '../../src/mirror/queue.js';

import type { Claim } from '../../src/contracts/claim.js';
import type { Task } from '../../src/contracts/task.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T-04',
    title: 'Make the refund path idempotent',
    brief: 'A retried charge must credit once.',
    specRefs: [],
    assignee: 'codex',
    deps: [],
    acceptance: ['A retried charge credits once.'],
    state: 'assigned',
    branch: 'ct/T-04-refund',
    ...overrides,
  };
}

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'C-118',
    raisedBy: 'leader',
    against: 'codex',
    target: 'src/economy.ts:41',
    assertion: 'The refund path double-credits.',
    severity: 'defect',
    falsifier: 'One credit on a retried charge refutes this.',
    evidence: [],
    state: 'open',
    rounds: 0,
    ...overrides,
  };
}

describe('the mirror queue when GitHub is unreachable', () => {
  it('does not throw, and keeps the work for the next drain', async () => {
    const github = new FakeGitHub();
    github.offline = true;
    const queue = new MirrorQueue(github);

    queue.enqueue({ kind: 'task', task: task() });
    const result = await queue.drain();

    expect(result.retrying).toBe(1);
    expect(result.completed).toBe(0);
    expect(github.pulls).toHaveLength(0);
    expect(queue.pending).toBe(1);
  });

  it('applies the held work once the remote comes back', async () => {
    const github = new FakeGitHub();
    github.offline = true;
    const queue = new MirrorQueue(github);

    queue.enqueue({ kind: 'task', task: task() });
    await queue.drain();

    github.offline = false;
    const result = await queue.drain();

    expect(result.completed).toBe(1);
    expect(queue.pending).toBe(0);
    expect(github.pulls).toHaveLength(1);
  });

  /**
   * The neighbouring case: a queue that never cleared anything would pass the
   * test above's `pending` assertion at every point in its life.
   */
  it('clears the work when the remote was reachable all along', async () => {
    const github = new FakeGitHub();
    const queue = new MirrorQueue(github);

    queue.enqueue({ kind: 'task', task: task() });
    const result = await queue.drain();

    expect(result.retrying).toBe(0);
    expect(result.completed).toBe(1);
    expect(queue.pending).toBe(0);
  });

  /**
   * One claim whose mirroring fails must not strand every other claim behind
   * it. A queue that stopped at the first error would mirror the settled record
   * up to the first failure and no further, which reads as a complete record.
   */
  it('does not let one failing job block the rest of the drain', async () => {
    const github = new FakeGitHub();
    const queue = new MirrorQueue(github);

    // Pull 999 does not exist, so this job throws inside the fake.
    queue.enqueue({ kind: 'claim', claim: claim({ id: 'C-1' }), pullNumber: 999 });
    queue.enqueue({ kind: 'task', task: task() });

    const result = await queue.drain();

    expect(result.completed).toBe(1);
    expect(result.retrying).toBe(1);
    expect(github.pulls).toHaveLength(1);
  });
});

describe('the mirror queue', () => {
  it('collapses repeated changes to one claim into a single write', async () => {
    const github = new FakeGitHub();
    const pull = await github.createDraftPullRequest({ branch: 'b', title: 't', body: 'b' });
    const queue = new MirrorQueue(github);

    queue.enqueue({ kind: 'claim', claim: claim({ state: 'open', rounds: 0 }), pullNumber: pull.number });
    queue.enqueue({ kind: 'claim', claim: claim({ state: 'contested', rounds: 1 }), pullNumber: pull.number });
    queue.enqueue({
      kind: 'claim',
      claim: claim({ state: 'resolved', resolution: 'upheld', rounds: 2 }),
      pullNumber: pull.number,
    });
    await queue.drain();

    expect(github.countCalls('comment')).toBe(1);
    expect(github.countCalls('edit')).toBe(0);
    // The last state wins, not the first — a queue keyed by claim that kept the
    // earliest payload would publish an open claim that had already settled.
    expect(github.allComments()[0]?.body).toContain('upheld');
  });

  it('keeps two different claims as two jobs', async () => {
    const github = new FakeGitHub();
    const pull = await github.createDraftPullRequest({ branch: 'b', title: 't', body: 'b' });
    const queue = new MirrorQueue(github);

    queue.enqueue({ kind: 'claim', claim: claim({ id: 'C-1' }), pullNumber: pull.number });
    queue.enqueue({ kind: 'claim', claim: claim({ id: 'C-2' }), pullNumber: pull.number });

    expect(queue.pending).toBe(2);
    await queue.drain();
    expect(github.allComments()).toHaveLength(2);
  });
});

describe('a mirror with no remote and no credential', () => {
  it('degrades to nothing rather than failing', async () => {
    const queue = new MirrorQueue(undefined);

    queue.enqueue({ kind: 'task', task: task() });
    const result = await queue.drain();

    expect(result).toEqual({ completed: 0, retrying: 0 });
    expect(queue.pending).toBe(0);
  });
});
