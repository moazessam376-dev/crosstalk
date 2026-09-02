import { type ReactNode, createElement } from 'react';
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
import type { MessageAttachment } from '../../contracts/events.js';

type HumanAction = { type: 'propose_test' | 'intervene_human' };

export interface LayoutProps {
  state: HubState;
  activeRoom?: string;
  /** `policy.dispute.maxRounds`, passed through to the dispute header. */
  maxRounds?: number;
  /** Where blobs live on this machine, from `/config.json`. Only a video chip uses it. */
  blobRoot?: string;
  /** Who the daemon attributes this browser's posts to. */
  self?: string;
  /** `live`, `connecting` or `reconnecting`. */
  status?: string;
  /** Absent when no daemon is attached — the composer is not rendered at all. */
  onSend?: (body: string, attachments?: readonly MessageAttachment[]) => Promise<PostResult>;
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
  /** Point the mirror at a repository. Passed through to the rail. */
  onConfigureMirror?: (url: string) => Promise<{ ok: boolean; reason?: string }>;
  /** The run picker, rendered into the sidebar head. Absent without a daemon. */
  runPicker?: ReactNode;
}

export function Layout({
  state,
  activeRoom,
  maxRounds,
  blobRoot,
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
  onConfigureMirror,
  runPicker,
}: LayoutProps) {
  const seat = sessions?.seats.find((candidate) => candidate.id === openSeat);
  const showingSeat = seat !== undefined && onCloseSession !== undefined;
  const mirrored = new Set((sessions?.seats ?? []).filter((s) => s.mirrored === true).map((s) => s.id));

  return createElement(
    'div',
    { className: 'hub-shell' },
    sessions === undefined && mirror === undefined
      ? null
      : createElement(EnvironmentRail, {
          sessions,
          mirror,
          onOpenSession,
          openSeat,
          ...(onConfigureMirror === undefined ? {} : { onConfigureMirror }),
        }),
    createElement(
    'div',
    {
      className: 'hub-layout',
      'data-testid': 'hub-layout',
      'data-layout': 'three-region',
      // The column widths live in `theme.css`, not here. An inline style beats
      // every media query, so a hub with the track sizes set in JS cannot
      // collapse for a narrow screen — and watching a run from a phone is the
      // reason the interactive seats exist.
    },
    createElement(Sidebar, { rooms: state.rooms, activeRoom, self, operator, onSetOperator, onSelectRoom, runPicker }),
    // The seat's terminal takes the centre column rather than opening beside
    // it. A mirror squeezed into a dock is a terminal you cannot read, and
    // reading it is the entire reason to open one.
    //
    // Both are rendered, and the board is hidden rather than swapped out. These
    // shared one slot, and React reconciles by component type: a type change at
    // a position unmounts the whole subtree and mounts a new one. So every trip
    // to a CLI and back destroyed `.stream-scroll` and built a fresh one at the
    // top of the log — 1187 events from where the operator was reading — along
    // with every expanded message and any half-written composer draft. Nothing
    // in `src/ui/` restores a scroll position, so nothing put it back.
    createElement(Stream, {
      hidden: showingSeat,
      events: state.events,
      activeRoom,
      rooms: state.rooms,
      participants: state.participants,
      maxRounds,
      blobRoot,
      self,
      status,
      operator,
      onSend,
      onVote,
      onHumanAction,
    }),
    showingSeat ? createElement(SessionPanel, { seat, onClose: onCloseSession! }) : null,
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
