import { describe, expect, it } from 'vitest';
import type { Decision, DecisionMethod } from '../../src/contracts/decision.js';
import { resolvableRungs, tally, validateLadder } from '../../src/core/decisions.js';

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
    expect(tally(d)).toBeNull();
    expect(tally({ ...d, votes: { a: 'yes', b: 'yes' } })).toBe('yes');
  });

  it('returns null for unanimous when any voter dissents', () => {
    const d = decision({ method: 'unanimous', voters: ['a', 'b'], votes: { a: 'yes', b: 'no' } });
    expect(tally(d)).toBeNull();
  });


  it.each(['leader', 'human'] as const)('does not resolve %s from an unlisted vote', (method) => {
    const d = decision({
      method,
      voters: ['leader'],
      votes: { worker: 'yes' },
    });

    expect(tally(d)).toBeNull();
  });

  it.each(['leader', 'human'] as const)('uses the listed authority vote for %s', (method) => {
    const d = decision({
      method,
      voters: ['leader'],
      votes: { worker: 'yes', leader: 'no' },
    });

    expect(tally(d)).toBe('no');
  });
});

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
