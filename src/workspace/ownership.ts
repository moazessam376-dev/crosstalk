/**
 * Declared path ownership: which paths a participant may write when every agent
 * shares the repository root.
 *
 * Prefixes rather than globs (claim CT-B). The repo allows two runtime
 * dependencies and neither matches globs, so globs would mean writing a matcher
 * — and one that is subtly wrong about `**` would silently mis-scope the gate
 * that decides whether a submit is refused, which is worse than not having the
 * gate. Prefixes are also what was asked for: "their own folders".
 *
 * The whole correctness argument rests on one character. `src/metrics-old/`
 * starts with `src/metrics`, so a check that compares raw strings would let one
 * agent commit another's files. Every comparison here goes through
 * `normalisePrefix` for that reason.
 */

/**
 * POSIX form, exactly one trailing slash.
 *
 * Backslashes are folded because `crosstalk.yaml` is edited by hand on Windows
 * and `src\metrics\` is what gets typed there; compared raw against a git path
 * it would match nothing, and the failure would present as "ownership is
 * ignored" rather than as a path-format problem.
 */
export function normalisePrefix(prefix: string): string {
  const posixed = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
  return posixed === '' ? '/' : `${posixed}/`;
}

/** True when `path` is inside `prefix`, treating both as directories. */
export function isWithinPrefix(path: string, prefix: string): boolean {
  const normalised = normalisePrefix(prefix);
  const candidate = path.replace(/\\/g, '/');
  if (normalised === '/') return true;
  // `slice(0, -1)` so a prefix also owns the directory entry itself, not only
  // what is under it.
  return candidate === normalised.slice(0, -1) || candidate.startsWith(normalised);
}

/**
 * True when either prefix contains the other. Siblings do not overlap.
 *
 * Symmetric on purpose: whichever participant the roster happens to list first,
 * `src/` and `src/metrics/` can clobber each other and the check must say so.
 */
export function prefixesOverlap(left: string, right: string): boolean {
  const a = normalisePrefix(left);
  const b = normalisePrefix(right);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Every path in `paths` that no prefix in `owns` contains.
 *
 * Fails closed: an empty `owns` owns nothing rather than everything. A
 * participant that declares no paths must not be able to commit any, and
 * `doctor` rejects that configuration precisely so this case stays unreachable
 * — but if it ever slips through, the gate refuses rather than waving it past.
 */
export function outsideOwnership(paths: readonly string[], owns: readonly string[]): string[] {
  return paths.filter((path) => !owns.some((prefix) => isWithinPrefix(path, prefix)));
}
