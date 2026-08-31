import { useCallback, useEffect, useState } from 'react';
import type { PostResult } from './humanAction.js';

/** A gate as the launcher shows it: what the shape will hold the team to. */
export interface ShapeGate {
  id: string;
  by: 'workspace' | 'asserted';
  quorum: 'any' | 'all';
}

export interface ShapePhase {
  id: string;
  intent: string;
  writes: string;
  gates: ShapeGate[];
}

export interface ShapeSummary {
  name: string;
  summary: string;
  seats: Array<{ role: string; count: number }>;
  phases: ShapePhase[];
}

/** What one CLI is doing right now, from its own tool hooks. */
export interface SeatSession {
  id: string;
  role: string;
  harness: string;
  model: string | null;
  effort: string | null;
  workspace: string;
  present: boolean;
  activity: { verb: string; path?: string; working: boolean; at: number } | null;
  /** The Remote Control handle to attach to from a phone, when there is one. */
  remoteControl: string | null;
  /**
   * Whether this daemon holds the pipe to the seat's terminal.
   *
   * False for a seat someone started in their own shell: it is real, it is
   * working, and there is nothing here to mirror. The hub says so instead of
   * offering a terminal that would never fill.
   */
  mirrored?: boolean;
}

export interface SessionsView {
  phase: { id: string; intent: string; blocking: string[]; complete: boolean } | null;
  seats: SeatSession[];
}

async function getJson<T>(path: string, fetchImpl: typeof fetch): Promise<T | undefined> {
  try {
    const response = await fetchImpl(path, { credentials: 'same-origin' });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    // A hub that blanks because one poll failed is worse than one that keeps
    // the last good answer on screen. Callers hold their previous value.
    return undefined;
  }
}

export interface HarnessOption {
  id: string;
  label: string;
  models: string[];
}

/**
 * What each harness is called and what it can be put on, from the registry.
 *
 * Fetched rather than hard-coded because both are properties of the binaries:
 * Codex does not run Claude models, and a model missing from an array in a
 * React file was a model no seat could be put on.
 */
export function useHarnessCatalog(live: boolean, fetchImpl: typeof fetch = fetch): HarnessOption[] {
  const [catalog, setCatalog] = useState<HarnessOption[]>([]);
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void getJson<{ catalog?: HarnessOption[] }>('/harnesses', fetchImpl).then((body) => {
      if (!cancelled && body?.catalog !== undefined) setCatalog(body.catalog);
    });
    return () => {
      cancelled = true;
    };
  }, [live, fetchImpl]);
  return catalog;
}

/** The shape registry. Fetched once: shapes do not change while the hub is open. */
export function useShapes(live: boolean, fetchImpl: typeof fetch = fetch): ShapeSummary[] {
  const [shapes, setShapes] = useState<ShapeSummary[]>([]);
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void getJson<{ shapes: ShapeSummary[] }>('/shapes', fetchImpl).then((body) => {
      if (!cancelled && body !== undefined) setShapes(body.shapes);
    });
    return () => {
      cancelled = true;
    };
  }, [live, fetchImpl]);
  return shapes;
}

/**
 * What every seat is doing, polled.
 *
 * Polled rather than streamed on purpose: presence is a *sample* of a fast,
 * lossy signal — which file a seat has open this second — and replaying it
 * through the event log would put thousands of entries in an append-only
 * record that exists to hold decisions. `/presence` deliberately never enters
 * the log, so the hub asks instead.
 */
export function useSessions(
  live: boolean,
  everyMs = 2000,
  fetchImpl: typeof fetch = fetch,
): SessionsView | undefined {
  const [view, setView] = useState<SessionsView | undefined>();
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const body = await getJson<SessionsView>('/sessions', fetchImpl);
      if (!cancelled && body !== undefined) setView(body);
    };
    void tick();
    const timer = setInterval(() => void tick(), everyMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live, everyMs, fetchImpl]);
  return view;
}

export interface LaunchRequest {
  job: string;
  shape?: string;
  /** `id:role:harness` per seat, the same spelling `crosstalk init` takes. */
  seats: string[];
}

/** Starts a run. The daemon spawns and supervises; this returns as soon as it has. */
export function useLaunch(fetchImpl: typeof fetch = fetch): {
  launch: (request: LaunchRequest) => Promise<PostResult>;
  launching: boolean;
} {
  const [launching, setLaunching] = useState(false);

  const launch = useCallback(
    async (request: LaunchRequest): Promise<PostResult> => {
      setLaunching(true);
      try {
        const response = await fetchImpl('/launch', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
        if (!response.ok) {
          const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
          return { ok: false, reason: detail.error?.message ?? `The daemon refused the launch (${response.status}).` };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      } finally {
        setLaunching(false);
      }
    },
    [fetchImpl],
  );

  return { launch, launching };
}
