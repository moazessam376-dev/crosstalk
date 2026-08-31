import { createElement } from 'react';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Dock } from './Dock.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Sidebar } from './Sidebar.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Stream } from './Stream.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { EnvironmentRail } from '../env/EnvironmentRail.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { SessionPanel } from '../session/SessionPanel.js';
import type { HubState } from '../state/derive.js';
import type { SessionsView } from '../state/useLaunch.js';
import type { MirrorView } from '../state/useMirror.js';
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
  onCompose?: (job: string) => Promise<PostResult>;
  /** `GET /mirror`, not the log. Undefined until the first response. */
  mirror?: MirrorView;
  /** `GET /sessions`: who is seated, what they are doing, what can be mirrored. */
  sessions?: SessionsView;
  /** What to call the operator's own seat, and how to change it. */
  operator?: string;
  onSetOperator?: (name: string) => void;
  /** The seat whose terminal is open, if any. */
  openSeat?: string;
  onOpenSession?: (seat: string) => void;
  onCloseSession?: () => void;
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
  onCompose,
  mirror,
  sessions,
  operator,
  onSetOperator,
  openSeat,
  onOpenSession,
  onCloseSession,
}: LayoutProps) {
  const seat = sessions?.seats.find((candidate) => candidate.id === openSeat);
  const mirrored = new Set((sessions?.seats ?? []).filter((s) => s.mirrored === true).map((s) => s.id));

  return createElement(
    'div',
    { className: 'hub-shell' },
    sessions === undefined && mirror === undefined
      ? null
      : createElement(EnvironmentRail, { sessions, mirror, onOpenSession, openSeat }),
    createElement(
    'div',
    {
      className: 'hub-layout',
      'data-testid': 'hub-layout',
      'data-layout': 'three-region',
      style: { gridTemplateColumns: GRID_TEMPLATE },
    },
    createElement(Sidebar, { rooms: state.rooms, activeRoom, self, operator, onSetOperator, onSelectRoom }),
    // The seat's terminal takes the centre column rather than opening beside
    // it. A mirror squeezed into a dock is a terminal you cannot read, and
    // reading it is the entire reason to open one.
    seat !== undefined && onCloseSession !== undefined
      ? createElement(SessionPanel, { seat, onClose: onCloseSession })
      : createElement(Stream, {
      events: state.events,
      activeRoom,
      rooms: state.rooms,
      participants: state.participants,
      maxRounds,
      self,
      status,
      operator,
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
      onOpenSession,
      onCompose,
      mirror,
      mirrored,
      operator,
    }),
    ),
  );
}
