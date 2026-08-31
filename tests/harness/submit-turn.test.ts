import { describe, expect, it } from 'vitest';

import { openSession, SUBMIT_DELAY_MS } from '../../src/harness/session.js';
import type { PtyProcess, PtySpec, SpawnPty } from '../../src/harness/pty.js';

/**
 * The Return that submits a turn has to arrive as its own keystroke.
 *
 * `send` used to write the turn and its Return in one go, on the reasoning that
 * "the trailing newline is the Return that submits it; without it the text sits
 * in the composer and the seat looks alive while doing nothing". The reasoning
 * was right and the implementation produced exactly that failure by the other
 * door: a terminal UI that reads text and its Return in one chunk sees a
 * *paste*, and a Return inside a paste is a newline, not a submit.
 *
 * Measured on three live Claude Code seats: not one turn was ever submitted.
 * The job typed itself into the composer at launch and stayed there, and every
 * board wake stacked another unsent copy behind it until the input box filled
 * all 32 rows of the screen. From the board those seats had joined and gone
 * silent — indistinguishable from three agents ignoring the room.
 *
 * The same text followed by a separate write of Return submitted every time,
 * which is what these pin: two writes, in order, text first.
 */

function fakePty(): { spawnPty: SpawnPty; writes: () => string[] } {
  const writes: string[] = [];
  const spawnPty: SpawnPty = (_spec: PtySpec): PtyProcess => ({
    write: (chunk: string) => {
      writes.push(chunk);
    },
    onData: () => {},
    onExit: () => {},
    resize: () => {},
    kill: () => {},
  });
  return { spawnPty, writes: () => [...writes] };
}

const RETURN = '\r';

describe('submitting a turn to an interactive seat', () => {
  it('presses Return as a write of its own, not stuck to the text', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: '',
      turnFormat: 'interactive',
      readyDelayMs: 10 ** 6,
      submitDelayMs: 0,
      spawnPty: pty.spawnPty,
    });

    await session.send('agree the split');

    // Two writes. One write of `agree the split\r` is the bug: it reads as a
    // paste and never submits.
    expect(pty.writes()).toEqual(['agree the split', RETURN]);
  });

  it('types the text before it presses Return', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: '',
      turnFormat: 'interactive',
      readyDelayMs: 10 ** 6,
      submitDelayMs: 0,
      spawnPty: pty.spawnPty,
    });

    await session.send('read JOB.md');

    const writes = pty.writes();
    expect(writes.indexOf('read JOB.md')).toBeLessThan(writes.indexOf(RETURN));
  });

  /**
   * The gap is the whole mechanism: it has to outlast whatever window the TUI
   * coalesces reads over, or the two writes are merged back into one paste and
   * nothing has changed.
   */
  it('leaves a gap between the text and the Return', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: '',
      turnFormat: 'interactive',
      readyDelayMs: 10 ** 6,
      submitDelayMs: 40,
      spawnPty: pty.spawnPty,
    });

    const sent = session.send('the job');
    expect(pty.writes()).toEqual(['the job']);

    await sent;
    expect(pty.writes()).toEqual(['the job', RETURN]);
  });

  it('defaults the gap to something a terminal will not coalesce over', () => {
    expect(SUBMIT_DELAY_MS).toBeGreaterThanOrEqual(100);
  });

  /**
   * The first turn goes through the same path, which is where this cost the
   * most: the job itself was the turn that never submitted.
   */
  it('submits the opening job the same way', async () => {
    const pty = fakePty();
    openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'build the vault',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      submitDelayMs: 0,
      spawnPty: pty.spawnPty,
    });

    await new Promise((done) => setTimeout(done, 20));
    expect(pty.writes()).toEqual(['build the vault', RETURN]);
  });
});
