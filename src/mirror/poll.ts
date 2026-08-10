import { join } from 'node:path';

import type { MirrorMode } from '../contracts/config.js';
import { isMirrorAuthored } from './render.js';

export interface PostOptions {
  /** Daemon base URL, e.g. `http://127.0.0.1:7777`. */
  url: string;
  /** The posting participant's token. The daemon derives `from` from it. */
  token: string;
  room: string;
  body: string;
}

/**
 * Where `crosstalk init` writes `@human`'s token. `tokenFilename` strips the
 * `@`, and `doctor` reserves the plain id `human` so no other participant can
 * land on this path.
 */
export function humanTokenPath(repo: string): string {
  return join(repo, '.crosstalk', 'tokens', 'human');
}

/**
 * Posts a message to the hub as the participant holding `token`.
 *
 * There is no `from` in the body on purpose. The daemon mints one token per
 * participant and resolves `from` from the bearer, so the mirror can speak as
 * `@human` only by holding `@human`'s token — it cannot assert an identity it
 * does not have, and a `from` in the body is refused with `FROM_NOT_ALLOWED`
 * rather than ignored. That property is what makes the inbound channel safe to
 * run in a separate process, and `tests/mirror/daemon-seam.test.ts` guards it.
 */
export async function postAsParticipant(options: PostOptions): Promise<void> {
  const response = await fetch(new URL('/events', options.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ kind: 'message', room: options.room, body: options.body }),
  });

  if (!response.ok) {
    throw new Error(`POST /events refused with ${response.status}: ${await response.text()}`);
  }
}

export interface InboundComment {
  id: number;
  body: string;
  /** GitHub's own field: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`. */
  authorAssociation: string;
}

export interface PollOptions {
  comments(): Promise<InboundComment[]>;
  post(body: string): Promise<void>;
  alreadyDelivered(id: number): boolean;
  mode: MirrorMode;
}

/**
 * The mirror's handle on a comment it has already relayed.
 *
 * Deliberately in the message body rather than in a file the mirror keeps: the
 * poller asks the event log what it has already delivered, so a mirror that has
 * restarted — or crashed and been restarted in a loop — does not replay every
 * comment the human has ever written back into `#floor`. The trailing ` -->`
 * makes the match exact: comment 4 is not a prefix hit inside comment 42.
 */
export function commentRef(id: number): string {
  return `<!-- crosstalk:gh-comment:${id} -->`;
}

/** The comment text as the floor sees it, with the provenance marker attached. */
export function renderInboundMessage(comment: InboundComment): string {
  return `${comment.body}\n\n${commentRef(comment.id)}`;
}

/**
 * Whether a GitHub comment should reach `#floor` as `@human`.
 *
 * Two filters, and the second is the load-bearing one. Author association picks
 * out the repository owner per design §8. But every agent on this project posts
 * under the owner's credential — the mirror's own writes included — so
 * association alone would pull the mirror's output straight back in. The marker
 * check is what actually closes the echo loop the spec names.
 */
export function isPullable(comment: InboundComment): boolean {
  if (isMirrorAuthored(comment.body)) return false;
  return comment.authorAssociation === 'OWNER';
}

export async function pollInbound(options: PollOptions): Promise<{ delivered: number }> {
  // `one-way` and `off` do not read GitHub at all, as opposed to reading it and
  // discarding the result — no request, no rate limit, no credential needed.
  if (options.mode !== 'two-way-human') return { delivered: 0 };

  const comments = await options.comments();
  let delivered = 0;

  for (const comment of comments) {
    if (!isPullable(comment)) continue;
    if (options.alreadyDelivered(comment.id)) continue;
    await options.post(renderInboundMessage(comment));
    delivered += 1;
  }

  return { delivered };
}
