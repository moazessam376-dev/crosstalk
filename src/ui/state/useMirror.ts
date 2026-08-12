import { useEffect, useState } from 'react';

/**
 * Mirrors `MirrorStatus` in `src/daemon/server.ts`, which is what serves it.
 *
 * Declared here rather than beside the card that renders it: the frozen test
 * config omits `--jsx`, so a `.ts` module importing a type out of a `.tsx` one
 * needs a suppression at every call site. A shape belongs with the state layer
 * regardless.
 */
export interface MirrorView {
  /** A `mirror:` block exists in the config. Absent is a gap, not a failure. */
  configured: boolean;
  /** It started and is running. False when `gh` or a credential is missing. */
  enabled: boolean;
  lastDrain?: { completed: number; retrying: number };
  lastError?: string;
}

/**
 * The GitHub mirror's status, polled from `GET /mirror`.
 *
 * Polled rather than streamed, and not projected from the log, because the
 * mirror has no write path into the log — that one-way street is what makes
 * "mirror failure never blocks the protocol" structural rather than a
 * discipline, and a `mirror_status` event would trade it for a status line.
 *
 * Returns `undefined` until the first response. That is "not asked yet", which
 * the dock renders as no card at all: rendering "not configured" before the
 * first fetch returned would show a wrong answer on every load, more often than
 * the right one.
 */
const EVERY_MS = 10_000;

export function useMirror(enabled: boolean): MirrorView | undefined {
  const [mirror, setMirror] = useState<MirrorView | undefined>();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const read = async (): Promise<void> => {
      try {
        const response = await fetch('/mirror', { credentials: 'same-origin' });
        if (!response.ok) return;
        const next = (await response.json()) as MirrorView;
        if (!cancelled) setMirror(next);
      } catch {
        // A status fetch that fails must not blank a card that was correct a
        // moment ago, and must never take the hub down: the mirror is the least
        // important thing on this screen.
      }
    };

    void read();
    const timer = setInterval(() => void read(), EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return mirror;
}
