import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project, type HubState } from '../../src/core/projection.js';
import type { CrosstalkEvent, DraftEvent } from '../../src/contracts/events.js';
import type { ClaimVerdict, Evidence } from '../../src/contracts/claim.js';
import type { Task, TaskState } from '../../src/contracts/task.js';

async function loadFixture(name: string): Promise<CrosstalkEvent[]> {
  const raw = await readFile(join('tests', 'fixtures', `${name}.jsonl`), 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as CrosstalkEvent);
}

describe('project', () => {
  it('is deterministic — same events, same state', async () => {
    const events = await loadFixture('session-dispute');
    expect(JSON.stringify(project(events), replacer))
      .toEqual(JSON.stringify(project(events), replacer));
  });

  it('folds a contested claim to state "contested" with rounds preserved', async () => {
    const state = project(await loadFixture('session-dispute'));
    const claim = state.claims.get('C-118');
    expect(claim?.state).toBe('contested');
    expect(claim?.rounds).toBe(3);
  });

  it('marks evidence stale when an evidence_stale event names its sha', async () => {
    const state = project(await loadFixture('session-dispute'));
    const claim = state.claims.get('C-118')!;
    expect(claim.evidence.some((e) => e.stale === true)).toBe(true);
  });

  it('orders by seq while preserving message timestamps', async () => {
    const events = await loadFixture('session-dispute');
    const scrambled = events.map((event, i) => ({
      ...event,
      ts: new Date(2000, 0, events.length - i).toISOString(),
    }));

    const actual = project(scrambled);
    const expectedMessages = scrambled
      .filter((event): event is Extract<CrosstalkEvent, { kind: 'message' }> => event.kind === 'message')
      .sort((a, b) => a.seq - b.seq);

    expect(actual.messages).toEqual(expectedMessages);

    const baseline = project(events);
    expect(actual.lastSeq).toBe(baseline.lastSeq);
    expect([...actual.participants.keys()]).toEqual([...baseline.participants.keys()]);
    expect([...actual.tasks.keys()]).toEqual([...baseline.tasks.keys()]);
    expect([...actual.claims.keys()]).toEqual([...baseline.claims.keys()]);
    expect([...actual.decisions.keys()]).toEqual([...baseline.decisions.keys()]);
  });

  it.each([
    ['accept', 'upheld'],
    ['concede', 'withdrawn'],
    ['amend', 'superseded'],
  ] as const)('resolves %s claim responses as %s', (verdict, resolution) => {
    const claim = project(claimResponseEvents(verdict)).claims.get('C-1');
    expect(claim?.state).toBe('resolved');
    expect(claim?.resolution).toBe(resolution);
  });
});

function replacer(_k: string, v: unknown) {
  return v instanceof Map ? Object.fromEntries([...v.entries()].sort()) : v;
}

function claimResponseEvents(verdict: ClaimVerdict): CrosstalkEvent[] {
  return [
    {
      seq: 1,
      ts: '2026-08-09T00:00:00.000Z',
      kind: 'claim_raised',
      from: 'leader',
      claim: {
        id: 'C-1',
        raisedBy: 'leader',
        against: 'codex',
        target: 'src/example.ts:1',
        assertion: 'Example claim',
        severity: 'defect',
        falsifier: 'If wrong, the focused projection test shows a different resolution.',
        evidence: [],
        state: 'open',
        rounds: 0,
      },
    },
    {
      seq: 2,
      ts: '2026-08-09T00:00:01.000Z',
      kind: 'claim_response',
      from: 'codex',
      claimId: 'C-1',
      verdict,
      rationale: 'Focused projection response.',
      falsifier: 'If wrong, this event will not project to the expected terminal resolution.',
      evidence: [],
    },
  ];
}

describe('lastResponder', () => {
  // A1: the alternation is decided from this field, so the projection deriving
  // it is what makes the validator able to ask "whose turn is it?" at all.
  it('records who answered last, and moves it on the next response', () => {
    const afterContest = project(responseSequence(['codex']));
    expect(afterContest.claims.get('C-1')!.lastResponder).toBe('codex');

    // The neighbouring case: a second response from the other side must move
    // the field, not leave the first responder latched.
    const afterUphold = project(responseSequence(['codex', 'leader']));
    expect(afterUphold.claims.get('C-1')!.lastResponder).toBe('leader');
    expect(afterUphold.claims.get('C-1')!.rounds).toBe(2);
  });

  it('is unset on a claim nobody has answered', () => {
    expect(project(responseSequence([])).claims.get('C-1')!.lastResponder).toBeUndefined();
  });
});

/** A raised claim followed by one `claim_response` per entry in `from`. */
function responseSequence(from: string[]): CrosstalkEvent[] {
  const events: CrosstalkEvent[] = [
    {
      seq: 1,
      ts: '2026-08-09T00:00:00.000Z',
      kind: 'claim_raised',
      from: 'leader',
      room: 'dispute:C-1',
      claim: {
        id: 'C-1',
        raisedBy: 'leader',
        against: 'codex',
        target: 'src/example.ts:1',
        assertion: 'Example claim',
        severity: 'defect',
        falsifier: 'If wrong, the focused projection test shows a different responder.',
        evidence: [],
        state: 'open',
        rounds: 0,
      },
    },
  ];
  from.forEach((who, index) => {
    events.push({
      seq: index + 2,
      ts: `2026-08-09T00:00:0${index + 1}.000Z`,
      kind: 'claim_response',
      from: who,
      room: 'dispute:C-1',
      claimId: 'C-1',
      verdict: who === 'leader' ? 'uphold' : 'contest',
      rationale: 'Focused projection response.',
      falsifier: 'If wrong, this event will not project to the expected responder.',
      evidence: [],
    } as CrosstalkEvent);
  });
  return events;
}

/* ------------------------------------------------------- A5: staleness -- */

/**
 * §5.4's consequences. `evidence_stale` marking the item was already here; what
 * was missing is the part that makes the marking matter — a claim whose whole
 * case has been rewritten out from under it stops counting as settled.
 */
describe('evidence_stale reopens a claim that has nothing left to stand on', () => {
  it('returns an upheld claim to open and clears the resolution', () => {
    const state = replay([
      ...answeredClaim('C-1', 'accept', [ev('sha-raiser')], [ev('sha-fix')]),
      stale('C-1', 'sha-raiser'),
      stale('C-1', 'sha-fix'),
    ]);
    const claim = state.claims.get('C-1')!;

    expect(claim.state).toBe('open');
    // Omitted, not set to `undefined`: an own undefined key survives the
    // determinism test's serialised comparison.
    expect('resolution' in claim).toBe(false);
    // A reopened claim takes a triage verdict; the round cap governs the
    // ladder, and this argument has already had its rounds.
    expect(claim.rounds).toBe(1);
    expect(claim.evidence.every((item) => item.stale === true)).toBe(true);
  });

  it('leaves a claim resolved while one fresh piece still holds it up', () => {
    const state = replay([
      ...answeredClaim('C-1', 'accept', [ev('sha-raiser')], [ev('sha-fix')]),
      stale('C-1', 'sha-raiser'),
    ]);
    const claim = state.claims.get('C-1')!;

    expect(claim.state).toBe('resolved');
    expect(claim.resolution).toBe('upheld');
    // The marking still happened — this is not "the event was ignored".
    expect(claim.evidence.filter((item) => item.stale === true)).toHaveLength(1);
  });

  it('does not reopen a claim that carries no evidence at all', () => {
    // `[].every(...)` is true, so an evidence-free claim would reopen on a sha
    // it never carried. The suite above builds exactly such a claim.
    const state = replay([
      ...answeredClaim('C-2', 'accept', [], []),
      stale('C-2', 'a-sha-this-claim-never-carried'),
    ]);

    expect(state.claims.get('C-2')?.state).toBe('resolved');
    expect(state.claims.get('C-2')?.resolution).toBe('upheld');
  });

  it.each([
    ['concede', 'withdrawn'],
    ['amend', 'superseded'],
  ] as const)('does not resurrect a %s claim', (verdict, resolution) => {
    const state = replay([
      ...answeredClaim('C-3', verdict, [ev('sha-old')], [ev('sha-old')]),
      stale('C-3', 'sha-old'),
    ]);
    const claim = state.claims.get('C-3')!;

    expect(claim.state).toBe('resolved');
    expect(claim.resolution).toBe(resolution);
  });

  it('still only marks, on a claim that was never resolved', () => {
    const state = replay([...raisedClaim('C-4', [ev('sha-old')]), stale('C-4', 'sha-old')]);
    const claim = state.claims.get('C-4')!;

    expect(claim.state).toBe('open');
    expect(claim.evidence[0]?.stale).toBe(true);
  });

  // A live argument is not reopened, it is already open — and `open` and
  // `contested` route the next response to opposite participants, so
  // flattening one into the other hands the turn to the wrong side.
  it('does not flatten a contested claim to open when its evidence all goes stale', () => {
    const state = replay([
      ...answeredClaim('C-5', 'contest', [ev('sha-raiser')], [ev('sha-counter')]),
      stale('C-5', 'sha-raiser'),
      stale('C-5', 'sha-counter'),
    ]);
    const claim = state.claims.get('C-5')!;

    expect(claim.state).toBe('contested');
    expect(claim.evidence.every((item) => item.stale === true)).toBe(true);
  });
});

describe('rebase_notice returns a submitted task to in_progress', () => {
  it('moves the task out of the review queue', () => {
    const state = replay([...task('T-1', 'submitted'), rebase('T-1')]);
    expect(state.tasks.get('T-1')?.state).toBe('in_progress');
  });

  // Without this the handler is indistinguishable from "set every task to
  // in_progress whenever anything rebases".
  it.each(['under_review', 'accepted', 'merged', 'self_reviewed', 'assigned'] as const)(
    'leaves a %s task where it is',
    (state) => {
      expect(replay([...task('T-1', state), rebase('T-1')]).tasks.get('T-1')?.state).toBe(state);
    },
  );

  it('ignores a notice for a task nobody created', () => {
    expect(replay([rebase('T-404')]).tasks.size).toBe(0);
  });
});

/** Stamps `seq` and `ts` the way the daemon does, so `project` has an order. */
function replay(drafts: DraftEvent[]): HubState {
  return project(
    drafts.map(
      (draft, index) =>
        ({
          ...draft,
          seq: index + 1,
          ts: new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString(),
        }) as CrosstalkEvent,
    ),
  );
}

function ev(sha: string): Evidence {
  return { kind: 'command', command: 'npm test', output: '3 passed', sha, by: 'codex' };
}

function raisedClaim(id: string, evidence: Evidence[]): DraftEvent[] {
  return [
    {
      kind: 'claim_raised',
      from: 'leader',
      room: `dispute:${id}`,
      claim: {
        id,
        raisedBy: 'leader',
        against: 'codex',
        target: 'src/example.ts:1',
        assertion: 'the example is wrong',
        severity: 'defect',
        falsifier: 'if this is wrong, the example test passes at the head of the main branch',
        evidence,
        state: 'open',
        rounds: 0,
      },
    },
  ];
}

/**
 * A resolution is never authored — `resolutionForVerdict` derives it from a
 * verdict — so every resolved claim here is built the only way one exists.
 */
function answeredClaim(
  id: string,
  verdict: ClaimVerdict,
  raiserEvidence: Evidence[],
  answerEvidence: Evidence[],
): DraftEvent[] {
  return [
    ...raisedClaim(id, raiserEvidence),
    {
      kind: 'claim_response',
      from: verdict === 'accept' ? 'codex' : 'leader',
      room: `dispute:${id}`,
      claimId: id,
      verdict,
      rationale: 'Answered.',
      evidence: answerEvidence,
    },
  ];
}

function stale(claimId: string, sha: string): DraftEvent {
  return { kind: 'evidence_stale', from: 'leader', room: `dispute:${claimId}`, claimId, sha };
}

function rebase(taskId: string): DraftEvent {
  return {
    kind: 'rebase_notice',
    from: 'leader',
    room: `task:${taskId}`,
    taskId,
    newBase: 'new-main-sha',
  };
}

function task(id: string, state: TaskState): DraftEvent[] {
  const created: Task = {
    id,
    title: 'Build the log',
    brief: 'Implement the append-only event log.',
    specRefs: ['§5.2'],
    assignee: 'codex',
    deps: [],
    acceptance: ['the log appends by seq'],
    state: 'draft',
    branch: `ct/${id}-log`,
  };
  return [
    { kind: 'task_created', from: 'leader', room: `task:${id}`, task: created },
    { kind: 'task_state', from: 'leader', room: `task:${id}`, taskId: id, state },
  ];
}
