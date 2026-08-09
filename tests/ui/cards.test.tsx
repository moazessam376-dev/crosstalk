// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { Claim, Evidence } from '../../src/contracts/claim.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ClaimCard } from '../../src/ui/cards/ClaimCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { MessageCard } from '../../src/ui/cards/MessageCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Stream } from '../../src/ui/layout/Stream.js';

afterEach(cleanup);

const evidence: Evidence = {
  kind: 'command',
  command: 'node tools/economycheck.mjs --trace',
  output: 'tick 1 ledger: balanced',
  sha: '7c18253',
  by: 'leader',
};

const claim: Claim = {
  id: 'C-1',
  raisedBy: 'leader',
  against: 'codex',
  target: 'src/economy.ts:41',
  assertion: 'The staffing coefficient is applied twice.',
  severity: 'defect',
  falsifier: 'A single-tick trace shows one application rather than two.',
  evidence: [evidence],
  state: 'contested',
  rounds: 1,
  taskId: 'T-2',
};

const events: CrosstalkEvent[] = [
  {
    seq: 1,
    ts: '2026-08-09T00:00:01Z',
    kind: 'message',
    from: 'leader',
    room: '#floor',
    body: 'A structured event should not become a paragraph.',
  },
  {
    seq: 2,
    ts: '2026-08-09T00:00:02Z',
    kind: 'claim_raised',
    from: 'leader',
    room: 'dispute:C-1',
    claim,
  },
  {
    seq: 3,
    ts: '2026-08-09T00:00:03Z',
    kind: 'vote_cast',
    from: 'cursor',
    room: 'dispute:C-1',
    decisionId: 'D-1',
    option: 'once',
    rationale: 'The default trace shows one application.',
  },
  {
    seq: 4,
    ts: '2026-08-09T00:00:04Z',
    kind: 'evidence_stale',
    from: 'leader',
    room: 'dispute:C-1',
    claimId: 'C-1',
    sha: 'old-sha',
  },
  {
    seq: 5,
    ts: '2026-08-09T00:00:05Z',
    kind: 'rebase_notice',
    from: 'leader',
    room: 'task:T-2',
    taskId: 'T-2',
    newBase: 'abc1234',
  },
];

describe('B4 message and protocol cards', () => {
  it('renders a message as authored chat content', () => {
    render(createElement(MessageCard, { from: 'leader', body: 'A human-readable update.' }));

    expect(screen.getByTestId('message-card')).toHaveAttribute('data-card-kind', 'message');
    expect(screen.getByText('A human-readable update.')).toBeInTheDocument();
    expect(screen.getByText('leader')).toBeInTheDocument();
  });

  it('shows claim state, falsifier, and expandable evidence', () => {
    render(createElement(ClaimCard, { claim }));

    expect(screen.getByTestId('claim-card-C-1')).toHaveAttribute('data-claim-state', 'contested');
    expect(screen.getByText('defect')).toBeInTheDocument();
    expect(screen.getByText(claim.falsifier)).toBeInTheDocument();
    expect(screen.queryByTestId('evidence-output')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /economycheck/ }));

    expect(screen.getByRole('button', { name: /economycheck/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('evidence-output')).toHaveTextContent('tick 1 ledger: balanced');
  });

  it('renders protocol events as typed cards rather than event-kind paragraphs', () => {
    render(createElement(Stream, { events }));

    expect(screen.getByTestId('card-message-1')).toBeInTheDocument();
    expect(screen.getByTestId('card-claim-C-1')).toBeInTheDocument();
    expect(screen.getByTestId('card-vote-D-1')).toBeInTheDocument();
    expect(screen.getByTestId('card-evidence-stale-old-sha')).toBeInTheDocument();
    expect(screen.getByTestId('card-rebase-T-2')).toHaveTextContent('abc1234');
    expect(screen.queryByText('claim_raised')).not.toBeInTheDocument();
  });
});
