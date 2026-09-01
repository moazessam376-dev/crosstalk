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
/**
 * What a seat is doing right now.
 *
 * Not an event, and deliberately. Beacon-1's board carried roughly twenty
 * messages asking what a seat was working on, and the answers were wrong often
 * enough that one seat spent 21 minutes rebuilding a file another had already
 * finished. The fix is to make it *state* — one row per seat, overwritten —
 * rather than history: a tool-call ping per edit would have buried 87 real
 * events under thousands.
 */
export interface Activity {
  /** `Edit`, `Bash`, `Read` — whatever the harness calls the thing it just did. */
  verb: string;
  /** The file it touched, when there was one. */
  path?: string;
  /** False once the harness reports the turn finished. */
  working: boolean;
  /**
   * Why the seat cannot be handed the board, when it cannot.
   *
   * Reported by the supervisor rather than by the seat, because a seat sitting
   * on its own confirmation dialog is by definition not running hooks. Separate
   * from `verb` on purpose: "what it is doing" and "whether it can be reached"
   * are different facts, and the vault-team run spent 622 board events
   * conflating them.
   */
  blocked?: string;
  at: number;
}

export class Presence {
  readonly #lastSeen = new Map<ParticipantId, number>();
  readonly #activity = new Map<ParticipantId, Activity>();

  /** Called on every authenticated request. */
  touch(who: ParticipantId, now: number): void {
    this.#lastSeen.set(who, now);
  }

  /** Reported by the harness itself, through a hook. Overwrites; never appends. */
  note(who: ParticipantId, activity: Omit<Activity, 'at'>, now: number): void {
    this.#activity.set(who, { ...activity, at: now });
    this.#lastSeen.set(who, now);
  }

  /**
   * What this seat is doing, or nothing if it has not reported.
   *
   * Stale entries are dropped rather than aged: "editing harbor.ts, 40 minutes
   * ago" reads as a fact about now and is the exact shape of wrong answer that
   * caused the duplicated build.
   */
  activityOf(who: ParticipantId, now: number): Activity | undefined {
    const found = this.#activity.get(who);
    if (found === undefined || now - found.at >= PRESENCE_TTL_MS) return undefined;
    return found;
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
