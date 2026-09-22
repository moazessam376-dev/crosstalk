import { createElement, useState } from 'react';
import type { Role, Tier } from '../../contracts/participant.js';
import { identityFor } from '../state/identity.js';

/**
 * How long a body may be before the stream previews it instead of pouring it out.
 *
 * CT-16. The operator's ask, verbatim: *"I want at least a preview on the
 * message that is readable to a human, something like Discord chat, with an
 * expand button."* Explicitly **not** a request that agents write less
 * rigorously — the density is the protocol working. A 600-word claim carrying
 * evidence tables is correct as an artefact and unreadable as a chat line.
 *
 * On characters, not lines. The first line of an agent message is usually a
 * heading, so it makes a poor summary and a worse threshold. Roughly three or
 * four lines of prose at the stream's width: long enough that ordinary chat
 * traffic is untouched, short enough that a claim gets folded.
 *
 * The clamp itself is CSS, so the whole body stays in the DOM — selectable,
 * findable by the browser's own search, and readable by a screen reader.
 * Truncating the string would take all three away.
 *
 * The better fix is a `summary` field the *author* writes, on `say`,
 * `raise_claim` and `submit_task`; the report recommends it and so does this
 * comment. It changes a frozen contract and invalidates every existing log, so
 * it wants a claim rather than a unilateral edit. When it lands, the card
 * renders the summary here and this control keeps working.
 */
const PREVIEW_LIMIT = 320;

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
  const [expanded, setExpanded] = useState(false);
  const long = body.length > PREVIEW_LIMIT;
  const collapsed = long && !expanded;

  const identity = identityFor(
    from,
    role === undefined
      ? undefined
      : { id: from, role, harness: harness ?? '', model, lifecycle: 'attached', workspace: '.', transport: tier },
    colour,
  );

  return createElement(
    'article',
    {
      className: 'message-row',
      'data-card-kind': 'message',
      'data-testid': testId,
      // Only on a body long enough to fold, so a short message's DOM is exactly
      // what it was before any of this existed.
      ...(long ? { 'data-collapsed': collapsed ? 'true' : 'false' } : {}),
    },
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
      createElement(
        'p',
        { className: collapsed ? 'message-body is-clamped' : 'message-body' },
        body,
      ),
      long
        ? createElement(
            'button',
            {
              type: 'button',
              className: 'message-expand',
              'data-testid': 'message-expand',
              'aria-expanded': expanded ? 'true' : 'false',
              onClick: () => setExpanded((was) => !was),
            },
            expanded ? 'Show less' : 'Show more',
          )
        : null,
      mention === undefined
        ? null
        : createElement('span', { className: 'message-mention', 'data-testid': 'message-mention' }, mention),
    ),
  );
}
