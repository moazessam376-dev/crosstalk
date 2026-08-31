/**
 * Which vendor a registry id belongs to.
 *
 * Split out of the component so a `.ts` module can read it: the frozen test
 * config omits `--jsx`, so importing a value from a `.tsx` file needs a
 * suppression at every call site.
 */
export type HarnessKind = 'claude' | 'codex' | 'cursor' | 'human' | 'unknown';

/**
 * Maps a registry id (`claude-code-live`, `codex-cli`, …) to its vendor.
 *
 * `human` is in here because the operator's seat goes through the same roster
 * and the same rows as everybody else. Without it the person got the
 * initials fallback — a two-letter `HU` box where a CLI mark sits — which read
 * as a harness the hub failed to recognise rather than as a person.
 */
export function harnessKind(harness: string | undefined): HarnessKind {
  if (harness === undefined) return 'unknown';
  if (harness.startsWith('claude')) return 'claude';
  if (harness.startsWith('codex')) return 'codex';
  if (harness.startsWith('cursor')) return 'cursor';
  if (harness === 'human' || harness === 'none') return 'human';
  return 'unknown';
}
