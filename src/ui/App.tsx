import { createElement } from 'react';
import { useLog } from './state/useLog.js';

const DEFAULT_SOURCE = { kind: 'fixture', path: '/fixtures/session-dispute.jsonl' } as const;

export default function App() {
  const { events, connected } = useLog(DEFAULT_SOURCE);

  return createElement(
    'main',
    { 'data-connected': connected ? 'true' : 'false' },
    createElement(
      'header',
      null,
      createElement('p', null, 'Crosstalk hub'),
      createElement('h1', null, 'Session stream'),
      createElement('span', null, connected ? 'connected' : 'connecting'),
    ),
    createElement(
      'section',
      { 'aria-live': 'polite', 'aria-label': 'event stream' },
      createElement('p', null, events.length === 0 ? 'Waiting for events…' : `${events.length} events loaded`),
    ),
  );
}
