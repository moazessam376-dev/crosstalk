import { describe, it, expect } from 'vitest';

import { claimMarker, findMarkedComment, renderClaimComment } from '../../src/mirror/render.js';

import type { Claim } from '../../src/contracts/claim.js';

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'C-118',
    raisedBy: 'leader',
    against: 'codex',
    target: 'src/economy.ts:41',
    assertion: 'The refund path double-credits on a retried charge.',
    severity: 'defect',
    falsifier: 'A retried charge that credits once in the ledger refutes this.',
    evidence: [{ kind: 'command', command: 'npm test -- refund', sha: 'abc1234', by: 'leader' }],
    state: 'open',
    rounds: 0,
    ...overrides,
  };
}

describe('the claim comment', () => {
  it('carries a marker naming the claim, so the mirror can find it again', () => {
    const body = renderClaimComment(claim());

    expect(body).toContain(claimMarker('C-118'));
    // The marker must not be visible prose — it is an HTML comment.
    expect(claimMarker('C-118')).toMatch(/^<!--.*-->$/);
  });

  it('renders the assertion and the falsifier', () => {
    const body = renderClaimComment(claim());

    expect(body).toContain('The refund path double-credits on a retried charge.');
    expect(body).toContain('A retried charge that credits once in the ledger refutes this.');
  });

  it('states the resolution of a settled claim', () => {
    const body = renderClaimComment(claim({ state: 'resolved', resolution: 'upheld', rounds: 3 }));

    expect(body).toContain('upheld');
  });

  /**
   * The neighbouring case. Without it, a renderer that always printed a
   * resolution line would pass the test above and publish every open claim as
   * settled — the mirror asserting an outcome the protocol has not reached.
   */
  it('states no resolution for a claim that is still open', () => {
    const body = renderClaimComment(claim({ state: 'open' }));

    expect(body).not.toMatch(/upheld|withdrawn|amended|superseded/);
  });

  /**
   * Two rounds of the same state must not render identically. The mirror skips
   * a write whose body already matches, so a renderer blind to `rounds` would
   * leave the comment showing round 1 for the rest of a five-round dispute —
   * silently, and looking exactly like a mirror that was up to date.
   */
  it('distinguishes one round of a contested claim from the next', () => {
    const first = renderClaimComment(claim({ state: 'contested', rounds: 1 }));
    const second = renderClaimComment(claim({ state: 'contested', rounds: 2 }));

    expect(first).not.toBe(second);
    expect(second).toContain('2');
  });

  it('finds its own comment among others by marker, and matches no other claim', () => {
    const comments = [
      { id: 1, body: 'a human being talking about C-118 in passing' },
      { id: 2, body: renderClaimComment(claim({ id: 'C-200' })) },
      { id: 3, body: renderClaimComment(claim({ id: 'C-118' })) },
    ];

    expect(findMarkedComment(comments, claimMarker('C-118'))?.id).toBe(3);
    expect(findMarkedComment(comments, claimMarker('C-201'))).toBeUndefined();
  });
});

describe('the deciding decision', () => {
  const decision = {
    id: 'D-07',
    question: 'Does the refund path double-credit?',
    options: ['yes', 'no'],
    voters: ['leader', 'codex', '@human'],
    method: 'ladder' as const,
    outcome: 'yes',
    rationale: [],
    claimId: 'C-118',
    votes: { leader: 'yes', codex: 'yes' },
  };

  it('names the decision and its outcome on the claim it settled', () => {
    const body = renderClaimComment(
      claim({ state: 'resolved', resolution: 'upheld', rounds: 3 }),
      decision,
    );

    expect(body).toContain('D-07');
    expect(body).toContain('Does the refund path double-credit?');
  });

  /**
   * The neighbouring case: a claim settled without a decision must not grow a
   * decision section, or every ordinary concession would publish as an
   * adjudication.
   */
  it('says nothing about a decision on a claim that never had one', () => {
    const body = renderClaimComment(claim({ state: 'resolved', resolution: 'withdrawn', rounds: 1 }));

    expect(body).not.toContain('Decided by');
  });

  it('reports an open decision as undecided rather than inventing an outcome', () => {
    const { outcome: _outcome, ...open } = decision;
    const body = renderClaimComment(claim({ state: 'contested', rounds: 2 }), open);

    expect(body).toContain('D-07');
    expect(body).not.toContain('yes');
  });
});
