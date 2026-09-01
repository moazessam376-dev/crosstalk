import { createElement, useEffect, useState } from 'react';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Disconnected } from './layout/Disconnected.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Layout } from './layout/Layout.js';
import { deriveState } from './state/derive.js';
import { useLog, type LogSource } from './state/useLog.js';
import { loadHubConfig, type HubConnection } from './state/hubConfig.js';
import { useMirror } from './state/useMirror.js';
import { postCompose, postMirrorRepo, postHumanAction, postMessage, postVote, type HumanAction } from './state/humanAction.js';
import { dmId } from '../core/rooms.js';
import { isRunStart } from '../core/runs.js';
import { useRuns } from './state/useRuns.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { RunPicker } from './layout/RunPicker.js';
import { FLOOR } from '../contracts/room.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Launcher } from './launch/Launcher.js';
import { useHarnessCatalog, useLaunch, useSessions, useShapes } from './state/useLaunch.js';
import { useOperatorName } from './state/operator.js';

/**
 * Used when no daemon answers `/config.json` — `vite dev`, or a static build
 * someone opened directly. It is never shown unasked: see `Disconnected`.
 */
const FIXTURE_SOURCE: LogSource = { kind: 'fixture', path: '/session-dispute.jsonl' };

export interface AppProps {
  /** Injected by tests. Production resolves it from the daemon. */
  connection?: HubConnection;
}

function sourceFor(connection: HubConnection): LogSource {
  return connection.kind === 'live'
    ? { kind: 'sse', url: connection.config.streamUrl }
    : FIXTURE_SOURCE;
}

/**
 * Where the browser is pointed, for the recovery screen to quote back.
 *
 * Read off `globalThis` because the repo's tsconfig omits the `dom` lib on
 * purpose, so `window` is not a name here.
 */
function currentOrigin(): string {
  const location = (globalThis as { location?: { origin?: string; pathname?: string } }).location;
  if (location === undefined) return '';
  return `${location.origin ?? ''}${location.pathname ?? ''}`;
}

export default function App({ connection: injected }: AppProps = {}) {
  const [connection, setConnection] = useState<HubConnection>(injected ?? { kind: 'loading' });
  const [notice, setNotice] = useState<string | undefined>();
  const [sampleOpened, setSampleOpened] = useState(false);
  // The board is where a run is watched; the launcher is where one starts. They
  // are different jobs, so they are different screens rather than a panel that
  // steals room from the conversation once the run is under way.
  const [view, setView] = useState<'board' | 'launch'>('board');
  const mirror = useMirror(connection.kind === 'live');
  const shapes = useShapes(connection.kind === 'live');
  const catalog = useHarnessCatalog(connection.kind === 'live');
  const sessions = useSessions(connection.kind === 'live');
  const { launch, launching } = useLaunch();
  const { name: operator, setName: setOperator } = useOperatorName();
  const runsView = useRuns(connection.kind === 'live');
  // Which seat's terminal is open. Held here rather than in `Layout` so the
  // launcher can close it: starting a new run and staring at the last run's
  // dead terminal was the first thing that went wrong when this was local.
  const [openSeat, setOpenSeat] = useState<string | undefined>();

  useEffect(() => {
    if (injected !== undefined) return;
    let cancelled = false;
    void loadHubConfig().then((resolved) => {
      if (!cancelled) setConnection(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [injected]);

  const { events, connected } = useLog(sourceFor(connection));
  const [selectedRoom, setSelectedRoom] = useState<string | undefined>();

  // A run boundary can select a room out of existence.
  //
  // `selectedRoom` holds an id, and a `dm:` room from the run that just ended
  // is not a room any more: the sidebar stops listing it and the stream has
  // nothing for it, so the hub sits on a blank pane with no route back except
  // guessing that #floor is still there. `openSeat` is the same defect one
  // layer up — a terminal belonging to a team that has stopped.
  //
  // `useLog` empties its buffer on the marker, so it is the first event held
  // whenever a run is current; its seq is what changes.
  const runSeq = events.length > 0 && isRunStart(events[0]!) ? events[0]!.seq : 0;
  useEffect(() => {
    if (runSeq === 0) return;
    setSelectedRoom(undefined);
    setOpenSeat(undefined);
    // The run that just ended is a run the picker does not know about yet.
    void runsView.refresh();
  }, [runSeq]);
  const maxRounds = connection.kind === 'live' ? connection.config.maxRounds : undefined;
  const state = deriveState(events, maxRounds);
  const defaultRoom = connection.kind === 'live'
    ? connection.config.room
    : state.rooms.find((room) => room.kind === 'dispute')?.id ?? state.rooms[0]?.id;
  const activeRoom = selectedRoom ?? defaultRoom;

  // The pill shows a short label; this is the long one. Four states, not two:
  // `connected` alone cannot tell a live stream that has sent nothing from a
  // hub reading a fixture, and "connected" over an empty screen is this
  // project's signature failure, shipped once already behind 28 green tests.
  // The design has no room for the long form, so it stays as the live region —
  // a screen reader still gets the distinction the pill compresses.
  const status = connection.kind === 'loading'
    ? 'connecting'
    : connection.kind === 'fixture'
      ? 'not connected'
      : connected
        ? (events.length === 0 ? 'live — waiting for the first event' : 'live')
        : 'reconnecting';
  const statusLabel = status.startsWith('live') ? 'live' : status;

  /**
   * CT-10. A refused browser used to get the entire working hub — channel
   * list, composer, live Send button — over zero events and an empty
   * participants panel, under the words "showing a sample conversation" when no
   * sample had loaded. A live session with sixteen events and two open claims
   * was read as dead.
   *
   * With no daemon there is nothing to show and nothing that can be posted, so
   * the hub is not drawn at all. The sample is offered only once it has
   * actually loaded, and only on request — a hub that announces a sample it
   * does not have is the whole defect.
   */
  if (connection.kind === 'fixture' && !sampleOpened) {
    return createElement(Disconnected, {
      reason: connection.reason,
      origin: currentOrigin(),
      sampleCount: events.length,
      onViewSample: () => setSampleOpened(true),
    });
  }

  const onHumanAction = (action: HumanAction): void => {
    if (connection.kind !== 'live') {
      setNotice('This hub is not connected to a daemon, so there is nobody to tell.');
      return;
    }
    setNotice(undefined);
    void postHumanAction(action, activeRoom ?? connection.config.room).then((result) => {
      if (!result.ok) setNotice(result.reason);
    });
  };

  return createElement(
    'main',
    {
      'data-connected': connected ? 'true' : 'false',
      'data-source': connection.kind,
      'data-status': status,
      className: 'hub-root',
    },
    // The sample is a sample and says so for as long as it is on screen. It is
    // read-only: there is no daemon behind it to post to.
    connection.kind === 'fixture'
      ? createElement(
          'p',
          { className: 'sample-banner', role: 'status', 'data-testid': 'sample-banner' },
          `Sample conversation — not your session. ${connection.reason}`,
        )
      : null,
    notice !== undefined
      ? createElement('p', { className: 'app-notice', role: 'alert', 'data-testid': 'human-action-notice' }, notice)
      : null,
    createElement('p', { className: 'app-status sr-only', 'aria-live': 'polite' }, status),
    connection.kind === 'live'
      ? createElement(
          'nav',
          { className: 'hub-views', 'aria-label': 'hub views' },
          (['board', 'launch'] as const).map((name) =>
            createElement(
              'button',
              {
                key: name,
                type: 'button',
                className: `hub-view${view === name ? ' is-current' : ''}`,
                'aria-current': view === name ? 'page' : undefined,
                onClick: () => {
                  setView(name);
                  setOpenSeat(undefined);
                },
              },
              name === 'board' ? 'Board' : 'Start a run',
            ),
          ),
        )
      : null,
    view === 'launch' && connection.kind === 'live'
      ? createElement(Launcher, {
          shapes,
          catalog,
          launching,
          // The roster this daemon is running. A seat's role and harness are
          // fixed when its token is minted, so this is the roster a launch can
          // actually name — arriving with anything else means the default
          // action on the screen fails.
          running: sessions?.seats ?? [],
          // A launch that leaves you on an emptied form gives no sign anything
          // happened. The job lands on the floor and the seats start joining
          // there, so that is where to be — the operator asked to drop a
          // prompt and be taken to the room.
          onLaunch: async (request: { job: string; shape?: string; seats: string[] }) => {
            const result = await launch(request);
            if (result.ok) {
              setView('board');
              setSelectedRoom(FLOOR);
            }
            return result;
          },
        })
      : createElement(Layout, {
      state,
      activeRoom,
      maxRounds,
      status: statusLabel,
      self: connection.kind === 'live' ? connection.config.self : undefined,
      onSend: connection.kind === 'live' && activeRoom !== undefined
        ? (body: string) => postMessage(body, activeRoom)
        : undefined,
      onVote: connection.kind === 'live'
        ? (decisionId: string, option: string, rationale: string) => postVote(decisionId, option, rationale)
        : undefined,
      onSelectRoom: (roomId: string) => setSelectedRoom(roomId),
      // Only with a daemon: the run list is a fact about files on disk, and a
      // picker over a fixture would be a menu of one thing that cannot change.
      runPicker: connection.kind === 'live'
        ? createElement(RunPicker, {
            runs: runsView.runs,
            onArchive: (runId: string) => void runsView.archive(runId),
            onDelete: (runId: string) => void runsView.remove(runId),
            onStartNew: () => void runsView.startNew(),
          })
        : undefined,
      onHumanAction,
      // Selecting the room is the whole action: the room becomes real when
      // something is said in it, and the composer is already there. Posting an
      // empty "opened a room" message would put a card in everyone's stream
      // saying nothing.
      onOpenSideRoom: connection.kind === 'live'
        ? (participantId: string) => setSelectedRoom(dmId(connection.config.self, participantId))
        : undefined,
      onCompose: connection.kind === 'live' ? (job: string) => postCompose(job) : undefined,
      // Only against a live daemon: there is no config to write otherwise, and
      // a field that silently does nothing is worse than no field.
      onConfigureMirror: connection.kind === 'live' ? (url: string) => postMirrorRepo(url) : undefined,
      ...(operator === undefined ? {} : { operator }),
      onSetOperator: setOperator,
      sessions,
      ...(openSeat === undefined ? {} : { openSeat }),
      onOpenSession: connection.kind === 'live' ? (seat: string) => setOpenSeat(seat) : undefined,
      onCloseSession: () => setOpenSeat(undefined),
      // Only against a live daemon. The fixture hub has no `/mirror` to poll,
      // and a card there would describe a mirror that does not exist.
      mirror,
    }),
  );
}
