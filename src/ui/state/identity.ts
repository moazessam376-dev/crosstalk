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
  harness?: string;
  tier?: Tier;
  /** `harness · model · tier`, omitting whatever the log does not carry. */
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
 * `effort` is deliberately absent.
 *
 * The design shows `harness · model effort · tier` and its own comment says
 * effort "has no home in src/contracts/participant.ts yet — it needs a field
 * alongside `model` before this can be read from the log rather than authored".
 * It still has none, so the hub shows the three it can read. Inventing the
 * fourth would put a number on screen that no event ever carried.
 */
export function identityFor(id: string, participant?: Participant, colour?: string): Identity {
  const meta = [participant?.harness, participant?.model, participant?.transport].filter(Boolean).join(' · ');
  return {
    id,
    initials: initialsFor(id),
    colour: colour ?? hue(id),
    role: participant?.role,
    model: participant?.model,
    harness: participant?.harness,
    tier: participant?.transport,
    meta,
  };
}
