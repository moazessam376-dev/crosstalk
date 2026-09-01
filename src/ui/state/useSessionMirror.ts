import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ScreenModes } from '../../harness/screen.js';
import { openInputChannel, type InputChannel, type SendResult } from './sessionInput.js';

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
  /** What the seat asked its terminal to send. Absent on an older daemon. */
  modes?: ScreenModes;
  /** How many lines are held above the top row. */
  scrollback?: number;
  alt?: boolean;
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
 * The fallback only. The stream is the path that matters, and this is what a
 * browser without `EventSource` — or a daemon too old to have the route — falls
 * back to.
 *
 * Worth recording why the poll was not enough, because the reasoning that put
 * it here was half right. Polling *is* cheap: an unchanged answer costs 57
 * bytes. What it cannot be is prompt. The interval was 800ms; measured in a
 * real browser it ran at 1,000ms, because a hidden tab has its timers clamped
 * to a second and the hub tab is hidden whenever it is not frontmost. So a
 * keystroke took 1,009ms to reach the screen on a path where the POST was
 * 2.8ms and the pty echo 3.2ms. The wait was the entire latency.
 *
 * The docblock that lived here rejected streaming as "tens of kilobytes a
 * second per seat". That is true of streaming *pty bytes* — every repaint, all
 * its escape sequences — and it is not what the stream does: it carries the
 * reconstruction, which measures 3.3 KB/sec against a full-screen app
 * repainting once a second, for the one seat whose panel is open.
 */
const LIVE_MS = 800;
/** An exited seat's screen cannot change. One confirming read, then stop. */
const DEAD_MS = 10_000;

const UNAVAILABLE = 'This seat was not started from the hub, so there is no terminal to mirror.';

interface Frame {
  unchanged?: boolean;
  version?: number;
  running?: boolean;
  exitCode?: number | null;
  canPush?: boolean;
  screen?: MirrorScreen | null;
}

function mirrorFrom(seat: string, payload: Frame): SessionMirror {
  const screen = payload.screen ?? undefined;
  return {
    seat,
    running: payload.running ?? false,
    canPush: payload.canPush ?? false,
    ...(screen === undefined ? {} : { screen }),
    ...(payload.exitCode === undefined ? {} : { exitCode: payload.exitCode }),
  };
}

/**
 * One seat's terminal, streamed while it is on screen.
 *
 * Only the open session is watched — never the whole roster. A hub with six
 * seats that mirrored all of them would hold six connections to render one
 * terminal, which is exactly the "loading sessions is painful and slow" failure
 * this is built to avoid. `/sessions` already carries what the roster needs
 * (present, activity, mirrored); a screen is only fetched for the seat someone
 * is actually looking at.
 *
 * Pass `undefined` to stop entirely — closing the mirror must cost nothing, not
 * merely less.
 */
export function useSessionMirror(seat: string | undefined, enabled = true): SessionMirror | undefined {
  const [mirror, setMirror] = useState<SessionMirror | undefined>();

  useEffect(() => {
    if (seat === undefined || !enabled) {
      setMirror(undefined);
      return;
    }
    setMirror(undefined);

    let cancelled = false;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Held in a ref-like local rather than in state: it is what the *next*
    // request sends, and putting it in state would restart the effect on every
    // frame.
    let version = -1;

    /**
     * The poll, kept for the two cases the stream cannot cover: a browser with
     * no `EventSource`, and a daemon that predates the route.
     */
    const poll = async (): Promise<void> => {
      let nextDelay = LIVE_MS;
      try {
        const response = await fetch(`/sessions/${encodeURIComponent(seat)}/screen?since=${version}`, {
          credentials: 'same-origin',
        });
        if (cancelled) return;
        if (response.status === 404) {
          setMirror({ seat, running: false, canPush: false, unavailable: UNAVAILABLE });
          nextDelay = DEAD_MS;
        } else if (response.ok) {
          const payload = (await response.json()) as Frame;
          if (cancelled) return;
          if (payload.unchanged === true) {
            // Nothing to redraw. Still worth recording that the seat is alive.
            setMirror((was) => (was === undefined ? was : { ...was, running: payload.running ?? was.running }));
            nextDelay = payload.running === false ? DEAD_MS : LIVE_MS;
          } else {
            if (payload.screen != null) version = payload.screen.version;
            setMirror(mirrorFrom(seat, payload));
            nextDelay = payload.running === false ? DEAD_MS : LIVE_MS;
          }
        }
      } catch {
        // A failed read must not blank a screen that was correct a moment ago.
        // The next tick will either succeed or keep showing the last frame,
        // which is more useful than an empty terminal.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), nextDelay);
    };

    if (typeof EventSource === 'undefined') {
      void poll();
    } else {
      // One read first, so a 404 is a 404 rather than an `EventSource` that
      // retries a missing seat forever. `EventSource` has no way to see a
      // status code, which is the one thing it is bad at.
      void (async () => {
        try {
          const probe = await fetch(`/sessions/${encodeURIComponent(seat)}/screen?since=-1`, {
            credentials: 'same-origin',
          });
          if (cancelled) return;
          if (probe.status === 404) {
            setMirror({ seat, running: false, canPush: false, unavailable: UNAVAILABLE });
            return;
          }
          if (probe.ok) setMirror(mirrorFrom(seat, (await probe.json()) as Frame));
        } catch {
          // Fall through to the stream, which will either work or fail over.
        }
        if (cancelled) return;

        const stream = new EventSource(`/sessions/${encodeURIComponent(seat)}/screen/stream`);
        source = stream;
        stream.onmessage = (event: MessageEvent) => {
          if (cancelled) return;
          try {
            setMirror(mirrorFrom(seat, JSON.parse(String(event.data)) as Frame));
          } catch {
            // A frame that will not parse is one frame, not a broken mirror.
          }
        };
        stream.onerror = () => {
          // `EventSource` reconnects on its own, and that is usually right. It
          // cannot recover from a route that does not exist, so one failure
          // hands over to the poll rather than retrying a 404 forever.
          if (cancelled || stream.readyState !== EventSource.CLOSED) return;
          source = undefined;
          void poll();
        };
      })();
    }

    return () => {
      cancelled = true;
      source?.close();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [seat, enabled]);

  return mirror;
}

/** Type into a seat's CLI. `keys` are raw bytes; `turn` is a prompt plus Return. */
export async function postSessionInput(
  seat: string,
  payload: { turn: string } | { keys: string } | { rows: number; cols: number },
): Promise<SendResult> {
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

/**
 * The one ordered channel every keystroke for this seat goes down.
 *
 * Per seat and stable across renders: two channels would be two racing queues,
 * which is the bug this exists to remove.
 */
export function useSessionKeys(seat: string): InputChannel {
  return useMemo(() => openInputChannel((payload) => postSessionInput(seat, payload)), [seat]);
}

export interface ScrollbackPage {
  captured: boolean;
  total: number;
  from: number;
  rows: MirrorRun[][];
}

/** A window onto what has scrolled off this seat's screen. */
export function useScrollback(seat: string): (from: number, count: number) => Promise<ScrollbackPage | undefined> {
  return useCallback(
    async (from: number, count: number) => {
      try {
        const response = await fetch(
          `/sessions/${encodeURIComponent(seat)}/scrollback?from=${Math.max(0, Math.trunc(from))}&count=${Math.max(0, Math.trunc(count))}`,
          { credentials: 'same-origin' },
        );
        if (!response.ok) return undefined;
        const body = (await response.json()) as Partial<ScrollbackPage>;
        if (body.captured !== true) return undefined;
        return { captured: true, total: body.total ?? 0, from: body.from ?? 0, rows: body.rows ?? [] };
      } catch {
        return undefined;
      }
    },
    [seat],
  );
}

/**
 * Tell the seat how much room it has, whenever that changes.
 *
 * Measured in cells off the rendered grid rather than computed from a font
 * metric: the panel already draws one, and asking it is the only way to be
 * right about zoom, a user stylesheet, or a font that did not load.
 */
export function useSessionResize(seat: string, running: boolean): (rows: number, cols: number) => void {
  const last = useRef<string>('');
  return useCallback(
    (rows: number, cols: number) => {
      if (!running) return;
      const key = `${rows}x${cols}`;
      if (key === last.current) return;
      last.current = key;
      void postSessionInput(seat, { rows, cols });
    },
    [seat, running],
  );
}

export type { SendResult };
