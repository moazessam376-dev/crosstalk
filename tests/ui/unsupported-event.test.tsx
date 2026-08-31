// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ProtocolCard } from '../../src/ui/cards/ProtocolCard.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';

const known: CrosstalkEvent = {
  seq: 1,
  ts: '2026-08-10T00:00:01Z',
  from: 'leader',
  room: 'task:T-1',
  kind: 'rebase_notice',
  taskId: 'T-1',
  newBase: 'abc123',
};

// A kind this build does not know. Cast rather than widen the union: the
// point is a frame arriving from a newer daemon, which by definition is not
// in this build's type.
const unknown = { ...known, kind: 'some_future_kind' } as unknown as CrosstalkEvent;

/**
 * The plan required `cardFor` to refuse unknown kinds so a new protocol event
 * could not silently become message-like text. The shipped switch had a
 * default branch rendering "protocol event" plus the kind — plausible, and
 * indistinguishable from a card that works.
 *
 * It was not hypothetical: `self_review` was added to the contract after that
 * switch was written and rendered through the default branch.
 */
afterEach(cleanup);

describe('an event this build does not know', () => {
  it('renders as explicitly unsupported, not as an ordinary protocol card', () => {
    render(createElement(ProtocolCard, { event: unknown, testId: 'card-unknown' }));

    const card = screen.getByTestId('card-unknown');
    expect(card).toHaveAttribute('data-unsupported', 'true');
    expect(card).toHaveAttribute('data-card-kind', 'unsupported');
    expect(screen.getByText(/unsupported event/i)).toBeInTheDocument();
    expect(screen.getByText(/newer than this hub/i)).toBeInTheDocument();
  });

  it('names the kind it could not display, so the incompatibility is diagnosable', () => {
    render(createElement(ProtocolCard, { event: unknown, testId: 'card-unknown' }));
    expect(screen.getByText(/does not know how to display/)).toHaveTextContent('some_future_kind');
  });

  // The neighbouring case: a known kind must NOT be marked unsupported, or the
  // rule degenerates to "mark everything unsupported" and still passes above.
  it('leaves a known kind alone', () => {
    render(createElement(ProtocolCard, { event: known, testId: 'card-known' }));

    const card = screen.getByTestId('card-known');
    expect(card).not.toHaveAttribute('data-unsupported');
    expect(card).toHaveAttribute('data-card-kind', 'rebase_notice');
    expect(screen.queryByText(/unsupported event/i)).not.toBeInTheDocument();
  });

  // Neighbouring case: task rooms are almost entirely these three kinds.
  // If they stay on the default branch, a live T-01 looks like a broken
  // protocol even though every event is in this build's union.
  it('renders task_state, brief_ack, and self_review as protocol rows, not unsupported', () => {
    const taskState: CrosstalkEvent = {
      seq: 6,
      ts: '2026-08-30T09:23:00Z',
      from: 'leader',
      room: 'task:T-01',
      kind: 'task_state',
      taskId: 'T-01',
      state: 'assigned',
    };
    const briefAck: CrosstalkEvent = {
      seq: 10,
      ts: '2026-08-30T09:23:02Z',
      from: 'builder',
      room: 'task:T-01',
      kind: 'brief_ack',
      taskId: 'T-01',
      ack: { restatement: 'App() loads DecisionLog(SEED) into render.', ambiguities: [] },
    };
    const selfReview: CrosstalkEvent = {
      seq: 16,
      ts: '2026-08-30T09:23:25Z',
      from: 'builder',
      room: 'task:T-01',
      kind: 'self_review',
      taskId: 'T-01',
      critique: { rounds: 1, critic: 'self', findings: [] },
    };

    for (const event of [taskState, briefAck, selfReview]) {
      const testId = `card-${event.kind}`;
      const { unmount } = render(createElement(ProtocolCard, { event, testId }));
      const card = screen.getByTestId(testId);
      expect(card).not.toHaveAttribute('data-unsupported');
      expect(card).toHaveAttribute('data-card-kind', event.kind);
      expect(screen.queryByText(/unsupported event/i)).not.toBeInTheDocument();
      unmount();
    }

    render(createElement(ProtocolCard, { event: taskState, testId: 'card-task-state-body' }));
    expect(screen.getByTestId('card-task-state-body')).toHaveTextContent('assigned');
    cleanup();
    render(createElement(ProtocolCard, { event: briefAck, testId: 'card-brief-ack-body' }));
    expect(screen.getByTestId('card-brief-ack-body')).toHaveTextContent('App() loads DecisionLog(SEED)');
    cleanup();
    render(createElement(ProtocolCard, { event: selfReview, testId: 'card-self-review-body' }));
    expect(screen.getByTestId('card-self-review-body')).toHaveTextContent('0 finding');
  });
});
