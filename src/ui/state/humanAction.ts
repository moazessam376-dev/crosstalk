import type { RoomId } from '../../contracts/room.js';

export type HumanAction = { type: 'propose_test' | 'intervene_human' };

export type PostResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * What the human's buttons say when they land in the room.
 *
 * The daemon derives `from` from the cookie, so nothing here asserts identity.
 * `POST /events` accepts `kind: "message"` and nothing else — a human pressing
 * a button is not entitled to forge a protocol event any more than an agent is.
 */
const BODIES: Record<HumanAction['type'], string> = {
  propose_test:
    'Human: settle this with a discriminating test. Derive a command from both falsifiers, run it, and post the output as evidence.',
  intervene_human:
    'Human: intervening. Stop work on this claim and wait for my ruling.',
};

/**
 * Posts a human action into the room everyone is looking at.
 *
 * Audit finding F-09: `onHumanAction` was threaded from `App` through `Layout`
 * and `Stream` down to two buttons in `DisputeView`, and `App` never passed a
 * handler — so both buttons were inert. Every layer had been tested with a
 * handler passed in, which proves the wiring works *given* one.
 *
 * Human intervention has to be visible to every participant, not just the
 * person who clicked. That is why this appends to the room rather than
 * changing local state.
 */
export async function postHumanAction(
  action: HumanAction,
  room: RoomId,
  fetchImpl: typeof fetch = fetch,
): Promise<PostResult> {
  let response: Response;
  try {
    response = await fetchImpl('/events', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'message', room, body: BODIES[action.type] }),
    });
  } catch (error) {
    return { ok: false, reason: `Could not reach the daemon: ${(error as Error).message}` };
  }

  if (response.status === 401) {
    return { ok: false, reason: 'The daemon refused this browser. Reopen the hub from the link `crosstalk up` printed.' };
  }
  if (!response.ok) {
    return { ok: false, reason: `The daemon answered ${response.status}.` };
  }
  return { ok: true };
}
