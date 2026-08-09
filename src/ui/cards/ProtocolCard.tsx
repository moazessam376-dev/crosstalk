import { createElement } from 'react';
import type { CrosstalkEvent } from '../../contracts/events.js';

export interface ProtocolCardProps {
  event: CrosstalkEvent;
  testId?: string;
}

function defaultTestId(event: CrosstalkEvent): string {
  if (event.kind === 'vote_cast') return `card-vote-${event.decisionId}`;
  if (event.kind === 'evidence_stale') return `card-evidence-stale-${event.sha}`;
  if (event.kind === 'rebase_notice') return `card-rebase-${event.taskId}`;
  if (event.kind === 'decision_opened') return `card-decision-${event.decision.id}`;
  return `card-protocol-${event.seq}`;
}

export function ProtocolCard({ event, testId = defaultTestId(event) }: ProtocolCardProps) {
  let content: ReturnType<typeof createElement>;

  switch (event.kind) {
    case 'decision_opened':
      content = createElement(
        'div',
        null,
        createElement('span', { className: 'fact-label' }, 'decision opened'),
        createElement('p', null, event.decision.question),
        createElement('p', { className: 'fact' }, `${event.decision.method}${event.decision.ladder ? ` · ${event.decision.ladder.join(' → ')}` : ''}`),
      );
      break;
    case 'vote_cast':
      content = createElement(
        'div',
        null,
        createElement('span', { className: 'fact-label' }, 'vote'),
        createElement('p', null, `${event.from} chose ${event.option}`),
        createElement('p', { className: 'fact' }, event.rationale),
      );
      break;
    case 'evidence_stale':
      content = createElement(
        'div',
        null,
        createElement('span', { className: 'fact-label' }, 'evidence stale'),
        createElement('p', null, createElement('s', null, `@${event.sha}`)),
      );
      break;
    case 'rebase_notice':
      content = createElement(
        'div',
        null,
        createElement('span', { className: 'fact-label' }, 'rebase notice'),
        createElement('p', null, `${event.taskId} now targets ${event.newBase}`),
      );
      break;
    default:
      content = createElement(
        'div',
        null,
        createElement('span', { className: 'fact-label' }, 'protocol event'),
        createElement('p', null, event.kind),
      );
  }

  return createElement(
    'article',
    {
      className: 'protocol-card',
      'data-card-kind': event.kind,
      'data-event-kind': event.kind,
      'data-testid': testId,
    },
    createElement('header', { className: 'protocol-card-header' }, createElement('strong', null, event.from), createElement('span', { className: 'fact' }, `#${event.seq}`)),
    content,
  );
}
