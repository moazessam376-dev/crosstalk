import { describe, it, expect } from 'vitest';
import { responderFor, validateRaise, validateResponse } from '../../src/core/claims.js';
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
    rungs: new Map(),
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

/**
 * A1 — in `contested`, the eligible responder is whoever did *not* answer last.
 * Before this, `contested` admitted only `claim.raisedBy`, so the leader could
 * uphold forever and the worker got exactly one turn.
 */
describe('a dispute alternates', () => {
  it('resolves the responder to the target for a claim against a participant', () => {
    const state = disputeState({ against: 'codex' });
    expect(responderFor(state.claims.get('C-1')!, state)).toBe('codex');
  });

  it('resolves the responder to the brief owner for a claim against the spec', () => {
    const state = disputeState({ against: 'spec', raisedBy: 'codex' });
    // Never `claim.against` directly: 'spec' is not a participant and the
    // comparison would match nobody. This is the claim shape the plan reviews
    // themselves used.
    expect(responderFor(state.claims.get('C-1')!, state)).toBe('leader');
  });

  it('lets the responder contest again after the raiser upholds', () => {
    const state = disputeState({ against: 'codex', lastResponder: 'leader' });
    expect(() => validateResponse(contestBy('codex'), state)).not.toThrow();
  });

  it('refuses the responder answering twice in a row', () => {
    const state = disputeState({ against: 'codex', lastResponder: 'codex' });
    expect(() => validateResponse(contestBy('codex'), state)).toThrowError(
      expect.objectContaining({ code: 'NOT_CLAIM_RESPONDER' }),
    );
  });

  it('refuses the raiser upholding twice in a row', () => {
    const state = disputeState({ against: 'codex', lastResponder: 'leader' });
    expect(() =>
      validateResponse(
        { claimId: 'C-1', from: 'leader', verdict: 'uphold', evidence: [ev('sha-new')] },
        state,
      ),
    ).toThrowError(expect.objectContaining({ code: 'NOT_CLAIM_RESPONDER' }));
  });

  it('still lets the raiser answer when nobody has answered yet', () => {
    // The neighbouring case: `lastResponder` unset is the pre-A1 behaviour and
    // must keep working, or every claim already in a log changes meaning.
    const state = disputeState({ against: 'codex' });
    expect(() =>
      validateResponse(
        { claimId: 'C-1', from: 'leader', verdict: 'uphold', evidence: [ev('sha-new')] },
        state,
      ),
    ).not.toThrow();
  });

  it('gives the raiser the turn on a spec claim once the brief owner has answered', () => {
    // Raiser `codex`, responder = brief owner = `leader`. The leader answered
    // last, so the raiser holds the turn: concede | amend | uphold.
    const state = disputeState({ against: 'spec', raisedBy: 'codex', lastResponder: 'leader' });
    expect(() =>
      validateResponse(
        { claimId: 'C-1', from: 'codex', verdict: 'uphold', evidence: [ev('sha-new')] },
        state,
      ),
    ).not.toThrow();
    // The neighbouring case: the brief owner may not take the raiser's turn.
    expect(() => validateResponse(contestBy('leader'), state)).toThrowError(
      expect.objectContaining({ code: 'NOT_CLAIM_RESPONDER' }),
    );
  });

  it('gives the brief owner the turn on a spec claim once the raiser has answered', () => {
    const state = disputeState({ against: 'spec', raisedBy: 'codex', lastResponder: 'codex' });
    expect(() => validateResponse(contestBy('leader'), state)).not.toThrow();
    expect(() => validateResponse(contestBy('codex'), state)).toThrowError(
      expect.objectContaining({ code: 'NOT_CLAIM_RESPONDER' }),
    );
  });
});

function contestBy(from: string) {
  return {
    claimId: 'C-1',
    from,
    verdict: 'contest' as const,
    rationale: 'built this way because replay determinism needs a single pass',
    falsifier: 'the focused ledger check would print two rows rather than one',
    evidence: [ev('sha-counter')],
  };
}

function disputeState(opts: {
  against: Claim['against'];
  raisedBy?: string;
  lastResponder?: string;
}): HubState {
  const state = emptyState();
  state.participants.set('leader', {
    id: 'leader',
    role: 'leader',
    harness: 'claude-code-app',
    lifecycle: 'attached',
    workspace: '.',
  } as never);
  state.participants.set('codex', {
    id: 'codex',
    role: 'worker',
    harness: 'codex-cli',
    lifecycle: 'attached',
    workspace: '.crosstalk/worktrees/codex',
  } as never);
  state.claims.set('C-1', {
    ...claim('C-1', 'contested', [ev('sha-old')]),
    raisedBy: opts.raisedBy ?? 'leader',
    against: opts.against,
    rounds: 2,
    ...(opts.lastResponder === undefined ? {} : { lastResponder: opts.lastResponder }),
  });
  return state;
}
