import type { Participant, Role, Tier } from '../../contracts/participant.js';

/**
 * How a participant is drawn: colour, initials, and the identity line.
 *
 * The design authored these per person (`PEOPLE` in the design file). A real
 * hub has whoever is in the log, so the colour is derived from the id instead —
 * stable across reloads and across participants joining in a different order,
 * which a positional palette would not be.
 */
export interface Identity {
  id: string;
  /** Two characters, upper case. `@` is not one of them. */
  initials: string;
  colour: string;
  role?: Role;
  model?: string;
  /** A model at two effort levels does not behave alike. Shown beside it. */
  effort?: string;
  harness?: string;
  tier?: Tier;
  /** `harness · model effort · tier`, omitting whatever the log does not carry. */
  meta: string;
}

/**
 * The design's four participant hues. `@human` is pinned to the same amber the
 * rest of the UI uses for "a person is needed" — it is the one identity the
 * human must find instantly, and it should not move because somebody else
 * joined first.
 */
const HUMAN_COLOUR = '#dbab79';
const PALETTE = ['#58a6ff', '#3fb950', '#bc8cff', '#56d4dd', '#e3956a', '#7ee787'] as const;

/**
 * A colour per participant, guaranteed distinct while the roster fits the
 * palette.
 *
 * Hashing the id was the obvious approach and the wrong one: `leader` and
 * `codex` collided on the first roster I rendered, and two identically
 * coloured avatars defeat the only thing an avatar is for. Position in the
 * sorted roster cannot collide, and a roster is stable for as long as anyone
 * is looking at it.
 *
 * `@human` is pinned outside the rotation, to the amber the rest of the UI
 * already uses for "a person is needed" — the one identity that must not move
 * because somebody else joined.
 */
export function assignColours(ids: readonly string[]): Map<string, string> {
  const colours = new Map<string, string>();
  const others = [...new Set(ids)].filter((id) => id !== '@human').sort();
  colours.set('@human', HUMAN_COLOUR);
  others.forEach((id, index) => colours.set(id, PALETTE[index % PALETTE.length]!));
  return colours;
}

/** Fallback for an author the roster has not introduced. */
function hue(id: string): string {
  if (id === '@human') return HUMAN_COLOUR;
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PALETTE[(hash >>> 16) % PALETTE.length]!;
}

export function initialsFor(id: string): string {
  return id.replace('@', '').slice(0, 2).toUpperCase();
}

/**
 * `harness · model effort · tier`, omitting whatever the log does not carry.
 *
 * Effort attaches to the model rather than standing beside it, because it
 * qualifies the model: "opus-5 max" is one configuration, "opus-5 · max" reads
 * as two peer facts. Joining the pair separately also keeps the separator count
 * honest when only one of them is set — Rigit configures an effort and no
 * model, and a single flat join would render that as `· max ·` with a leading
 * space inside the separators.
 *
 * The field this reads was added under claim CT-A; before it existed this
 * function carried a comment explaining that the design's fourth fact had
 * nowhere in `src/contracts/participant.ts` to come from.
 */
export function identityFor(id: string, participant?: Participant, colour?: string): Identity {
  const engine = [participant?.model, participant?.effort].filter(Boolean).join(' ');
  const meta = [participant?.harness, engine, participant?.transport].filter(Boolean).join(' · ');
  return {
    id,
    initials: initialsFor(id),
    colour: colour ?? hue(id),
    role: participant?.role,
    model: participant?.model,
    effort: participant?.effort,
    harness: participant?.harness,
    tier: participant?.transport,
    meta,
  };
}
