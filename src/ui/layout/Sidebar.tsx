import { createElement, useState } from 'react';
import type { ChannelKind, ChannelRoom } from '../state/derive.js';

export interface SidebarProps {
  rooms: ChannelRoom[];
  activeRoom?: string;
  /** Who this browser posts as. Absent without a daemon. */
  self?: string;
  /** What to call that seat on screen. Absent until the operator has said. */
  operator?: string;
  onSetOperator?: (name: string) => void;
  onSelectRoom?: (roomId: string) => void;
}

/**
 * The design's order (design:554). Disputes first: they are the rooms with a
 * clock on them.
 */
const GROUPS: readonly { kind: ChannelKind; label: string }[] = [
  { kind: 'dispute', label: 'DISPUTES' },
  { kind: 'floor', label: 'FLOOR' },
  { kind: 'task', label: 'TASKS' },
  { kind: 'direct', label: 'DIRECT' },
];

/**
 * One glyph per room kind, so the group a room belongs to survives being read
 * at a glance rather than only by its heading.
 */
const ICONS: Record<ChannelKind, string> = {
  floor: '#',
  task: '◇',
  dispute: '⚔',
  direct: '@',
};

function displayName(room: ChannelRoom): string {
  if (room.id === '#floor') return '#floor';
  return room.id.replace(/^(task:|dispute:|dm:)/, '');
}

function sortRooms(rooms: ChannelRoom[]): ChannelRoom[] {
  return [...rooms].sort((left, right) => {
    // Anything awaiting a person sorts to the top of its group — spec §10.1.
    const urgency = Number(Boolean(right.awaitingHuman)) - Number(Boolean(left.awaitingHuman));
    return urgency || left.id.localeCompare(right.id);
  });
}

/**
 * The room rail.
 *
 * Deliberately without the design's `New room`, search and notification
 * controls, and without `Ledger` and `Pull requests`: none of them have a route
 * behind them. Rendering a control that cannot work is the defect CT-10 is
 * about, and the brief cuts the last two for the same reason.
 */
export function Sidebar({ rooms, activeRoom, self, operator, onSetOperator, onSelectRoom }: SidebarProps) {
  const groups = GROUPS.map((group) => ({
    ...group,
    rooms: sortRooms(rooms.filter((room) => room.kind === group.kind)),
  }))
    .filter((group) => group.rooms.length > 0)
    // §10.1 again, one level up: a room awaiting a person is no use at the top
    // of a group that is itself below the fold.
    .sort((left, right) => {
      const leftUrgent = left.rooms.some((room) => room.awaitingHuman);
      const rightUrgent = right.rooms.some((room) => room.awaitingHuman);
      return Number(rightUrgent) - Number(leftUrgent);
    });

  return createElement(
    'nav',
    { className: 'hub-region hub-sidebar', 'aria-label': 'channels', 'data-testid': 'hub-region' },
    createElement(
      'div',
      { className: 'sidebar-head' },
      createElement('span', { className: 'sidebar-wordmark' }, 'Crosstalk'),
    ),
    createElement(
      'div',
      { className: 'sidebar-scroll' },
      groups.map((group) =>
        createElement(
          'section',
          { key: group.kind, className: 'channel-group', 'aria-labelledby': `channel-group-${group.kind}` },
          createElement('h3', { id: `channel-group-${group.kind}`, className: 'channel-group-label' }, group.label),
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
                    'data-room-kind': room.kind,
                    'aria-current': activeRoom === room.id ? 'true' : undefined,
                    onClick: () => onSelectRoom?.(room.id),
                  },
                  createElement('span', { className: 'channel-icon', 'aria-hidden': 'true' }, ICONS[room.kind]),
                  createElement('span', { className: 'channel-name' }, displayName(room)),
                  room.awaitingHuman ? createElement('span', { className: 'human-badge' }, 'human') : null,
                  // No denominator when the config did not supply one. The `3`
                  // that used to sit here disagreed with the running config.
                  room.kind === 'dispute' && room.rounds !== undefined
                    ? createElement(
                        'span',
                        { className: 'round-counter' },
                        room.maxRounds === undefined ? `${room.rounds}` : `${room.rounds}/${room.maxRounds}`,
                      )
                    : null,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    createElement(OperatorFoot, { self: self ?? '@human', operator, onSetOperator }),
  );
}

/**
 * Who you are, at the foot of the rail.
 *
 * This showed `@human` — the protocol id, which is correct in the log and reads
 * on screen as a placeholder nobody filled in. Crosstalk is going open source
 * and the first thing anyone sees should not look unfinished.
 *
 * The name is display-only and lives in the browser. Nothing is written to the
 * log, no contract moves, and a log copied between machines does not carry one
 * person's name into another person's hub. The seat is still `@human`
 * everywhere it matters; the id stays visible beneath the name so the
 * connection to what the log records is never lost.
 */
function OperatorFoot({
  self,
  operator,
  onSetOperator,
}: {
  self: string;
  operator?: string;
  onSetOperator?: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(operator ?? '');

  const commit = (): void => {
    onSetOperator?.(draft);
    setEditing(false);
  };

  if (onSetOperator !== undefined && (editing || operator === undefined)) {
    return createElement(
      'form',
      {
        className: 'sidebar-foot is-editing',
        'data-testid': 'sidebar-self',
        onSubmit: (event: { preventDefault(): void }) => {
          event.preventDefault();
          commit();
        },
      },
      createElement('input', {
        className: 'operator-input',
        'data-testid': 'operator-input',
        value: draft,
        // Not "Name" — the field is asking who is sitting here, and the answer
        // is what every message of theirs will be signed with.
        placeholder: 'Your name',
        'aria-label': 'Your name',
        autoFocus: editing,
        onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
        onBlur: commit,
      }),
      createElement('span', { className: 'sidebar-self-id fact' }, self),
    );
  }

  return createElement(
    'div',
    { className: 'sidebar-foot', 'data-testid': 'sidebar-self' },
    createElement(
      'button',
      {
        type: 'button',
        className: 'operator-name',
        'data-testid': 'operator-name',
        disabled: onSetOperator === undefined,
        title: onSetOperator === undefined ? undefined : 'Change your name',
        onClick: () => {
          setDraft(operator ?? '');
          setEditing(true);
        },
      },
      operator ?? self,
    ),
    // The id the log records, kept in view so the display name never hides what
    // the protocol actually attributes a message to.
    operator === undefined
      ? createElement('span', { className: 'sidebar-self-role' }, 'you')
      : createElement('span', { className: 'sidebar-self-id fact' }, self),
  );
}
