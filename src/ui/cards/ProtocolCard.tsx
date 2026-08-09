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
      // An event this build does not know must look wrong, not plausible.
      // The plan said throw; throwing blanks the whole stream for one
      // unrecognised frame, which is worse than the problem. An explicit
      // unsupported card surfaces the incompatibility and keeps the rest of
      // the log readable.
      //
      // Not hypothetical: `self_review` was added to the contract after this
      // switch was written and rendered through the old generic branch.
      return createElement(
        'article',
        {
          className: 'protocol-card protocol-card-unsupported',
          'data-card-kind': 'unsupported',
          'data-event-kind': event.kind,
          'data-unsupported': 'true',
          'data-testid': testId,
        },
        createElement(
          'div',
          { className: 'unsupported-event' },
          createElement('span', { className: 'fact-label' }, 'unsupported event'),
          createElement(
            'p',
            null,
            `This build does not know how to display "${event.kind}". It may be newer than this hub.`,
          ),
        ),
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
