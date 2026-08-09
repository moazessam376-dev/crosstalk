import { open, readFile, writeFile, unlink } from 'node:fs/promises';

import { DaemonError } from './errors.js';

export interface LockInfo {
  pid: number;
  startedAt: string;
  /** Absent between acquiring the lock and binding the port. */
  url?: string;
}

/** How long a recorded url gets to answer /health before we call the lock stale. */
const HEALTH_TIMEOUT_MS = 500;

/**
 * Exclusive `wx` open, holding the pid.
 *
 * A pid that is *present* is not proof the daemon is alive — pids are recycled,
 * routinely on Windows — so a lock whose pid exists but whose recorded url does
 * not answer is also reclaimed. Without that, one recycled pid makes the daemon
 * permanently unstartable and the only remedy is deleting a lock file by hand,
 * which is not something a user should ever be asked to do.
 */
export async function acquireLock(path: string): Promise<void> {
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };

  try {
    await writeExclusive(path, info);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const existing = await readLock(path);

  if (existing !== undefined && (await isHolderAlive(existing))) {
    throw new DaemonError(
      'DAEMON_ALREADY_RUNNING',
      existing.url === undefined
        ? `A daemon is already running for this repository (pid ${existing.pid})`
        : `A daemon is already running for this repository at ${existing.url} (pid ${existing.pid})`,
      existing.url,
    );
  }

  // Stale: the holder is gone, or its pid was recycled onto something else.
  await unlink(path).catch(() => {});
  try {
    await writeExclusive(path, info);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process reclaimed it in the gap. It wins; we are the second daemon.
      const winner = await readLock(path);
      throw new DaemonError(
        'DAEMON_ALREADY_RUNNING',
        'A daemon claimed this repository while we were reclaiming a stale lock',
        winner?.url,
      );
    }
    throw error;
  }
}

/** Records the bound address, so a second daemon can report where the live one is. */
export async function recordLockUrl(path: string, url: string): Promise<void> {
  const existing = await readLock(path);
  if (existing === undefined) return;
  await writeFile(path, JSON.stringify({ ...existing, url }), 'utf8');
}

export async function releaseLock(path: string): Promise<void> {
  const existing = await readLock(path);
  // Only drop a lock we hold: a crashed-then-reclaimed lock belongs to someone else.
  if (existing !== undefined && existing.pid !== process.pid) return;
  await unlink(path).catch(() => {});
}

export async function readLock(path: string): Promise<LockInfo | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as LockInfo;
    return typeof parsed.pid === 'number' ? parsed : undefined;
  } catch {
    // Unreadable or truncated: treat as no lock rather than jamming the daemon shut.
    return undefined;
  }
}

async function writeExclusive(path: string, info: LockInfo): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(JSON.stringify(info), 'utf8');
  } finally {
    await handle.close();
  }
}

async function isHolderAlive(info: LockInfo): Promise<boolean> {
  if (!isPidAlive(info.pid)) return false;
  if (info.url === undefined) return true;
  return respondsToHealth(info.url);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to another user. Alive, and not ours to reclaim.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function respondsToHealth(url: string): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/health`, { signal: abort.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
