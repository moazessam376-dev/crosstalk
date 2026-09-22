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
