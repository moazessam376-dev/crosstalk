/** '#floor' | 'dm:codex~leader' | 'task:T-04' | 'dispute:C-118' */
export type RoomId = string;

export type RoomKind = 'floor' | 'dm' | 'task' | 'dispute';

/** The room every participant belongs to. */
export const FLOOR: RoomId = '#floor';

/** The human is a member of every room by construction. */
export const HUMAN_ID = '@human';

/**
 * The daemon, when it speaks for itself.
 *
 * A rung that times out has no author — no participant asked for it, and the
 * ladder advances on a timer the daemon owns. It still needs a `from`, and
 * every candidate that is a real participant is wrong: `addressesParticipant`
 * returns false when `from === who`, so signing a timeout-driven `rung_entered`
 * as the leader silences it for the leader, who is exactly who the terminal
 * rung exists to wake. Signing it as a disputant is worse.
 *
 * Reserved rather than derived, and `doctor` must refuse a participant claiming
 * the plain id `crosstalk`, for the same reason it refuses `human`: the '@'
 * prefix is stripped for token filenames, so the two would collide.
 *
 * Lives here beside HUMAN_ID rather than in the daemon that emits it. Two
 * reserved participant ids in two layers is how one of them gets forgotten.
 */
export const SYSTEM_ID = '@crosstalk';
