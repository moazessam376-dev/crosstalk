import { describe, it, expect } from 'vitest';
import { validateRaise, validateResponse } from '../../src/core/claims.js';
import type { Evidence, Claim } from '../../src/contracts/claim.js';
import type { HubState } from '../../src/core/projection.js';

const base = {
  raisedBy: 'leader',
  against: 'codex',
  target: 'src/economy.ts:41',
  assertion: 'staffing coefficient applied twice',
  severity: 'defect' as const,
  evidence: [{ kind: 'command' as const, command: 'npm test', output: 'ok', sha: 'abc', by: 'leader' }],
};

describe('claim validators', () => {
  it('rejects a claim with no falsifier', () => {
    expect(() => validateRaise({ ...base, falsifier: '' }, emptyState())).toThrowError(
      expect.objectContaining({ code: 'MISSING_FALSIFIER' }),
    );
  });

  it('rejects a vacuous falsifier', () => {
    expect(() => validateRaise({ ...base, falsifier: 'if it did not work' }, emptyState())).toThrowError(
      expect.objectContaining({ code: 'VACUOUS_FALSIFIER' }),
    );
  });

  it('accepts an observable falsifier with an ordinary verb', () => {
    const claim = validateRaise(
      { ...base, falsifier: 'The focused command prints two rows instead of one.' },
      emptyState(),
    );

    expect(claim.falsifier).toBe('The focused command prints two rows instead of one.');
  });
  it('rejects a contest with no rationale', () => {
    const state = stateWithOpenClaim('C-1');
    expect(() =>
      validateResponse(
        {
          claimId: 'C-1',
          from: 'codex',
          verdict: 'contest',
          falsifier: 'ledger would diverge on tick 3',
          evidence: [ev('x')],
        },
        state,
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONTEST_WITHOUT_RATIONALE' }));
  });

  it('rejects a response from a participant who is not the claim target', () => {
    const state = stateWithOpenClaim('C-1');
    expect(() =>
      validateResponse(
        {
          claimId: 'C-1',
          from: 'cursor',
          verdict: 'contest',
          rationale: 'the implementation is intentional',
          falsifier: 'a focused ledger check would show divergent multipliers',
          evidence: [ev('sha-new')],
        },
        state,
      ),
    ).toThrowError(/not authorized/i);
  });

  it('allows the brief owner to resolve a clarified brief claim', () => {
    const state = emptyState();
    state.participants.set('leader', {
      id: 'leader',
      role: 'leader',
      harness: '',
      lifecycle: 'attached',
      workspace: '',
    });
    state.claims.set('C-1', {
      ...claim('C-1', 'clarify', []),
      raisedBy: 'codex',
      against: 'brief',
    });

    expect(() =>
      validateResponse(
        { claimId: 'C-1', from: 'leader', verdict: 'accept', evidence: [ev('sha-new')] },
        state,
      ),
    ).not.toThrow();
  });

  it('allows the claimant to withdraw a clarified claim', () => {
    const state = emptyState();
    state.claims.set('C-1', claim('C-1', 'clarify', []));

    expect(() =>
      validateResponse(
        {
          claimId: 'C-1',
          from: 'leader',
          verdict: 'concede',
          rationale: 'The brief was amended and the claim is withdrawn.',
          evidence: [],
        },
        state,
      ),
    ).not.toThrow();
  });

  it('rejects responses after a claim is resolved', () => {
    const state = emptyState();
    state.claims.set('C-1', claim('C-1', 'resolved', []));

    expect(() =>
      validateResponse(
        { claimId: 'C-1', from: 'codex', verdict: 'accept', evidence: [ev('sha-new')] },
        state,
      ),
    ).toThrowError(/resolved/i);
  });

  it('rejects an uphold that carries no evidence newer than the contest', () => {
    const state = stateWithContestedClaim('C-1', 'sha-old');
    expect(() =>
      validateResponse({ claimId: 'C-1', from: 'leader', verdict: 'uphold', evidence: [ev('sha-old')] }, state),
    ).toThrowError(expect.objectContaining({ code: 'UPHOLD_WITHOUT_NEW_EVIDENCE' }));
  });

  it('accepts an uphold carrying evidence not already on the claim', () => {
    const state = stateWithContestedClaim('C-1', 'sha-old');
    expect(() =>
      validateResponse({ claimId: 'C-1', from: 'leader', verdict: 'uphold', evidence: [ev('sha-new')] }, state),
    ).not.toThrow();
  });
});

function ev(sha: string): Evidence {
  return { kind: 'command', command: 'x', output: 'y', sha, by: 'leader' };
}

function emptyState(): HubState {
  return {
    participants: new Map(),
    tasks: new Map(),
    claims: new Map(),
    decisions: new Map(),
    messages: [],
    lastSeq: 0,
  };
}

function stateWithOpenClaim(id: string): HubState {
  const state = emptyState();
  state.claims.set(id, claim(id, 'open', []));
  return state;
}

function stateWithContestedClaim(id: string, sha: string): HubState {
  const state = emptyState();
  state.claims.set(id, claim(id, 'contested', [ev(sha)]));
  return state;
}

function claim(id: string, state: Claim['state'], evidence: Evidence[]): Claim {
  return {
    id,
    raisedBy: 'leader',
    against: 'codex',
    target: 'src/economy.ts:41',
    assertion: 'staffing coefficient applied twice',
    severity: 'defect',
    falsifier: 'production and consumption multipliers would be different in the focused ledger check',
    evidence,
    state,
    rounds: state === 'contested' ? 1 : 0,
  };
}
