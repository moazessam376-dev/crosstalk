import { createElement } from 'react';
import type { ParticipantStatus, ParticipantView } from '../state/derive.js';

export interface RailParticipant extends Omit<ParticipantView, 'status'> {
  status: ParticipantStatus | string;
}

export interface RailProps {
  participants: RailParticipant[];
}

function formatStatus(status: string): string {
  return status.replaceAll('_', ' ');
}

export function Rail({ participants }: RailProps) {
  return createElement(
    'aside',
    { className: 'hub-region hub-rail', 'aria-label': 'participants', 'data-testid': 'hub-region' },
    createElement('h2', null, 'Participants'),
    createElement(
      'ul',
      { className: 'participant-list' },
      participants.map((participant) =>
        createElement(
          'li',
          { key: participant.id, className: 'participant-row' },
          createElement('span', { className: 'participant-name' }, participant.id),
          createElement('span', {
            className: `participant-status status-${participant.status}`,
            'aria-label': formatStatus(participant.status),
            title: formatStatus(participant.status),
          }),
          // No badge when transport is unprobed: absence says "not probed",
          // whereas `file` would claim "probed, and it is the worst tier".
          participant.tier
            ? createElement('span', { className: 'tier-badge' }, participant.tier)
            : null,
        ),
      ),
    ),
  );
}
