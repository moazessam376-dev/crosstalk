import { createElement, useState } from 'react';
import type { Role, Tier } from '../../contracts/participant.js';
import { identityFor } from '../state/identity.js';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { HarnessMark } from '../marks/HarnessMark.js';
import { harnessKind } from '../marks/kind.js';

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
 * This is the fallback now. `head` is the field this comment asked for — "a
 * `summary` field the *author* writes" — and where there is one, the fold is
 * decided by whether a body exists rather than by counting characters. The
 * count was never right on its own: it gated on 320 *characters* while the CSS
 * clamped at four *lines*, so a 330-character body that already fitted got an
 * expander revealing nothing.
 */
const PREVIEW_LIMIT = 320;

export interface MessageCardProps {
  from: string;
  body: string;
  /**
   * The author's own one line. Absent on every message written before the
   * contract amendment, which is the whole log to date.
   */
  head?: string;
  /** What the message is for — `status`, `result`, `ask`. */
  tag?: string;
  ts?: string;
  seq?: number;
  /** From the roster, when the log has told us who this is. */
  role?: Role;
  model?: string;
  harness?: string;
  tier?: Tier;
  /** Assigned from the roster so two participants never share one. */
  colour?: string;
  /**
   * What to call this author on screen.
   *
   * Only ever different for the operator's own seat: the log records it as
   * `@human` and always will, and `@human` on screen reads as a placeholder
   * nobody filled in. An agent's id is its id — the team addresses it by that
   * on the floor, so renaming one here would make the screen disagree with the
   * conversation on it.
   */
  displayName?: string;
  /** A handle this message addresses, when the roster knows it. */
  mention?: string;
  testId?: string;
}

/**
 * A message: the mark of the CLI that wrote it beside a header of
 * author · role · model · time · seq, with the body beneath.
 *
 * The avatar used to be two initials on a colour from a rotating palette. The
 * colour carried nothing — it said "a different participant", which the name
 * beside it already said — and in a run mixing Claude Code, Codex and Cursor
 * the fact worth reading at a glance is which tool is answering, because that
 * is what explains a seat's behaviour when it surprises you.
 *
 * Everything after the author is read from `participant_joined`. A participant
 * the log has not introduced gets the mark and the name and nothing else,
 * rather than a blank space where a model should be.
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
  displayName,
  head,
  tag,
  testId = 'message-card',
}: MessageCardProps) {
  const [expanded, setExpanded] = useState(false);
  // With a head, "is there more" is a fact rather than an estimate: `body`
  // holds the head itself when the author wrote nothing else, so the two being
  // equal means there is nothing behind the fold.
  const long = head === undefined ? body.length > PREVIEW_LIMIT : body !== head;
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
      { className: 'message-mark', 'data-harness': harnessKind(harness) },
      createElement(HarnessMark, { harness, size: 15, fallback: identity.initials }),
    ),
    createElement(
      'div',
      { className: 'message-body-col' },
      createElement(
        'header',
        { className: 'message-card-header' },
        createElement('strong', { className: 'message-author' }, displayName ?? from),
        role === undefined ? null : createElement('span', { className: 'message-role' }, role),
        model === undefined ? null : createElement('span', { className: 'message-model fact' }, model),
        ts ? createElement('time', { className: 'message-time fact', dateTime: ts }, ts.slice(11, 16)) : null,
        seq !== undefined ? createElement('span', { className: 'message-seq fact' }, `#${seq}`) : null,
        tag === undefined
          ? null
          : createElement('span', { className: 'message-tag fact', 'data-testid': 'message-tag', 'data-tag': tag }, tag),
      ),
      head === undefined
        ? null
        : createElement('p', { className: 'message-head', 'data-testid': 'message-head' }, head),
      // Hidden entirely when the head is the whole message, rather than
      // repeated under itself.
      head !== undefined && !long
        ? null
        : createElement(
            'p',
            {
              className: collapsed ? 'message-body is-clamped' : 'message-body',
              'data-testid': 'message-body',
            },
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
