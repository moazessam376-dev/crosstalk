import { createElement } from 'react';
import type { Role, Tier } from '../../contracts/participant.js';
import { identityFor } from '../state/identity.js';

export interface MessageCardProps {
  from: string;
  body: string;
  ts?: string;
  seq?: number;
  /** From the roster, when the log has told us who this is. */
  role?: Role;
  model?: string;
  harness?: string;
  tier?: Tier;
  /** Assigned from the roster so two participants never share one. */
  colour?: string;
  /** A handle this message addresses, when the roster knows it. */
  mention?: string;
  testId?: string;
}

/**
 * A message as the design draws it: a 30px avatar beside a header of
 * author · role · model · handle · time · seq, with the body beneath.
 *
 * Everything after the author is read from `participant_joined`. A participant
 * the log has not introduced gets the avatar and handle and nothing else,
 * rather than a blank chip where a model should be.
 */
export function MessageCard({
  from,
  body,
  ts,
  seq,
  role,
  model,
  harness,
  tier,
  colour,
  mention,
  testId = 'message-card',
}: MessageCardProps) {
  const identity = identityFor(
    from,
    role === undefined
      ? undefined
      : { id: from, role, harness: harness ?? '', model, lifecycle: 'attached', workspace: '.', transport: tier },
    colour,
  );

  return createElement(
    'article',
    { className: 'message-row', 'data-card-kind': 'message', 'data-testid': testId },
    createElement(
      'span',
      { className: 'avatar avatar-lg', style: { background: identity.colour }, 'aria-hidden': 'true' },
      identity.initials,
    ),
    createElement(
      'div',
      { className: 'message-body-col' },
      createElement(
        'header',
        { className: 'message-card-header' },
        createElement('strong', { className: 'message-author', style: { color: identity.colour } }, from),
        role === undefined ? null : createElement('span', { className: 'message-role' }, role),
        model === undefined ? null : createElement('span', { className: 'message-model fact' }, model),
        harness === undefined ? null : createElement('span', { className: 'message-handle fact' }, harness),
        ts ? createElement('time', { className: 'message-time fact', dateTime: ts }, ts.slice(11, 16)) : null,
        seq !== undefined ? createElement('span', { className: 'message-seq fact' }, `#${seq}`) : null,
      ),
      createElement('p', { className: 'message-body' }, body),
      mention === undefined
        ? null
        : createElement('span', { className: 'message-mention', 'data-testid': 'message-mention' }, mention),
    ),
  );
}
