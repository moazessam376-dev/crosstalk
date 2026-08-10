// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { Claim, Evidence } from '../../src/contracts/claim.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { DisputeView } from '../../src/ui/dispute/DisputeView.js';

afterEach(cleanup);

const claimEvidence: Evidence = {
  kind: 'command',
  command: 'node tools/economycheck.mjs --trace',
  output: 'tick 1 produce: staffed=0.5 applied',
  sha: '7c18253',
  by: 'leader',
};

const claim: Claim = {
  id: 'C-118',
  raisedBy: 'leader',
  against: 'codex',
  target: 'src/economy.ts:41',
  assertion: 'The staffing coefficient is applied twice.',
  severity: 'defect',
  falsifier: 'produce() and consume() reference different multipliers.',
  evidence: [claimEvidence],
  state: 'open',
  rounds: 2,
  taskId: 'T-02',
};

const responseEvidence: Evidence = {
  kind: 'command',
  command: 'node tools/replay.mjs --ticks 3 --no-consume-coeff',
  output: 'tick 3 ledger divergence: expected 0, got -42 input units',
  sha: '20b08a7',
  by: 'codex',
};

const events: CrosstalkEvent[] = [
  {
    seq: 1,
    ts: '2026-08-09T00:00:01Z',
    kind: 'claim_raised',
    from: 'leader',
    room: 'dispute:C-118',
    claim,
  },
  {
    seq: 2,
    ts: '2026-08-09T00:00:02Z',
    kind: 'claim_response',
    from: 'codex',
    room: 'dispute:C-118',
    claimId: 'C-118',
    verdict: 'contest',
    rationale: 'Both sites read the coefficient but scale different quantities.',
    falsifier: 'Removing the coefficient from consume() leaves the ledger balanced.',
    evidence: [responseEvidence],
  },
  {
    seq: 3,
    ts: '2026-08-09T00:00:03Z',
    kind: 'decision_opened',
    from: 'leader',
    room: 'dispute:C-118',
    decision: {
      id: 'D-01',
      question: 'Does the staffing coefficient apply twice?',
      options: ['twice', 'once'],
      voters: ['cursor'],
      method: 'ladder',
      ladder: ['discriminating_test', 'third_agent', 'leader'],
      currentRung: 1,
      rationale: [],
      claimId: 'C-118',
      votes: {},
    },
  },
  {
    seq: 4,
    ts: '2026-08-09T00:00:04Z',
    kind: 'vote_cast',
    from: 'cursor',
    room: 'dispute:C-118',
    decisionId: 'D-01',
    option: 'once',
    rationale: 'The default trace shows one application.',
  },
  {
    seq: 5,
    ts: '2026-08-09T00:00:05Z',
    kind: 'evidence_stale',
    from: 'leader',
    room: 'dispute:C-118',
    claimId: 'C-118',
    sha: '7c18253',
  },
];

describe('B5 dispute view', () => {
  it('shows both falsifiers, the active ladder rung, round, vote tally, and human controls', () => {
    const actions: unknown[] = [];
    render(
      createElement(DisputeView, {
        roomId: 'dispute:C-118',
        events,
        maxRounds: 3,
        onHumanAction: (action) => actions.push(action),
      }),
    );

    expect(screen.getByTestId('dispute-view')).toHaveAttribute('data-round', '2');
    expect(screen.getByText('round 2 / 3')).toBeInTheDocument();
    expect(screen.getByText(claim.falsifier)).toBeInTheDocument();
    expect(screen.getByTestId('dispute-claim-C-118')).toHaveAttribute('data-claim-state', 'contested');
    expect(screen.getByText('Removing the coefficient from consume() leaves the ledger balanced.')).toBeInTheDocument();
    expect(screen.getByTestId('ladder-rung-third_agent')).toHaveAttribute('data-current', 'true');
    expect(screen.getByTestId('vote-tally-D-01')).toHaveTextContent('once');
    expect(screen.getByTestId('evidence-stale-7c18253')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /propose discriminating test/i }));
    fireEvent.click(screen.getByRole('button', { name: /intervene as @human/i }));

    expect(actions).toEqual([{ type: 'propose_test' }, { type: 'intervene_human' }]);
  });

  it('counts only the latest vote from each voter', () => {
    const laterVote: CrosstalkEvent = {
      seq: 6,
      ts: '2026-08-09T00:00:06Z',
      kind: 'vote_cast',
      from: 'cursor',
      room: 'dispute:C-118',
      decisionId: 'D-01',
      option: 'twice',
      rationale: 'A later vote replaces the earlier vote.',
    };

    render(createElement(DisputeView, { roomId: 'dispute:C-118', events: [...events, laterVote] }));

    const tally = screen.getByTestId('vote-tally-D-01');
    expect(tally).toHaveTextContent(/twice\s*1/);
    expect(tally).toHaveTextContent(/once\s*0/);
  });

  it('keeps the contesting side on screen after the raiser upholds', () => {
    // The signature failure this view exists to prevent: leader raises, codex
    // contests, leader upholds, and the screen shows "CLAIM · leader" beside
    // "UPHOLD · leader" with codex's falsifier gone. Both falsifiers side by
    // side is the whole idea (spec §10.2).
    const uphold: CrosstalkEvent = {
      seq: 8,
      ts: '2026-08-09T00:00:08Z',
      kind: 'claim_response',
      from: 'leader',
      room: 'dispute:C-118',
      claimId: 'C-118',
      verdict: 'uphold',
      rationale: 'The trace still shows two applications after the replay run.',
      evidence: [
        {
          kind: 'command',
          command: 'node tools/economycheck.mjs --trace --after-replay',
          output: 'tick 1 produce: staffed=0.5 applied twice',
          sha: '9f31aa4',
          by: 'leader',
        },
      ],
    };

    render(createElement(DisputeView, { roomId: 'dispute:C-118', events: [...events, uphold] }));

    expect(screen.getByText('Removing the coefficient from consume() leaves the ledger balanced.')).toBeInTheDocument();
    expect(screen.getByTestId('dispute-response-C-118')).toHaveTextContent('CONTEST · codex');
  });

  it('folds the raiser latest evidence into the claim pane', () => {
    const uphold: CrosstalkEvent = {
      seq: 8,
      ts: '2026-08-09T00:00:08Z',
      kind: 'claim_response',
      from: 'leader',
      room: 'dispute:C-118',
      claimId: 'C-118',
      verdict: 'uphold',
      rationale: 'The trace still shows two applications after the replay run.',
      evidence: [
        {
          kind: 'command',
          command: 'node tools/economycheck.mjs --trace --after-replay',
          output: 'tick 1 produce: staffed=0.5 applied twice',
          sha: '9f31aa4',
          by: 'leader',
        },
      ],
    };

    render(createElement(DisputeView, { roomId: 'dispute:C-118', events: [...events, uphold] }));

    // An uphold updates the claim pane's evidence; it does not replace the
    // opposing pane.
    expect(screen.getByTestId('dispute-claim-C-118')).toHaveTextContent('node tools/economycheck.mjs --trace --after-replay');
  });

  it('keeps a claim contested after its linked decision resolves', () => {
    const decisionResolved: CrosstalkEvent = {
      seq: 7,
      ts: '2026-08-09T00:00:07Z',
      kind: 'decision_resolved',
      from: 'leader',
      room: 'dispute:C-118',
      decisionId: 'D-01',
      outcome: 'once',
    };

    render(createElement(DisputeView, { roomId: 'dispute:C-118', events: [...events, decisionResolved] }));

    expect(screen.getByTestId('dispute-claim-C-118')).toHaveAttribute('data-claim-state', 'contested');
  });
});

/**
 * Rule 1 of the freeze: the current rung is the `index` of the last
 * `rung_entered` for that decision, falling back to `decision.currentRung ?? 0`
 * only when there is none. `decision.currentRung` is an open-time snapshot on an
 * append-only log, so a rail that reads it alone shows the opening rung forever
 * while the ladder climbs underneath it.
 */
describe('C1 ladder rail', () => {
  const ladderEvents: CrosstalkEvent[] = [
    {
      seq: 1,
      ts: '2026-08-09T00:00:01Z',
      kind: 'claim_raised',
      from: 'leader',
      room: 'dispute:C-200',
      claim: { ...claim, id: 'C-200' },
    },
    {
      seq: 2,
      ts: '2026-08-09T00:00:02Z',
      kind: 'decision_opened',
      from: 'leader',
      room: 'dispute:C-200',
      decision: {
        id: 'D-09',
        question: 'Does the staffing coefficient apply twice?',
        options: ['twice', 'once'],
        voters: ['leader', 'codex', '@human'],
        method: 'ladder',
        ladder: ['discriminating_test', 'third_agent', 'leader', 'human'],
        currentRung: 0,
        skipped: [{ rung: 'third_agent', reason: 'only one worker is configured, so there is no uninvolved peer' }],
        rationale: [],
        claimId: 'C-200',
        votes: {},
      },
    },
    {
      seq: 3,
      ts: '2026-08-09T00:00:03Z',
      kind: 'rung_entered',
      from: 'leader',
      room: 'dispute:C-200',
      decisionId: 'D-09',
      rung: 'discriminating_test',
      index: 0,
    },
    {
      seq: 4,
      ts: '2026-08-09T00:00:04Z',
      kind: 'rung_failed',
      from: 'leader',
      room: 'dispute:C-200',
      decisionId: 'D-09',
      rung: 'discriminating_test',
      reason: 'timeout: codex did not propose',
    },
    {
      seq: 5,
      ts: '2026-08-09T00:00:05Z',
      kind: 'rung_entered',
      from: 'leader',
      room: 'dispute:C-200',
      decisionId: 'D-09',
      rung: 'leader',
      index: 2,
    },
  ];

  it('lights the rung named by the last rung_entered, not the open-time snapshot', () => {
    render(createElement(DisputeView, { roomId: 'dispute:C-200', events: ladderEvents }));

    // Both sides of the discrimination: the live rung is current and the
    // snapshot rung is not. `currentRung` is 0 in this decision, so a rail
    // reading it alone would light `discriminating_test`.
    expect(screen.getByTestId('ladder-rung-leader')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('ladder-rung-discriminating_test')).not.toHaveAttribute('data-state', 'current');
  });

  it('renders a failed rung distinctly from a skipped one', () => {
    render(createElement(DisputeView, { roomId: 'dispute:C-200', events: ladderEvents }));

    // A degraded ladder must not look like a short one, and an escalated ladder
    // must not look like a stalled one. Three different states, three renders.
    expect(screen.getByTestId('ladder-rung-discriminating_test')).toHaveAttribute('data-state', 'failed');
    expect(screen.getByTestId('ladder-rung-third_agent')).toHaveAttribute('data-state', 'skipped');
    expect(screen.getByTestId('ladder-rung-human')).toHaveAttribute('data-state', 'pending');
  });

  it('names why a rung was skipped and why one failed', () => {
    render(createElement(DisputeView, { roomId: 'dispute:C-200', events: ladderEvents }));

    // Skipped, never silent — audit F-07.
    expect(screen.getByTestId('ladder-rung-third_agent')).toHaveAttribute(
      'title',
      'only one worker is configured, so there is no uninvolved peer',
    );
    expect(screen.getByTestId('ladder-rung-discriminating_test')).toHaveAttribute('title', 'timeout: codex did not propose');
  });

  it('reads the adjudicator from the last rung_entered, never from decision_opened', () => {
    // Rule 2: "uninvolved" decays, so the peer is chosen at rung entry. A rail
    // reading `decision_opened` would name whoever was uninvolved at open time.
    const withAdjudicator: CrosstalkEvent[] = [
      ...ladderEvents.slice(0, 4),
      {
        seq: 5,
        ts: '2026-08-09T00:00:05Z',
        kind: 'rung_entered',
        from: 'leader',
        room: 'dispute:C-200',
        decisionId: 'D-09',
        rung: 'third_agent',
        index: 1,
        adjudicator: 'cursor',
      },
    ];

    render(createElement(DisputeView, { roomId: 'dispute:C-200', events: withAdjudicator }));

    expect(screen.getByTestId('ladder-adjudicator')).toHaveTextContent('cursor');
  });
});

/**
 * C2. `policy.dispute.maxRounds` is configuration, and the hub read `3` from
 * three separate hard-coded constants. The same dispute read "round 3 / 3" in
 * the header and "4/3" in the channel row, and neither number came from the
 * config the daemon was actually running.
 */
describe('C2 round counter', () => {
  it('renders the configured maximum, not a constant', () => {
    render(createElement(DisputeView, { roomId: 'dispute:C-118', events, maxRounds: 5 }));

    expect(screen.getByText('round 2 / 5')).toBeInTheDocument();
  });

  it('does not clamp a dispute that ran past its maximum', () => {
    // `Math.min(3, …)` meant a dispute at round 5 of 3 reported "3 / 3" — the
    // display disagreeing with the escalation that had already happened.
    // One response is already on the base log, so four more make five rounds.
    const extraResponses: CrosstalkEvent[] = [2, 3, 4, 5].map((n) => ({
      seq: 20 + n,
      ts: `2026-08-09T00:01:0${n}Z`,
      kind: 'claim_response',
      from: n % 2 === 0 ? 'leader' : 'codex',
      room: 'dispute:C-118',
      claimId: 'C-118',
      verdict: n % 2 === 0 ? 'uphold' : 'contest',
      rationale: `round ${n}`,
      falsifier: `falsifier ${n}`,
      evidence: [],
    }));

    render(createElement(DisputeView, { roomId: 'dispute:C-118', events: [...events, ...extraResponses], maxRounds: 3 }));

    expect(screen.getByText('round 5 / 3')).toBeInTheDocument();
  });

  it('renders no denominator at all when no config supplied one', () => {
    // Fixture mode — `vite dev`, a static build, every UI test. A fallback of 3
    // here reinstates exactly the bug this task removes and hides the
    // regression it exists to expose.
    render(createElement(DisputeView, { roomId: 'dispute:C-118', events }));

    expect(screen.getByText('round 2')).toBeInTheDocument();
    expect(screen.queryByText(/round 2 \/ 3/)).not.toBeInTheDocument();
  });
});

/**
 * The `discriminating_test` rung, made legible. `test_proposed.sha` exists
 * because two disputants running one command at two commits get a difference
 * explained by the diff between them rather than by who is right — and the rung
 * then records an inconclusive falsifier against both.
 */
describe('C1 discriminating test proposals', () => {
  const proposal: CrosstalkEvent = {
    seq: 3,
    ts: '2026-08-09T00:00:03Z',
    kind: 'test_proposed',
    from: 'codex',
    room: 'dispute:C-200',
    decisionId: 'D-09',
    claimId: 'C-200',
    command: 'node tools/replay.mjs --ticks 3',
    predicts: 'the ledger balances at tick 3 if the coefficient is applied once',
    sha: '7c18253',
  };

  const base: CrosstalkEvent[] = [
    {
      seq: 1,
      ts: '2026-08-09T00:00:01Z',
      kind: 'claim_raised',
      from: 'leader',
      room: 'dispute:C-200',
      claim: { ...claim, id: 'C-200', evidence: [] },
    },
    proposal,
  ];

  it('renders the command, the prediction and the commit it is asserted at', () => {
    render(createElement(DisputeView, { roomId: 'dispute:C-200', events: base }));

    const proposed = screen.getByTestId('test-proposal-3');
    expect(proposed).toHaveTextContent('node tools/replay.mjs --ticks 3');
    expect(proposed).toHaveTextContent('the ledger balances at tick 3 if the coefficient is applied once');
    expect(proposed).toHaveTextContent('7c18253');
  });

  it('marks answering evidence that ran at a different commit', () => {
    const answeredElsewhere: CrosstalkEvent = {
      seq: 4,
      ts: '2026-08-09T00:00:04Z',
      kind: 'evidence_added',
      from: 'leader',
      room: 'dispute:C-200',
      claimId: 'C-200',
      evidence: {
        kind: 'command',
        command: 'node tools/replay.mjs --ticks 3',
        output: 'tick 3 ledger divergence: expected 0, got -42 input units',
        sha: '20b08a7',
        by: 'leader',
      },
    };

    render(createElement(DisputeView, { roomId: 'dispute:C-200', events: [...base, answeredElsewhere] }));

    const divergence = screen.getByTestId('test-proposal-3-divergence');
    expect(divergence).toHaveTextContent('20b08a7');
  });

  it('says nothing about divergence when the answer ran at the proposed commit', () => {
    // The neighbouring case that must not trigger: same command, same commit.
    const answeredHere: CrosstalkEvent = {
      seq: 4,
      ts: '2026-08-09T00:00:04Z',
      kind: 'evidence_added',
      from: 'leader',
      room: 'dispute:C-200',
      claimId: 'C-200',
      evidence: {
        kind: 'command',
        command: 'node tools/replay.mjs --ticks 3',
        output: 'tick 3 ledger balanced',
        sha: '7c18253',
        by: 'leader',
      },
    };

    render(createElement(DisputeView, { roomId: 'dispute:C-200', events: [...base, answeredHere] }));

    expect(screen.queryByTestId('test-proposal-3-divergence')).not.toBeInTheDocument();
  });
});
/**
 * C3. A3 makes `human` a reachable ladder rung and A2 resolves that rung on
 * `@human`'s vote. With no way to vote from the hub, a dispute that escalated
 * all the way to the person holding terminal authority could not be answered by
 * them — the ladder would sit on its last rung, whose timer never fires, for
 * ever. Same defect as a decision that reaches nobody, one layer up.
 */
describe('C3 the human can vote', () => {
  const ladderToHuman: CrosstalkEvent[] = [
    {
      seq: 1,
      ts: '2026-08-09T00:00:01Z',
      kind: 'claim_raised',
      from: 'leader',
      room: 'dispute:C-300',
      claim: { ...claim, id: 'C-300' },
    },
    {
      seq: 2,
      ts: '2026-08-09T00:00:02Z',
      kind: 'decision_opened',
      from: 'leader',
      room: 'dispute:C-300',
      decision: {
        id: 'D-30',
        question: 'Does the staffing coefficient apply twice?',
        options: ['twice', 'once'],
        voters: ['leader', 'codex', '@human'],
        method: 'ladder',
        ladder: ['discriminating_test', 'human'],
        currentRung: 1,
        rationale: [],
        claimId: 'C-300',
        votes: {},
      },
    },
  ];

  it('offers a vote to a participant the decision names', async () => {
    const cast: unknown[] = [];
    render(
      createElement(DisputeView, {
        roomId: 'dispute:C-300',
        events: ladderToHuman,
        self: '@human',
        onVote: async (decisionId: string, option: string, rationale: string) => {
          cast.push({ decisionId, option, rationale });
          return { ok: true as const };
        },
      }),
    );

    fireEvent.change(screen.getByTestId('vote-rationale'), {
      target: { value: 'The replay run settles it: one application.' },
    });
    fireEvent.click(screen.getByTestId('vote-option-once'));

    await waitFor(() => expect(cast).toHaveLength(1));
    expect(cast[0]).toEqual({
      decisionId: 'D-30',
      option: 'once',
      rationale: 'The replay run settles it: one application.',
    });
  });

  it('will not send a vote without a rationale', async () => {
    // The daemon refuses this with VOTE_WITHOUT_RATIONALE. Discovering that
    // through a round-trip is a worse experience than a required field.
    const cast: unknown[] = [];
    render(
      createElement(DisputeView, {
        roomId: 'dispute:C-300',
        events: ladderToHuman,
        self: '@human',
        onVote: async (decisionId: string, option: string, rationale: string) => {
          cast.push({ decisionId, option, rationale });
          return { ok: true as const };
        },
      }),
    );

    fireEvent.click(screen.getByTestId('vote-option-once'));

    expect(cast).toEqual([]);
    expect(screen.getByTestId('vote-option-once')).toBeDisabled();
  });

  it('offers nothing to a participant the decision does not name', () => {
    // The neighbouring case that must not render. `voters` is the eligibility
    // list and the daemon refuses anyone else with NOT_ELIGIBLE_VOTER.
    render(
      createElement(DisputeView, {
        roomId: 'dispute:C-300',
        events: ladderToHuman,
        self: 'cursor',
        onVote: async () => ({ ok: true as const }),
      }),
    );

    expect(screen.queryByTestId('vote-rationale')).not.toBeInTheDocument();
  });

  it('offers nothing once the decision has resolved', () => {
    const resolved: CrosstalkEvent = {
      seq: 3,
      ts: '2026-08-09T00:00:03Z',
      kind: 'decision_resolved',
      from: 'leader',
      room: 'dispute:C-300',
      decisionId: 'D-30',
      outcome: 'once',
    };

    render(
      createElement(DisputeView, {
        roomId: 'dispute:C-300',
        events: [...ladderToHuman, resolved],
        self: '@human',
        onVote: async () => ({ ok: true as const }),
      }),
    );

    expect(screen.queryByTestId('vote-rationale')).not.toBeInTheDocument();
  });
});
