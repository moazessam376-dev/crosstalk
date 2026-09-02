import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EventLog } from '../../src/core/log.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';

/**
 * Moving a finished run out of the live log.
 *
 * The append-only rule says corrections are new events, never edits, and
 * nothing here edits or reorders anything: a completed run's lines move whole,
 * in order, into a file of their own. Only which file holds them changes.
 *
 * Two invariants carry the whole design, and both are the sort that fail
 * quietly months later rather than loudly now — a reused seq corrupts the total
 * order, and an append that lands mid-archive is written to an inode nobody
 * will ever read again.
 */

const dirs: string[] = [];
const logs: EventLog[] = [];

async function logIn(): Promise<{ log: EventLog; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-archive-'));
  dirs.push(dir);
  const path = join(dir, 'events.jsonl');
  const log = await EventLog.open(path);
  logs.push(log);
  return { log, path };
}

function said(body: string): Parameters<EventLog['append']>[0] {
  return { kind: 'message', from: '@human', room: '#floor', body } as Parameters<EventLog['append']>[0];
}

async function linesOf(path: string): Promise<CrosstalkEvent[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CrosstalkEvent);
}

afterEach(async () => {
  // Closed explicitly, not left to the collector. Node warns about it, and on
  // Windows a directory with a live handle in it refuses to be removed — the
  // same EBUSY that made these suites red on the runner once already.
  while (logs.length > 0) await logs.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

describe('archiving a prefix of the log', () => {
  it('never reassigns a seq that has already been used', async () => {
    // The invariant everything else rests on. `#lastSeq` means "highest ever
    // assigned", not "highest still in the file" — recomputing it from what
    // remains would hand the next append a seq an archived event already
    // carries, and two events sharing a seq is unrecoverable.
    const { log, path } = await logIn();
    const dest = join(dirs[dirs.length - 1]!, 'run.jsonl');
    for (const body of ['one', 'two', 'three']) await log.append(said(body));

    await log.archiveBefore(3, dest);
    const next = await log.append(said('four'));

    expect(next.seq).toBe(4);
    expect((await linesOf(path)).map((event) => event.seq)).toEqual([3, 4]);
    expect((await linesOf(dest)).map((event) => event.seq)).toEqual([1, 2]);
  });

  it('keeps counting when everything is archived and the file is empty', async () => {
    // The case that makes the invariant bite. Moving a *prefix* always leaves
    // the highest seq behind, so a `#lastSeq` recomputed from what remains
    // happens to be right — and the bug hides. Move all of it and there is
    // nothing left to recompute from: the counter has to be its own memory, or
    // the next append reuses seq 1 and two events share it forever.
    const { log, path } = await logIn();
    const dest = join(dirs[dirs.length - 1]!, 'run.jsonl');
    for (const body of ['one', 'two', 'three']) await log.append(said(body));

    await log.archiveBefore(4, dest);
    expect(await linesOf(path)).toHaveLength(0);

    const next = await log.append(said('after everything'));
    expect(next.seq).toBe(4);
  });

  it('keeps an append that raced the archive', async () => {
    // Not awaited before the archive starts: the two are issued together, which
    // is what a seat saying something at the moment the operator archives looks
    // like. Both must survive, and the appended one must be in the live file.
    const { log, path } = await logIn();
    const dest = join(dirs[dirs.length - 1]!, 'run.jsonl');
    await log.append(said('before'));

    const racing = log.append(said('during'));
    const archiving = log.archiveBefore(2, dest);
    await Promise.all([racing, archiving]);

    const live = await linesOf(path);
    const bodies = live.map((event) => (event as { body?: string }).body);
    expect(bodies).toContain('during');
    // And it is readable through the log's own view, not just on disk — the
    // in-memory array and the file have to agree after a replace.
    expect(JSON.stringify(await log.read())).toContain('during');
  });

  it('moves the lines whole and in order, editing none of them', async () => {
    const { log, path } = await logIn();
    const dest = join(dirs[dirs.length - 1]!, 'run.jsonl');
    const written: CrosstalkEvent[] = [];
    for (const body of ['a', 'b', 'c', 'd']) written.push(await log.append(said(body)));

    await log.archiveBefore(3, dest);

    expect(await linesOf(dest)).toEqual(written.slice(0, 2));
    expect(await linesOf(path)).toEqual(written.slice(2));
  });

  it('reopens the live file so later appends are not written into a ghost', async () => {
    // The POSIX trap: the handle is open on the original inode, so renaming
    // over it without closing leaves every later append going to an unlinked
    // file. It looks like it worked until the next restart reads none of it.
    const { log, path } = await logIn();
    const dest = join(dirs[dirs.length - 1]!, 'run.jsonl');
    await log.append(said('one'));
    await log.append(said('two'));
    await log.archiveBefore(2, dest);
    await log.append(said('after the archive'));
    await log.close();

    const reopened = await EventLog.open(path);
    logs.push(reopened);
    expect(JSON.stringify(await reopened.read())).toContain('after the archive');
    expect(reopened.lastSeq).toBe(3);
  });

  it('does nothing when there is nothing below the mark', async () => {
    const { log, path } = await logIn();
    const dest = join(dirs[dirs.length - 1]!, 'run.jsonl');
    await log.append(said('only'));

    expect(await log.archiveBefore(1, dest)).toEqual({ moved: 0, kept: 1 });
    expect(await linesOf(path)).toHaveLength(1);
    await expect(readFile(dest, 'utf8')).rejects.toThrow();
  });
});
