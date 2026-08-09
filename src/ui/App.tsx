import { createElement, useState } from 'react';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Layout } from './layout/Layout.js';
import { deriveState } from './state/derive.js';
import { useLog } from './state/useLog.js';

const DEFAULT_SOURCE = { kind: 'fixture', path: '/fixtures/session-dispute.jsonl' } as const;

export default function App() {
  const { events, connected } = useLog(DEFAULT_SOURCE);
  const [selectedRoom, setSelectedRoom] = useState<string | undefined>();
  const state = deriveState(events);
  const defaultRoom = state.rooms.find((room) => room.kind === 'dispute')?.id ?? state.rooms[0]?.id;
  const activeRoom = selectedRoom ?? defaultRoom;

  return createElement(
    'main',
    { 'data-connected': connected ? 'true' : 'false' },
    createElement('p', { className: 'app-status', 'aria-live': 'polite' }, connected ? 'connected' : 'connecting'),
    createElement(Layout, {
      state,
      activeRoom,
      onSelectRoom: (roomId) => setSelectedRoom(roomId),
    }),
  );
}
