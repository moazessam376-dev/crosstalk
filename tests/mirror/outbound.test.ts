import { describe, it, expect } from 'vitest';

import { FakeGitHub } from './fake-github.js';
import { reconcileClaim, reconcileTask } from '../../src/mirror/queue.js';
import { claimMarker } from '../../src/mirror/render.js';

import type { Claim } from '../../src/contracts/claim.js';
import type { Task } from '../../src/contracts/task.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T-04',
    title: 'Make the refund path idempotent',
    brief: 'A retried charge must credit once.',
    specRefs: ['spec §4.2'],
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
    assertion: 'The refund path double-credits on a retried charge.',
    severity: 'defect',
    falsifier: 'A retried charge that credits once refutes this.',
    evidence: [],
    state: 'open',
    rounds: 0,
    taskId: 'T-04',
    ...overrides,
  };
}

describe('the task pull request', () => {
  it('opens a draft when the task reaches assigned', async () => {
    const github = new FakeGitHub();

    await reconcileTask(github, task({ state: 'assigned' }));

    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]).toMatchObject({ branch: 'ct/T-04-refund', isDraft: true });
  });

  /**
   * The neighbouring case. A mirror that opened a PR for every task it saw
   * would pass the test above and publish drafts for work nobody has been
   * assigned yet — `draft` is a state the leader is still writing in.
   */
  it('opens nothing for a task still in draft', async () => {
    const github = new FakeGitHub();

    await reconcileTask(github, task({ state: 'draft' }));

    expect(github.pulls).toHaveLength(0);
  });

  it('marks the pull request ready when the task reaches submitted', async () => {
    const github = new FakeGitHub();
    const assigned = task({ state: 'assigned' });

    await reconcileTask(github, assigned);
    await reconcileTask(github, { ...assigned, state: 'submitted' });

    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]?.isDraft).toBe(false);
  });

  it('does not open a second pull request for a task it has already mirrored', async () => {
    const github = new FakeGitHub();
    const assigned = task({ state: 'assigned' });

    await reconcileTask(github, assigned);
    await reconcileTask(github, assigned);
    await reconcileTask(github, { ...assigned, state: 'in_progress' });

    expect(github.pulls).toHaveLength(1);
    expect(github.countCalls('create-draft')).toBe(1);
  });

  /**
   * Restart safety. The mirror holds no map from task to PR — it finds the PR
   * by the branch the task already names — so a mirror that has forgotten
   * everything must not duplicate what a previous run opened.
   */
  it('adopts a pull request opened by an earlier run rather than opening another', async () => {
    const github = new FakeGitHub();
    await reconcileTask(github, task({ state: 'assigned' }));

    const restarted = new FakeGitHub();
    restarted.pulls.push(...github.pulls);

    await reconcileTask(restarted, task({ state: 'submitted' }));

    expect(restarted.countCalls('create-draft')).toBe(0);
    expect(restarted.pulls).toHaveLength(1);
    expect(restarted.pulls[0]?.isDraft).toBe(false);
  });
});

describe('the claim comment', () => {
  it('leaves one comment edited three times across contest, uphold and concede', async () => {
    const github = new FakeGitHub();
    const pull = await github.createDraftPullRequest({
      branch: 'ct/T-04-refund',
      title: 't',
      body: 'b',
    });

    await reconcileClaim(github, claim({ state: 'open', rounds: 0 }), pull.number);
    await reconcileClaim(github, claim({ state: 'contested', rounds: 1 }), pull.number);
    await reconcileClaim(github, claim({ state: 'contested', rounds: 2 }), pull.number);
    await reconcileClaim(
      github,
      claim({ state: 'resolved', resolution: 'withdrawn', rounds: 3 }),
      pull.number,
    );

    expect(github.allComments()).toHaveLength(1);
    expect(github.countCalls('comment')).toBe(1);
    expect(github.countCalls('edit')).toBe(3);
    expect(github.allComments()[0]?.body).toContain('withdrawn');
  });

  it('gives two claims two comments', async () => {
    const github = new FakeGitHub();
    const pull = await github.createDraftPullRequest({
      branch: 'ct/T-04-refund',
      title: 't',
      body: 'b',
    });

    await reconcileClaim(github, claim({ id: 'C-118' }), pull.number);
    await reconcileClaim(github, claim({ id: 'C-119' }), pull.number);

    expect(github.allComments()).toHaveLength(2);
    expect(github.allComments()[0]?.body).toContain(claimMarker('C-118'));
    expect(github.allComments()[1]?.body).toContain(claimMarker('C-119'));
  });

  /**
   * Rate limit discipline, and the reason the mirror reads before it writes:
   * re-running the same settled claim must not produce a PATCH that changes
   * nothing. Without this, a poll loop rewrites every comment on every tick.
   */
  it('writes nothing when the rendered comment already matches', async () => {
    const github = new FakeGitHub();
    const pull = await github.createDraftPullRequest({
      branch: 'ct/T-04-refund',
      title: 't',
      body: 'b',
    });
    const settled = claim({ state: 'resolved', resolution: 'upheld', rounds: 2 });

    await reconcileClaim(github, settled, pull.number);
    await reconcileClaim(github, settled, pull.number);

    expect(github.countCalls('edit')).toBe(0);
    expect(github.countCalls('comment')).toBe(1);
  });
});
