import { createElement } from 'react';
import type { ChannelKind, ChannelRoom } from '../state/derive.js';

export interface ChannelListProps {
  rooms: ChannelRoom[];
  activeRoom?: string;
  onSelectRoom?: (roomId: string) => void;
}

const GROUPS: readonly { kind: ChannelKind; label: string }[] = [
  { kind: 'floor', label: 'FLOOR' },
  { kind: 'task', label: 'TASKS' },
  { kind: 'dispute', label: 'DISPUTES' },
  { kind: 'direct', label: 'DIRECT' },
];

const DEFAULT_MAX_ROUNDS = 3;

function displayName(room: ChannelRoom): string {
  if (room.id === '#floor') return '#floor';
  return room.id.replace(/^(task:|dispute:|dm:)/, '');
}

function sortRooms(rooms: ChannelRoom[]): ChannelRoom[] {
  return [...rooms].sort((left, right) => {
    const urgency = Number(Boolean(right.awaitingHuman)) - Number(Boolean(left.awaitingHuman));
    return urgency || left.id.localeCompare(right.id);
  });
}

export function ChannelList({ rooms, activeRoom, onSelectRoom }: ChannelListProps) {
  const groups = GROUPS.map((group) => ({
    ...group,
    rooms: sortRooms(rooms.filter((room) => room.kind === group.kind)),
  }))
    .filter((group) => group.rooms.length > 0)
    .sort((left, right) => {
      const leftUrgent = left.rooms.some((room) => room.awaitingHuman);
      const rightUrgent = right.rooms.some((room) => room.awaitingHuman);
      return Number(rightUrgent) - Number(leftUrgent);
    });

  return createElement(
    'nav',
    { className: 'hub-region hub-channels', 'aria-label': 'channels', 'data-testid': 'hub-region' },
    createElement('h2', null, 'Channels'),
    groups.map((group) =>
      createElement(
        'section',
        { key: group.kind, className: 'channel-group', 'aria-labelledby': `channel-group-${group.kind}` },
        createElement('h3', { id: `channel-group-${group.kind}` }, group.label),
        createElement(
          'ul',
          { className: 'channel-list' },
          group.rooms.map((room) =>
            createElement(
              'li',
              { key: room.id, className: 'channel-item' },
              createElement(
                'button',
                {
                  type: 'button',
                  className: activeRoom === room.id ? 'channel-button is-active' : 'channel-button',
                  onClick: () => onSelectRoom?.(room.id),
                },
                createElement('span', null, displayName(room)),
                room.awaitingHuman ? createElement('span', { className: 'human-badge' }, 'human') : null,
                room.kind === 'dispute' && room.rounds !== undefined
                  ? createElement('span', { className: 'round-counter' }, `${room.rounds}/${room.maxRounds ?? DEFAULT_MAX_ROUNDS}`)
                  : null,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
