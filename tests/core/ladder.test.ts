import { describe, expect, it } from 'vitest';

import type { Claim } from '../../src/contracts/claim.js';
import { DEFAULT_POLICY, type CrosstalkConfig } from '../../src/contracts/config.js';
import type { Decision, LadderRung } from '../../src/contracts/decision.js';
import type { Participant } from '../../src/contracts/participant.js';
import { adjudicatorFor, nextRung, planLadder } from '../../src/core/ladder.js';
import type { HubState } from '../../src/core/projection.js';

const DEFAULT_LADDER: LadderRung[] = ['discriminating_test', 'third_agent', 'leader'];

function participant(id: string, role: 'leader' | 'worker'): Participant {
  return { id, role, harness: 'codex-cli', lifecycle: 'attached', workspace: '.' } as Participant;
}

/** `workers` are configured; `connected` are the subset that have polled. */
function fixture(workers: string[], connected: string[] = workers, claim?: Partial<Claim>) {
  const config: CrosstalkConfig = {
    version: 1,
    project: { repo: '.', mainBranch: 'main' },
    participants: [participant('leader', 'leader'), ...workers.map((w) => participant(w, 'worker'))],
    policy: DEFAULT_POLICY,
  };

  const state: HubState = {
    participants: new Map([['leader', participant('leader', 'leader')]]),
    tasks: new Map(),
    claims: new Map(),
    decisions: new Map(),
    rungs: new Map(),
    messages: [],
    lastSeq: 0,
  };
  for (const id of connected) state.participants.set(id, participant(id, 'worker'));

  if (claim !== undefined) {
    state.claims.set('C-1', {
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
  return { config, state };
}

describe('planLadder plans from the configuration', () => {
  it('keeps third_agent with two workers configured and both connected', () => {
    const { config } = fixture(['codex', 'cursor']);
    expect(planLadder(DEFAULT_LADDER, config).skipped).toEqual([]);
  });

  it('keeps third_agent with two workers configured and only one connected', () => {
    // C-14, and the case a HubState count gets wrong. Agents attaching at
    // different times is what `lifecycle: attached` means — it is the normal
    // case, not a race.
    const { config } = fixture(['codex', 'cursor'], ['codex']);
    expect(planLadder(DEFAULT_LADDER, config).skipped).toEqual([]);
    expect(planLadder(DEFAULT_LADDER, config).start).toBe(0);
  });

  it('skips third_agent with one worker configured, blaming the configuration', () => {
    const { config } = fixture(['codex']);
    const plan = planLadder(DEFAULT_LADDER, config);
    expect(plan.skipped.map((s) => s.rung)).toEqual(['third_agent']);
    // The reason must say *configured*, or it blames something not at fault.
    expect(plan.skipped[0]!.reason).toMatch(/configur/i);
    expect(plan.ladder).toEqual(DEFAULT_LADDER);
  });

  it('starts at the first attemptable rung when the first is skipped', () => {
    const { config } = fixture(['codex']);
    expect(planLadder(['third_agent', 'leader'], config).start).toBe(1);
  });
});

describe('adjudicatorFor answers who can rule now', () => {
  it('returns the uninvolved worker', () => {
    const { config, state } = fixture(['codex', 'cursor', 'gemini'], undefined, {});
    expect(adjudicatorFor('C-1', config, state)).toBe('gemini');
  });

  it('never returns either disputant', () => {
    const { config, state } = fixture(['codex', 'cursor', 'gemini'], undefined, {});
    const chosen = adjudicatorFor('C-1', config, state);
    expect(chosen).not.toBe('codex');
    expect(chosen).not.toBe('cursor');
  });

  it('prefers a connected peer over a configured one', () => {
    const { config, state } = fixture(
      ['codex', 'cursor', 'gemini', 'llama'],
      ['codex', 'cursor', 'llama'],
      {},
    );
    // gemini is configured but has not polled; llama has.
    expect(adjudicatorFor('C-1', config, state)).toBe('llama');
  });

  it('falls back to a configured peer when none is connected', () => {
    // It will wake through await_turn. Refusing to name it would lose the rung
    // for the same reason C-14 lost it.
    const { config, state } = fixture(['codex', 'cursor', 'gemini'], ['codex', 'cursor'], {});
    expect(adjudicatorFor('C-1', config, state)).toBe('gemini');
  });

  it('is undefined when both workers are the disputants', () => {
    const { config, state } = fixture(['codex', 'cursor'], undefined, {});
    expect(adjudicatorFor('C-1', config, state)).toBeUndefined();
  });

  it('excludes the brief owner as a disputant on a spec claim', () => {
    const { config, state } = fixture(['codex', 'cursor'], undefined, {
      against: 'spec',
      raisedBy: 'codex',
    });
    expect(adjudicatorFor('C-1', config, state)).toBe('cursor');
  });

  it('is undefined for a claim that does not exist', () => {
    const { config, state } = fixture(['codex', 'cursor']);
    expect(adjudicatorFor('C-99', config, state)).toBeUndefined();
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
    const { config, state } = fixture(['codex', 'cursor', 'gemini'], undefined, {});
    expect(nextRung(decision(), state)).toEqual({ rung: 'third_agent', index: 1 });
  });

  it('returns a rung with no uninvolved peer rather than skipping it', () => {
    // The daemon enters it and fails it with `no_uninvolved_peer`, so the log
    // shows the rung was tried. Skipping here would make an unavailable
    // third_agent look like a ladder that never had one.
    const { state } = fixture(['codex', 'cursor'], undefined, {});
    expect(nextRung(decision(), state)).toEqual({ rung: 'third_agent', index: 1 });
  });

  it('is undefined at the last rung, which is terminal', () => {
    const { config, state } = fixture(['codex', 'cursor', 'gemini'], undefined, {});
    expect(nextRung(decision({ currentRung: 2 }), state)).toBeUndefined();
  });

  it('advances from the live rung, not the open-time snapshot', () => {
    const { config, state } = fixture(['codex', 'cursor', 'gemini'], undefined, {});
    state.rungs.set('D-1', { rung: 'third_agent', index: 1, adjudicator: 'gemini' });
    expect(nextRung(decision(), state)).toEqual({ rung: 'leader', index: 2 });
  });
});
