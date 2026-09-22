# Message Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the claim protocol with a daemonless message board that agents in any harness reach over MCP or a CLI, with a Claude Code adapter that tells agents when they have mail.

**Architecture:** Every entry point (MCP server, CLI, hooks, hub) reads and writes plain files under `.crosstalk/runs/<run>/`. Each agent appends only to its own `msgs/<name>.jsonl` and owns its own cursor file, so there are no locks. Readers merge sender files by timestamp and advance per-sender byte offsets.

**Tech Stack:** TypeScript (NodeNext ESM, strict), Node ≥ 20, `@modelcontextprotocol/sdk` 1.30 (only runtime dependency), vitest, tsx (dev, for multi-process tests).

**Spec:** [docs/specs/2026-09-22-message-board-design.md](../specs/2026-09-22-message-board-design.md)

## Global Constraints

- Runtime dependencies: `@modelcontextprotocol/sdk` only. No native modules.
- Node ≥ 20. ESM. `tsconfig` stays strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (type-only imports use `import type`).
- `node:path` for every path. `execFile`, never `exec`.
- Names match `^[a-z][a-z0-9-]{0,23}$`. `all` and `human` are reserved.
- `inbox` returns at most 20 messages or 4,000 characters; `wait_s` is capped at 50.
- Hooks notify, never carry message content. They never fail the agent: any error exits 0.
- Tool output is plain text lines, never JSON. Tool descriptions are one or two sentences.
- Commits: imperative subject under 72 characters, no `feat:` prefix, body says why, **no co-author trailers**.
- Documentation commands are never chained with `&&` (PowerShell 5.1 rejects it).
- Tests use real files under `os.tmpdir()`. No mocked filesystem.

## Review Focus

1. **Multibyte text** (emoji, Arabic, accented names in message text): byte offsets must still land on line boundaries, so nothing repeats or is lost. Pinned in Task 2.
2. **A recipient that has not joined** (a typo, or an agent not spawned yet): the message is kept for that name and the sender is told. Pinned in Task 6.
3. **An agent that `/clear`s and rejoins**: it continues from its old position, with no repeats and no loss. Pinned in Task 6.
4. **A project with its own `.mcp.json` or hooks, or a broken one**: setup preserves what is there, and refuses before writing anything if a file is not valid JSON. Pinned in Task 9.
5. **A `current` pointer to a run that was deleted by hand**: the next join starts a fresh run instead of failing. Pinned in Task 1.

## File Structure

```
src/
  board/
    fsutil.ts     BoardError, atomic writes, JSON reads, small guards
    runs.ts       repo root, run ids, current run, creating runs
    messages.ts   message type, appending, reading complete lines, merging senders
    agents.ts     names, joining, cursors, notified offsets
    inbox.ts      which messages an agent gets, and advancing its offsets
    wait.ts       waiting for a directory to change
    format.ts     message lines and tables for humans
    board.ts      Board: join, send, inbox, who, stats, newRun
  mcp/server.ts   four MCP tools over Board
  hooks/hook.ts   Claude Code hook logic
  cli/index.ts    ct command dispatch
  cli/setup.ts    ct setup claude
  hub/server.ts   loopback web hub with SSE
  hub/page.ts     the hub page as a string
tests/
  helpers.ts
  fixtures/writer.ts, fixtures/joiner.ts
  board/*.test.ts, mcp/server.test.ts, hooks/hook.test.ts, cli/*.test.ts, hub/hub.test.ts
```

---

### Task 1: Clean slate, file helpers and runs

**Files:**
- Delete: `src/`, `tests/`, `index.html`, `vite.config.ts`, `docs/audits/`, `docs/reviews/`, `docs/handoffs/`, `docs/design/`, `docs/specs/2026-08-*`, `docs/plans/2026-08-*`, `docs/plans/kickoff-*`, `docs/RUNNING.md`
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/ci.yml`, `.gitignore`
- Create: `src/board/fsutil.ts`, `src/board/runs.ts`, `tests/helpers.ts`, `tests/board/runs.test.ts`

**Interfaces:**
- Produces:
  - `class BoardError extends Error`
  - `errorCode(error: unknown): string`
  - `isRecord(value: unknown): value is Record<string, unknown>`
  - `writeAtomic(path: string, data: string): Promise<void>`
  - `readJson(path: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'missing' | 'corrupt' }>`
  - `interface Run { id: string; dir: string }`, `interface RunPaths { msgs: string; agents: string; hooks: string }`
  - `findRoot(start: string): string`, `stateDir(root: string): string`, `runPaths(run: Run): RunPaths`, `runId(now: Date, label?: string): string`
  - `newRun(root: string, label?: string, now?: Date): Promise<Run>`, `ensureRun(root: string): Promise<Run>`, `currentRun(root: string): Promise<Run | undefined>`, `openRun(root: string, id: string): Promise<Run>`, `listRuns(root: string): Promise<string[]>`
  - tests: `tempRepo(): Promise<string>`, `removeTempRepos(): Promise<void>`, `runTs(script: string, args: string[]): Promise<number>`

- [ ] **Step 1: Tag the old protocol and remove it**

```bash
git tag v0-protocol main
git rm -r -q src tests index.html vite.config.ts docs/audits docs/reviews docs/handoffs docs/design docs/RUNNING.md
git rm -q docs/specs/2026-08-* docs/plans/2026-08-* docs/plans/kickoff-*
```

- [ ] **Step 2: Replace `package.json`**

```json
{
  "name": "crosstalk-ai",
  "version": "0.2.0",
  "description": "A message board for coding agents, in any harness.",
  "license": "PolyForm-Noncommercial-1.0.0",
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "bin": {
    "crosstalk": "./dist/cli/index.js",
    "ct": "./dist/cli/index.js"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.test.json"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

Then refresh the lockfile so it holds only these:

```bash
npm install
```

Expected: `package-lock.json` no longer mentions `react`, `yaml` or `jsdom` at the top level. Check with `npm ls --depth=0`.

- [ ] **Step 3: Tidy config**

In `tsconfig.json`, change `"exclude": ["node_modules", "dist", "src/ui/**"]` to `"exclude": ["node_modules", "dist"]`.

Replace `vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

In `.github/workflows/ci.yml`, replace the comment above `- run: npm run build` (the one about `tests/cli/front-door.test.ts` and `dist/ui`) with:

```yaml
      # Build before test: the hook timing test runs the built CLI.
```

In `.gitignore`, replace the block under `# Crosstalk runtime state` (the six `.crosstalk/...` lines) with:

```
.crosstalk/
```

- [ ] **Step 4: Write test helpers**

`tests/helpers.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

/** A throwaway directory that looks like a repository root. */
export async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ct-'));
  await mkdir(join(root, '.git'));
  made.push(root);
  return root;
}

export async function removeTempRepos(): Promise<void> {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
}

/** Run a TypeScript file in its own Node process. Resolves with the exit code. */
export function runTs(script: string, args: string[]): Promise<number> {
  return new Promise((done) => {
    execFile(process.execPath, ['--import', 'tsx', script, ...args], (error) => {
      done(error === null ? 0 : typeof error.code === 'number' ? error.code : 1);
    });
  });
}
```

- [ ] **Step 5: Write the failing tests**

`tests/board/runs.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BoardError } from '../../src/board/fsutil.js';
import { currentRun, ensureRun, findRoot, listRuns, newRun, openRun, runId, runPaths, stateDir } from '../../src/board/runs.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

describe('runId', () => {
  it('formats local time and an optional label', () => {
    const now = new Date(2026, 8, 22, 21, 5, 9);
    expect(runId(now)).toBe('20260922-210509');
    expect(runId(now, 'geekfarm')).toBe('20260922-210509-geekfarm');
  });
});

describe('runs', () => {
  it('newRun creates the run folders and points current at it', async () => {
    const root = await tempRepo();
    const run = await newRun(root, 'trial');
    const paths = runPaths(run);
    expect(existsSync(paths.msgs) && existsSync(paths.agents) && existsSync(paths.hooks)).toBe(true);
    expect((await currentRun(root))?.id).toBe(run.id);
  });

  it('gives two runs started in the same second different ids', async () => {
    const root = await tempRepo();
    const now = new Date(2026, 8, 22, 21, 5, 9);
    const a = await newRun(root, undefined, now);
    const b = await newRun(root, undefined, now);
    expect(a.id).toBe('20260922-210509');
    expect(b.id).toBe('20260922-210509-2');
    expect((await currentRun(root))?.id).toBe(b.id);
  });

  it('ensureRun called concurrently settles on one run', async () => {
    const root = await tempRepo();
    const runs = await Promise.all([ensureRun(root), ensureRun(root), ensureRun(root)]);
    expect(new Set(runs.map((run) => run.id)).size).toBe(1);
    expect(await readdir(join(stateDir(root), 'runs'))).toEqual([runs[0]!.id]);
  });

  it('ensureRun starts a fresh run when current points at a deleted one', async () => {
    const root = await tempRepo();
    const old = await newRun(root, 'old');
    await rm(old.dir, { recursive: true });
    const fresh = await ensureRun(root);
    expect(fresh.id).not.toBe(old.id);
    expect((await currentRun(root))?.id).toBe(fresh.id);
  });

  it('refuses a bad label and a run id that escapes the runs folder', async () => {
    const root = await tempRepo();
    await expect(newRun(root, 'Bad Label')).rejects.toThrow(BoardError);
    await expect(openRun(root, '../../etc')).rejects.toThrow(/not a run id/);
    await expect(openRun(root, '20990101-000000')).rejects.toThrow(/no run/);
  });

  it('listRuns is empty before any run and sorted after', async () => {
    const root = await tempRepo();
    expect(await listRuns(root)).toEqual([]);
    await newRun(root, 'b', new Date(2026, 0, 2));
    await newRun(root, 'a', new Date(2026, 0, 1));
    expect(await listRuns(root)).toEqual(['20260101-000000-a', '20260102-000000-b']);
  });
});

describe('findRoot', () => {
  it('walks up to the directory holding .git', async () => {
    const root = await tempRepo();
    const deep = join(root, 'src', 'game');
    await mkdir(deep, { recursive: true });
    expect(findRoot(deep)).toBe(root);
  });

  it('treats a .git file (a worktree) as a root too', async () => {
    const root = await tempRepo();
    const tree = join(root, 'wt');
    await mkdir(tree);
    await writeFile(join(tree, '.git'), 'gitdir: elsewhere\n');
    expect(findRoot(tree)).toBe(tree);
  });
});
```

- [ ] **Step 6: Run the tests to see them fail**

Run: `npx vitest run tests/board/runs.test.ts`
Expected: FAIL, `Cannot find module '../../src/board/fsutil.js'`.

- [ ] **Step 7: Implement `src/board/fsutil.ts`**

```ts
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

/** A failure the caller can fix. The message says how. */
export class BoardError extends Error {}

export function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Write through a temp file and rename it over `path`, so a reader never sees
 * half a file. Windows refuses the rename while another process has the target
 * open, so that case is retried for about a second.
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, data, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      if (!RETRYABLE.has(errorCode(error)) || attempt >= 20) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      await new Promise((done) => setTimeout(done, 10 + attempt * 5));
    }
  }
}

export async function readJson(
  path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'missing' | 'corrupt' }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ok: false, reason: 'missing' };
    throw error;
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}
```

- [ ] **Step 8: Implement `src/board/runs.ts`**

```ts
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
  // Another process created the pointer. It may still be writing it.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const winner = await currentRun(root);
    if (winner !== undefined) {
      await rm(run.dir, { recursive: true, force: true });
      return winner;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  // The pointer names a run that no longer exists. Replace it.
  await writeAtomic(pointer(root), `${run.id}\n`);
  return run;
}

export async function currentRun(root: string): Promise<Run | undefined> {
  let id: string;
  try {
    id = (await readFile(pointer(root), 'utf8')).trim();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (!RUN_ID.test(id)) return undefined;
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
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `npx vitest run tests/board/runs.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 10: Typecheck and commit**

Run: `npm run typecheck`
Expected: no output, exit 0.

```bash
git add -A
git commit -m "Remove the claim protocol and start the board with runs" -m "The protocol is tagged v0-protocol. A run is the unit of old messages: a new run is an empty board, which is what stops history reaching new sessions."
```

---

### Task 2: Messages

**Files:**
- Create: `src/board/messages.ts`, `tests/board/messages.test.ts`

**Interfaces:**
- Consumes: `errorCode`, `isRecord` from `fsutil.ts`.
- Produces:
  - `interface Message { id: string; ts: string; from: string; to: string[]; text: string }`
  - `interface Line { sender: string; msg: Message; end: number }` (`end` is the byte offset just after the line's newline)
  - `interface Chunk { lines: Line[]; end: number; corrupt: number }`
  - `senderFile(msgsDir: string, sender: string): string`
  - `appendMessage(msgsDir: string, msg: Message): Promise<void>`
  - `nextId(msgsDir: string, sender: string): Promise<string>`
  - `senders(msgsDir: string): Promise<string[]>`
  - `readFrom(msgsDir: string, sender: string, offset: number): Promise<Chunk>`
  - `merge(queues: ReadonlyMap<string, readonly Line[]>): Generator<Line>`

- [ ] **Step 1: Write the failing tests**

`tests/board/messages.test.ts`:

```ts
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendMessage,
  merge,
  nextId,
  readFrom,
  senderFile,
  senders,
  type Line,
  type Message,
} from '../../src/board/messages.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

async function msgsDir(): Promise<string> {
  const dir = join(await tempRepo(), 'msgs');
  await mkdir(dir);
  return dir;
}

function msg(from: string, n: number, ts: string, text = `m${n}`): Message {
  return { id: `${from}-${n}`, ts, from, to: ['all'], text };
}

describe('append and read', () => {
  it('reads back what was appended, and nothing past the returned end', async () => {
    const dir = await msgsDir();
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z'));
    await appendMessage(dir, msg('a', 2, '2026-09-22T10:00:01.000Z'));
    const first = await readFrom(dir, 'a', 0);
    expect(first.lines.map((line) => line.msg.id)).toEqual(['a-1', 'a-2']);
    expect(first.lines.every((line) => line.sender === 'a')).toBe(true);
    expect((await readFrom(dir, 'a', first.end)).lines).toEqual([]);
  });

  it('leaves a line without its newline for the next read', async () => {
    const dir = await msgsDir();
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z'));
    const half = JSON.stringify(msg('a', 2, '2026-09-22T10:00:01.000Z'));
    await appendFile(senderFile(dir, 'a'), half.slice(0, 20));
    const partial = await readFrom(dir, 'a', 0);
    expect(partial.lines.map((line) => line.msg.id)).toEqual(['a-1']);
    await appendFile(senderFile(dir, 'a'), `${half.slice(20)}\n`);
    expect((await readFrom(dir, 'a', partial.end)).lines.map((line) => line.msg.id)).toEqual(['a-2']);
  });

  it('skips and counts a corrupt line, and reads on past it', async () => {
    const dir = await msgsDir();
    await appendFile(senderFile(dir, 'a'), '{not json\n');
    await appendMessage(dir, msg('a', 2, '2026-09-22T10:00:01.000Z'));
    const chunk = await readFrom(dir, 'a', 0);
    expect(chunk.corrupt).toBe(1);
    expect(chunk.lines.map((line) => line.msg.id)).toEqual(['a-2']);
  });

  it('keeps byte offsets right for multibyte text', async () => {
    const dir = await msgsDir();
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z', 'مرحبا 👋 café'));
    const first = await readFrom(dir, 'a', 0);
    await appendMessage(dir, msg('a', 2, '2026-09-22T10:00:01.000Z', 'ünïcødé again 🎮'));
    const second = await readFrom(dir, 'a', first.end);
    expect(first.lines[0]?.msg.text).toBe('مرحبا 👋 café');
    expect(second.lines.map((line) => line.msg.text)).toEqual(['ünïcødé again 🎮']);
  });

  it('reads nothing from a sender that never wrote', async () => {
    const dir = await msgsDir();
    expect(await readFrom(dir, 'ghost', 0)).toEqual({ lines: [], end: 0, corrupt: 0 });
  });
});

describe('ids and senders', () => {
  it('numbers a sender’s messages from 1', async () => {
    const dir = await msgsDir();
    expect(await nextId(dir, 'a')).toBe('a-1');
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z'));
    expect(await nextId(dir, 'a')).toBe('a-2');
  });

  it('lists senders by their files', async () => {
    const dir = await msgsDir();
    await appendMessage(dir, msg('b', 1, '2026-09-22T10:00:00.000Z'));
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z'));
    expect(await senders(dir)).toEqual(['a', 'b']);
  });
});

describe('merge', () => {
  const line = (sender: string, n: number, ts: string): Line => ({ sender, msg: msg(sender, n, ts), end: n });

  it('orders by time, then by sender', () => {
    const queues = new Map([
      ['b', [line('b', 1, '2026-09-22T10:00:01.000Z'), line('b', 2, '2026-09-22T10:00:03.000Z')]],
      ['a', [line('a', 1, '2026-09-22T10:00:01.000Z'), line('a', 2, '2026-09-22T10:00:02.000Z')]],
    ]);
    expect([...merge(queues)].map((l) => l.msg.id)).toEqual(['a-1', 'b-1', 'a-2', 'b-2']);
  });

  it('keeps each sender’s own order even if its clock went backwards', () => {
    const queues = new Map([
      ['a', [line('a', 1, '2026-09-22T10:00:05.000Z'), line('a', 2, '2026-09-22T10:00:01.000Z')]],
    ]);
    expect([...merge(queues)].map((l) => l.msg.id)).toEqual(['a-1', 'a-2']);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/board/messages.test.ts`
Expected: FAIL, `Cannot find module '../../src/board/messages.js'`.

- [ ] **Step 3: Implement `src/board/messages.ts`**

```ts
import { appendFile, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { errorCode, isRecord } from './fsutil.js';

export interface Message {
  id: string;
  ts: string;
  from: string;
  /** Names, or `['all']`. */
  to: string[];
  text: string;
}

export interface Line {
  sender: string;
  msg: Message;
  /** Byte offset just after this line's newline. */
  end: number;
}

export interface Chunk {
  lines: Line[];
  /** Where the next read should start: the end of the last complete line. */
  end: number;
  corrupt: number;
}

const NEWLINE = 0x0a;

export function senderFile(msgsDir: string, sender: string): string {
  return join(msgsDir, `${sender}.jsonl`);
}

/** One call, one complete line. The sender is the file's only writer, so lines never interleave. */
export async function appendMessage(msgsDir: string, msg: Message): Promise<void> {
  await appendFile(senderFile(msgsDir, msg.from), `${JSON.stringify(msg)}\n`, 'utf8');
}

export async function nextId(msgsDir: string, sender: string): Promise<string> {
  let count = 0;
  try {
    for (const byte of await readFile(senderFile(msgsDir, sender))) if (byte === NEWLINE) count += 1;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return `${sender}-${count + 1}`;
}

export async function senders(msgsDir: string): Promise<string[]> {
  try {
    return (await readdir(msgsDir))
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => file.slice(0, -'.jsonl'.length))
      .sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

/**
 * The complete lines of `sender`'s file after byte `offset`. A last line
 * without its newline is still being written, and is left for the next read.
 */
export async function readFrom(msgsDir: string, sender: string, offset: number): Promise<Chunk> {
  let handle;
  try {
    handle = await open(senderFile(msgsDir, sender), 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { lines: [], end: offset, corrupt: 0 };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size <= offset) return { lines: [], end: offset, corrupt: 0 };
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const lines: Line[] = [];
    let corrupt = 0;
    let start = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      if (buffer[i] !== NEWLINE) continue;
      const text = buffer.toString('utf8', start, i);
      start = i + 1;
      if (text.trim() === '') continue;
      const msg = parseMessage(text);
      if (msg === undefined) corrupt += 1;
      else lines.push({ sender, msg, end: offset + start });
    }
    return { lines, end: offset + start, corrupt };
  } finally {
    await handle.close();
  }
}

/**
 * Merge per-sender queues by time, then sender. Only queue heads are compared,
 * so each sender's own order survives even if its clock stepped backwards.
 */
export function* merge(queues: ReadonlyMap<string, readonly Line[]>): Generator<Line> {
  const heads = new Map<string, number>();
  for (;;) {
    let best: Line | undefined;
    for (const [sender, lines] of queues) {
      const line = lines[heads.get(sender) ?? 0];
      if (line !== undefined && (best === undefined || before(line, best))) best = line;
    }
    if (best === undefined) return;
    heads.set(best.sender, (heads.get(best.sender) ?? 0) + 1);
    yield best;
  }
}

function before(a: Line, b: Line): boolean {
  return a.msg.ts < b.msg.ts || (a.msg.ts === b.msg.ts && a.sender < b.sender);
}

function parseMessage(text: string): Message | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { id, ts, from, to, text: body } = value;
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof from !== 'string' || typeof body !== 'string') {
    return undefined;
  }
  if (!Array.isArray(to) || !to.every((name): name is string => typeof name === 'string')) return undefined;
  return { id, ts, from, to, text: body };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/board/messages.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Break it on purpose**

In `readFrom`, change `end: offset + start` in the returned object to `end: offset + bytesRead`. Run the file again. Expected: the partial-line test fails. Restore the line.

- [ ] **Step 6: Commit**

```bash
git add src/board/messages.ts tests/board/messages.test.ts
git commit -m "Store messages as one append-only file per sender" -m "One writer per file needs no lock. Readers take only complete lines, so a line being written is never read in half."
```

---

### Task 3: Agents and cursors

**Files:**
- Create: `src/board/agents.ts`, `tests/board/agents.test.ts`

**Interfaces:**
- Consumes: `Run`, `runPaths` from `runs.ts`; `BoardError`, `errorCode`, `isRecord`, `readJson`, `writeAtomic` from `fsutil.ts`.
- Produces:
  - `ALL = 'all'`, `HUMAN = 'human'`, `NAME_PATTERN`
  - `nameError(name: string): string | undefined`
  - `interface Stats { inboxCalls: number; delivered: number; deliveredChars: number }`
  - `interface Cursor { name: string; joinedAt: string; offsets: Record<string, number>; stats: Stats }`
  - `interface Notified { offsets: Record<string, number>; notices: number }`
  - `joinAgent(run: Run, name: string, rejoin: boolean, now?: Date): Promise<{ cursor: Cursor; rejoined: boolean }>`
  - `loadCursor(run: Run, name: string): Promise<(Cursor & { rebuilt?: true }) | undefined>`
  - `saveCursor(run: Run, cursor: Cursor): Promise<void>`
  - `listAgents(run: Run): Promise<string[]>`
  - `loadNotified(run: Run, name: string): Promise<Notified>`, `saveNotified(run: Run, name: string, notified: Notified): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`tests/board/agents.test.ts`:

```ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  joinAgent,
  listAgents,
  loadCursor,
  loadNotified,
  nameError,
  saveCursor,
  saveNotified,
} from '../../src/board/agents.js';
import { BoardError } from '../../src/board/fsutil.js';
import { newRun, runPaths } from '../../src/board/runs.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

describe('names', () => {
  it('accepts plain names and refuses the rest with a reason', () => {
    expect(nameError('builder-1')).toBeUndefined();
    expect(nameError('Builder')).toMatch(/lowercase/);
    expect(nameError('1st')).toMatch(/starting with a letter/);
    expect(nameError('a'.repeat(25))).toMatch(/24 characters/);
    expect(nameError('all')).toMatch(/reserved/);
    expect(nameError('human')).toMatch(/reserved/);
  });
});

describe('joining', () => {
  it('claims a name once', async () => {
    const run = await newRun(await tempRepo());
    const { cursor, rejoined } = await joinAgent(run, 'builder-1', false, new Date('2026-09-22T10:00:00.000Z'));
    expect(rejoined).toBe(false);
    expect(cursor).toEqual({
      name: 'builder-1',
      joinedAt: '2026-09-22T10:00:00.000Z',
      offsets: {},
      stats: { inboxCalls: 0, delivered: 0, deliveredChars: 0 },
    });
    await expect(joinAgent(run, 'builder-1', false)).rejects.toThrow(/taken.*rejoin: true/);
  });

  it('rejoin takes over the existing cursor', async () => {
    const run = await newRun(await tempRepo());
    const { cursor } = await joinAgent(run, 'builder-1', false);
    await saveCursor(run, { ...cursor, offsets: { orchestrator: 120 } });
    const again = await joinAgent(run, 'builder-1', true);
    expect(again.rejoined).toBe(true);
    expect(again.cursor.offsets).toEqual({ orchestrator: 120 });
    expect(again.cursor.joinedAt).toBe(cursor.joinedAt);
  });

  it('rejoin with a new name simply joins', async () => {
    const run = await newRun(await tempRepo());
    expect((await joinAgent(run, 'builder-2', true)).rejoined).toBe(false);
  });

  it('refuses a bad name as a BoardError', async () => {
    const run = await newRun(await tempRepo());
    await expect(joinAgent(run, 'all', false)).rejects.toThrow(BoardError);
  });
});

describe('cursors', () => {
  it('returns undefined for an agent that never joined', async () => {
    const run = await newRun(await tempRepo());
    expect(await loadCursor(run, 'nobody')).toBeUndefined();
  });

  it('rebuilds a corrupt cursor with offsets at zero and says so', async () => {
    const run = await newRun(await tempRepo());
    await writeFile(join(runPaths(run).agents, 'builder-1.json'), '{broken');
    const cursor = await loadCursor(run, 'builder-1');
    expect(cursor?.rebuilt).toBe(true);
    expect(cursor?.offsets).toEqual({});
    expect(cursor?.name).toBe('builder-1');
  });

  it('saveCursor does not persist the rebuilt flag', async () => {
    const run = await newRun(await tempRepo());
    await writeFile(join(runPaths(run).agents, 'builder-1.json'), '{broken');
    const cursor = await loadCursor(run, 'builder-1');
    await saveCursor(run, cursor!);
    expect((await loadCursor(run, 'builder-1'))?.rebuilt).toBeUndefined();
  });

  it('lists agents without their notified files', async () => {
    const run = await newRun(await tempRepo());
    await joinAgent(run, 'b', false);
    await joinAgent(run, 'a', false);
    await saveNotified(run, 'a', { offsets: { b: 10 }, notices: 1 });
    expect(await listAgents(run)).toEqual(['a', 'b']);
  });

  it('notified defaults to empty and round-trips', async () => {
    const run = await newRun(await tempRepo());
    expect(await loadNotified(run, 'a')).toEqual({ offsets: {}, notices: 0 });
    await saveNotified(run, 'a', { offsets: { b: 10 }, notices: 2 });
    expect(await loadNotified(run, 'a')).toEqual({ offsets: { b: 10 }, notices: 2 });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/board/agents.test.ts`
Expected: FAIL, `Cannot find module '../../src/board/agents.js'`.

- [ ] **Step 3: Implement `src/board/agents.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/board/agents.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/board/agents.ts tests/board/agents.test.ts
git commit -m "Claim agent names exclusively and keep a cursor per agent" -m "Rejoin is how a session continues after /clear. Hook notices live in a separate file so each file keeps one writer."
```

---

### Task 4: Deciding what an agent receives

**Files:**
- Create: `src/board/inbox.ts`, `tests/board/inbox.test.ts`

**Interfaces:**
- Consumes: `Message`, `Line`, `merge`, `readFrom`, `senders` from `messages.ts`; `ALL` from `agents.ts`.
- Produces:
  - `interface Limit { count: number; chars: number }`, `UNLIMITED: Limit`
  - `interface Collected { messages: Message[]; next: Record<string, number>; more: number; corrupt: number }`
  - `isFor(name: string, joinedAt: string): (msg: Message) => boolean`
  - `isDirectFor(name: string): (msg: Message) => boolean`
  - `collect(msgsDir: string, from: Record<string, number>, accept: (msg: Message) => boolean, limit: Limit): Promise<Collected>`

- [ ] **Step 1: Write the failing tests**

`tests/board/inbox.test.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { UNLIMITED, collect, isDirectFor, isFor } from '../../src/board/inbox.js';
import { appendMessage, type Message } from '../../src/board/messages.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const JOINED = '2026-09-22T10:00:00.000Z';
const at = (second: number): string => new Date(Date.parse(JOINED) + second * 1000).toISOString();

async function msgsDir(): Promise<string> {
  const dir = join(await tempRepo(), 'msgs');
  await mkdir(dir);
  return dir;
}

let counter = 0;
async function post(dir: string, from: string, to: string[], second: number, text = `t${++counter}`): Promise<Message> {
  const msg = { id: `${from}-${++counter}`, ts: at(second), from, to, text };
  await appendMessage(dir, msg);
  return msg;
}

describe('delivery rules', () => {
  it('delivers a direct message sent before the join', async () => {
    const dir = await msgsDir();
    const early = await post(dir, 'orchestrator', ['builder-1'], -60);
    const got = await collect(dir, {}, isFor('builder-1', JOINED), UNLIMITED);
    expect(got.messages).toEqual([early]);
  });

  it('delivers a broadcast only if sent after the join', async () => {
    const dir = await msgsDir();
    await post(dir, 'orchestrator', ['all'], -1);
    const late = await post(dir, 'orchestrator', ['all'], 1);
    const got = await collect(dir, {}, isFor('builder-1', JOINED), UNLIMITED);
    expect(got.messages).toEqual([late]);
  });

  it('never delivers an agent its own messages', async () => {
    const dir = await msgsDir();
    await post(dir, 'builder-1', ['all'], 1);
    await post(dir, 'builder-1', ['builder-1'], 2);
    expect((await collect(dir, {}, isFor('builder-1', JOINED), UNLIMITED)).messages).toEqual([]);
  });

  it('skips messages for others but still moves past them', async () => {
    const dir = await msgsDir();
    await post(dir, 'orchestrator', ['builder-2'], 1);
    const got = await collect(dir, {}, isFor('builder-1', JOINED), UNLIMITED);
    expect(got.messages).toEqual([]);
    expect(got.next['orchestrator']).toBeGreaterThan(0);
    const mine = await post(dir, 'orchestrator', ['builder-1'], 2);
    expect((await collect(dir, got.next, isFor('builder-1', JOINED), UNLIMITED)).messages).toEqual([mine]);
  });

  it('isDirectFor ignores broadcasts', async () => {
    const dir = await msgsDir();
    await post(dir, 'orchestrator', ['all'], 1);
    const direct = await post(dir, 'orchestrator', ['builder-1', 'builder-2'], 2);
    expect((await collect(dir, {}, isDirectFor('builder-1'), UNLIMITED)).messages).toEqual([direct]);
  });
});

describe('limits', () => {
  it('pages 50 messages from two senders as 20, 20, 10 with nothing lost or repeated', async () => {
    const dir = await msgsDir();
    const sent: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      sent.push((await post(dir, 'a', ['reader'], i * 2)).id);
      sent.push((await post(dir, 'b', ['reader'], i * 2 + 1)).id);
    }
    const accept = isFor('reader', JOINED);
    const limit = { count: 20, chars: 100_000 };
    const first = await collect(dir, {}, accept, limit);
    const second = await collect(dir, first.next, accept, limit);
    const third = await collect(dir, second.next, accept, limit);
    const fourth = await collect(dir, third.next, accept, limit);
    expect([first.more, second.more, third.more]).toEqual([30, 10, 0]);
    expect([...first.messages, ...second.messages, ...third.messages].map((m) => m.id)).toEqual(sent);
    expect(fourth.messages).toEqual([]);
  });

  it('stops at the character budget but always delivers at least one message', async () => {
    const dir = await msgsDir();
    const big = await post(dir, 'a', ['reader'], 1, 'x'.repeat(5000));
    await post(dir, 'a', ['reader'], 2, 'small');
    const got = await collect(dir, {}, isFor('reader', JOINED), { count: 20, chars: 4000 });
    expect(got.messages).toEqual([big]);
    expect(got.more).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/board/inbox.test.ts`
Expected: FAIL, `Cannot find module '../../src/board/inbox.js'`.

- [ ] **Step 3: Implement `src/board/inbox.ts`**

```ts
import { ALL } from './agents.js';
import { merge, readFrom, senders, type Line, type Message } from './messages.js';

export interface Limit {
  count: number;
  chars: number;
}

export const UNLIMITED: Limit = { count: Number.POSITIVE_INFINITY, chars: Number.POSITIVE_INFINITY };

export interface Collected {
  messages: Message[];
  /** Offsets to save: past everything delivered, and past skipped messages where nothing is held back. */
  next: Record<string, number>;
  /** Accepted messages held back by the limit. */
  more: number;
  corrupt: number;
}

/** Direct messages whenever they were sent; broadcasts only from the join on; never your own. */
export function isFor(name: string, joinedAt: string): (msg: Message) => boolean {
  return (msg) => msg.from !== name && (msg.to.includes(name) || (msg.to.includes(ALL) && msg.ts >= joinedAt));
}

export function isDirectFor(name: string): (msg: Message) => boolean {
  return (msg) => msg.from !== name && msg.to.includes(name);
}

export async function collect(
  msgsDir: string,
  from: Record<string, number>,
  accept: (msg: Message) => boolean,
  limit: Limit,
): Promise<Collected> {
  const queues = new Map<string, Line[]>();
  const ends = new Map<string, number>();
  let corrupt = 0;
  let total = 0;
  for (const sender of await senders(msgsDir)) {
    const chunk = await readFrom(msgsDir, sender, from[sender] ?? 0);
    const accepted = chunk.lines.filter((line) => accept(line.msg));
    queues.set(sender, accepted);
    ends.set(sender, chunk.end);
    corrupt += chunk.corrupt;
    total += accepted.length;
  }

  const messages: Message[] = [];
  const lastEnd = new Map<string, number>();
  const taken = new Map<string, number>();
  let chars = 0;
  for (const line of merge(queues)) {
    const size = line.msg.text.length;
    if (messages.length >= limit.count) break;
    if (messages.length > 0 && chars + size > limit.chars) break;
    messages.push(line.msg);
    chars += size;
    lastEnd.set(line.sender, line.end);
    taken.set(line.sender, (taken.get(line.sender) ?? 0) + 1);
  }

  const next: Record<string, number> = { ...from };
  for (const [sender, lines] of queues) {
    const all = (taken.get(sender) ?? 0) === lines.length;
    next[sender] = all ? (ends.get(sender) ?? 0) : (lastEnd.get(sender) ?? from[sender] ?? 0);
  }
  return { messages, next, more: total - messages.length, corrupt };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/board/inbox.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Break it on purpose**

In `collect`, replace the `next[sender] = …` line with `next[sender] = ends.get(sender) ?? 0;`. Run the file. Expected: the paging test fails (messages held back by the limit are lost). Restore the line.

- [ ] **Step 6: Commit**

```bash
git add src/board/inbox.ts tests/board/inbox.test.ts
git commit -m "Deliver only what is addressed to an agent, in capped pages" -m "Direct messages wait for their recipient; broadcasts reach only agents already present. The cap pages instead of dropping, so an agent back after hours gets everything, 20 at a time."
```

---

### Task 5: Waiting, and several processes at once

**Files:**
- Create: `src/board/wait.ts`, `tests/board/wait.test.ts`, `tests/board/processes.test.ts`, `tests/fixtures/writer.ts`, `tests/fixtures/joiner.ts`

**Interfaces:**
- Consumes: `appendMessage` (Task 2), `joinAgent` (Task 3), `collect`, `isFor` (Task 4), `newRun`, `runPaths` (Task 1), `runTs` (helpers).
- Produces: `waitForChange(dir: string, ms: number, signal?: AbortSignal): Promise<void>`

- [ ] **Step 1: Write the fixtures**

`tests/fixtures/writer.ts`:

```ts
import { appendMessage } from '../../src/board/messages.js';

const [msgsDir, name, count] = process.argv.slice(2);
for (let i = 1; i <= Number(count); i += 1) {
  await appendMessage(msgsDir!, {
    id: `${name}-${i}`,
    ts: new Date().toISOString(),
    from: name!,
    to: ['reader'],
    text: `message ${i} from ${name} ${'x'.repeat(i % 97)}`,
  });
}
```

`tests/fixtures/joiner.ts`:

```ts
import { joinAgent } from '../../src/board/agents.js';

const [dir, id] = process.argv.slice(2);
try {
  await joinAgent({ id: id!, dir: dir! }, 'builder-1', false);
  process.exit(0);
} catch {
  process.exit(1);
}
```

- [ ] **Step 2: Write the failing tests**

`tests/board/wait.test.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appendMessage } from '../../src/board/messages.js';
import { waitForChange } from '../../src/board/wait.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

async function msgsDir(): Promise<string> {
  const dir = join(await tempRepo(), 'msgs');
  await mkdir(dir);
  return dir;
}

describe('waitForChange', () => {
  it('returns soon after a message lands', async () => {
    const dir = await msgsDir();
    const started = Date.now();
    setTimeout(() => {
      void appendMessage(dir, { id: 'a-1', ts: new Date().toISOString(), from: 'a', to: ['b'], text: 'hi' });
    }, 200);
    await waitForChange(dir, 5000);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns at the timeout when nothing happens', async () => {
    const dir = await msgsDir();
    const started = Date.now();
    await waitForChange(dir, 300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('returns at once when aborted', async () => {
    const dir = await msgsDir();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await waitForChange(dir, 5000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
```

`tests/board/processes.test.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { collect, isFor } from '../../src/board/inbox.js';
import { newRun, runPaths } from '../../src/board/runs.js';
import { removeTempRepos, runTs, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const writer = fileURLToPath(new URL('../fixtures/writer.ts', import.meta.url));
const joiner = fileURLToPath(new URL('../fixtures/joiner.ts', import.meta.url));

describe('separate processes', () => {
  it('four writers and a reader: every message exactly once, in each sender’s order', async () => {
    const run = await newRun(await tempRepo());
    const { msgs } = runPaths(run);
    const names = ['w1', 'w2', 'w3', 'w4'];
    const writers = Promise.all(names.map((name) => runTs(writer, [msgs, name, '500'])));

    const seen: string[] = [];
    let offsets: Record<string, number> = {};
    let corrupt = 0;
    let finished = false;
    void writers.then(() => (finished = true));
    const accept = isFor('reader', '1970-01-01T00:00:00.000Z');
    for (;;) {
      const got = await collect(msgs, offsets, accept, { count: 20, chars: 4000 });
      offsets = got.next;
      corrupt += got.corrupt;
      seen.push(...got.messages.map((m) => m.id));
      if (finished && got.messages.length === 0) break;
    }

    expect(await writers).toEqual([0, 0, 0, 0]);
    expect(corrupt).toBe(0);
    expect(seen).toHaveLength(2000);
    expect(new Set(seen).size).toBe(2000);
    for (const name of names) {
      const own = seen.filter((id) => id.startsWith(`${name}-`)).map((id) => Number(id.split('-')[1]));
      expect(own).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    }
  }, 60_000);

  it('six processes joining one name: exactly one wins', async () => {
    const run = await newRun(await tempRepo());
    const codes = await Promise.all(Array.from({ length: 6 }, () => runTs(joiner, [run.dir, run.id])));
    expect(codes.filter((code) => code === 0)).toHaveLength(1);
  }, 60_000);
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/board/wait.test.ts tests/board/processes.test.ts`
Expected: `wait.test.ts` FAILS with `Cannot find module '../../src/board/wait.js'`. `processes.test.ts` may already pass, because it exercises Tasks 2–4. That is acceptable here: it is the cross-process check for code that already exists, not a test of new code.

- [ ] **Step 4: Implement `src/board/wait.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests five times**

Run each of these five times and record the pass count:

```bash
npx vitest run tests/board/wait.test.ts tests/board/processes.test.ts
```

Expected: 5 passed each run, 5 of 5 runs green. Any failure is a real bug; do not retry it away.

- [ ] **Step 6: Commit**

```bash
git add src/board/wait.ts tests/board/wait.test.ts tests/board/processes.test.ts tests/fixtures
git commit -m "Wait on the message folder and prove writers never collide" -m "Four processes writing while one reads, and six racing for one name, run as real processes because that is the case the design depends on."
```

---

### Task 6: The Board

**Files:**
- Create: `src/board/format.ts`, `src/board/board.ts`, `tests/board/board.test.ts`

**Interfaces:**
- Consumes: everything in `src/board/` from Tasks 1–5.
- Produces:
  - `hhmm(iso: string): string`, `formatLine(msg: Message): string`, `table(rows: readonly (readonly string[])[]): string`
  - `INBOX_LIMIT: Limit` (`{ count: 20, chars: 4000 }`), `MAX_WAIT_S = 50`
  - `etiquette(name: string): string`
  - `class Board` with `constructor(root: string)` and:
    - `join(name: string, rejoin?: boolean): Promise<string>` (starts with `joined as <name>` or `rejoined as <name>`)
    - `send(as: string, to: string | readonly string[], text: string): Promise<string>` (starts with `sent <id>`)
    - `inbox(as: string, waitS?: number): Promise<{ text: string; count: number }>`
    - `who(): Promise<string>`, `stats(runId?: string): Promise<string>`, `newRun(label?: string): Promise<string>`

- [ ] **Step 1: Write the failing tests**

`tests/board/board.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { BoardError } from '../../src/board/fsutil.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

async function board(): Promise<Board> {
  return new Board(await tempRepo());
}

describe('join', () => {
  it('returns the rules, and refuses a second agent with the same name', async () => {
    const b = await board();
    const text = await b.join('builder-1');
    expect(text).toMatch(/^joined as builder-1 \(run \d{8}-\d{6}\)/);
    expect(text).toContain('Pass as: "builder-1" on every Crosstalk call.');
    await expect(b.join('builder-1')).rejects.toThrow(/taken/);
    expect(await b.join('builder-1', true)).toMatch(/^rejoined as builder-1/);
  });
});

describe('send and inbox', () => {
  it('refuses to send before joining', async () => {
    const b = await board();
    await b.join('orchestrator');
    await expect(b.send('builder-1', 'orchestrator', 'hi')).rejects.toThrow(/has not joined/);
  });

  it('keeps a message for a name that has not joined, and says so', async () => {
    const b = await board();
    await b.join('orchestrator');
    expect(await b.send('orchestrator', 'builder-2', 'start on the dock')).toBe(
      'sent orchestrator-1; builder-2 has not joined yet and will get it on joining',
    );
    await b.join('builder-2');
    const got = await b.inbox('builder-2');
    expect(got.count).toBe(1);
    expect(got.text).toMatch(/^\d\d:\d\d orchestrator: start on the dock$/);
  });

  it('gives broadcasts only to agents present when they were sent', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.send('orchestrator', 'all', 'before');
    await b.join('builder-1');
    await b.send('orchestrator', 'all', 'after');
    expect((await b.inbox('builder-1')).text).toMatch(/orchestrator → all: after$/);
  });

  it('continues from the same place after a rejoin', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    await b.send('orchestrator', 'builder-1', 'one');
    await b.send('orchestrator', 'builder-1', 'two');
    expect((await b.inbox('builder-1')).count).toBe(2);
    await b.join('builder-1', true);
    expect(await b.inbox('builder-1')).toEqual({ text: 'no new messages', count: 0 });
    await b.send('orchestrator', 'builder-1', 'three');
    expect((await b.inbox('builder-1')).text).toMatch(/three$/);
  });

  it('pages a backlog and says how much is left', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    for (let i = 0; i < 25; i += 1) await b.send('orchestrator', 'builder-1', `m${i}`);
    const first = await b.inbox('builder-1');
    expect(first.count).toBe(20);
    expect(first.text.endsWith('5 more; call inbox again')).toBe(true);
    expect((await b.inbox('builder-1')).count).toBe(5);
  });

  it('waits for a message when asked to', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    setTimeout(() => void b.send('orchestrator', 'builder-1', 'late'), 300);
    const started = Date.now();
    const got = await b.inbox('builder-1', 5);
    expect(got.count).toBe(1);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('gives up after the wait with nothing new', async () => {
    const b = await board();
    await b.join('builder-1');
    const started = Date.now();
    expect(await b.inbox('builder-1', 1)).toEqual({ text: 'no new messages', count: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('validates recipients and text', async () => {
    const b = await board();
    await b.join('builder-1');
    await expect(b.send('builder-1', 'all, builder-2', 'x')).rejects.toThrow(/not both/);
    await expect(b.send('builder-1', '', 'x')).rejects.toThrow(/to is required/);
    await expect(b.send('builder-1', 'builder-2', '   ')).rejects.toThrow(/empty/);
    await expect(b.send('builder-1', 'builder-1', 'x')).rejects.toThrow(/yourself/);
    await expect(b.send('builder-1', 'Builder 2', 'x')).rejects.toThrow(BoardError);
  });

  it('lets the human send without joining', async () => {
    const b = await board();
    await b.join('builder-1');
    await b.send('human', 'builder-1', 'stop and check the dock');
    expect((await b.inbox('builder-1')).text).toMatch(/human: stop and check the dock$/);
  });
});

describe('runs, who and stats', () => {
  it('a new run is an empty board that old names must join again', async () => {
    const b = await board();
    await b.join('builder-1');
    expect(await b.newRun('second')).toMatch(/^started run \d{8}-\d{6}-second$/);
    await expect(b.inbox('builder-1')).rejects.toThrow(/has not joined/);
  });

  it('who shows unread counts', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    await b.send('orchestrator', 'builder-1', 'x');
    const who = await b.who();
    expect(who).toMatch(/^builder-1\s+\d\d:\d\d\s+-\s+1$/m);
    expect(who).toMatch(/^orchestrator\s+\d\d:\d\d\s+\d\d:\d\d\s+0$/m);
  });

  it('stats counts delivered characters and estimates tokens', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    await b.send('orchestrator', 'builder-1', 'x'.repeat(400));
    await b.inbox('builder-1');
    const stats = await b.stats();
    expect(stats).toMatch(/^builder-1\s+0\s+1\s+1\s+400\s+0\s+100$/m);
    expect(stats).toMatch(/^orchestrator\s+1\s+0\s+0\s+0\s+0\s+0$/m);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/board/board.test.ts`
Expected: FAIL, `Cannot find module '../../src/board/board.js'`.

- [ ] **Step 3: Implement `src/board/format.ts`**

```ts
import { ALL } from './agents.js';
import type { Message } from './messages.js';

const pad = (n: number): string => String(n).padStart(2, '0');

export function hhmm(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `21:04 orchestrator: text`, naming the audience only when it is not just you. */
export function formatLine(msg: Message): string {
  const audience = msg.to.includes(ALL) ? ' → all' : msg.to.length > 1 ? ` → ${msg.to.join(', ')}` : '';
  return `${hhmm(msg.ts)} ${msg.from}${audience}: ${msg.text}`;
}

export function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  '))
    .join('\n');
}
```

- [ ] **Step 4: Implement `src/board/board.ts`**

```ts
import {
  ALL,
  HUMAN,
  joinAgent,
  listAgents,
  loadCursor,
  loadNotified,
  nameError,
  saveCursor,
  type Cursor,
} from './agents.js';
import { formatLine, hhmm, table } from './format.js';
import { BoardError } from './fsutil.js';
import { UNLIMITED, collect, isFor, type Limit } from './inbox.js';
import { appendMessage, nextId, readFrom } from './messages.js';
import { currentRun, ensureRun, newRun, openRun, runPaths, type Run } from './runs.js';
import { waitForChange } from './wait.js';

export const INBOX_LIMIT: Limit = { count: 20, chars: 4000 };
export const MAX_WAIT_S = 50;
const RECHECK_MS = 1000;
/** A hook notice is one short line. */
const NOTICE_TOKENS = 15;

export function etiquette(name: string): string {
  return [
    `You are "${name}" on a Crosstalk board. Pass as: "${name}" on every Crosstalk call.`,
    'Send a message only when: you are about to edit a file another agent may be editing; you are blocked on something another agent owns; or you changed something others depend on.',
    'Never send progress reports. Your result reaches whoever started you.',
    'When you are told you have unread Crosstalk messages, call inbox and act on them within your task.',
  ].join('\n');
}

export class Board {
  constructor(readonly root: string) {}

  async join(name: string, rejoin = false): Promise<string> {
    const run = await ensureRun(this.root);
    const { rejoined } = await joinAgent(run, name, rejoin);
    return `${rejoined ? 'rejoined' : 'joined'} as ${name} (run ${run.id})\n\n${etiquette(name)}`;
  }

  async send(as: string, to: string | readonly string[], text: string): Promise<string> {
    const run = as === HUMAN ? await ensureRun(this.root) : await this.#run();
    if (as !== HUMAN) await this.#cursor(run, as);
    const recipients = parseRecipients(to, as);
    if (text.trim() === '') throw new BoardError('the message is empty');

    const { msgs } = runPaths(run);
    const id = await nextId(msgs, as);
    await appendMessage(msgs, { id, ts: new Date().toISOString(), from: as, to: recipients, text });

    const joined = new Set(await listAgents(run));
    const waiting = recipients.filter((r) => r !== ALL && r !== HUMAN && !joined.has(r));
    if (waiting.length === 0) return `sent ${id}`;
    return `sent ${id}; ${waiting.join(', ')} ${waiting.length === 1 ? 'has' : 'have'} not joined yet and will get it on joining`;
  }

  async inbox(as: string, waitS = 0): Promise<{ text: string; count: number }> {
    const run = await this.#run();
    const cursor = await this.#cursor(run, as);
    const { msgs } = runPaths(run);
    const accept = isFor(as, cursor.joinedAt);
    const deadline = Date.now() + Math.min(Math.max(waitS, 0), MAX_WAIT_S) * 1000;

    let got = await collect(msgs, cursor.offsets, accept, INBOX_LIMIT);
    while (got.messages.length === 0 && Date.now() < deadline) {
      await waitForChange(msgs, Math.min(RECHECK_MS, deadline - Date.now()));
      got = await collect(msgs, cursor.offsets, accept, INBOX_LIMIT);
    }

    const chars = got.messages.reduce((sum, msg) => sum + msg.text.length, 0);
    await saveCursor(run, {
      name: cursor.name,
      joinedAt: cursor.joinedAt,
      offsets: got.next,
      stats: {
        inboxCalls: cursor.stats.inboxCalls + 1,
        delivered: cursor.stats.delivered + got.messages.length,
        deliveredChars: cursor.stats.deliveredChars + chars,
      },
    });

    const lines = got.messages.length === 0 ? ['no new messages'] : got.messages.map(formatLine);
    if (got.more > 0) lines.push(`${got.more} more; call inbox again`);
    if (got.corrupt > 0) lines.push(`${got.corrupt} unreadable line${got.corrupt === 1 ? '' : 's'} skipped`);
    if (cursor.rebuilt === true) lines.push('your read position was lost and has been reset; some direct messages may repeat');
    return { text: lines.join('\n'), count: got.messages.length };
  }

  async who(): Promise<string> {
    const run = await currentRun(this.root);
    if (run === undefined) return 'no run yet';
    const { msgs } = runPaths(run);
    const rows = [['name', 'joined', 'last sent', 'unread']];
    for (const name of await listAgents(run)) {
      const cursor = await loadCursor(run, name);
      if (cursor === undefined) continue;
      const unread = await collect(msgs, cursor.offsets, isFor(name, cursor.joinedAt), UNLIMITED);
      const lastSent = (await readFrom(msgs, name, 0)).lines.at(-1)?.msg.ts;
      rows.push([name, hhmm(cursor.joinedAt), lastSent === undefined ? '-' : hhmm(lastSent), String(unread.messages.length)]);
    }
    return `run ${run.id}\n${table(rows)}`;
  }

  async stats(id?: string): Promise<string> {
    const run = id === undefined ? await currentRun(this.root) : await openRun(this.root, id);
    if (run === undefined) return 'no run yet';
    const { msgs } = runPaths(run);
    const rows = [['name', 'sent', 'inbox calls', 'delivered', 'chars', 'notices', '~tokens']];
    const totals = [0, 0, 0, 0, 0, 0];
    for (const name of await listAgents(run)) {
      const cursor = await loadCursor(run, name);
      if (cursor === undefined) continue;
      const sent = (await readFrom(msgs, name, 0)).lines.length;
      const { notices } = await loadNotified(run, name);
      const tokens = Math.ceil(cursor.stats.deliveredChars / 4) + notices * NOTICE_TOKENS;
      const values = [sent, cursor.stats.inboxCalls, cursor.stats.delivered, cursor.stats.deliveredChars, notices, tokens];
      values.forEach((value, i) => (totals[i] = (totals[i] ?? 0) + value));
      rows.push([name, ...values.map(String)]);
    }
    rows.push(['total', ...totals.map(String)]);
    return (
      `run ${run.id}\n${table(rows)}\n` +
      '~tokens counts message text and hook notices, not tool-call overhead; transcripts have the exact cost.'
    );
  }

  async newRun(label?: string): Promise<string> {
    return `started run ${(await newRun(this.root, label)).id}`;
  }

  async #run(): Promise<Run> {
    const run = await currentRun(this.root);
    if (run === undefined) throw new BoardError('no run yet; call join first');
    return run;
  }

  async #cursor(run: Run, name: string): Promise<Cursor & { rebuilt?: true }> {
    const cursor = await loadCursor(run, name);
    if (cursor === undefined) {
      throw new BoardError(`"${name}" has not joined run ${run.id}; call join first, with rejoin: true if you were ${name} before a /clear`);
    }
    return cursor;
  }
}

function parseRecipients(to: string | readonly string[], as: string): string[] {
  const list = (typeof to === 'string' ? to.split(',') : [...to]).map((r) => r.trim()).filter((r) => r !== '');
  if (list.length === 0) throw new BoardError('to is required: one or more names, or "all"');
  if (list.includes(ALL) && list.length > 1) throw new BoardError('send to "all" or to names, not both');
  for (const recipient of list) {
    if (recipient === ALL || recipient === HUMAN) continue;
    const problem = nameError(recipient);
    if (problem !== undefined) throw new BoardError(problem);
  }
  if (list.includes(as)) throw new BoardError('you cannot send a message to yourself');
  return [...new Set(list)];
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/board/board.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all green, typecheck silent.

- [ ] **Step 7: Commit**

```bash
git add src/board/format.ts src/board/board.ts tests/board/board.test.ts
git commit -m "Add the Board that every entry point talks to" -m "join returns the rules once, so every agent including subagents gets them without a brief file. inbox answers in plain lines and pages rather than truncating."
```

---

### Task 7: MCP server

**Files:**
- Create: `src/mcp/server.ts`, `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `Board` (Task 6), `BoardError`, `HUMAN`.
- Produces: `INSTRUCTIONS: string`, `TOOLS: readonly Tool[]`, `createServer(board: Board): Server`, `serveStdio(board: Board): Promise<void>`. Tool names: `join`, `send`, `inbox`, `who`.

- [ ] **Step 1: Write the failing tests**

`tests/mcp/server.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { createServer } from '../../src/mcp/server.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

async function connect(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(new Board(await tempRepo())).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content[0]?.text ?? '', isError: result.isError === true };
}

describe('mcp server', () => {
  it('offers four tools with short descriptions, and instructions that mention join', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['join', 'send', 'inbox', 'who']);
    for (const tool of tools) expect((tool.description ?? '').length).toBeLessThan(160);
    expect(client.getInstructions()).toContain('join');
  });

  it('carries a message from one agent to another as plain text', async () => {
    const client = await connect();
    expect((await call(client, 'join', { name: 'orchestrator' })).text).toMatch(/^joined as orchestrator/);
    await call(client, 'join', { name: 'builder-1' });
    expect((await call(client, 'send', { as: 'orchestrator', to: 'builder-1', text: 'skip step two' })).text).toBe(
      'sent orchestrator-1',
    );
    expect((await call(client, 'inbox', { as: 'builder-1' })).text).toMatch(/^\d\d:\d\d orchestrator: skip step two$/);
    expect((await call(client, 'who', {})).text).toContain('builder-1');
  });

  it('reports mistakes as tool errors that say what to do', async () => {
    const client = await connect();
    const missing = await call(client, 'send', { to: 'x', text: 'y' });
    expect(missing).toEqual({ text: 'as is required', isError: true });
    const human = await call(client, 'inbox', { as: 'human' });
    expect(human.isError).toBe(true);
    expect(human.text).toMatch(/reserved/);
    const unknown = await call(client, 'inbox', { as: 'nobody' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/call join first|no run yet/);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL, `Cannot find module '../../src/mcp/server.js'`.

- [ ] **Step 3: Implement `src/mcp/server.ts`**

```ts
import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { HUMAN } from '../board/agents.js';
import type { Board } from '../board/board.js';
import { BoardError } from '../board/fsutil.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export const INSTRUCTIONS =
  'Crosstalk is a message board shared by the agents working in this repository, subagents included. ' +
  'Call join with a unique name before using it. When you start a subagent that should coordinate with others, ' +
  'tell it in its prompt which name to join as, and that when it is told it has unread Crosstalk messages it should call inbox and act on them.';

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, object>; required: string[] };
  run(board: Board, args: Args): Promise<string>;
}

const AS = { type: 'string', description: 'Your name on the board, as given to join.' };

export const TOOLS: readonly Tool[] = [
  {
    name: 'join',
    description: 'Join the Crosstalk board under a unique name. Returns the rules for using it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase letters, digits and dashes, e.g. "builder-1".' },
        rejoin: { type: 'boolean', description: 'Continue as this name after /clear or a restart.' },
      },
      required: ['name'],
    },
    run: (board, args) => board.join(text(args, 'name'), args['rejoin'] === true),
  },
  {
    name: 'send',
    description: 'Send a message to agents by name, or to "all".',
    inputSchema: {
      type: 'object',
      properties: {
        as: AS,
        to: { type: 'string', description: 'Comma-separated names, or "all".' },
        text: { type: 'string' },
      },
      required: ['as', 'to', 'text'],
    },
    run: (board, args) => board.send(caller(args), text(args, 'to'), text(args, 'text')),
  },
  {
    name: 'inbox',
    description: 'Your new messages, oldest first. With wait_s, waits up to that many seconds (at most 50) for one.',
    inputSchema: { type: 'object', properties: { as: AS, wait_s: { type: 'number' } }, required: ['as'] },
    run: async (board, args) =>
      (await board.inbox(caller(args), typeof args['wait_s'] === 'number' ? args['wait_s'] : 0)).text,
  },
  {
    name: 'who',
    description: 'Who is on the board, when each last sent, and how many messages each has unread.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: (board) => board.who(),
  },
];

function text(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new BoardError(`${key} is required`);
  return value;
}

function caller(args: Args): string {
  const as = text(args, 'as');
  if (as === HUMAN) throw new BoardError('"human" is reserved for the person at the hub');
  return as;
}

export function createServer(board: Board): Server {
  const server = new Server({ name: 'crosstalk', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      return { content: [{ type: 'text' as const, text: `unknown tool ${request.params.name}` }], isError: true };
    }
    try {
      return { content: [{ type: 'text' as const, text: await tool.run(board, request.params.arguments ?? {}) }] };
    } catch (error) {
      if (!(error instanceof BoardError)) throw error;
      return { content: [{ type: 'text' as const, text: error.message }], isError: true };
    }
  });

  return server;
}

export async function serveStdio(board: Board): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await createServer(board).connect(new StdioServerTransport());
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS, 3 tests. If `client.getInstructions` is missing from the SDK's `Client` type, check `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts` for the method name before changing the test.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "Serve the board over MCP as four tools" -m "Every call names its caller, because subagents share their parent's connection. Results are plain lines, not pretty-printed JSON."
```

---

### Task 8: CLI

**Files:**
- Create: `src/cli/index.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `Board`, `BoardError`, `findRoot`, `serveStdio` (dynamic import).
- Produces:
  - `interface Io { out(text: string): void; err(text: string): void; stdin(): Promise<string> }`
  - `EXIT = { ok: 0, error: 1, usage: 2, empty: 3 }`
  - `run(argv: string[], io: Io): Promise<number>`
  - internal `parse(args, options)`, `rootOf(values)`, `need(values, key)` and `class UsageError`, which Tasks 9 and 10 extend with `hook`, `setup` and `hub` cases.

- [ ] **Step 1: Write the failing tests**

`tests/cli/cli.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, run, type Io } from '../../src/cli/index.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

function capture(stdin = ''): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    stdin: async () => stdin,
  };
}

describe('ct', () => {
  it('joins, sends, reads and reports', async () => {
    const repo = await tempRepo();
    const io = capture();
    expect(await run(['join', 'orchestrator', '--repo', repo], io)).toBe(EXIT.ok);
    expect(await run(['join', 'builder-1', '--repo', repo], io)).toBe(EXIT.ok);
    expect(await run(['send', '--as', 'orchestrator', '--to', 'builder-1', 'take', 'the', 'dock', '--repo', repo], io)).toBe(EXIT.ok);
    expect(io.stdout.at(-1)).toBe('sent orchestrator-1');
    expect(await run(['inbox', '--as', 'builder-1', '--repo', repo], io)).toBe(EXIT.ok);
    expect(io.stdout.at(-1)).toMatch(/orchestrator: take the dock$/);
    expect(await run(['inbox', '--as', 'builder-1', '--repo', repo], io)).toBe(EXIT.empty);
    expect(await run(['who', '--repo', repo], io)).toBe(EXIT.ok);
    expect(await run(['stats', '--repo', repo], io)).toBe(EXIT.ok);
    expect(await run(['new', 'next', '--repo', repo], io)).toBe(EXIT.ok);
    expect(io.stdout.at(-1)).toMatch(/^started run .*-next$/);
  });

  it('exits 2 with usage for a bad command or missing flag', async () => {
    const repo = await tempRepo();
    const io = capture();
    expect(await run(['frobnicate'], io)).toBe(EXIT.usage);
    expect(await run(['send', '--to', 'x', 'hi', '--repo', repo], io)).toBe(EXIT.usage);
    expect(io.stderr.at(-1)).toMatch(/--as is required/);
    expect(await run(['inbox', '--as', 'x', '--wait', 'soon', '--repo', repo], io)).toBe(EXIT.usage);
  });

  it('exits 1 with the board’s message for a board error', async () => {
    const repo = await tempRepo();
    const io = capture();
    await run(['join', 'builder-1', '--repo', repo], io);
    expect(await run(['join', 'builder-1', '--repo', repo], io)).toBe(EXIT.error);
    expect(io.stderr.at(-1)).toMatch(/taken/);
  });

  it('runs as a script', async () => {
    const repo = await tempRepo();
    const entry = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
    const output = await new Promise<string>((done, fail) => {
      execFile(process.execPath, ['--import', 'tsx', entry, 'who', '--repo', repo], (error, stdout) =>
        error === null ? done(stdout) : fail(error),
      );
    });
    expect(output.trim()).toBe('no run yet');
  }, 30_000);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/cli/cli.test.ts`
Expected: FAIL, `Cannot find module '../../src/cli/index.js'`.

- [ ] **Step 3: Implement `src/cli/index.ts`**

```ts
#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { Board } from '../board/board.js';
import { BoardError } from '../board/fsutil.js';
import { findRoot } from '../board/runs.js';

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdin(): Promise<string>;
}

export const EXIT = { ok: 0, error: 1, usage: 2, empty: 3 } as const;

const USAGE = `Usage: ct <command> [--repo <path>]

  join <name> [--rejoin]                    join the current run
  send --as <name> --to <names|all> <text>  send a message
  inbox --as <name> [--wait <seconds>]      read new messages; exit 3 if none
  who                                       who is in the current run
  new [label]                               start a new, empty run
  stats [run]                               what the board cost each agent
  hub [--port <n>] [--host <addr>]          serve the web hub
  setup claude                              install the Claude Code adapter
  mcp                                       run the MCP server on stdio
  hook                                      Claude Code hook entry point (reads stdin)`;

class UsageError extends Error {}

type Values = Record<string, unknown>;

export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'join':
        return await join(rest, io);
      case 'send':
        return await send(rest, io);
      case 'inbox':
        return await inbox(rest, io);
      case 'who':
        return await simple(rest, io, (board) => board.who());
      case 'new':
        return await simple(rest, io, (board, positionals) => board.newRun(positionals[0]));
      case 'stats':
        return await simple(rest, io, (board, positionals) => board.stats(positionals[0]));
      case 'mcp':
        return await mcp(rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return EXIT.ok;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    if (error instanceof BoardError) {
      io.err(error.message);
      return EXIT.error;
    }
    throw error;
  }
}

function parse(args: string[], options: NonNullable<ParseArgsConfig['options']>): { values: Values; positionals: string[] } {
  try {
    return parseArgs({ args, options: { ...options, repo: { type: 'string' } }, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function rootOf(values: Values): string {
  const repo = values['repo'];
  return typeof repo === 'string' ? resolve(repo) : findRoot(process.cwd());
}

function need(values: Values, key: string): string {
  const value = values[key];
  if (typeof value !== 'string' || value === '') throw new UsageError(`--${key} is required`);
  return value;
}

async function join(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { rejoin: { type: 'boolean' } });
  const name = positionals[0];
  if (name === undefined) throw new UsageError('join needs a name');
  io.out(await new Board(rootOf(values)).join(name, values['rejoin'] === true));
  return EXIT.ok;
}

async function send(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { as: { type: 'string' }, to: { type: 'string' } });
  io.out(await new Board(rootOf(values)).send(need(values, 'as'), need(values, 'to'), positionals.join(' ')));
  return EXIT.ok;
}

async function inbox(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, { as: { type: 'string' }, wait: { type: 'string' } });
  const wait = values['wait'] === undefined ? 0 : Number(values['wait']);
  if (!Number.isFinite(wait) || wait < 0) throw new UsageError('--wait must be a number of seconds');
  const result = await new Board(rootOf(values)).inbox(need(values, 'as'), wait);
  io.out(result.text);
  return result.count === 0 ? EXIT.empty : EXIT.ok;
}

async function simple(
  args: string[],
  io: Io,
  action: (board: Board, positionals: string[]) => Promise<string>,
): Promise<number> {
  const { values, positionals } = parse(args, {});
  io.out(await action(new Board(rootOf(values)), positionals));
  return EXIT.ok;
}

async function mcp(args: string[]): Promise<number> {
  const { values } = parse(args, {});
  // Loaded here so every other command, the hook above all, starts without the SDK.
  const { serveStdio } = await import('../mcp/server.js');
  await serveStdio(new Board(rootOf(values)));
  return EXIT.ok;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(realpathSync(invoked)).href) {
  const io: Io = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    stdin: readStdin,
  };
  process.exitCode = await run(process.argv.slice(2), io);
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/cli/cli.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Build and try it by hand**

```bash
npm run build
node dist/cli/index.js --help
```

Expected: the usage text, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts tests/cli/cli.test.ts
git commit -m "Add the ct command line" -m "Every board operation is available without MCP, for harnesses that only have a shell. The MCP SDK is loaded only by ct mcp so the hook starts fast."
```

---

### Task 9: Claude Code hooks and `ct setup claude`

**Files:**
- Create: `src/hooks/hook.ts`, `src/cli/setup.ts`, `tests/hooks/hook.test.ts`, `tests/cli/setup.test.ts`
- Modify: `src/cli/index.ts` (add `hook` and `setup` cases)

**Interfaces:**
- Consumes: `Board`, `collect`, `isFor`, `isDirectFor`, `UNLIMITED`, `loadCursor`, `loadNotified`, `saveNotified`, `currentRun`, `runPaths`, `writeAtomic`, `errorCode`, `isRecord`, `BoardError`.
- Produces:
  - `interface HookInput { hook_event_name?: string; session_id?: string; agent_id?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown; stop_hook_active?: boolean; cwd?: string }`
  - `type HookOutput = { hookSpecificOutput: { hookEventName: 'PostToolUse'; additionalContext: string } } | { decision: 'block'; reason: string }`
  - `runHook(root: string, input: HookInput): Promise<HookOutput | undefined>`
  - `interface SetupResult { changes: string[]; notes: string[] }`, `setupClaude(root: string, cliPath: string): Promise<SetupResult>`

- [ ] **Step 1: Write the failing hook tests**

`tests/hooks/hook.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { runHook, type HookInput } from '../../src/hooks/hook.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const SESSION = 'b1c2d3e4-0000-4000-8000-000000000000';
const SUB = 'ac3aab5d43df49e5c';

/** What Claude Code sends after a successful join tool call. */
function joined(name: string, agentId?: string, response = `joined as ${name} (run x)`): HookInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    tool_name: 'mcp__crosstalk__join',
    tool_input: { name },
    tool_response: [{ type: 'text', text: response }],
  };
}

function toolCall(agentId?: string, tool = 'Bash'): HookInput {
  return { hook_event_name: 'PostToolUse', session_id: SESSION, ...(agentId === undefined ? {} : { agent_id: agentId }), tool_name: tool };
}

async function setup(): Promise<{ root: string; board: Board }> {
  const root = await tempRepo();
  const board = new Board(root);
  await board.join('orchestrator');
  await board.join('builder-1');
  return { root, board };
}

describe('PostToolUse', () => {
  it('stays quiet for an agent that never joined', async () => {
    const { root, board } = await setup();
    await board.send('orchestrator', 'builder-1', 'hello');
    expect(await runHook(root, toolCall(SUB))).toBeUndefined();
  });

  it('announces unread messages once, by count, without their content', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'skip step two');
    const notice = await runHook(root, toolCall(SUB));
    expect(notice).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'crosstalk: 1 unread message for builder-1. Call inbox.',
      },
    });
    expect(JSON.stringify(notice)).not.toContain('skip step two');
    expect(await runHook(root, toolCall(SUB))).toBeUndefined();
  });

  it('counts only messages that arrived since the last notice or read', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'one');
    await runHook(root, toolCall(SUB));
    await board.inbox('builder-1');
    await board.send('orchestrator', 'builder-1', 'two');
    await board.send('orchestrator', 'builder-1', 'three');
    const notice = await runHook(root, toolCall(SUB));
    expect(JSON.stringify(notice)).toContain('2 unread messages for builder-1');
  });

  it('says nothing after the inbox call itself', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'x');
    expect(await runHook(root, toolCall(SUB, 'mcp__crosstalk__inbox'))).toBeUndefined();
  });

  it('does not map a failed join', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB, 'name "builder-1" is taken'));
    await board.send('orchestrator', 'builder-1', 'x');
    expect(await runHook(root, toolCall(SUB))).toBeUndefined();
  });

  it('never lets a subagent inherit its parent’s name', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('orchestrator'));
    await board.send('builder-1', 'orchestrator', 'for the parent');
    expect(await runHook(root, toolCall(SUB))).toBeUndefined();
    expect(JSON.stringify(await runHook(root, toolCall()))).toContain('for orchestrator');
  });
});

describe('Stop and SubagentStop', () => {
  it('blocks finishing while a direct message is unread', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'one more thing');
    expect(await runHook(root, { hook_event_name: 'SubagentStop', session_id: SESSION, agent_id: SUB })).toEqual({
      decision: 'block',
      reason: 'crosstalk: 1 unread message for builder-1. Call inbox before finishing.',
    });
  });

  it('lets it finish on the second attempt, and for broadcasts only', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('builder-1', SUB));
    await board.send('orchestrator', 'builder-1', 'x');
    const again = { hook_event_name: 'SubagentStop', session_id: SESSION, agent_id: SUB, stop_hook_active: true };
    expect(await runHook(root, again)).toBeUndefined();
    await board.inbox('builder-1');
    await board.send('orchestrator', 'all', 'fyi');
    expect(await runHook(root, { hook_event_name: 'SubagentStop', session_id: SESSION, agent_id: SUB })).toBeUndefined();
  });

  it('applies to the main session’s Stop as well', async () => {
    const { root, board } = await setup();
    await runHook(root, joined('orchestrator'));
    await board.send('builder-1', 'orchestrator', 'done with the dock');
    const result = await runHook(root, { hook_event_name: 'Stop', session_id: SESSION });
    expect(result).toMatchObject({ decision: 'block' });
  });
});
```

- [ ] **Step 2: Run the hook tests to see them fail**

Run: `npx vitest run tests/hooks/hook.test.ts`
Expected: FAIL, `Cannot find module '../../src/hooks/hook.js'`.

- [ ] **Step 3: Implement `src/hooks/hook.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadCursor, loadNotified, saveNotified } from '../board/agents.js';
import { errorCode, writeAtomic } from '../board/fsutil.js';
import { UNLIMITED, collect, isDirectFor, isFor } from '../board/inbox.js';
import { currentRun, runPaths, type Run } from '../board/runs.js';

/** The fields of Claude Code's hook input that the board uses. */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  /** Present only inside a subagent. */
  agent_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
  cwd?: string;
}

export type HookOutput =
  | { hookSpecificOutput: { hookEventName: 'PostToolUse'; additionalContext: string } }
  | { decision: 'block'; reason: string };

const JOIN_TOOL = /^mcp__crosstalk[\w-]*__join$/;
const INBOX_TOOL = /^mcp__crosstalk[\w-]*__inbox$/;

/**
 * Tells an agent it has mail; never passes the mail itself. Agents treat
 * message text arriving through a hook as possible prompt injection and will
 * not act on it, but they act on messages they fetched with their own inbox call.
 */
export async function runHook(root: string, input: HookInput): Promise<HookOutput | undefined> {
  const key = hookKey(input);
  if (key === undefined) return undefined;
  const run = await currentRun(root);
  if (run === undefined) return undefined;
  const event = input.hook_event_name;
  const tool = input.tool_name ?? '';

  if (event === 'PostToolUse' && JOIN_TOOL.test(tool)) {
    await remember(run, key, input);
    return undefined;
  }

  const name = await recall(run, key);
  if (name === undefined) return undefined;
  const cursor = await loadCursor(run, name);
  if (cursor === undefined) return undefined;
  const { msgs } = runPaths(run);

  if (event === 'PostToolUse') {
    if (INBOX_TOOL.test(tool)) return undefined;
    const notified = await loadNotified(run, name);
    const from = furthest(cursor.offsets, notified.offsets);
    const got = await collect(msgs, from, isFor(name, cursor.joinedAt), UNLIMITED);
    if (got.messages.length === 0) return undefined;
    await saveNotified(run, name, { offsets: got.next, notices: notified.notices + 1 });
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `crosstalk: ${unread(got.messages.length)} for ${name}. Call inbox.`,
      },
    };
  }

  if ((event === 'Stop' || event === 'SubagentStop') && input.stop_hook_active !== true) {
    const got = await collect(msgs, cursor.offsets, isDirectFor(name), UNLIMITED);
    if (got.messages.length === 0) return undefined;
    return { decision: 'block', reason: `crosstalk: ${unread(got.messages.length)} for ${name}. Call inbox before finishing.` };
  }

  return undefined;
}

/** A subagent is known only by its own id, never by the session it shares with its parent. */
function hookKey(input: HookInput): string | undefined {
  const raw = input.agent_id ?? (input.session_id === undefined ? undefined : `s-${input.session_id}`);
  return raw?.replace(/[^A-Za-z0-9-]/g, '_');
}

async function remember(run: Run, key: string, input: HookInput): Promise<void> {
  const name = input.tool_input?.['name'];
  if (typeof name !== 'string') return;
  if (!JSON.stringify(input.tool_response ?? '').includes(`joined as ${name}`)) return;
  await writeAtomic(join(runPaths(run).hooks, key), name);
}

async function recall(run: Run, key: string): Promise<string | undefined> {
  try {
    return (await readFile(join(runPaths(run).hooks, key), 'utf8')).trim() || undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function furthest(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [sender, offset] of Object.entries(b)) out[sender] = Math.max(out[sender] ?? 0, offset);
  return out;
}

function unread(n: number): string {
  return `${n} unread message${n === 1 ? '' : 's'}`;
}
```

- [ ] **Step 4: Run the hook tests to see them pass**

Run: `npx vitest run tests/hooks/hook.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing setup tests**

`tests/cli/setup.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { setupClaude } from '../../src/cli/setup.js';
import { BoardError } from '../../src/board/fsutil.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const CLI = '/opt/crosstalk/dist/cli/index.js';

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
}

describe('setupClaude', () => {
  it('writes the server, three hooks and the ignore line', async () => {
    const root = await tempRepo();
    await setupClaude(root, CLI);
    const mcp = await json(join(root, '.mcp.json'));
    expect(mcp.mcpServers.crosstalk.command).toBe('node');
    expect(mcp.mcpServers.crosstalk.args.slice(0, 3)).toEqual([CLI, 'mcp', '--repo']);
    const settings = await json(join(root, '.claude', 'settings.local.json'));
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'Stop', 'SubagentStop']);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('*');
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/^node ".+index\.js" hook --repo ".+"$/);
    expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.crosstalk/');
  });

  it('keeps what the project already has', async () => {
    const root = await tempRepo();
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } }, extra: 1 }));
    await mkdir(join(root, '.claude'));
    const mine = { matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] };
    await writeFile(join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PostToolUse: [mine] }, model: 'x' }));
    await setupClaude(root, CLI);
    const mcp = await json(join(root, '.mcp.json'));
    expect(mcp.mcpServers.playwright).toEqual({ command: 'npx' });
    expect(mcp.extra).toBe(1);
    const settings = await json(join(root, '.claude', 'settings.local.json'));
    expect(settings.model).toBe('x');
    expect(settings.hooks.PostToolUse[0]).toEqual(mine);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
  });

  it('can run twice without duplicating anything', async () => {
    const root = await tempRepo();
    await setupClaude(root, CLI);
    await setupClaude(root, CLI);
    const settings = await json(join(root, '.claude', 'settings.local.json'));
    for (const event of ['PostToolUse', 'Stop', 'SubagentStop']) expect(settings.hooks[event]).toHaveLength(1);
    const exclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === '.crosstalk/')).toHaveLength(1);
  });

  it('replaces its own hook when the checkout moves', async () => {
    const root = await tempRepo();
    await setupClaude(root, '/old/place/dist/cli/index.js');
    await setupClaude(root, CLI);
    const settings = await json(join(root, '.claude', 'settings.local.json'));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(CLI);
  });

  it('refuses a broken .mcp.json before writing anything', async () => {
    const root = await tempRepo();
    await writeFile(join(root, '.mcp.json'), '{ oops');
    await expect(setupClaude(root, CLI)).rejects.toThrow(BoardError);
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(false);
    expect(await readFile(join(root, '.mcp.json'), 'utf8')).toBe('{ oops');
  });
});
```

- [ ] **Step 6: Run the setup tests to see them fail**

Run: `npx vitest run tests/cli/setup.test.ts`
Expected: FAIL, `Cannot find module '../../src/cli/setup.js'`.

- [ ] **Step 7: Implement `src/cli/setup.ts`**

```ts
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { BoardError, errorCode, isRecord } from '../board/fsutil.js';

export interface SetupResult {
  changes: string[];
  notes: string[];
}

/** Merge the Crosstalk server and hooks into a project's Claude Code config. Never overwrites what is there. */
export async function setupClaude(root: string, cliPath: string): Promise<SetupResult> {
  const mcpPath = join(root, '.mcp.json');
  const settingsPath = join(root, '.claude', 'settings.local.json');
  // Read both before writing either: half a setup is worse than none.
  const mcp = await readObject(mcpPath);
  const settings = await readObject(settingsPath);
  const cli = slashes(cliPath);
  const repo = slashes(root);

  const servers = isRecord(mcp['mcpServers']) ? { ...mcp['mcpServers'] } : {};
  servers['crosstalk'] = { command: 'node', args: [cli, 'mcp', '--repo', repo] };
  mcp['mcpServers'] = servers;

  const command = `node "${cli}" hook --repo "${repo}"`;
  const ours = `hook --repo "${repo}"`;
  const hooks = isRecord(settings['hooks']) ? { ...settings['hooks'] } : {};
  setHook(hooks, 'PostToolUse', command, ours, '*');
  setHook(hooks, 'Stop', command, ours);
  setHook(hooks, 'SubagentStop', command, ours);
  settings['hooks'] = hooks;

  await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8');
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  const changes = [`mcp     ${mcpPath}: server "crosstalk"`, `hooks   ${settingsPath}: PostToolUse, Stop, SubagentStop`];
  const notes: string[] = [];
  const ignore = await ignoreState(root);
  if (ignore === 'added') changes.push('ignore  .git/info/exclude: .crosstalk/');
  if (ignore === 'no-git-dir') notes.push('No .git directory here. Add .crosstalk/ to your ignore list yourself.');
  if (await isTracked(root, '.mcp.json')) {
    notes.push('.mcp.json is tracked by git, and the crosstalk entry holds paths for this machine. Commit it only if everyone shares them.');
  }
  notes.push('Restart the Claude Code sessions in this folder so they load the server and the hooks.');
  return { changes, notes };
}

function setHook(hooks: Record<string, unknown>, event: string, command: string, ours: string, matcher?: string): void {
  const existing: unknown[] = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  // Drop an earlier Crosstalk hook for this repository, which may point at another checkout.
  const kept = existing.filter(
    (entry) =>
      !(
        isRecord(entry) &&
        Array.isArray(entry['hooks']) &&
        entry['hooks'].some((hook) => isRecord(hook) && typeof hook['command'] === 'string' && hook['command'].endsWith(ours))
      ),
  );
  kept.push({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] });
  hooks[event] = kept;
}

async function readObject(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (!isRecord(value)) throw new BoardError(`${path} is not a JSON object. Fix or remove it, then run setup again.`);
  return value;
}

async function ignoreState(root: string): Promise<'added' | 'present' | 'no-git-dir'> {
  const gitDir = join(root, '.git');
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return 'no-git-dir';
  const path = join(gitDir, 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  if (current.split(/\r?\n/).includes('.crosstalk/')) return 'present';
  await mkdir(join(gitDir, 'info'), { recursive: true });
  await appendFile(path, `${current === '' || current.endsWith('\n') ? '' : '\n'}.crosstalk/\n`, 'utf8');
  return 'added';
}

function isTracked(root: string, file: string): Promise<boolean> {
  return new Promise((done) => {
    execFile('git', ['ls-files', '--error-unmatch', file], { cwd: root }, (error) => done(error === null));
  });
}

function slashes(path: string): string {
  return path.split(sep).join('/');
}
```

- [ ] **Step 8: Run the setup tests to see them pass**

Run: `npx vitest run tests/cli/setup.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Wire `hook` and `setup` into the CLI**

In `src/cli/index.ts`, add imports:

```ts
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runHook, type HookInput } from '../hooks/hook.js';
import { setupClaude } from './setup.js';
```

(replace the existing `import { pathToFileURL } from 'node:url';` line with the first of these.)

Add two cases to the `switch`, before `case 'mcp':`:

```ts
      case 'hook':
        return await hook(rest, io);
      case 'setup':
        return await setup(rest, io);
```

Add the two handlers after `mcp`:

```ts
async function hook(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, {});
  let input: HookInput;
  try {
    input = JSON.parse(await io.stdin()) as HookInput;
  } catch {
    return EXIT.ok;
  }
  const root =
    typeof values['repo'] === 'string'
      ? resolve(values['repo'])
      : findRoot(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  try {
    const output = await runHook(root, input);
    if (output !== undefined) io.out(JSON.stringify(output));
  } catch (error) {
    // A hook must never stop the agent it serves.
    io.err(`crosstalk hook: ${error instanceof Error ? error.message : String(error)}`);
  }
  return EXIT.ok;
}

async function setup(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, {});
  if (positionals[0] !== 'claude') throw new UsageError('setup supports one harness so far: ct setup claude');
  const cli = realpathSync(fileURLToPath(import.meta.url));
  const result = await setupClaude(rootOf(values), cli);
  io.out([...result.changes, '', ...result.notes].join('\n'));
  return EXIT.ok;
}
```

Add to `tests/cli/cli.test.ts`, inside `describe('ct', …)`:

```ts
  it('hook reads stdin, prints a notice, and never fails', async () => {
    const repo = await tempRepo();
    const quiet = capture();
    await run(['join', 'orchestrator', '--repo', repo], quiet);
    await run(['join', 'builder-1', '--repo', repo], quiet);
    const join = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      agent_id: 'a1',
      tool_name: 'mcp__crosstalk__join',
      tool_input: { name: 'builder-1' },
      tool_response: 'joined as builder-1',
    });
    expect(await run(['hook', '--repo', repo], capture(join))).toBe(EXIT.ok);
    await run(['send', '--as', 'orchestrator', '--to', 'builder-1', 'hi', '--repo', repo], quiet);
    const io = capture(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', agent_id: 'a1', tool_name: 'Bash' }));
    expect(await run(['hook', '--repo', repo], io)).toBe(EXIT.ok);
    expect(JSON.parse(io.stdout[0]!)).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('builder-1') } });
    expect(await run(['hook', '--repo', repo], capture('not json'))).toBe(EXIT.ok);
  });
```

- [ ] **Step 10: Add the hook timing test**

`tests/hooks/timing.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const built = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

function once(repo: string, input: string): Promise<number> {
  return new Promise((done, fail) => {
    const started = performance.now();
    const child = execFile(process.execPath, [built, 'hook', '--repo', repo], (error) =>
      error === null ? done(performance.now() - started) : fail(error),
    );
    child.stdin?.end(input);
  });
}

describe.skipIf(!existsSync(built))('hook timing (built CLI)', () => {
  it('answers an ordinary tool call quickly', async () => {
    const repo = await tempRepo();
    const board = new Board(repo);
    await board.join('builder-1');
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash' });
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) times.push(await once(repo, input));
    times.sort((a, b) => a - b);
    // The target is 100 ms on a developer machine; CI runners are slower, so this only catches regressions like loading the MCP SDK.
    expect(times[2]).toBeLessThan(400);
  }, 30_000);
});
```

- [ ] **Step 11: Run everything**

```bash
npm run build
npm test
npm run typecheck
```

Expected: all green. Then measure the real number on this machine and write it in the commit body:

```bash
node -e "const {execFileSync}=require('child_process');const t=[];for(let i=0;i<7;i++){const s=performance.now();execFileSync(process.execPath,['dist/cli/index.js','hook','--repo','.'],{input:'{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"x\",\"tool_name\":\"Bash\"}'});t.push(performance.now()-s)}t.sort((a,b)=>a-b);console.log('median ms',Math.round(t[3]))"
```

Expected: a median under about 100 ms. If it is well over, find what the hook path imports before moving on.

- [ ] **Step 12: Commit**

```bash
git add src/hooks src/cli tests/hooks tests/cli
git commit -m "Tell Claude Code agents when they have mail" -m "Hooks announce unread messages by count and block finishing on unread direct messages. A probe showed agents refuse message text injected by a hook but act on messages they fetch themselves. Median hook time here: <N> ms."
```

(Replace `<N>` with the measured median.)

---

### Task 10: The hub

**Files:**
- Create: `src/hub/page.ts`, `src/hub/server.ts`, `tests/hub/hub.test.ts`
- Modify: `src/cli/index.ts` (add `hub` case)

**Interfaces:**
- Consumes: `Board`, `BoardError`, `merge`, `readFrom`, `senders`, `Line`, `currentRun`, `listRuns`, `openRun`, `runPaths`, `waitForChange`, `HUMAN`.
- Produces: `PAGE: string`; `interface Hub { url: string; close(): Promise<void> }`; `startHub(root: string, options?: { port?: number; host?: string }): Promise<Hub>`.

- [ ] **Step 1: Write the failing tests**

`tests/hub/hub.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { currentRun, runPaths } from '../../src/board/runs.js';
import { PAGE } from '../../src/hub/page.js';
import { startHub, type Hub } from '../../src/hub/server.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

const hubs: Hub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  await removeTempRepos();
});

async function open(): Promise<{ root: string; base: string; cookie: string }> {
  const root = await tempRepo();
  const hub = await startHub(root);
  hubs.push(hub);
  const login = await fetch(hub.url, { redirect: 'manual' });
  expect(login.status).toBe(302);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { root, base: new URL(hub.url).origin, cookie };
}

describe('hub', () => {
  it('refuses a browser without the token', async () => {
    const root = await tempRepo();
    const hub = await startHub(root);
    hubs.push(hub);
    const response = await fetch(new URL(hub.url).origin);
    expect(response.status).toBe(403);
  });

  it('streams messages as they are written', async () => {
    const { root, base, cookie } = await open();
    const board = new Board(root);
    await board.join('orchestrator');
    await board.send('orchestrator', 'all', 'before connecting');
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { headers: { cookie }, signal: controller.signal });
    const reader = response.body!.getReader();
    setTimeout(() => void board.send('orchestrator', 'all', 'after connecting'), 200);
    let seen = '';
    while (!seen.includes('after connecting')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(seen).toContain('"text":"before connecting"');
    expect(seen).toContain('"text":"after connecting"');
  });

  it('sends as human', async () => {
    const { root, base, cookie } = await open();
    const board = new Board(root);
    await board.join('builder-1');
    const response = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'builder-1', text: 'check the dock' }),
    });
    expect(response.status).toBe(200);
    const run = await currentRun(root);
    expect(await readFile(join(runPaths(run!).msgs, 'human.jsonl'), 'utf8')).toContain('check the dock');
    expect((await board.inbox('builder-1')).text).toMatch(/human: check the dock$/);
  });

  it('answers a bad send with the reason', async () => {
    const { base, cookie } = await open();
    const response = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'all, builder-1', text: 'x' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/not both/);
  });

  it('lists runs', async () => {
    const { root, base, cookie } = await open();
    await new Board(root).join('builder-1');
    const body = (await (await fetch(`${base}/api/runs`, { headers: { cookie } })).json()) as { current: string; runs: string[] };
    expect(body.runs).toEqual([body.current]);
  });

  it('renders message text as text, never as HTML', () => {
    expect(PAGE).toContain('textContent');
    expect(PAGE).not.toContain('innerHTML');
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/hub/hub.test.ts`
Expected: FAIL, `Cannot find module '../../src/hub/page.js'`.

- [ ] **Step 3: Implement `src/hub/page.ts`**

```ts
/** The whole hub: one page, no framework, no build step. Message text is only ever set with textContent. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crosstalk</title>
<style>
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #2563eb; --error: #dc2626; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #60a5fa; --error: #f87171; }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100vh; }
header { display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
h1 { font-size: 15px; margin: 0; }
#status { color: var(--muted); margin-left: auto; }
main { flex: 1; overflow-y: auto; padding: 8px 16px; }
.msg { padding: 6px 0; border-bottom: 1px solid var(--line); }
.meta { color: var(--muted); font-size: 12px; }
.from { color: var(--accent); font-weight: 600; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
form { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); }
input, textarea, select, button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
#to { width: 140px; }
#text { flex: 1; resize: vertical; min-height: 38px; }
button { cursor: pointer; }
#error { color: var(--error); padding: 0 16px; min-height: 1.5em; }
</style>
</head>
<body>
<header><h1>Crosstalk</h1><select id="run" aria-label="Run"></select><span id="status">connecting…</span></header>
<main id="log"></main>
<div id="error" role="alert"></div>
<form id="compose">
  <input id="to" value="all" aria-label="To: names or all">
  <textarea id="text" placeholder="Message as human" aria-label="Message"></textarea>
  <button>Send</button>
</form>
<script>
const $ = (id) => document.getElementById(id);
let source;

function row(msg) {
  const el = document.createElement('div');
  el.className = 'msg';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const from = document.createElement('span');
  from.className = 'from';
  from.textContent = msg.from;
  meta.append(new Date(msg.ts).toLocaleTimeString() + ' ', from, ' → ' + msg.to.join(', '));
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = msg.text;
  el.append(meta, text);
  return el;
}

function watch(run) {
  if (source) source.close();
  source = new EventSource('/api/stream?run=' + encodeURIComponent(run));
  // The server replays the run on every connection, so start clean each time.
  source.onopen = () => { $('log').replaceChildren(); $('status').textContent = 'live · ' + run; };
  source.onerror = () => { $('status').textContent = 'reconnecting…'; };
  source.onmessage = (event) => {
    const log = $('log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(row(JSON.parse(event.data)));
    if (atBottom) log.scrollTop = log.scrollHeight;
  };
}

async function loadRuns() {
  const { current, runs } = await (await fetch('/api/runs')).json();
  if (!current) {
    $('status').textContent = 'no run yet; one starts when an agent joins';
    setTimeout(loadRuns, 3000);
    return;
  }
  $('run').replaceChildren(...runs.slice().reverse().map((id) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id === current ? id + ' (current)' : id;
    return option;
  }));
  $('run').value = current;
  watch(current);
}

$('run').onchange = () => watch($('run').value);
$('compose').onsubmit = async (event) => {
  event.preventDefault();
  $('error').textContent = '';
  const response = await fetch('/api/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: $('to').value, text: $('text').value }),
  });
  const body = await response.json();
  if (!response.ok) { $('error').textContent = body.error; return; }
  $('text').value = '';
};
loadRuns();
</script>
</body>
</html>
`;
```

- [ ] **Step 4: Implement `src/hub/server.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HUMAN } from '../board/agents.js';
import { Board } from '../board/board.js';
import { BoardError, isRecord } from '../board/fsutil.js';
import { merge, readFrom, senders, type Line } from '../board/messages.js';
import { currentRun, listRuns, openRun, runPaths } from '../board/runs.js';
import { waitForChange } from '../board/wait.js';
import { PAGE } from './page.js';

export interface Hub {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;
const HEARTBEAT_MS = 15_000;

export async function startHub(root: string, options: { port?: number; host?: string } = {}): Promise<Hub> {
  const token = randomBytes(16).toString('hex');
  const board = new Board(root);
  const closing = new AbortController();

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://hub');
    if (url.pathname === '/' && url.searchParams.get('t') === token) {
      response.writeHead(302, { 'set-cookie': `ct=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
      response.end();
      return;
    }
    if (!hasToken(request, token)) {
      reply(response, 403, 'text/plain', 'Open the hub from the URL that `ct hub` printed.');
      return;
    }

    const route = `${request.method ?? 'GET'} ${url.pathname}`;
    if (route === 'GET /') return reply(response, 200, 'text/html; charset=utf-8', PAGE);
    if (route === 'GET /api/runs') {
      return json(response, 200, { current: (await currentRun(root))?.id ?? null, runs: await listRuns(root) });
    }
    if (route === 'GET /api/stream') return stream(request, response, url.searchParams.get('run'));
    if (route === 'POST /api/send') {
      try {
        const body = await readBody(request);
        const result = await board.send(HUMAN, String(body['to'] ?? ''), String(body['text'] ?? ''));
        return json(response, 200, { result });
      } catch (error) {
        if (error instanceof BoardError) return json(response, 400, { error: error.message });
        throw error;
      }
    }
    return reply(response, 404, 'text/plain', 'not found');
  }

  async function stream(request: IncomingMessage, response: ServerResponse, id: string | null): Promise<void> {
    const run = id === null || id === '' ? await currentRun(root) : await openRun(root, id);
    if (run === undefined) return json(response, 404, { error: 'no run yet' });
    const { msgs } = runPaths(run);

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    const gone = new AbortController();
    request.on('close', () => gone.abort());
    const stop = (): void => gone.abort();
    closing.signal.addEventListener('abort', stop, { once: true });

    const offsets: Record<string, number> = {};
    while (!gone.signal.aborted) {
      const queues = new Map<string, Line[]>();
      for (const sender of await senders(msgs)) {
        const chunk = await readFrom(msgs, sender, offsets[sender] ?? 0);
        offsets[sender] = chunk.end;
        queues.set(sender, chunk.lines);
      }
      for (const line of merge(queues)) write(response, `data: ${JSON.stringify(line.msg)}\n\n`);
      await waitForChange(msgs, HEARTBEAT_MS, gone.signal);
      write(response, ':hb\n\n');
    }
    closing.signal.removeEventListener('abort', stop);
    if (!response.writableEnded) response.end();
  }

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, host, () => done());
  });
  const { port } = server.address() as AddressInfo;
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    url: `http://${shown}:${port}/?t=${token}`,
    close: async () => {
      closing.abort();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function hasToken(request: IncomingMessage, token: string): boolean {
  return (request.headers.cookie ?? '').split(';').some((part) => part.trim() === `ct=${token}`);
}

function write(response: ServerResponse, text: string): void {
  if (!response.writableEnded && !response.destroyed) response.write(text);
}

function reply(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type });
  response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  reply(response, status, 'application/json', JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BoardError('message too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/hub/hub.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Wire `hub` into the CLI**

Add a case before `case 'mcp':` in `src/cli/index.ts`:

```ts
      case 'hub':
        return await hub(rest, io);
```

And the handler after `setup`:

```ts
async function hub(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, { port: { type: 'string' }, host: { type: 'string' } });
  const port = values['port'] === undefined ? 0 : Number(values['port']);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a port number');
  const host = typeof values['host'] === 'string' ? values['host'] : '127.0.0.1';
  const { startHub } = await import('../hub/server.js');
  const started = await startHub(rootOf(values), { port, host });
  io.out(`Crosstalk hub: ${started.url}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    io.out(`Listening on ${host}. The token in that URL is the only thing guarding it.`);
  }
  return EXIT.ok;
}
```

- [ ] **Step 7: Look at it**

```bash
npm run build
node dist/cli/index.js join builder-1 --repo .
node dist/cli/index.js hub --repo .
```

Open the printed URL. Send a message to `builder-1` from the page, then in a second shell:

```bash
node dist/cli/index.js inbox --as builder-1 --repo .
```

Expected: the page shows `live · <run>`; the message appears on the page and in the inbox output. Check it in dark mode too. Afterwards remove the test run: `node dist/cli/index.js new --repo .` is not enough; delete `.crosstalk/` in this repository.

- [ ] **Step 8: Commit**

```bash
npm test
npm run typecheck
git add src/hub src/cli/index.ts tests/hub
git commit -m "Add a one-page hub for watching and messaging agents" -m "Plain HTML with no build step, served on loopback with a token. The human sends as human without joining."
```

---

### Task 11: Documentation and the end-to-end check

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CLAUDE.md`
- Keep: `docs/CROSS-PLATFORM.md`, `docs/FRICTION-LOG.md`, the spec, this plan

- [ ] **Step 1: Rewrite `README.md`**

Replace everything above `## License` with:

````markdown
<div align="center">

# Crosstalk

**A message board for coding agents, in any harness.**

Claude Code, Codex and Cursor agents working in one repository, subagents included, message each other directly. Nothing to start, nothing to replay: a new session sees only what arrives after it joins.

</div>

---

## Why

Parallel agents step on each other. Two builders edit the same file; an orchestrator cannot redirect a subagent that is already running; a subagent learns something the others need and it stays in its context until it returns. Crosstalk gives them one channel for exactly those moments, and keeps everything else out of their context.

## How it works

- **Files, not a server.** Messages live under `.crosstalk/runs/<run>/`, one append-only file per sender. There is no daemon, no port and no token for agents.
- **Runs.** `ct new` starts an empty board. Old runs stay on disk for you to read; agents never see them.
- **Only what is yours.** An agent receives direct messages (even ones sent before it joined) and broadcasts sent after it joined. Never its own, never the history.
- **Small answers.** One line per message, 20 messages or 4,000 characters per call, and `N more` instead of dropping anything.

## Four tools

| Tool | Does |
|---|---|
| `join(name, rejoin?)` | Take a unique name. Returns the rules for using the board. `rejoin` continues after `/clear`. |
| `send(as, to, text)` | `to` is comma-separated names or `all`. |
| `inbox(as, wait_s?)` | Your new messages. `wait_s` waits up to 50 s for one. |
| `who()` | Who is on the board and what they have unread. |

Every call names its caller with `as`, because subagents share their parent's MCP connection.

## Setup

Crosstalk is not on npm yet. Build it once:

```bash
git clone https://github.com/moazessam376-dev/crosstalk
cd crosstalk
npm ci
npm run build
```

### Claude Code (CLI or desktop)

From the project your agents work in:

```bash
node <crosstalk>/dist/cli/index.js setup claude
```

`<crosstalk>` is the folder you cloned into. This merges a `crosstalk` server into `.mcp.json`, three hooks into `.claude/settings.local.json`, and `.crosstalk/` into `.git/info/exclude`. It never overwrites what is there. Restart the sessions in that folder.

The hooks do two things:

- After a tool call, if the agent has unread messages, they add one line to its context: `crosstalk: 2 unread messages for builder-1. Call inbox.` Never the message text: agents rightly distrust text injected that way, and act on messages they fetch themselves.
- They stop an agent or subagent from finishing while it has an unread direct message.

When you start subagents that should coordinate, tell each one in its prompt which name to join as. The rest comes from `join`.

### Codex, Cursor and anything else with MCP

Point the harness at the server, passing the project path:

```toml
# ~/.codex/config.toml
[mcp_servers.crosstalk]
command = "node"
args = ["<crosstalk>/dist/cli/index.js", "mcp", "--repo", "<project>"]
```

```json
// .cursor/mcp.json
{ "mcpServers": { "crosstalk": { "command": "node", "args": ["<crosstalk>/dist/cli/index.js", "mcp", "--repo", "<project>"] } } }
```

These harnesses have no hook adapter yet, so tell the agent to call `inbox` between steps.

### Anything with a shell

```bash
node <crosstalk>/dist/cli/index.js join builder-1
node <crosstalk>/dist/cli/index.js send --as builder-1 --to orchestrator "api.ts is free"
node <crosstalk>/dist/cli/index.js inbox --as builder-1 --wait 50
```

`inbox` exits 3 when there is nothing new.

## Watching

```bash
node <crosstalk>/dist/cli/index.js hub
```

Open the printed URL. You see the run live and can message any agent, or `all`, as `human`.

`ct stats` shows what the board cost each agent: messages, characters delivered, hook notices, and an estimate in tokens.

## Waiting while idle (desktop app)

A Claude Code desktop session wakes when a background command it started exits. An idle agent can wait for mail at no token cost by starting `ct inbox --as <name> --wait 50` in the background and restarting it after each idle return. Headless `claude -p` exits at the end of its turn and cannot do this.

## Limits

- Local only. Cloud agents (Devin, Cursor background agents) cannot reach your files.
- Names are claimed, not authenticated. Any process on your machine can write under `.crosstalk/`.
- Message order across senders is by timestamp, from one machine clock.
````

- [ ] **Step 2: Update `AGENTS.md`**

Replace the "Read first" line with:

```markdown
**Read first:** [design spec](docs/specs/2026-09-22-message-board-design.md) · [plan](docs/plans/2026-09-22-message-board.md) · [cross-platform rules](docs/CROSS-PLATFORM.md)
```

Replace the `## Hard rules` list with:

```markdown
1. **One runtime dependency** — `@modelcontextprotocol/sdk`. Dev deps are free.
2. **No native modules.** They break installs on machines without build tools.
3. **One writer per file.** A sender appends only to its own messages file; an agent writes only its own cursor; hooks write only notified files. Anything that needs a lock is a design change.
4. **Hooks notify, never carry messages, and never fail the agent.**
5. **Every board answer is plain text and bounded.** No tool returns history or unbounded output.
6. **`node:path` always, `execFile` never `exec`.** Details in `docs/CROSS-PLATFORM.md`.
7. **Green on one platform is not done.** CI is Windows, macOS and Linux.
8. **Scratch files go under `.crosstalk/` or the OS temp directory**, never the repo root.
```

Keep Commands, Testing, Review is a conversation, Handing off and Commits as they are. The review section is about PR review, not the removed protocol.

- [ ] **Step 3: Update `CLAUDE.md`**

Replace the `## Role` section's first paragraph with:

```markdown
In this repo Claude Code is usually the **leader**: it authors the spec and plan, reviews each task as a harsh critic (max two rounds per task), and owns merge order.
```

(This drops "freezes `src/contracts/`", which no longer exists.)

- [ ] **Step 4: Full verification, five times**

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Run `npm test` five times and record the pass count of each run. Expected: 5 of 5 green.

Then check the size of the change:

```bash
git diff --shortstat v0-protocol
```

- [ ] **Step 5: End-to-end with a real Claude Code subagent**

In a scratch repository under the OS temp directory (not this repo):

```bash
git init
git commit --allow-empty -m init
node <crosstalk>/dist/cli/index.js setup claude
```

Run, with `<crosstalk>` substituted:

```bash
claude -p --model claude-sonnet-5 --allowedTools "mcp__crosstalk__join" "mcp__crosstalk__send" "mcp__crosstalk__inbox" "mcp__crosstalk__who" "Bash(echo:*)" "Agent" "Task" -- "Join crosstalk as orchestrator. Then start one general-purpose subagent with this prompt: 'Join crosstalk as builder-1. Run echo step-one, then echo step-two, then echo step-three, then finish. Report every command you ran, in order.' While it runs, send builder-1 this message: 'change of plan: skip step-three, run echo redirected instead'. Relay the subagent's report verbatim."
```

Expected:
- `node <crosstalk>/dist/cli/index.js stats --repo .` shows `orchestrator` sent 1 and `builder-1` delivered 1.
- The report either shows `echo redirected` instead of `echo step-three` (the message arrived mid-run), or lists all three steps and then says the SubagentStop hook made it read the message before finishing. Record which one happened; both prove delivery.

If `.mcp.json` servers need approving in headless mode, add `--mcp-config .mcp.json` to the command.

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md CLAUDE.md
git commit -m "Document Crosstalk as a message board" -m "Setup for Claude Code, Codex, Cursor and a plain shell, what the hooks do and why they never carry message text, and the limits."
```

- [ ] **Step 7: Hand off**

Report to the owner: the `git diff --shortstat v0-protocol` line, the five test pass counts, the hook median, and which way the end-to-end run went. Pushing the branch, pushing the `v0-protocol` tag and opening the PR wait for the owner's go-ahead.
