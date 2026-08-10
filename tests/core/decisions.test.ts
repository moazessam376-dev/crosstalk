import { describe, expect, it } from 'vitest';
import type { Decision, DecisionMethod } from '../../src/contracts/decision.js';
import { resolvableRungs, tally, validateLadder } from '../../src/core/decisions.js';
import type { HubState } from '../../src/core/projection.js';
import type { Participant } from '../../src/contracts/participant.js';

describe('dispute ladder', () => {
  it('rejects a ladder whose last rung is not terminal', () => {
    expect(() => validateLadder(['discriminating_test', 'third_agent'])).toThrowError(
      expect.objectContaining({ code: 'NON_TERMINAL_LADDER' }),
    );
  });

  it('accepts the default ladder', () => {
    expect(() => validateLadder(['discriminating_test', 'third_agent', 'leader'])).not.toThrow();
  });

  it('drops third_agent when there are fewer than two workers', () => {
    expect(resolvableRungs(['discriminating_test', 'third_agent', 'leader'], 1)).toEqual([
      'discriminating_test',
      'leader',
    ]);
  });

  it('keeps third_agent with two workers', () => {
    expect(resolvableRungs(['discriminating_test', 'third_agent', 'leader'], 2)).toEqual([
      'discriminating_test',
      'third_agent',
      'leader',
    ]);
  });

  it('tallies a majority and returns null before quorum', () => {
    const d = decision({ method: 'majority', voters: ['a', 'b', 'c'], votes: { a: 'yes' } });
    expect(tally(d, stateWithLeader())).toBeNull();
    expect(tally({ ...d, votes: { a: 'yes', b: 'yes' } }, stateWithLeader())).toBe('yes');
  });

  it('returns null for unanimous when any voter dissents', () => {
    const d = decision({ method: 'unanimous', voters: ['a', 'b'], votes: { a: 'yes', b: 'no' } });
    expect(tally(d, stateWithLeader())).toBeNull();
  });

  it('does not resolve a leader decision from a non-leader vote', () => {
    // The authority is the participant holding `role: 'leader'`, not whoever
    // happens to be listed first. Ordering `voters` with a worker ahead of the
    // leader used to hand a worker the decision.
    const d = decision({ method: 'leader', voters: ['worker', 'leader'], votes: { worker: 'yes' } });
    expect(tally(d, stateWithLeader())).toBeNull();
  });

  it('resolves a leader decision on the leader vote', () => {
    const d = decision({
      method: 'leader',
      voters: ['worker', 'leader'],
      votes: { worker: 'yes', leader: 'no' },
    });
    expect(tally(d, stateWithLeader())).toBe('no');
  });

  it('does not resolve a human decision from anyone but @human', () => {
    const d = decision({ method: 'human', voters: ['leader', '@human'], votes: { leader: 'yes' } });
    expect(tally(d, stateWithLeader())).toBeNull();
  });

  it('resolves a human decision on the @human vote', () => {
    const d = decision({
      method: 'human',
      voters: ['leader', '@human'],
      votes: { leader: 'yes', '@human': 'no' },
    });
    expect(tally(d, stateWithLeader())).toBe('no');
  });
});

function stateWithLeader(): HubState {
  return {
    participants: new Map<string, Participant>([
      ['leader', { id: 'leader', role: 'leader', harness: 'claude-code-app', lifecycle: 'attached', workspace: '.' } as Participant],
      ['worker', { id: 'worker', role: 'worker', harness: 'codex-cli', lifecycle: 'attached', workspace: '.' } as Participant],
    ]),
    tasks: new Map(),
    claims: new Map(),
    decisions: new Map(),
    rungs: new Map(),
    messages: [],
    lastSeq: 0,
  };
}

function decision({ method, ...overrides }: Partial<Decision> & { method: DecisionMethod }): Decision {
  return {
    id: 'D-1',
    question: 'Should the claim stand?',
    options: ['yes', 'no'],
    voters: [],
    method,
    rationale: [],
    votes: {},
    ...overrides,
  };
}
