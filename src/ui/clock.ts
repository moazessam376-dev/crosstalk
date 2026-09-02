/**
 * The time of day, as the operator's own clock shows it.
 *
 * Every timestamp on the board was `event.ts.slice(11, 16)` — five characters
 * off an ISO string, which is **UTC**. For anyone not on UTC that is silently
 * the wrong time on every card: at UTC+3 a message sent at 14:12 read 11:12,
 * and nothing about it looked broken.
 *
 * It was found by putting the run divider next to the run picker. The picker
 * builds its label from a `Date`, so it said `today 01:31`; the divider sliced
 * the string, so it said `22:31`; and they were labelling the same run. One of
 * them had to be wrong and it turned out both readings had been on screen for
 * as long as the board has existed.
 *
 * `Date` and not `toLocaleTimeString`, so the shape is fixed at `HH:MM` rather
 * than following a locale into `2:31 PM` — the board's columns are monospaced
 * and a timestamp that changes width per user breaks their alignment.
 */
export function clockTime(iso: string): string {
  const at = new Date(iso);
  // A malformed `ts` should not blank the card. Falling back to the slice
  // keeps the old, wrong-but-present behaviour rather than showing nothing.
  if (Number.isNaN(at.getTime())) return iso.slice(11, 16);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
