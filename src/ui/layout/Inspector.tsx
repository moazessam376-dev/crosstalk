import { createElement } from 'react';
import type { ChannelRoom } from '../state/derive.js';

export interface InspectorProps {
  activeRoom?: string;
  rooms: ChannelRoom[];
}

export function Inspector({ activeRoom, rooms }: InspectorProps) {
  const room = rooms.find((candidate) => candidate.id === activeRoom);
  return createElement(
    'aside',
    { className: 'hub-region hub-inspector', 'aria-label': 'inspector', 'data-testid': 'hub-region' },
    createElement('h2', null, 'Inspector'),
    room
      ? createElement(
          'dl',
          null,
          createElement('dt', null, 'Room'),
          createElement('dd', { className: 'fact' }, room.id),
          createElement('dt', null, 'Kind'),
          createElement('dd', null, room.kind),
          room.awaitingHuman ? createElement('dd', { className: 'human-callout' }, 'Awaiting human decision') : null,
        )
      : createElement('p', null, 'Select a channel'),
  );
}
