import type { RoomId } from '../../contracts/room.js';
import type { MessageAttachment } from '../../contracts/events.js';

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
  return postMessage(BODIES[action.type], room, fetchImpl);
}

/**
 * Posts what the human actually typed.
 *
 * `kind: "message"` is not a simplification: `POST /events` accepts
 * `DIRECTLY_APPENDABLE` and refuses everything else, so a browser cannot
 * hand-build a protocol event whoever is clicking. A human pressing a button is
 * not entitled to forge one any more than an agent is.
 */
export async function postMessage(
  body: string,
  room: RoomId,
  fetchImpl: typeof fetch = fetch,
  attachments?: readonly MessageAttachment[],
): Promise<PostResult> {
  return post(
    '/events',
    // Omitted rather than sent empty: every message written before the
    // amendment has no `attachments` key at all, and an empty array would
    // change what every existing reader sees for no reason.
    { kind: 'message', room, body, ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }) },
    fetchImpl,
  );
}

/**
 * Casts the human's vote on an open decision.
 *
 * §10.3 makes the human the terminal authority and A3 makes `human` a reachable
 * ladder rung, so without this a dispute that escalated all the way to them
 * could not be answered from the hub at all — the ladder would sit on its last
 * rung, whose timer never fires, indefinitely.
 *
 * The rationale is collected by the control rather than discovered here: the
 * daemon refuses an empty one with `VOTE_WITHOUT_RATIONALE`, and learning that
 * through a round-trip is worse than a field that says so.
 */
export async function postVote(
  decisionId: string,
  option: string,
  rationale: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PostResult> {
  return post(`/decisions/${encodeURIComponent(decisionId)}/vote`, { option, rationale }, fetchImpl);
}

export async function postCompose(
  job: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PostResult> {
  return post('/compose', { job }, fetchImpl);
}

/**
 * Point the mirror at a GitHub repository.
 *
 * The measured reason nobody ever configured the mirror: doing it meant a
 * terminal command against a YAML block with no documented shape, while the hub
 * said "no mirror configured" and offered no way to change that.
 */
export async function postMirrorRepo(url: string, fetchImpl: typeof fetch = fetch): Promise<PostResult> {
  return post('/mirror', { url }, fetchImpl);
}

async function post(path: string, payload: unknown, fetchImpl: typeof fetch): Promise<PostResult> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { ok: false, reason: `Could not reach the daemon: ${(error as Error).message}` };
  }

  if (response.status === 401) {
    return { ok: false, reason: 'The daemon refused this browser. Reopen the hub from the link `crosstalk up` printed.' };
  }
  if (!response.ok) {
    // The daemon's own message names the protocol error, which is more use than
    // a status code on its own.
    const detail = await response.text().catch(() => '');
    return { ok: false, reason: detail.trim().length > 0 ? detail.trim() : `The daemon answered ${response.status}.` };
  }
  return { ok: true };
}
