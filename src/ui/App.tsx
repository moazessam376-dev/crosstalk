import { createElement, useEffect, useState } from 'react';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Layout } from './layout/Layout.js';
import { deriveState } from './state/derive.js';
import { useLog, type LogSource } from './state/useLog.js';
import { loadHubConfig, type HubConnection } from './state/hubConfig.js';
import { postHumanAction, postMessage, postVote, type HumanAction } from './state/humanAction.js';

/**
 * Used when no daemon answers `/config.json` — `vite dev`, or a static build
 * someone opened directly. Keeping it means every existing UI test still
 * drives the component the same way.
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

export default function App({ connection: injected }: AppProps = {}) {
  const [connection, setConnection] = useState<HubConnection>(injected ?? { kind: 'loading' });
  const [notice, setNotice] = useState<string | undefined>();

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
  // Undefined in fixture mode, and deliberately not defaulted. `deriveState`
  // feeds the channel rows and the prop feeds the dispute header; both read
  // this one value so the two can no longer disagree.
  const maxRounds = connection.kind === 'live' ? connection.config.maxRounds : undefined;
  const state = deriveState(events, maxRounds);
  const defaultRoom = connection.kind === 'live'
    ? connection.config.room
    : state.rooms.find((room) => room.kind === 'dispute')?.id ?? state.rooms[0]?.id;
  const activeRoom = selectedRoom ?? defaultRoom;

  // Four states, not two. `connected` alone cannot distinguish a live stream
  // that has sent nothing yet from a hub reading a fixture — and "connected"
  // over an empty screen is this project's signature failure, shipped once
  // already with 28 green tests behind it.
  const status = connection.kind === 'loading'
    ? 'connecting'
    : connection.kind === 'fixture'
      ? 'offline — showing a sample conversation'
      : connected
        ? (events.length === 0 ? 'live — waiting for the first event' : 'live')
        : 'reconnecting';

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
    },
    createElement('p', { className: 'app-status', 'aria-live': 'polite' }, status),
    connection.kind === 'fixture'
      ? createElement('p', { className: 'app-reason', 'data-testid': 'fixture-reason' }, connection.reason)
      : null,
    notice !== undefined
      ? createElement('p', { className: 'app-notice', role: 'alert', 'data-testid': 'human-action-notice' }, notice)
      : null,
    // An empty live log is a first run, not a fault. Saying nothing here is how
    // a blank screen gets shipped and called "connected".
    connection.kind === 'live' && events.length === 0
      ? createElement(
          'p',
          { className: 'app-empty', 'data-testid': 'empty-log' },
          `Connected as ${connection.config.self}. Nothing has been said yet — start an agent, or post to ${connection.config.room}.`,
        )
      : null,
    createElement(Layout, {
      state,
      activeRoom,
      maxRounds,
      self: connection.kind === 'live' ? connection.config.self : undefined,
      // No daemon, nowhere to post. The composer is hidden rather than shown
      // and inert — a text box that silently drops what you typed is worse
      // than no text box.
      onSend: connection.kind === 'live' && activeRoom !== undefined
        ? (body: string) => postMessage(body, activeRoom)
        : undefined,
      onVote: connection.kind === 'live'
        ? (decisionId: string, option: string, rationale: string) => postVote(decisionId, option, rationale)
        : undefined,
      onSelectRoom: (roomId: string) => setSelectedRoom(roomId),
      onHumanAction,
    }),
  );
}
