import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Claim, ClaimResolution, ClaimState, Evidence } from '../../src/contracts/claim.js';
import type { CrosstalkEvent, DraftEvent } from '../../src/contracts/events.js';
import type { Task, TaskState } from '../../src/contracts/task.js';
import { applyEvent, type HubState } from '../../src/core/projection.js';
import { checkStaleness, type StalenessContext } from '../../src/daemon/staleness.js';

const execFile = promisify(execFileCallback);
const temporaryRepositories: string[] = [];

/**
 * Twice the 60s the rest of the suite uses, because these tests are process
 * spawns rather than computation: each builds a repository and rebases it,
 * around twenty `git` invocations, and on Windows spawn cost dominates. On a
 * loaded machine the same test that runs in 3s has been measured at 62s — a
 * timeout there reports a scheduling queue, not a defect, and a suite that
 * cannot tell those apart is worse than a slow one.
 */
const TIMEOUT_MS = 120_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function tempRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'crosstalk-daemon-stale-'));
  temporaryRepositories.push(repo);

  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Crosstalk Tests']);
  await git(repo, ['config', 'user.email', 'tests@crosstalk.invalid']);
  await writeFile(join(repo, 'README.md'), 'first\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'first']);
  await git(repo, ['branch', '-M', 'main']);

  return repo;
}

/**
 * §5.4's own story, run for real rather than mocked: work is rebased onto main
 * and fast-forwarded in, so the commit its evidence was gathered at has been
 * rewritten and is no longer reachable from the branch that now holds the work.
 */
async function rebaseWorkOntoMain(repo: string): Promise<{ before: string; head: string }> {
  await git(repo, ['checkout', '-b', 'work']);
  await writeFile(join(repo, 'work.txt'), 'work\n', 'utf8');
  await git(repo, ['add', 'work.txt']);
  await git(repo, ['commit', '-m', 'work']);
  const before = await git(repo, ['rev-parse', 'HEAD']);

  await git(repo, ['checkout', 'main']);
  await writeFile(join(repo, 'README.md'), 'second\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'second']);

  await git(repo, ['checkout', 'work']);
  await git(repo, ['rebase', 'main']);
  await git(repo, ['checkout', 'main']);
  await git(repo, ['merge', '--ff-only', 'work']);

  return { before, head: await git(repo, ['rev-parse', 'main']) };
}

afterEach(async () => {
  while (temporaryRepositories.length > 0) {
    const repo = temporaryRepositories.pop();
    if (repo !== undefined) {
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}, TIMEOUT_MS);

describe('the staleness sweep over claims', () => {
  it('marks orphaned evidence and reopens the claim it was holding up', async () => {
    const repo = await tempRepo();
    const { before } = await rebaseWorkOntoMain(repo);
    const ctx = context(repo);
    ctx.state.claims.set('C-1', upheldClaim('C-1', [ev(before)]));

    const events = await checkStaleness(ctx);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'evidence_stale',
      // C-12: roomless, this wakes nobody — and the one participant who now
      // owes a re-run is the one nobody told.
      room: 'dispute:C-1',
      claimId: 'C-1',
      sha: before,
      from: 'leader',
    });

    const claim = ctx.state.claims.get('C-1')!;
    expect(claim.state).toBe('open');
    expect('resolution' in claim).toBe(false);
  }, TIMEOUT_MS);

  it('says nothing when the main branch still contains every sha', async () => {
    const repo = await tempRepo();
    const { head } = await rebaseWorkOntoMain(repo);
    const ctx = context(repo);
    ctx.state.claims.set('C-1', upheldClaim('C-1', [ev(head)]));

    expect(await checkStaleness(ctx)).toEqual([]);
    expect(ctx.state.claims.get('C-1')?.state).toBe('resolved');
  }, TIMEOUT_MS);

  /**
   * The scope rule, and the reason it is worded by resolution rather than by
   * state: a claim resolved `upheld` is precisely the one that has to be
   * re-checked, and reading the scope as "open claims" makes the reopen rule
   * dead code. `withdrawn` and `superseded` are the two that are genuinely
   * finished — nobody is standing on their evidence.
   */
  it('re-checks every claim except the withdrawn and the superseded ones', async () => {
    const repo = await tempRepo();
    const { before } = await rebaseWorkOntoMain(repo);
    const ctx = context(repo);
    ctx.state.claims.set('C-open', claim('C-open', 'open', undefined, [ev(before)]));
    ctx.state.claims.set('C-upheld', upheldClaim('C-upheld', [ev(before)]));
    ctx.state.claims.set('C-contested', claim('C-contested', 'contested', undefined, [ev(before)]));
    ctx.state.claims.set('C-withdrawn', claim('C-withdrawn', 'resolved', 'withdrawn', [ev(before)]));
    ctx.state.claims.set('C-superseded', claim('C-superseded', 'resolved', 'superseded', [ev(before)]));

    const events = await checkStaleness(ctx);

    expect(events.map((event) => (event.kind === 'evidence_stale' ? event.claimId : ''))).toEqual([
      'C-open',
      'C-upheld',
      'C-contested',
    ]);
    // The two out of scope are untouched, not merely un-notified.
    expect(ctx.state.claims.get('C-withdrawn')?.evidence[0]?.stale).toBeUndefined();
    expect(ctx.state.claims.get('C-superseded')?.evidence[0]?.stale).toBeUndefined();
  }, TIMEOUT_MS);

  it('does not repeat itself on the next poll', async () => {
    const repo = await tempRepo();
    const { before } = await rebaseWorkOntoMain(repo);
    const ctx = context(repo);
    ctx.state.claims.set('C-1', upheldClaim('C-1', [ev(before)]));

    expect(await checkStaleness(ctx)).toHaveLength(1);
    expect(await checkStaleness(ctx)).toEqual([]);
  }, TIMEOUT_MS);
});

describe('the staleness sweep over submitted tasks', () => {
  it('sends a rebase notice that returns the task to in_progress', async () => {
    const repo = await tempRepo();
    const { before, head } = await rebaseWorkOntoMain(repo);
    const ctx = context(repo);
    ctx.state.tasks.set('T-1', task('T-1', 'submitted', [before]));

    const events = await checkStaleness(ctx);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'rebase_notice',
      room: 'task:T-1',
      taskId: 'T-1',
      newBase: head,
      from: 'leader',
    });
    expect(ctx.state.tasks.get('T-1')?.state).toBe('in_progress');
  }, TIMEOUT_MS);

  // The neighbouring case. Same stale evidence, a state §5.4 does not name.
  it.each(['under_review', 'accepted', 'merged', 'in_progress'] as const)(
    'leaves a %s task alone',
    async (state) => {
      const repo = await tempRepo();
      const { before } = await rebaseWorkOntoMain(repo);
      const ctx = context(repo);
      ctx.state.tasks.set('T-1', task('T-1', state, [before]));

      expect(await checkStaleness(ctx)).toEqual([]);
      expect(ctx.state.tasks.get('T-1')?.state).toBe(state);
    },
    TIMEOUT_MS,
  );

  it('sends one notice, not one per stale sha', async () => {
    const repo = await tempRepo();
    const { before } = await rebaseWorkOntoMain(repo);
    // A second orphan, so the task stands on two commits main no longer has.
    await git(repo, ['checkout', '-b', 'other', before]);
    await git(repo, ['commit', '--allow-empty', '-m', 'other']);
    const alsoOrphaned = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['checkout', 'main']);
    // Deleted so both shas are genuinely orphaned: a live branch would keep
    // them fresh under the reachability predicate, and rightly so.
    await git(repo, ['branch', '-D', 'other']);

    const ctx = context(repo);
    ctx.state.tasks.set('T-1', task('T-1', 'submitted', [before, alsoOrphaned]));

    const events = await checkStaleness(ctx);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('rebase_notice');
  }, TIMEOUT_MS);

  it('does not repeat itself on the next poll', async () => {
    const repo = await tempRepo();
    const { before } = await rebaseWorkOntoMain(repo);
    const ctx = context(repo);
    ctx.state.tasks.set('T-1', task('T-1', 'submitted', [before]));

    expect(await checkStaleness(ctx)).toHaveLength(1);
    expect(await checkStaleness(ctx)).toEqual([]);
  }, TIMEOUT_MS);
});

/**
 * The predicate is orphaned-ness, not ancestry of main. Honest evidence lives
 * at branch-per-task worktree HEADs — commits that are *never* ancestors of
 * main until merge — and the old ancestry-only sweep flagged all of it stale
 * within one tick, bouncing fresh submissions back to `in_progress` and
 * reopening claims settled minutes earlier.
 */
describe('the sweep measures against the main branch', () => {
  it('keeps evidence fresh that an unmerged local branch still contains', async () => {
    const repo = await tempRepo();
    await git(repo, ['checkout', '-b', 'work']);
    await git(repo, ['commit', '--allow-empty', '-m', 'work']);
    const onlyOnWork = await git(repo, ['rev-parse', 'HEAD']);
    const mainTip = await git(repo, ['rev-parse', 'main']);
    await git(repo, ['checkout', 'main']);

    expect(onlyOnWork).not.toBe(mainTip);

    const ctx = context(repo);
    ctx.state.claims.set('C-1', upheldClaim('C-1', [ev(onlyOnWork)]));

    expect(await checkStaleness(ctx)).toEqual([]);
    expect(ctx.state.claims.get('C-1')?.state).toBe('resolved');
  }, TIMEOUT_MS);

  it('names the branch when the configured one is not in this clone', async () => {
    const repo = await tempRepo();
    const ctx = context(repo);
    ctx.mainBranch = 'trunk';
    ctx.state.claims.set('C-1', upheldClaim('C-1', [ev(await git(repo, ['rev-parse', 'HEAD']))]));

    await expect(checkStaleness(ctx)).rejects.toThrow(/trunk/);
  }, TIMEOUT_MS);
});

/* ------------------------------------------------------------ fixtures -- */

/** Stamps `seq` and folds the event in, exactly as `Daemon.#append` does. */
function context(repo: string): StalenessContext & { state: HubState } {
  const state = emptyState();
  return {
    repo,
    mainBranch: 'main',
    who: 'leader',
    state,
    append: async (draft: DraftEvent): Promise<CrosstalkEvent> => {
      const event = { ...draft, seq: state.lastSeq + 1, ts: new Date().toISOString() } as CrosstalkEvent;
      applyEvent(state, event);
      return event;
    },
  };
}

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

function ev(sha: string): Evidence {
  return { kind: 'command', command: 'npm test', output: '278 passed', sha, by: 'codex' };
}

function claim(
  id: string,
  state: ClaimState,
  resolution: ClaimResolution | undefined,
  evidence: Evidence[],
): Claim {
  return {
    id,
    raisedBy: 'leader',
    against: 'codex',
    target: 'src/core/log.ts:41',
    assertion: 'the log orders by ts, not seq',
    severity: 'defect',
    falsifier: 'if this is wrong, replaying the fixture out of order produces identical state',
    evidence,
    state,
    rounds: 1,
    ...(resolution === undefined ? {} : { resolution }),
  };
}

/** The case §5.4 exists for: settled, and standing on evidence that moved. */
function upheldClaim(id: string, evidence: Evidence[]): Claim {
  return claim(id, 'resolved', 'upheld', evidence);
}

function task(id: string, state: TaskState, shas: string[]): Task {
  return {
    id,
    title: 'Build the log',
    brief: 'Implement the append-only event log.',
    specRefs: ['§5.2'],
    assignee: 'codex',
    deps: [],
    acceptance: ['the log appends by seq'],
    state,
    branch: `ct/${id}-log`,
    critique: {
      rounds: 1,
      critic: 'codex subagent',
      findings: shas.map((sha) => ({ assertion: 'the log appends by seq', closedBy: [ev(sha)] })),
    },
  };
}
