import { watch, type FSWatcher } from 'node:fs';

/**
 * Resolves when anything in `dir` changes, after `ms`, or on abort, whichever
 * comes first. Callers re-check on a short interval as well, so a missed
 * watch event costs at most one interval.
 */
export function waitForChange(dir: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    let watcher: FSWatcher | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener('abort', finish);
      done();
    };
    if (signal?.aborted === true) {
      done();
      return;
    }
    timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener('abort', finish, { once: true });
    try {
      watcher = watch(dir, finish);
      watcher.on('error', finish);
    } catch {
      // An unwatchable directory falls back to the timeout.
    }
  });
}
