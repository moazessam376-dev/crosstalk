import { createElement } from 'react';
import type { CrosstalkEvent } from '../../contracts/events.js';

export interface StreamProps {
  events: CrosstalkEvent[];
  activeRoom?: string;
}

export function Stream({ events, activeRoom }: StreamProps) {
  const visibleEvents = activeRoom ? events.filter((event) => event.room === activeRoom) : events;
  return createElement(
    'section',
    { className: 'hub-region hub-stream', 'aria-label': 'event stream', 'data-testid': 'hub-region' },
    createElement('h2', null, activeRoom ?? 'Stream'),
    createElement('p', { className: 'stream-count' }, `${visibleEvents.length} events`),
    createElement(
      'ol',
      { className: 'event-list' },
      visibleEvents.map((event) =>
        createElement(
          'li',
          { key: `${event.seq}-${event.kind}`, className: 'event-row' },
          createElement('span', { className: 'event-seq' }, event.seq),
          createElement('span', { className: 'event-kind' }, event.kind),
          createElement('span', { className: 'event-from' }, event.from),
        ),
      ),
    ),
  );
}
