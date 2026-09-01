import { useCallback, useEffect, useState } from 'react';

import type { CrosstalkEvent } from '../../contracts/events.js';
import type { RunSummary } from '../../core/runs.js';

export interface RunsView {
  runs: RunSummary[];
  /** Re-read the list. Called after anything that changes it. */
  refresh: () => Promise<void>;
  archive: (runId: string) => Promise<void>;
  remove: (runId: string) => Promise<void>;
  startNew: () => Promise<void>;
  /**
   * Which run the board is showing, and its events when that is not the
   * current one.
   *
   * `undefined` means the current run, which is the live buffer the SSE
   * stream is filling — the board's normal state, and the only one that
   * accepts a message.
   */
  viewing?: string;
  viewed?: CrosstalkEvent[];
  view: (runId: string | undefined) => Promise<void>;
  error?: string;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: 'same-origin', ...init });
}

/**
 * The operator's runs, fetched rather than derived.
 *
 * Derived would mean projecting the hub's own event buffer — but that buffer
 * holds one run by construction now, which is the entire point of the
 * boundary. The list of *other* runs is a fact about files on disk, so it comes
 * from the daemon.
 *
 * Not polled. A run list changes when the operator changes it, and a request
 * every two seconds to render a menu nobody has opened is the kind of cost this
 * project measures other people for.
 */
export function useRuns(live: boolean): RunsView {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [viewing, setViewing] = useState<string | undefined>();
  const [viewed, setViewed] = useState<CrosstalkEvent[] | undefined>();

  const refresh = useCallback(async () => {
    if (!live) return;
    try {
      const response = await call('/runs');
      if (!response.ok) throw new Error(`runs: ${response.status}`);
      setRuns(((await response.json()) as { runs: RunSummary[] }).runs);
      setError(undefined);
    } catch {
      // A hub that cannot list runs still shows the one it is watching, so this
      // is a disabled menu rather than a broken board.
      setError('could not read the run list');
    }
  }, [live]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (path: string, init: RequestInit) => {
      try {
        const response = await call(path, init);
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? `failed: ${response.status}`);
          return;
        }
        setError(undefined);
      } catch {
        setError('the daemon did not answer');
      }
      await refresh();
    },
    [refresh],
  );

  /**
   * Open a run for reading, or go back to the current one.
   *
   * Fetched once and held, rather than streamed: a finished run does not
   * change, so subscribing to it would be a socket that never delivers. Going
   * back drops the buffer, so the next visit re-reads rather than showing a
   * snapshot of what it was.
   */
  const view = useCallback(
    async (runId: string | undefined): Promise<void> => {
      if (runId === undefined) {
        setViewing(undefined);
        setViewed(undefined);
        return;
      }
      try {
        const response = await call(`/runs/${encodeURIComponent(runId)}/events`);
        if (!response.ok) throw new Error(`run: ${response.status}`);
        setViewed(((await response.json()) as { events: CrosstalkEvent[] }).events);
        setViewing(runId);
        setError(undefined);
      } catch {
        // Stay where we are. Switching to an empty board and calling it an old
        // run would be a lie the operator cannot tell from an empty old run.
        setError('could not open that run');
      }
    },
    [],
  );

  return {
    runs,
    refresh,
    error,
    viewing,
    viewed,
    view,
    archive: (runId) => act(`/runs/${encodeURIComponent(runId)}/archive`, { method: 'POST' }),
    // The id again in the body, and the daemon checks it against the path.
    // Belt and braces on the one irreversible act: the hub already asks the
    // operator to type it, and a request that reached the daemon by any other
    // route still has to mean it.
    remove: (runId) =>
      act(`/runs/${encodeURIComponent(runId)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: runId }),
      }),
    startNew: () =>
      act('/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
  };
}
