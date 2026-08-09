// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('marks a claim resolved after its linked decision resolves', () => {
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

    expect(screen.getByTestId('dispute-claim-C-118')).toHaveAttribute('data-claim-state', 'resolved');
  });
});