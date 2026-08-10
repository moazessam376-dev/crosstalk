import { describe, expect, it } from 'vitest';

import type { Claim } from '../../src/contracts/claim.js';
import type { Decision, LadderRung } from '../../src/contracts/decision.js';
import type { Participant } from '../../src/contracts/participant.js';
import { adjudicatorFor, nextRung, planLadder } from '../../src/core/ladder.js';
import type { HubState } from '../../src/core/projection.js';

const DEFAULT_LADDER: LadderRung[] = ['discriminating_test', 'third_agent', 'leader'];

function participant(id: string, role: 'leader' | 'worker'): Participant {
  return { id, role, harness: 'codex-cli', lifecycle: 'attached', workspace: '.' } as Participant;
}

function state(
  workers: string[],
  claim?: Partial<Claim>,
): HubState {
  const hub: HubState = {
    participants: new Map([['leader', participant('leader', 'leader')]]),
    tasks: new Map(),
    claims: new Map(),
    decisions: new Map(),
    rungs: new Map(),
    messages: [],
    lastSeq: 0,
  };
  for (const id of workers) hub.participants.set(id, participant(id, 'worker'));
  if (claim !== undefined) {
    hub.claims.set('C-1', {
      id: 'C-1',
      raisedBy: 'codex',
      against: 'cursor',
      target: 'src/economy.ts:41',
      assertion: 'staffing coefficient applied twice',
      severity: 'defect',
      falsifier: 'the focused ledger check would print two rows rather than one',
      evidence: [],
      state: 'contested',
      rounds: 4,
      ...claim,
    });
  }
  return hub;
}

describe('planLadder', () => {
  it('keeps every rung when two workers can supply an uninvolved peer', () => {
    const plan = planLadder(DEFAULT_LADDER, state(['codex', 'cursor']));
    expect(plan.ladder).toEqual(DEFAULT_LADDER);
    expect(plan.skipped).toEqual([]);
    expect(plan.start).toBe(0);
  });

  it('skips third_agent with one worker, and names why', () => {
    const plan = planLadder(DEFAULT_LADDER, state(['codex']));
    // Skipped, never silent — audit F-07. A degraded ladder must not read as a
    // ladder somebody deliberately configured short.
    expect(plan.skipped.map((s) => s.rung)).toEqual(['third_agent']);
    expect(plan.skipped[0]!.reason).toMatch(/worker/i);
    // The full ladder is still reported, so the rail can render the gap.
    expect(plan.ladder).toEqual(DEFAULT_LADDER);
  });

  it('starts at the first attemptable rung when the first is skipped', () => {
    const plan = planLadder(['third_agent', 'leader'], state(['codex']));
    expect(plan.start).toBe(1);
  });
});

describe('adjudicatorFor', () => {
  it('returns the uninvolved worker', () => {
    const hub = state(['codex', 'cursor', 'gemini'], {});
    expect(adjudicatorFor('C-1', hub)).toBe('gemini');
  });

  it('never returns either disputant', () => {
    const hub = state(['codex', 'cursor', 'gemini'], {});
    const chosen = adjudicatorFor('C-1', hub);
    expect(chosen).not.toBe('codex');
    expect(chosen).not.toBe('cursor');
  });

  it('is undefined when both workers are the disputants', () => {
    expect(adjudicatorFor('C-1', state(['codex', 'cursor'], {}))).toBeUndefined();
  });

  it('excludes the brief owner as a disputant on a spec claim', () => {
    // `against: 'spec'` resolves to the leader through responderFor. The leader
    // is not a worker so it cannot be the adjudicator anyway, but the raiser
    // must still be excluded.
    const hub = state(['codex', 'cursor'], { against: 'spec', raisedBy: 'codex' });
    expect(adjudicatorFor('C-1', hub)).toBe('cursor');
  });

  it('is undefined for a claim that does not exist', () => {
    expect(adjudicatorFor('C-99', state(['codex', 'cursor']))).toBeUndefined();
  });
});

describe('nextRung', () => {
  const decision = (over: Partial<Decision> = {}): Decision => ({
    id: 'D-1',
    question: 'settle C-1',
    options: ['raiser', 'responder'],
    voters: ['codex', 'cursor', 'leader', '@human'],
    method: 'ladder',
    ladder: DEFAULT_LADDER,
    currentRung: 0,
    rationale: [],
    votes: {},
    claimId: 'C-1',
    ...over,
  });

  it('advances to the next attemptable rung', () => {
    const hub = state(['codex', 'cursor', 'gemini'], {});
    expect(nextRung(decision(), hub)).toEqual({ rung: 'third_agent', index: 1 });
  });

  it('steps over a skipped rung', () => {
    // One worker beyond the disputants is what third_agent needs; with only the
    // two disputants it is unattemptable and the ladder must not stop there.
    const hub = state(['codex', 'cursor'], {});
    expect(nextRung(decision(), hub)).toEqual({ rung: 'leader', index: 2 });
  });

  it('is undefined at the last rung, which is terminal', () => {
    const hub = state(['codex', 'cursor', 'gemini'], {});
    expect(nextRung(decision({ currentRung: 2 }), hub)).toBeUndefined();
  });

  it('advances from the live rung, not the open-time snapshot', () => {
    const hub = state(['codex', 'cursor', 'gemini'], {});
    hub.rungs.set('D-1', { rung: 'third_agent', index: 1, adjudicator: 'gemini' });
    // currentRung is still 0; the ladder has climbed underneath it.
    expect(nextRung(decision(), hub)).toEqual({ rung: 'leader', index: 2 });
  });
});
