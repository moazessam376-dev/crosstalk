import { join } from 'node:path';

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
 * does not have. That property is what makes the inbound channel safe to run in
 * a separate process, and `tests/mirror/daemon-seam.test.ts` guards it.
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
