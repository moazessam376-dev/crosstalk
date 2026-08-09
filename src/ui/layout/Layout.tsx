import { createElement } from 'react';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { ChannelList } from './ChannelList.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Inspector } from './Inspector.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Rail } from './Rail.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Stream } from './Stream.js';
import type { HubState } from '../state/derive.js';

export interface LayoutProps {
  state: HubState;
  activeRoom?: string;
  onSelectRoom?: (roomId: string) => void;
}

const GRID_TEMPLATE = 'minmax(180px, 220px) minmax(220px, 280px) minmax(0, 1fr) minmax(240px, 320px)';

export function Layout({ state, activeRoom, onSelectRoom }: LayoutProps) {
  return createElement(
    'div',
    {
      className: 'hub-layout',
      'data-testid': 'hub-layout',
      'data-layout': 'four-region',
      style: {
        display: 'grid',
        gridTemplateColumns: GRID_TEMPLATE,
        gap: '1px',
        minHeight: '100vh',
        backgroundColor: 'var(--border-hairline)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui)',
        fontSize: 'var(--size-ui)',
      },
    },
    createElement(Rail, { participants: state.participants }),
    createElement(ChannelList, { rooms: state.rooms, activeRoom, onSelectRoom }),
    createElement(Stream, { events: state.events, activeRoom }),
    createElement(Inspector, { activeRoom, rooms: state.rooms }),
  );
}
