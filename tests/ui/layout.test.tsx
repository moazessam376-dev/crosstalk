// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Sidebar } from '../../src/ui/layout/Sidebar.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Composer } from '../../src/ui/layout/Composer.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Layout } from '../../src/ui/layout/Layout.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Dock } from '../../src/ui/layout/Dock.js';
import type { HubState } from '../../src/ui/state/derive.js';

afterEach(cleanup);

// The repo's tsconfig omits the `dom` lib on purpose, so `HTMLTextAreaElement`
// carries no `value`. One narrow cast, named once.
function valueOf(field: Element): string {
  return (field as unknown as { value: string }).value;
}

// Same reason: no `dom` lib means no global `document` and no `Node.contains`.
function byClass(selector: string): Element | null {
  return (globalThis as unknown as { document: { querySelector(s: string): Element | null } })
    .document.querySelector(selector);
}

function contains(parent: Element, child: Element): boolean {
  return (parent as unknown as { contains(node: Element): boolean }).contains(child);
}

const state: HubState = {
  participants: [{ id: 'codex', role: 'worker', status: 'awaiting_turn', tier: 'mcp', harness: 'codex-cli', workspace: '.crosstalk/worktrees/codex' }],
  rooms: [{ id: '#floor', kind: 'floor' }],
  events: [],
  lastSeq: 0,
};

describe('hub layout regions', () => {
  it('renders participants with their status, harness, model and tier', () => {
    // The participant rail moved into the right dock, which is where the design
    // puts the roster — beside the room it belongs to rather than in a column
    // of its own.
    render(
      createElement(Dock, {
        events: [],
        rooms: [{ id: '#floor', kind: 'floor' }],
        activeRoom: '#floor',
        participants: [
          { id: 'codex', role: 'worker', status: 'awaiting_turn', tier: 'mcp', harness: 'codex-cli', model: 'gpt-5.5-codex', workspace: '.crosstalk/worktrees/codex' },
        ],
      }),
    );

    expect(screen.getByTestId('member-codex')).toHaveTextContent('codex');
    expect(screen.getByTestId('member-codex')).toHaveTextContent('codex-cli · gpt-5.5-codex · mcp');
    expect(screen.getByTestId('member-dot-codex')).toHaveAttribute('data-status', 'awaiting_turn');
  });

  it('renders no tier at all when the transport was never probed', () => {
    // Spec 10.1: `Tier` has no *unknown* member, so a defaulted `file` is
    // indistinguishable from a probed `file`. Absence says "not probed"; the
    // two are different claims and only one of them is true.
    render(
      createElement(Dock, {
        events: [],
        rooms: [{ id: '#floor', kind: 'floor' }],
        activeRoom: '#floor',
        participants: [
          { id: 'codex', role: 'worker', status: 'working', harness: 'codex-cli', workspace: '.' },
        ],
      }),
    );

    expect(screen.getByTestId('member-codex')).toHaveTextContent('codex-cli');
    expect(screen.getByTestId('member-codex')).not.toHaveTextContent('mcp');
    expect(screen.getByTestId('member-codex')).not.toHaveTextContent('file');
  });

  it('renders effort attached to the model, as the design has it', () => {
    // `harness · model effort · tier`. Effort qualifies the model rather than
    // standing beside it: "opus-5 max" is one configuration, "opus-5 · max"
    // reads as two peer facts.
    render(
      createElement(Dock, {
        events: [],
        rooms: [{ id: '#floor', kind: 'floor' }],
        activeRoom: '#floor',
        participants: [
          { id: 'metrics', role: 'worker', status: 'working', tier: 'mcp', harness: 'claude-code-app', model: 'opus-5', effort: 'max', workspace: '.' },
        ],
      }),
    );

    expect(screen.getByTestId('member-metrics')).toHaveTextContent('claude-code-app · opus-5 max · mcp');
  });

  it('renders no effort at all when none is configured', () => {
    // The other side of the discrimination. A default here would put a level on
    // screen that nothing configured — the mistake `tier` already avoids.
    render(
      createElement(Dock, {
        events: [],
        rooms: [{ id: '#floor', kind: 'floor' }],
        activeRoom: '#floor',
        participants: [
          { id: 'metrics', role: 'worker', status: 'working', tier: 'mcp', harness: 'claude-code-app', model: 'opus-5', workspace: '.' },
        ],
      }),
    );

    expect(screen.getByTestId('member-metrics')).toHaveTextContent('claude-code-app · opus-5 · mcp');
  });

  it('renders effort even when the model is unknown, without a stray space', () => {
    // `model effort` is a join of two optional parts, and this is the shape that
    // actually ships first: Rigit's config sets an effort and no model, so a
    // naive join yields a leading space inside the separators.
    render(
      createElement(Dock, {
        events: [],
        rooms: [{ id: '#floor', kind: 'floor' }],
        activeRoom: '#floor',
        participants: [
          { id: 'metrics', role: 'worker', status: 'working', tier: 'mcp', harness: 'claude-code-app', effort: 'max', workspace: '.' },
        ],
      }),
    );

    expect(screen.getByTestId('member-metrics')).toHaveTextContent('claude-code-app · max · mcp');
  });

  it('groups channels and shows a round counter on disputes', () => {
    render(createElement(Sidebar, { rooms: [{ id: 'dispute:C-118', kind: 'dispute', rounds: 2, maxRounds: 3 }] }));

    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  it('sorts rooms awaiting a human decision to the top', () => {
    render(
      createElement(Sidebar, {
        rooms: [
          { id: 'task:T-1', kind: 'task' },
          { id: 'dispute:C-9', kind: 'dispute', awaitingHuman: true },
        ],
      }),
    );

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('C-9');
  });

  it('renders the sidebar, stream and dock as three regions', () => {
    // The design is three columns, not four: the participant rail moved into
    // the right dock beside Room and Workspace, which is where the roster is
    // read from rather than glanced at.
    render(createElement(Layout, { state, activeRoom: '#floor' }));

    expect(screen.getAllByTestId('hub-region')).toHaveLength(3);
    expect(screen.getByTestId('hub-layout')).toHaveAttribute('data-layout', 'three-region');
  });
});

/**
 * C2. `ChannelList` carried its own `DEFAULT_MAX_ROUNDS = 3`, independent of
 * the one in `derive.ts` and of the config the daemon was running. The same
 * dispute read "round 3 / 3" in the header and "4/3" in this row.
 */
describe('C2 channel row denominator', () => {
  it('renders the configured maximum', () => {
    render(createElement(Sidebar, { rooms: [{ id: 'dispute:C-118', kind: 'dispute', rounds: 2, maxRounds: 5 }] }));

    expect(screen.getByText('2/5')).toBeInTheDocument();
  });

  it('renders the round alone when no config supplied a maximum', () => {
    // Not "2/3". A fallback here is the deleted constant coming back.
    render(createElement(Sidebar, { rooms: [{ id: 'dispute:C-118', kind: 'dispute', rounds: 2 }] }));

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('2/3')).not.toBeInTheDocument();
  });
});

/**
 * C3. Design §10.3 gives the human a composer on every room, and there was no
 * `<input>` or `<textarea>` anywhere in `src/ui/` — only two canned buttons.
 * The human could watch the argument and not join it.
 */
/**
 * CT-15. The operator's most-repeated friction of a day's use: to send a message
 * they had to scroll to the very bottom of `#floor`, and with agents writing
 * long-form that distance grew with every event.
 *
 * Already fixed by the hub redesign and pinned by nothing. This is the DOM half
 * — the composer is a sibling of the scrolling log, not a child of it. The CSS
 * half is in `theme.test.ts`, and neither is sufficient alone: the composer can
 * be outside the scroll container and still scroll away if `.stream-scroll`
 * loses `flex: 1`.
 */
describe('the composer is a control, not the last thing in the log', () => {
  it('renders outside the scrolling region', () => {
    render(
      createElement(Layout, {
        state: { ...state, rooms: [{ id: '#floor', kind: 'floor' }] },
        activeRoom: '#floor',
        self: '@human',
        onSend: async () => ({ ok: true as const }),
      }),
    );

    const composer = screen.getByTestId('composer');
    const scroll = byClass('.stream-scroll');

    expect(scroll).toBeTruthy();
    expect(contains(scroll!, composer)).toBe(false);
    // And still inside the stream region, so it belongs to the room on screen
    // rather than floating over the whole hub.
    expect(contains(byClass('.hub-stream')!, composer)).toBe(true);
  });
});

describe('C3 composer', () => {
  function renderComposer(send: (body: string) => Promise<{ ok: true } | { ok: false; reason: string }>) {
    render(createElement(Composer, { room: 'dispute:C-118', self: '@human', onSend: send }));
    return screen.getByTestId('composer-input');
  }

  it('sends on Enter and clears the field', async () => {
    const sent: string[] = [];
    const field = renderComposer(async (body) => {
      sent.push(body);
      return { ok: true as const };
    });

    fireEvent.change(field, { target: { value: 'Stop and wait for my ruling.' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(valueOf(field)).toBe(''));
    expect(sent).toEqual(['Stop and wait for my ruling.']);
  });

  it('does not send on Shift+Enter', async () => {
    // The neighbouring case: Shift+Enter is how you write a second line, and a
    // composer that posts it has eaten a half-written message.
    const sent: string[] = [];
    const field = renderComposer(async (body) => {
      sent.push(body);
      return { ok: true as const };
    });

    fireEvent.change(field, { target: { value: 'first line' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });

    expect(sent).toEqual([]);
    expect(valueOf(field)).toBe('first line');
  });

  it('sends nothing when the field holds only whitespace', async () => {
    const sent: string[] = [];
    const field = renderComposer(async (body) => {
      sent.push(body);
      return { ok: true as const };
    });

    fireEvent.change(field, { target: { value: '   \n  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(sent).toEqual([]);
  });

  it('keeps the text and names the reason when the post fails', async () => {
    // Losing what someone typed is not an acceptable failure mode.
    const field = renderComposer(async () => ({ ok: false, reason: 'The daemon answered 401.' }));

    fireEvent.change(field, { target: { value: 'a message worth keeping' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(await screen.findByTestId('composer-error')).toHaveTextContent('The daemon answered 401.');
    expect(valueOf(field)).toBe('a message worth keeping');
  });

  it('says who is posting and where, because everyone in the room sees it', () => {
    const field = renderComposer(async () => ({ ok: true as const }));

    expect(field).toHaveAttribute('placeholder', expect.stringContaining('dispute:C-118'));
    expect(screen.getByTestId('composer-identity')).toHaveTextContent('@human');
  });
});
