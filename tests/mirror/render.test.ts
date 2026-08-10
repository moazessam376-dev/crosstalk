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

/**
 * The ladder in the published record.
 *
 * Task 0 froze three event kinds and `Decision.skipped` so that "a dispute that
 * escalated through three rungs and one that never left the first" stop being
 * the same log. The mirror is the one consumer showing that record to someone
 * who is not running Crosstalk, so it has to preserve the distinction the
 * contracts were changed to create.
 */
describe('the ladder on a claim comment', () => {
  const decision = {
    id: 'D-07',
    question: 'Does the refund path double-credit?',
    options: ['yes', 'no'],
    voters: ['leader', 'codex', '@human'],
    method: 'ladder' as const,
    outcome: 'yes',
    rationale: [],
    claimId: 'C-118',
    votes: {},
  };

  const climbed = {
    entered: [
      { rung: 'discriminating_test' as const, index: 0 },
      { rung: 'third_agent' as const, index: 1, adjudicator: 'codex' },
      { rung: 'human' as const, index: 3 },
    ],
    failed: [{ rung: 'discriminating_test' as const, index: 0, reason: 'test_inconclusive' }],
    tests: [
      { command: 'npm test -- refund', predicts: 'one credit on a retried charge', sha: 'abc1234' },
    ],
    current: 3,
  };

  it('renders a line for every rung entered', () => {
    const body = renderClaimComment(claim(), decision, climbed);

    expect(body).toContain('discriminating_test');
    expect(body).toContain('third_agent');
    expect(body).toContain('human');
  });

  it('names the adjudicator chosen at the rung it was chosen at', () => {
    expect(renderClaimComment(claim(), decision, climbed)).toContain('codex');
  });

  it('reports a failed rung with its reason', () => {
    expect(renderClaimComment(claim(), decision, climbed)).toContain('test_inconclusive');
  });

  it('shows a proposed test with both what it predicts and the commit it is asserted at', () => {
    const body = renderClaimComment(claim(), decision, climbed);

    expect(body).toContain('npm test -- refund');
    expect(body).toContain('one credit on a retried charge');
    // C-11: two runs at two commits differ for reasons unrelated to who is right.
    expect(body).toContain('abc1234');
  });

  it('names a skipped rung with its reason, so a degraded ladder is not a short one', () => {
    const body = renderClaimComment(
      claim(),
      { ...decision, skipped: [{ rung: 'third_agent' as const, reason: 'no uninvolved peer' }] },
      { entered: [{ rung: 'leader' as const, index: 2 }], failed: [], tests: [], current: 2 },
    );

    expect(body).toContain('no uninvolved peer');
  });

  /**
   * `rung_failed.index` rather than pairing on the rung's name. A ladder may
   * enter the same rung twice; name-matching is ambiguous outright there, which
   * is why the field exists.
   */
  it('attaches a failure to the position that failed, not to a later rung of the same name', () => {
    const repeated = {
      entered: [
        { rung: 'third_agent' as const, index: 1, adjudicator: 'codex' },
        { rung: 'third_agent' as const, index: 3, adjudicator: 'leader' },
      ],
      failed: [{ rung: 'third_agent' as const, index: 1, reason: 'adjudicator became involved' }],
      tests: [],
      current: 3,
    };

    const lines = renderClaimComment(claim(), decision, repeated)
      .split('\n')
      .filter((line) => line.includes('third_agent'));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('adjudicator became involved');
    expect(lines[1]).not.toContain('adjudicator became involved');
  });

  /**
   * The discrimination that matters, and the reason the flat case is in this
   * file: it is the case that exists today, and it is what catches a renderer
   * that prints a ladder section unconditionally.
   */
  it('renders an escalated dispute differently from one settled in a single exchange', () => {
    const escalated = renderClaimComment(
      claim({ state: 'resolved', resolution: 'upheld', rounds: 4 }),
      decision,
      climbed,
    );
    const flat = renderClaimComment(claim({ state: 'resolved', resolution: 'upheld', rounds: 1 }));

    expect(escalated).not.toBe(flat);
    expect(escalated).toContain('test_inconclusive');
    expect(flat).not.toContain('test_inconclusive');
  });

  it('prints no ladder section at all for a claim that never opened one', () => {
    const flat = renderClaimComment(claim({ state: 'resolved', resolution: 'withdrawn', rounds: 1 }));

    expect(flat).not.toMatch(/ladder|rung/i);
  });
});

/**
 * C-20. The two early returns in `renderLadder` were both deletable with the
 * suite still green — two guards nobody was checking.
 *
 * The case they protect is not the flat dispute (that one never reaches
 * `renderLadder` at all, because the caller only enters the block when a
 * decision exists). It is a claim settled by a decision that is *not* a ladder:
 * `open_decision` accepts any method alongside a `claimId`, so a `majority` or
 * `leader` decision has no rungs to show and must not grow an empty header.
 */
describe('a claim decided by something that is not a ladder', () => {
  const byMajority = {
    id: 'D-09',
    question: 'Ship it?',
    options: ['yes', 'no'],
    voters: ['leader', 'codex'],
    method: 'majority' as const,
    outcome: 'yes',
    rationale: [],
    claimId: 'C-118',
    votes: { leader: 'yes', codex: 'yes' },
  };

  it('names the decision without opening an empty ladder section', () => {
    const body = renderClaimComment(claim({ state: 'resolved', resolution: 'upheld' }), byMajority);

    expect(body).toContain('D-09');
    expect(body).not.toContain('**Ladder**');
  });

  it('opens no ladder section for a ladder decision that has entered no rung yet', () => {
    const body = renderClaimComment(claim(), byMajority, {
      entered: [],
      failed: [],
      tests: [],
      current: 0,
    });

    expect(body).not.toContain('**Ladder**');
  });

  /**
   * The other side: a decision that skipped rungs but entered none still has
   * something to say, and F-07 says it must say it — otherwise a ladder
   * degraded to nothing reads as a decision that was never a ladder.
   */
  it('still reports skipped rungs when no rung was ever entered', () => {
    const body = renderClaimComment(
      claim(),
      { ...byMajority, skipped: [{ rung: 'third_agent' as const, reason: 'no uninvolved peer' }] },
      { entered: [], failed: [], tests: [], current: 0 },
    );

    expect(body).toContain('**Ladder**');
    expect(body).toContain('no uninvolved peer');
  });
});
