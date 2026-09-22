import type { ParticipantId } from '../contracts/participant.js';

/**
 * How long after its last request a participant still counts as present.
 *
 * Comfortably longer than `AWAIT_CAP_S`: an agent parked in `await_turn`
 * refreshes roughly every 50 seconds, and one that is busy doing the work it
 * was given may not poll for a minute or two. Short enough that a single
 * read-only call from a human shell does not make a never-started agent look
 * live for the rest of the day, which is what it did.
 */
export const PRESENCE_TTL_MS = 5 * 60_000;

/**
 * Who has been heard from, and when.
 *
 * Deliberately *not* in the event log. `participant_joined` is stamped the
 * first time a token is presented and nothing retracts it, which is the bug —
 * but the obvious repair, emitting `participant_left` on idleness, is worse
 * than the bug: room membership is projected from `participant_joined`
 * (`membersOf('#floor')` is literally `state.participants.keys()`), so a
 * participant dropped for going quiet also drops out of its rooms.
 * `addressesParticipant` would then return false for it forever and nothing
 * could ever wake it again.
 *
 * Presence is a fact about now. The log is the record of what was decided.
 * They do not belong in the same place.
 */
export class Presence {
  readonly #lastSeen = new Map<ParticipantId, number>();

  /** Called on every authenticated request. */
  touch(who: ParticipantId, now: number): void {
    this.#lastSeen.set(who, now);
  }

  /** For ranking: the ladder wants recency, not a boolean, so there is no cliff. */
  seenAt(): ReadonlyMap<ParticipantId, number> {
    return this.#lastSeen;
  }

  /** For display: the roster needs a boolean, so this one has a threshold. */
  isPresent(who: ParticipantId, now: number): boolean {
    const last = this.#lastSeen.get(who);
    return last !== undefined && now - last < PRESENCE_TTL_MS;
  }
}
