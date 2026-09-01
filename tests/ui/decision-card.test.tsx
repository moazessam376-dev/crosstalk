// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { DecisionCard } from '../../src/ui/cards/DecisionCard.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Stream } from '../../src/ui/layout/Stream.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { Decision } from '../../src/contracts/decision.js';

afterEach(cleanup);

/**
 * The planner asking the operator a question.
 *
 * Every part of this existed and none of it was reachable. `Decision` has
 * carried a question, options, voters, votes and rationale since v1; a decision
 * with no `claimId` lands on `#floor`; `awaitsHuman` lights the NEEDS YOU
 * banner for `method: 'human'`; and the vote handler takes any string for
 * `option`, so an answer of the operator's own has always been legal. What was
 * missing was a card: `ProtocolCard` drew the question and not the options, and
 * the hub's only vote control lives inside `DisputeView`, which a claimless
 * decision never reaches.
 */

const DECISION: Decision = {
  id: 'D-01',
  question: 'Do we ship the map before the combat?',
  options: ['map first', 'combat first'],
  voters: ['@human'],
  method: 'human',
  rationale: [],
  votes: {},
};

function opened(seq: number, method: 'human' | 'leader' = 'human'): CrosstalkEvent {
  return {
    kind: 'decision_opened',
    seq,
    ts: '2026-09-01T00:00:00.000Z',
    from: 'planner',
    room: '#floor',
    decision: { ...DECISION, method },
  };
}

describe('a decision the operator has to answer', () => {
  it('offers a button per option', () => {
    render(createElement(DecisionCard, { decision: DECISION, onVote: vi.fn() }));

    expect(screen.getByTestId('decision-question')).toHaveTextContent('map before the combat');
    expect(screen.getByTestId('decision-option-map first')).toBeInTheDocument();
    expect(screen.getByTestId('decision-option-combat first')).toBeInTheDocument();
  });

  it('sends the option, and says how the answer arrived when no reason was given', async () => {
    const onVote = vi.fn().mockResolvedValue({ ok: true });
    render(createElement(DecisionCard, { decision: DECISION, onVote }));

    fireEvent.click(screen.getByTestId('decision-option-map first'));

    // The daemon requires a rationale. Making the operator justify a click is
    // friction on the one surface that should have none, so a blank one records
    // how the answer arrived rather than inventing a reason.
    await waitFor(() => expect(onVote).toHaveBeenCalledWith('D-01', 'map first', 'answered from the hub'));
  });

  it('carries the operator’s reason when they give one', async () => {
    const onVote = vi.fn().mockResolvedValue({ ok: true });
    render(createElement(DecisionCard, { decision: DECISION, onVote }));

    fireEvent.change(screen.getByTestId('decision-why'), { target: { value: 'the map makes combat legible' } });
    fireEvent.click(screen.getByTestId('decision-option-map first'));

    await waitFor(() => expect(onVote).toHaveBeenCalledWith('D-01', 'map first', 'the map makes combat legible'));
  });

  it('lets the operator answer with something that is not on the list', async () => {
    // `option` is a free string on the wire and always has been, so this needs
    // no protocol change — only somewhere to type it.
    const onVote = vi.fn().mockResolvedValue({ ok: true });
    render(createElement(DecisionCard, { decision: DECISION, onVote }));

    expect(screen.queryByTestId('decision-answer-own')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('decision-why'), { target: { value: 'neither — do the tutorial' } });
    fireEvent.click(screen.getByTestId('decision-answer-own'));

    await waitFor(() => expect(onVote).toHaveBeenCalledWith('D-01', 'neither — do the tutorial', 'neither — do the tutorial'));
  });

  it('shows the answer instead of the buttons once it is settled', () => {
    render(createElement(DecisionCard, { decision: DECISION, outcome: 'map first', onVote: vi.fn() }));

    expect(screen.getByTestId('decision-outcome')).toHaveTextContent('map first');
    expect(screen.queryByTestId('decision-option-map first')).not.toBeInTheDocument();
  });

  it('surfaces a refusal rather than swallowing it', async () => {
    const onVote = vi.fn().mockResolvedValue({ ok: false, reason: 'not an eligible voter' });
    render(createElement(DecisionCard, { decision: DECISION, onVote }));

    fireEvent.click(screen.getByTestId('decision-option-map first'));

    await waitFor(() => expect(screen.getByTestId('decision-error')).toHaveTextContent('not an eligible voter'));
  });
});

describe('the stream', () => {
  it('renders an operator decision as an answerable card', () => {
    render(createElement(Stream, {
      events: [opened(1)],
      activeRoom: '#floor',
      rooms: [{ id: '#floor', kind: 'floor' }],
      onVote: vi.fn(),
    }));

    expect(screen.getByTestId('decision-option-map first')).toBeInTheDocument();
  });

  it('leaves a decision the seats settle among themselves alone', () => {
    // The neighbouring case: a leader-method decision is not a question for the
    // operator, and offering them buttons would say it was.
    render(createElement(Stream, {
      events: [opened(1, 'leader')],
      activeRoom: '#floor',
      rooms: [{ id: '#floor', kind: 'floor' }],
      onVote: vi.fn(),
    }));

    expect(screen.queryByTestId('decision-option-map first')).not.toBeInTheDocument();
    expect(screen.getByTestId('card-decision-D-01')).toBeInTheDocument();
  });
});
