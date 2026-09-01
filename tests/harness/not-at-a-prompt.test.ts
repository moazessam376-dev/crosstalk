import { describe, expect, it } from 'vitest';

import { awaitingConfirmation, NotAtAPromptError, openSession, showsTyped } from '../../src/harness/session.js';
import { Screen } from '../../src/harness/screen.js';
import type { PtyProcess, PtySpec, SpawnPty } from '../../src/harness/pty.js';

/**
 * Look before pressing Return.
 *
 * The Return that submits a turn is the same keystroke that answers a modal,
 * and a seat does not always come up at a composer. Claude Code opens on a
 * bypass-permissions confirmation whose default option is **No, exit**. The
 * harness typed the job on a fixed four-second timer and pressed Return, which
 * selected "No, exit" — three seats, all `exited 1`, before any of them had
 * read a line of its brief.
 *
 * The delay was always a guess. It only became fatal when Return started
 * working; before that the same guess failed silently, leaving the job sitting
 * unsent in the composer. Both are the same defect: typing at whatever happens
 * to be on screen.
 *
 * So the seat has to echo what was typed before Return is pressed. Text in a
 * text field comes back; text at a dialog does not.
 */

const ESC = String.fromCharCode(27);

function fakePty(): { spawnPty: SpawnPty; writes: () => string[]; draw: (text: string) => void } {
  const writes: string[] = [];
  let onData: ((chunk: string) => void) | undefined;
  const spawnPty: SpawnPty = (_spec: PtySpec): PtyProcess => ({
    write: (chunk: string) => {
      writes.push(chunk);
    },
    onData: (handler) => {
      onData = handler;
    },
    onExit: () => {},
    resize: () => {},
    kill: () => {},
  });
  return { spawnPty, writes: () => [...writes], draw: (text) => onData?.(text) };
}

/** The screen a seat that is waiting on the mode confirmation actually shows. */
const BYPASS_DIALOG = [
  'WARNING: Claude Code running in Bypass Permissions mode',
  'By proceeding, you accept all responsibility.',
  `${ESC}[7m> No, exit${ESC}[0m`,
  '  Yes, I accept',
  'Enter to confirm . Esc to cancel',
].join('\r\n');

describe('deciding whether Return is safe', () => {
  it('presses Return once the seat has echoed what was typed', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: '',
      turnFormat: 'interactive',
      readyDelayMs: 10 ** 6,
      submitDelayMs: 1,
      capture: {},
      spawnPty: pty.spawnPty,
    });

    const sending = session.send('read JOB.md and work it');
    pty.draw('> read JOB.md and work it');
    await sending;

    expect(pty.writes()).toContain('\r');
  });

  /** The measured failure, pinned: a Return here selects "No, exit". */
  it('refuses to press Return at the bypass dialog', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: '',
      turnFormat: 'interactive',
      readyDelayMs: 10 ** 6,
      submitDelayMs: 1,
      capture: {},
      spawnPty: pty.spawnPty,
    });

    pty.draw(BYPASS_DIALOG);
    await expect(session.send('read JOB.md and work it')).rejects.toBeInstanceOf(NotAtAPromptError);
    expect(pty.writes()).not.toContain('\r');
  });

  /**
   * Without a reconstructed screen there is nothing to look at, and refusing
   * every turn would be worse than the risk — a seat nobody is mirroring still
   * has to be able to work.
   */
  it('presses Return when there is no screen to check', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: '',
      turnFormat: 'interactive',
      readyDelayMs: 10 ** 6,
      submitDelayMs: 1,
      spawnPty: pty.spawnPty,
    });

    await session.send('anything');
    expect(pty.writes()).toContain('\r');
  });

  /** Keeps offering the job, so the seat starts once the operator answers. */
  it('delivers the opening job after the dialog is cleared', async () => {
    const pty = fakePty();
    openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'read JOB.md and work it',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      submitDelayMs: 1,
      capture: {},
      spawnPty: pty.spawnPty,
    });

    pty.draw(BYPASS_DIALOG);
    await new Promise((done) => setTimeout(done, 60));
    expect(pty.writes()).not.toContain('\r');

    // The operator answers it; the composer appears and echoes the retry.
    pty.draw(`${ESC}[2J${ESC}[H`);
    await new Promise((done) => setTimeout(done, 4200));
    pty.draw('> read JOB.md and work it');
    await new Promise((done) => setTimeout(done, 4200));

    expect(pty.writes()).toContain('\r');
  }, 20_000);
});

describe('reading the echo off the screen', () => {
  const screenWith = (text: string): Screen => {
    const screen = new Screen(8, 60);
    screen.write(text);
    return screen;
  };

  it('finds text the terminal wrapped across rows', () => {
    // The composer is 60 wide here and the turn is longer, so what comes back
    // is the same characters split over two rows. A naive substring check on
    // the joined screen would miss it.
    const typed = 'read JOB.md at the root of your worktree and work it';
    expect(showsTyped(screenWith(typed), typed)).toBe(true);
  });

  it('does not find text the seat never echoed', () => {
    expect(showsTyped(screenWith(BYPASS_DIALOG), 'read JOB.md and work it')).toBe(false);
  });

  it('treats an empty turn as nothing to check', () => {
    expect(showsTyped(screenWith(BYPASS_DIALOG), '')).toBe(true);
  });
});

/**
 * The race that actually killed the run, and the reason an echo check is not
 * enough on its own.
 *
 * The launch posts the job to #floor, which makes every seat's inbox non-empty
 * at once, so the wake loop delivers a turn about two seconds in — long before
 * the first-turn timer anyone was reasoning about. At two seconds the seat is
 * still starting: the composer takes the text and echoes it, the confirmation
 * paints over it, and Return lands on "No, exit". The text *is* on screen, so
 * "did it echo?" answers yes and presses Return into the dialog.
 *
 * Measured three times, three seats each, every seat `exited 1` at 2.1s.
 */
describe('a dialog that appears while a turn is being typed', () => {
  it('does not press Return when the confirmation drew itself after the echo', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: '',
      turnFormat: 'interactive',
      readyDelayMs: 10 ** 6,
      submitDelayMs: 30,
      capture: {},
      spawnPty: pty.spawnPty,
    });

    const sending = session.send('read JOB.md and work it');
    // The composer took it and echoed it...
    pty.draw('> read JOB.md and work it');
    // ...and then the confirmation painted over the top, which is the race.
    pty.draw(`\r\n${BYPASS_DIALOG}`);

    await expect(sending).rejects.toBeInstanceOf(NotAtAPromptError);
    expect(pty.writes()).not.toContain('\r');
  });

  it('will not even type at a seat that is already waiting on one', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: '',
      turnFormat: 'interactive',
      readyDelayMs: 10 ** 6,
      submitDelayMs: 1,
      capture: {},
      spawnPty: pty.spawnPty,
    });

    pty.draw(BYPASS_DIALOG);
    await expect(session.send('read JOB.md')).rejects.toBeInstanceOf(NotAtAPromptError);
    // Letters at a menu are keystrokes, not text: it must not have typed either.
    expect(pty.writes()).toEqual([]);
  });
});

describe('recognising a screen that is asking a question', () => {
  it('knows the confirmations the harnesses actually draw', () => {
    expect(awaitingConfirmation(BYPASS_DIALOG)).toBe(true);
    expect(awaitingConfirmation('Do you trust the files in this folder?')).toBe(true);
    expect(awaitingConfirmation('Overwrite? (y/n)')).toBe(true);
    expect(awaitingConfirmation('Press Enter to continue')).toBe(true);
  });

  it('leaves an ordinary working screen alone', () => {
    expect(awaitingConfirmation('Reading src/world/rock.ts')).toBe(false);
    expect(awaitingConfirmation('> read JOB.md and work it')).toBe(false);
  });
});
