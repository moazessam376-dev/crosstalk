// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Layout } from '../../src/ui/layout/Layout.js';
import type { HubState } from '../../src/ui/state/derive.js';
import type { SeatSession } from '../../src/ui/state/useLaunch.js';

afterEach(cleanup);

// No `dom` lib in the frozen test config, so no global `document` type.
function stream(): Element | null {
  return (globalThis as unknown as { document: { querySelector(s: string): Element | null } })
    .document.querySelector('[data-region="stream"]');
}

/**
 * Opening a seat's terminal must not destroy the board.
 *
 * `SessionPanel` and `Stream` shared one slot in `.hub-layout`, and React
 * reconciles by component type: a type change at a position is an unmount and a
 * mount, not an update. So every trip to a CLI and back threw away
 * `.stream-scroll` and built a new one, and the operator landed at the top of
 * the log — on a run with 1187 events, a very long way from what they were
 * reading. Nothing in `src/ui/` restores a scroll position, so there was
 * nothing to put it back.
 *
 * The subtree also holds state that is not scroll: every "Show more" the
 * operator expanded, and any half-written message in the composer.
 */

function seat(id: string): SeatSession {
  return {
    id,
    role: 'peer',
    harness: 'claude-code-live',
    model: 'claude-opus-5',
    effort: 'high',
    workspace: `.crosstalk/worktrees/${id}`,
    present: true,
    activity: null,
    remoteControl: null,
    mirrored: true,
  };
}

const LONG = 'a finding, and then a great deal of supporting detail. '.repeat(12);

const state: HubState = {
  participants: [
    { id: 'peer-1', role: 'peer', status: 'working', tier: 'mcp', harness: 'claude-code-live', workspace: '.' },
  ],
  rooms: [{ id: '#floor', kind: 'floor' }],
  events: [
    { kind: 'message', seq: 1, ts: '2026-09-01T00:00:00.000Z', from: 'peer-1', room: '#floor', body: LONG },
  ],
  lastSeq: 1,
};

function layout(openSeat?: string) {
  return createElement(Layout, {
    state,
    activeRoom: '#floor',
    self: 'peer-1',
    sessions: { phase: null, seats: [seat('peer-1')] },
    openSeat,
    onOpenSession: () => {},
    onCloseSession: () => {},
  });
}

describe('opening a seat terminal', () => {
  it('keeps the board mounted underneath', () => {
    const view = render(layout(undefined));
    expect(stream()).not.toBeNull();

    view.rerender(layout('peer-1'));

    // Both present: the terminal is what you are looking at, the board is still
    // there. Removing it from the DOM is the bug.
    expect(screen.getByTestId('session-panel')).toBeInTheDocument();
    expect(stream()).not.toBeNull();
    expect(stream()).toHaveAttribute('hidden');
  });

  it('shows the board again, and the same one, on the way back', () => {
    const view = render(layout(undefined));
    const before = stream();

    view.rerender(layout('peer-1'));
    view.rerender(layout(undefined));

    // Node identity, not just presence. A fresh element with the same testid
    // is exactly the bug wearing the right name.
    expect(stream()).toBe(before);
    expect(stream()).not.toHaveAttribute('hidden');
    expect(screen.queryByTestId('session-panel')).not.toBeInTheDocument();
  });

  it('keeps an expanded message expanded across the round trip', () => {
    // The user-visible proof that the subtree survived. This state lives in a
    // `useState` inside `MessageCard`, so it can only survive if the card was
    // never unmounted.
    const view = render(layout(undefined));
    fireEvent.click(screen.getByTestId('message-expand'));
    expect(screen.getByTestId('message-expand')).toHaveTextContent('Show less');

    view.rerender(layout('peer-1'));
    view.rerender(layout(undefined));

    expect(screen.getByTestId('message-expand')).toHaveTextContent('Show less');
  });
});
