// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ChannelList } from '../../src/ui/layout/ChannelList.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Layout } from '../../src/ui/layout/Layout.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Rail } from '../../src/ui/layout/Rail.js';
import type { HubState } from '../../src/ui/state/derive.js';

afterEach(cleanup);

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
