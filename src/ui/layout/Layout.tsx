import { createElement } from 'react';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Dock } from './Dock.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Sidebar } from './Sidebar.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Stream } from './Stream.js';
import type { HubState } from '../state/derive.js';
import type { PostResult } from '../state/humanAction.js';

type HumanAction = { type: 'propose_test' | 'intervene_human' };

export interface LayoutProps {
  state: HubState;
  activeRoom?: string;
  /** `policy.dispute.maxRounds`, passed through to the dispute header. */
  maxRounds?: number;
  /** Who the daemon attributes this browser's posts to. */
  self?: string;
  /** `live`, `connecting` or `reconnecting`. */
  status?: string;
  /** Absent when no daemon is attached — the composer is not rendered at all. */
  onSend?: (body: string) => Promise<PostResult>;
  onVote?: (decisionId: string, option: string, rationale: string) => Promise<PostResult>;
  onSelectRoom?: (roomId: string) => void;
  onHumanAction?: (action: HumanAction) => void;
  /** Opens a side room with a participant and selects it. CT-18. */
  onOpenSideRoom?: (participantId: string) => void;
}

/** Sidebar · stream · dock, at the design's widths. */
const GRID_TEMPLATE = '252px minmax(0, 1fr) 316px';

export function Layout({
  state,
  activeRoom,
  maxRounds,
  self,
  status,
  onSend,
  onVote,
  onSelectRoom,
  onHumanAction,
  onOpenSideRoom,
}: LayoutProps) {
  return createElement(
    'div',
    {
      className: 'hub-layout',
      'data-testid': 'hub-layout',
      'data-layout': 'three-region',
      style: { gridTemplateColumns: GRID_TEMPLATE },
    },
    createElement(Sidebar, { rooms: state.rooms, activeRoom, self, onSelectRoom }),
    createElement(Stream, {
      events: state.events,
      activeRoom,
      rooms: state.rooms,
      participants: state.participants,
      maxRounds,
      self,
      status,
      onSend,
      onVote,
      onHumanAction,
    }),
    createElement(Dock, {
      events: state.events,
      participants: state.participants,
      rooms: state.rooms,
      activeRoom,
      self,
      onOpenSideRoom,
    }),
  );
}
