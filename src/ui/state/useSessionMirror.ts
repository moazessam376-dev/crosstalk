import { useEffect, useRef, useState } from 'react';

/**
 * Mirrors `ScreenRun`/`ScreenSnapshot` in `src/harness/screen.ts`, which is
 * what serves them. Declared here because the frozen test config omits `--jsx`,
 * so a `.tsx` module cannot be the home of a shared type.
 */
export interface MirrorRun {
  text: string;
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

export interface MirrorScreen {
  version: number;
  rows: MirrorRun[][];
  cursor: { row: number; col: number };
  cols: number;
}

export interface SessionMirror {
  seat: string;
  screen?: MirrorScreen;
  running: boolean;
  exitCode?: number | null;
  /** False for a harness that reads its prompt once: the composer is disabled. */
  canPush: boolean;
  /** Set when the daemon has no pipe to this seat — started outside the hub. */
  unavailable?: string;
}

/**
 * How often to ask a live seat what its screen looks like.
 *
 * A terminal that redraws faster than this is a terminal nobody can read at
 * that speed anyway, and the cost of a tick when nothing changed is a version
 * number. Measured against the alternative that was tempting: streaming pty
 * bytes over SSE puts every repaint on the wire — tens of kilobytes a second
 * per seat, for a screen that is 3 KB.
 */
const LIVE_MS = 800;
/** An exited seat's screen cannot change. One confirming read, then stop. */
const DEAD_MS = 10_000;

/**
 * One seat's terminal, polled while it is on screen.
 *
 * Only the open session is polled — never the whole roster. A hub with six
 * seats that mirrored all of them would spend six requests a tick to render
 * one visible terminal, which is exactly the "loading sessions is painful and
 * slow" failure this is built to avoid. `/sessions` already carries what the
 * roster needs (present, activity, mirrored); a screen is only fetched for the
 * seat someone is actually looking at.
 *
 * Pass `undefined` to stop polling entirely — closing the mirror must cost
 * nothing, not merely less.
 */
export function useSessionMirror(seat: string | undefined, enabled = true): SessionMirror | undefined {
  const [mirror, setMirror] = useState<SessionMirror | undefined>();
  // Held in a ref, not in state: it is what the *next* request sends, and
  // putting it in state would re-run the effect on every frame and restart the
  // timer each time the screen changed.
  const version = useRef<number>(-1);

  useEffect(() => {
    if (seat === undefined || !enabled) {
      setMirror(undefined);
      return;
    }
    version.current = -1;
    setMirror(undefined);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async (): Promise<void> => {
      let nextDelay = LIVE_MS;
      try {
        const response = await fetch(`/sessions/${encodeURIComponent(seat)}/screen?since=${version.current}`, {
          credentials: 'same-origin',
        });
        if (cancelled) return;
        if (response.status === 404) {
          setMirror({ seat, running: false, canPush: false, unavailable: 'This seat was not started from the hub, so there is no terminal to mirror.' });
          nextDelay = DEAD_MS;
        } else if (response.ok) {
          const payload = (await response.json()) as {
            unchanged?: boolean;
            version?: number;
            running?: boolean;
            exitCode?: number | null;
            canPush?: boolean;
            screen?: MirrorScreen | null;
          };
          if (cancelled) return;
          if (payload.unchanged === true) {
            // Nothing to redraw. Still worth recording that the seat is alive.
            setMirror((was) => (was === undefined ? was : { ...was, running: payload.running ?? was.running }));
            nextDelay = payload.running === false ? DEAD_MS : LIVE_MS;
          } else {
            const screen = payload.screen ?? undefined;
            if (screen !== undefined) version.current = screen.version;
            setMirror({
              seat,
              running: payload.running ?? false,
              canPush: payload.canPush ?? false,
              ...(screen === undefined ? {} : { screen }),
              ...(payload.exitCode === undefined ? {} : { exitCode: payload.exitCode }),
            });
            nextDelay = payload.running === false ? DEAD_MS : LIVE_MS;
          }
        }
      } catch {
        // A failed read must not blank a screen that was correct a moment ago.
        // The next tick will either succeed or keep showing the last frame,
        // which is more useful than an empty terminal.
      }
      if (!cancelled) timer = setTimeout(() => void read(), nextDelay);
    };

    void read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [seat, enabled]);

  return mirror;
}

export interface SendResult {
  ok: boolean;
  reason?: string;
}

/** Type into a seat's CLI. `keys` are raw bytes; `turn` is a prompt plus Return. */
export async function postSessionInput(seat: string, payload: { turn: string } | { keys: string }): Promise<SendResult> {
  try {
    const response = await fetch(`/sessions/${encodeURIComponent(seat)}/input`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string } }
      | undefined;
    return { ok: false, reason: body?.error?.message ?? `the daemon answered ${response.status}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the daemon did not answer' };
  }
}
