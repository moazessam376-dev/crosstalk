import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from '../../src/core/projection.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { ClaimVerdict } from '../../src/contracts/claim.js';

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
