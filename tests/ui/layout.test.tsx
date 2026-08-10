// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ChannelList } from '../../src/ui/layout/ChannelList.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Composer } from '../../src/ui/layout/Composer.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Layout } from '../../src/ui/layout/Layout.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Rail } from '../../src/ui/layout/Rail.js';
import type { HubState } from '../../src/ui/state/derive.js';

afterEach(cleanup);

// The repo's tsconfig omits the `dom` lib on purpose, so `HTMLTextAreaElement`
// carries no `value`. One narrow cast, named once.
function valueOf(field: Element): string {
  return (field as unknown as { value: string }).value;
}

const state: HubState = {
  participants: [{ id: 'codex', role: 'worker', status: 'awaiting_turn', tier: 'mcp' }],
  rooms: [{ id: '#floor', kind: 'floor' }],
  events: [],
  lastSeq: 0,
};

describe('hub layout regions', () => {
  it('renders participants with live status and tier badge', () => {
    render(createElement(Rail, { participants: [{ id: 'codex', role: 'worker', status: 'awaiting_turn', tier: 'mcp' }] }));

    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByLabelText('awaiting turn')).toBeInTheDocument();
    expect(screen.getByText('mcp')).toBeInTheDocument();
  });

  it('groups channels and shows a round counter on disputes', () => {
    render(createElement(ChannelList, { rooms: [{ id: 'dispute:C-118', kind: 'dispute', rounds: 2, maxRounds: 3 }] }));

    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  it('sorts rooms awaiting a human decision to the top', () => {
    render(
      createElement(ChannelList, {
        rooms: [
          { id: 'task:T-1', kind: 'task' },
          { id: 'dispute:C-9', kind: 'dispute', awaitingHuman: true },
        ],
      }),
    );

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('C-9');
  });

  it('renders the rail, channels, stream, and inspector as four regions', () => {
    render(createElement(Layout, { state, activeRoom: '#floor' }));

    expect(screen.getAllByTestId('hub-region')).toHaveLength(4);
    expect(screen.getByTestId('hub-layout')).toHaveAttribute('data-layout', 'four-region');
  });
});

/**
 * C2. `ChannelList` carried its own `DEFAULT_MAX_ROUNDS = 3`, independent of
 * the one in `derive.ts` and of the config the daemon was running. The same
 * dispute read "round 3 / 3" in the header and "4/3" in this row.
 */
describe('C2 channel row denominator', () => {
  it('renders the configured maximum', () => {
    render(createElement(ChannelList, { rooms: [{ id: 'dispute:C-118', kind: 'dispute', rounds: 2, maxRounds: 5 }] }));

    expect(screen.getByText('2/5')).toBeInTheDocument();
  });

  it('renders the round alone when no config supplied a maximum', () => {
    // Not "2/3". A fallback here is the deleted constant coming back.
    render(createElement(ChannelList, { rooms: [{ id: 'dispute:C-118', kind: 'dispute', rounds: 2 }] }));

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('2/3')).not.toBeInTheDocument();
  });
});

/**
 * C3. Design §10.3 gives the human a composer on every room, and there was no
 * `<input>` or `<textarea>` anywhere in `src/ui/` — only two canned buttons.
 * The human could watch the argument and not join it.
 */
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
