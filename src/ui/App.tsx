import { createElement, useEffect, useState } from 'react';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Disconnected } from './layout/Disconnected.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Layout } from './layout/Layout.js';
import { deriveState } from './state/derive.js';
import { useLog, type LogSource } from './state/useLog.js';
import { loadHubConfig, type HubConnection } from './state/hubConfig.js';
import { useMirror } from './state/useMirror.js';
import { postHumanAction, postMessage, postVote, type HumanAction } from './state/humanAction.js';
import { dmId } from '../core/rooms.js';

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
  const mirror = useMirror(connection.kind === 'live');

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
    createElement(Layout, {
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
      onHumanAction,
      // Selecting the room is the whole action: the room becomes real when
      // something is said in it, and the composer is already there. Posting an
      // empty "opened a room" message would put a card in everyone's stream
      // saying nothing.
      onOpenSideRoom: connection.kind === 'live'
        ? (participantId: string) => setSelectedRoom(dmId(connection.config.self, participantId))
        : undefined,
      // Only against a live daemon. The fixture hub has no `/mirror` to poll,
      // and a card there would describe a mirror that does not exist.
      mirror,
    }),
  );
}
