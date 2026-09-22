import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BoardError, errorCode, isRecord, readJson, writeAtomic } from './fsutil.js';
import { runPaths, type Run } from './runs.js';

export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
export const ALL = 'all';
export const HUMAN = 'human';

export interface Stats {
  inboxCalls: number;
  delivered: number;
  deliveredChars: number;
}

export interface Cursor {
  name: string;
  joinedAt: string;
  /** Per sender: how far this agent has read. */
  offsets: Record<string, number>;
  stats: Stats;
}

/** Written only by the hooks, so the cursor keeps a single writer. */
export interface Notified {
  offsets: Record<string, number>;
  notices: number;
}

export function nameError(name: string): string | undefined {
  if (!NAME_PATTERN.test(name)) {
    return `"${name}" is not a valid name: use lowercase letters, digits and dashes, starting with a letter, at most 24 characters`;
  }
  if (name === ALL || name === HUMAN) return `"${name}" is reserved; pick another name`;
  return undefined;
}

export async function joinAgent(
  run: Run,
  name: string,
  rejoin: boolean,
  now = new Date(),
): Promise<{ cursor: Cursor; rejoined: boolean }> {
  const problem = nameError(name);
  if (problem !== undefined) throw new BoardError(problem);

  if (rejoin) {
    const existing = await loadCursor(run, name);
    if (existing !== undefined) return { cursor: existing, rejoined: true };
  }

  const cursor: Cursor = {
    name,
    joinedAt: now.toISOString(),
    offsets: {},
    stats: { inboxCalls: 0, delivered: 0, deliveredChars: 0 },
  };
  try {
    // `wx` fails if the file exists, atomically, on every platform: two agents cannot both get a name.
    await writeFile(cursorPath(run, name), JSON.stringify(cursor), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new BoardError(`name "${name}" is taken; pick another, or pass rejoin: true if you are ${name} continuing`);
    }
    throw error;
  }
  return { cursor, rejoined: false };
}

export async function loadCursor(run: Run, name: string): Promise<(Cursor & { rebuilt?: true }) | undefined> {
  const path = cursorPath(run, name);
  const read = await readJson(path);
  if (!read.ok && read.reason === 'missing') return undefined;
  if (read.ok && isCursor(read.value)) return read.value;
  // Unreadable. Its last write time stands in for the join time, so old broadcasts stay out.
  const { mtime } = await stat(path);
  return {
    name,
    joinedAt: mtime.toISOString(),
    offsets: {},
    stats: { inboxCalls: 0, delivered: 0, deliveredChars: 0 },
    rebuilt: true,
  };
}

export async function saveCursor(run: Run, cursor: Cursor): Promise<void> {
  const { name, joinedAt, offsets, stats } = cursor;
  await writeAtomic(cursorPath(run, name), JSON.stringify({ name, joinedAt, offsets, stats }));
}

export async function listAgents(run: Run): Promise<string[]> {
  try {
    return (await readdir(runPaths(run).agents))
      .filter((file) => file.endsWith('.json') && !file.endsWith('.notified.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

export async function loadNotified(run: Run, name: string): Promise<Notified> {
  const read = await readJson(notifiedPath(run, name));
  if (read.ok && isRecord(read.value) && isOffsets(read.value['offsets']) && typeof read.value['notices'] === 'number') {
    return { offsets: read.value['offsets'], notices: read.value['notices'] };
  }
  return { offsets: {}, notices: 0 };
}

export async function saveNotified(run: Run, name: string, notified: Notified): Promise<void> {
  await writeAtomic(notifiedPath(run, name), JSON.stringify(notified));
}

function cursorPath(run: Run, name: string): string {
  return join(runPaths(run).agents, `${name}.json`);
}

function notifiedPath(run: Run, name: string): string {
  return join(runPaths(run).agents, `${name}.notified.json`);
}

function isOffsets(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((n) => typeof n === 'number');
}

function isCursor(value: unknown): value is Cursor {
  if (!isRecord(value) || !isRecord(value['stats'])) return false;
  const stats = value['stats'];
  return (
    typeof value['name'] === 'string' &&
    typeof value['joinedAt'] === 'string' &&
    isOffsets(value['offsets']) &&
    typeof stats['inboxCalls'] === 'number' &&
    typeof stats['delivered'] === 'number' &&
    typeof stats['deliveredChars'] === 'number'
  );
}
