import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { BoardError, errorCode, writeAtomic } from './fsutil.js';

export interface Run {
  id: string;
  dir: string;
}

export interface RunPaths {
  msgs: string;
  agents: string;
  hooks: string;
}

const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RUN_ID = /^\d{8}-\d{6}(-[a-z0-9-]+)?$/;

/** The nearest directory at or above `start` that holds `.git`, or `start` itself. */
export function findRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function stateDir(root: string): string {
  return join(root, '.crosstalk');
}

export function runPaths(run: Run): RunPaths {
  return { msgs: join(run.dir, 'msgs'), agents: join(run.dir, 'agents'), hooks: join(run.dir, 'hooks') };
}

export function runId(now: Date, label?: string): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return label === undefined ? stamp : `${stamp}-${label}`;
}

/** Start a run and make it current, replacing whatever was current. */
export async function newRun(root: string, label?: string, now = new Date()): Promise<Run> {
  const run = await makeRun(root, label, now);
  await writeAtomic(pointer(root), `${run.id}\n`);
  return run;
}

/**
 * The current run, or a new one if there is none. Several agents may join an
 * empty folder at once; the pointer is created exclusively, so one run wins and
 * the losers remove theirs.
 */
export async function ensureRun(root: string): Promise<Run> {
  const existing = await currentRun(root);
  if (existing !== undefined) return existing;

  const run = await makeRun(root, undefined, new Date());
  try {
    await writeFile(pointer(root), `${run.id}\n`, { encoding: 'utf8', flag: 'wx' });
    return run;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  // Another process created the pointer. It may still be writing it, so an
  // empty or partial id is worth a short wait. A whole id whose folder is gone
  // is not: a run's folder exists before its pointer does, so that run was deleted.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = await readPointer(root);
    if (id !== undefined && RUN_ID.test(id)) {
      const winner = { id, dir: join(stateDir(root), 'runs', id) };
      if (!existsSync(winner.dir)) break;
      await rm(run.dir, { recursive: true, force: true });
      return winner;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  await writeAtomic(pointer(root), `${run.id}\n`);
  return run;
}

export async function currentRun(root: string): Promise<Run | undefined> {
  const id = await readPointer(root);
  if (id === undefined || !RUN_ID.test(id)) return undefined;
  const dir = join(stateDir(root), 'runs', id);
  return existsSync(dir) ? { id, dir } : undefined;
}

export async function openRun(root: string, id: string): Promise<Run> {
  if (!RUN_ID.test(id)) throw new BoardError(`"${id}" is not a run id`);
  const dir = join(stateDir(root), 'runs', id);
  if (!existsSync(dir)) throw new BoardError(`no run "${id}" in ${stateDir(root)}`);
  return { id, dir };
}

export async function listRuns(root: string): Promise<string[]> {
  try {
    return (await readdir(join(stateDir(root), 'runs'))).filter((id) => RUN_ID.test(id)).sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

function pointer(root: string): string {
  return join(stateDir(root), 'current');
}

async function readPointer(root: string): Promise<string | undefined> {
  try {
    return (await readFile(pointer(root), 'utf8')).trim();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function makeRun(root: string, label: string | undefined, now: Date): Promise<Run> {
  if (label !== undefined && !LABEL.test(label)) {
    throw new BoardError(`run label "${label}" must be lowercase letters, digits and dashes, at most 32 characters`);
  }
  const runs = join(stateDir(root), 'runs');
  await mkdir(runs, { recursive: true });
  const base = runId(now, label);
  for (let attempt = 1; ; attempt += 1) {
    const id = attempt === 1 ? base : `${base}-${attempt}`;
    const dir = join(runs, id);
    try {
      await mkdir(dir);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      throw error;
    }
    const run = { id, dir };
    const paths = runPaths(run);
    await Promise.all([mkdir(paths.msgs), mkdir(paths.agents), mkdir(paths.hooks)]);
    return run;
  }
}
