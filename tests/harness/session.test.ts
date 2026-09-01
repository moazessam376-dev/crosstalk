import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { openSession, PTY_SIZE, type SpawnProcess } from '../../src/harness/session.js';
import type { PtySpec, SpawnPty } from '../../src/harness/pty.js';

/**
 * A child that records what was written to its stdin.
 *
 * The real claim — that a turn written mid-flight is queued and answered in
 * order — was verified against the `claude` binary before this module was
 * written. What is worth pinning here is the framing and the fallback, because
 * those are ours to get wrong.
 */
function fakeChild(): {
  child: ChildProcess;
  written: () => string[];
  raw: () => string;
  emit: (text: string) => void;
  close: (code: number) => void;
} {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: string[] = [];
  stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  Object.assign(emitter, { stdin, stdout, stderr, kill: () => true });
  return {
    child: emitter,
    written: () => chunks.join('').split('\n').filter((line) => line !== ''),
    raw: () => chunks.join(''),
    emit: (text) => stdout.write(text),
    close: (code) => emitter.emit('close', code),
  };
}

interface SpawnCall {
  file: string;
  args: string[];
  options: { cwd: string; env?: NodeJS.ProcessEnv };
}

function harness(): { spawn: SpawnProcess; calls: SpawnCall[]; last: () => ReturnType<typeof fakeChild> } {
  const calls: SpawnCall[] = [];
  let made: ReturnType<typeof fakeChild> | undefined;
  const spawn: SpawnProcess = (file, args, options) => {
    calls.push({ file, args, options });
    made = fakeChild();
    return made.child;
  };
  return { spawn, calls, last: () => made! };
}

/**
 * Wait for the session to have written something, rather than for a stopwatch.
 *
 * The opening turn is delivered asynchronously — it looks at the screen before
 * pressing Return — so a fixed 5ms sleep asserted against whatever had happened
 * by then. That is fast enough on this machine and not on a Windows runner,
 * where the same tests failed with the Return not yet sent.
 */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('timed out waiting for the session to write');
}

describe('a harness that takes streamed turns', () => {
  it('writes the job as the first turn instead of an argv positional', async () => {
    const { spawn, calls, last } = harness();
    openSession({
      argv: ['claude', '-p', '--input-format', 'stream-json'],
      cwd: '/tmp',
      first: 'build the thing',
      turnFormat: 'stream-json',
      spawn,
    });
    await new Promise((done) => setImmediate(done));

    // The job must not appear on the command line: with streaming input a
    // positional prompt is a second, conflicting way to say the same thing.
    expect(calls[0]!.args).not.toContain('build the thing');
    expect(JSON.parse(last().written()[0]!)).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'build the thing' }] },
    });
  });

  it('accepts another turn after it has started — the wake path', async () => {
    const { spawn, last } = harness();
    const session = openSession({
      argv: ['claude', '-p'],
      cwd: '/tmp',
      first: 'the job',
      turnFormat: 'stream-json',
      spawn,
    });

    expect(session.canPush).toBe(true);
    await session.send('opus claimed harbor.ts');
    await new Promise((done) => setImmediate(done));

    const lines = last().written();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).message.content[0].text).toBe('opus claimed harbor.ts');
  });

  it('settles exited when the child closes, so a supervisor cannot hang', async () => {
    const { spawn, last } = harness();
    const session = openSession({ argv: ['claude'], cwd: '/tmp', first: 'x', turnFormat: 'stream-json', spawn });

    last().close(0);
    await expect(session.exited).resolves.toBe(0);
  });

  it('settles exited when the binary is missing, which emits error and never close', async () => {
    const { spawn, last } = harness();
    const session = openSession({ argv: ['nope'], cwd: '/tmp', first: 'x', turnFormat: 'stream-json', spawn });

    (last().child as unknown as EventEmitter).emit('error', new Error('ENOENT'));
    await expect(session.exited).resolves.toBeNull();
  });
});

/**
 * A pty stood up in memory, so the interactive path is exercised without a
 * terminal — and, more to the point, without a real CLI.
 */
function fakePty(): {
  spawnPty: SpawnPty;
  spec: () => PtySpec;
  written: () => string;
  /** Each write on its own. Whether Return arrives separately is the point. */
  writes: () => string[];
  emit: (text: string) => void;
  exit: (code: number) => void;
} {
  let captured: PtySpec | undefined;
  let data: ((chunk: string) => void) | undefined;
  let exit: ((code: number | null) => void) | undefined;
  const writes: string[] = [];
  const spawnPty: SpawnPty = (spec) => {
    captured = spec;
    return {
      write: (chunk) => {
        writes.push(chunk);
      },
      onData: (handler) => {
        data = handler;
      },
      onExit: (handler) => {
        exit = handler;
      },
      resize: () => {},
      kill: () => exit?.(0),
    };
  };
  return {
    spawnPty,
    spec: () => captured!,
    written: () => writes.join(''),
    writes: () => [...writes],
    emit: (text) => data?.(text),
    exit: (code) => exit?.(code),
  };
}

describe('an interactive seat, watchable over Remote Control', () => {
  /**
   * The reason this is a pty and not `script`. Measured on macOS: spawning
   * `script -q /dev/null …` with a piped stdin dies immediately with
   * `script: tcgetattr/ioctl: Operation not supported on socket`, because
   * `script` calls `tcgetattr` on its own stdin and a daemon has only a pipe to
   * give it. It looked fine every time it was tried by hand, since a hand test
   * runs from a terminal where stdin is a tty — so it worked in every check
   * made and in none of the conditions it would run under.
   */
  it('runs the harness on a pty rather than wrapping it in a shell', async () => {
    const pty = fakePty();
    openSession({
      argv: ['claude', '--remote-control', 'opus', '--permission-mode', 'auto'],
      cwd: '/tmp',
      first: 'the job',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      spawnPty: pty.spawnPty,
    });

    expect(pty.spec().file).toBe('claude');
    expect(pty.spec().args).toEqual(['--remote-control', 'opus', '--permission-mode', 'auto']);
  });

  /**
   * A pty opened without a size is 0x0, and a TUI asked to lay out in zero
   * columns cannot. The same numbers size the reconstructed screen, so a mirror
   * cannot wrap text where the real terminal did not.
   */
  it('sizes the pty from the constant the mirror is reconstructed at', async () => {
    const pty = fakePty();
    openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'the job',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      spawnPty: pty.spawnPty,
    });

    expect(pty.spec().cols).toBe(PTY_SIZE.cols);
    expect(pty.spec().rows).toBe(PTY_SIZE.rows);
  });

  it('types the job rather than putting a whole brief on the command line', async () => {
    const pty = fakePty();
    openSession({
      argv: ['claude', '--remote-control', 'opus'],
      cwd: '/tmp',
      first: 'build the thing',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      submitDelayMs: 0,
      spawnPty: pty.spawnPty,
    });
    await until(() => pty.written().endsWith('\r'));

    expect(pty.spec().args).not.toContain('build the thing');
    expect(pty.written()).toBe('build the thing\r');
  });

  it('sends one line, so a multi-line brief cannot submit itself halfway', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'x',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      submitDelayMs: 0,
      spawnPty: pty.spawnPty,
    });
    await until(() => pty.written() === 'x\r');

    // A newline in the middle of a brief is a Return: it would submit the first
    // paragraph and leave the rest typing into a running turn.
    await session.send('line one\nline two\nline three');
    expect(pty.written()).toBe('x\rline one line two line three\r');
  });

  it('waits for the TUI to draw before typing, or the job lands on a splash screen', async () => {
    const pty = fakePty();
    openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'the job',
      turnFormat: 'interactive',
      readyDelayMs: 120,
      submitDelayMs: 0,
      spawnPty: pty.spawnPty,
    });

    // The half about waiting: silent now, and still silent well inside the
    // delay. 30ms was too tight to say that on a runner whose timers tick in
    // 15.6ms steps, so the window is wide enough to be a claim.
    expect(pty.written()).toBe('');
    await new Promise((done) => setTimeout(done, 40));
    expect(pty.written()).toBe('');

    // The half about typing, waited for as a *state*. Delivery is two writes —
    // the text, then Return — so a stopwatch asserts against whichever half had
    // happened when it fired. On Windows that was reliably 'the job' with the
    // Return still in flight, which is a slow machine, not a broken session.
    await until(() => pty.written() === 'the job\r');
  });

  it('settles exited when the pty closes, so a supervisor cannot hang', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'x',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      spawnPty: pty.spawnPty,
    });

    pty.exit(3);
    await expect(session.exited).resolves.toBe(3);
  });
});

describe('mirroring a seat', () => {
  it('reconstructs the seat screen from what its terminal writes', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'x',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      capture: {},
      spawnPty: pty.spawnPty,
    });

    pty.emit('Reading harbor.ts');

    const screen = session.screen();
    expect(screen?.rows[0]?.map((run) => run.text).join('')).toBe('Reading harbor.ts');
    expect(screen?.cols).toBe(PTY_SIZE.cols);
  });

  it('captures a piped harness too, so a non-interactive seat is watchable', async () => {
    const { spawn, last } = harness();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'x',
      turnFormat: 'stream-json',
      capture: {},
      spawn,
    });

    last().emit('thinking');
    await new Promise((done) => setImmediate(done));

    expect(session.screen()?.rows[0]?.map((run) => run.text).join('')).toBe('thinking');
  });

  /**
   * Capture is a parse per chunk. A seat nobody is watching should not pay for
   * a screen nobody reads, so it is opt-in and `screen()` says so by returning
   * nothing rather than an empty grid.
   */
  it('captures nothing unless asked', async () => {
    const { spawn, last } = harness();
    const session = openSession({ argv: ['claude'], cwd: '/tmp', first: 'x', turnFormat: 'stream-json', spawn });

    last().emit('output nobody asked for');
    await new Promise((done) => setImmediate(done));

    expect(session.screen()).toBeUndefined();
  });

  it('sends raw keys with nothing added, so Escape stays Escape', async () => {
    const pty = fakePty();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'x',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      submitDelayMs: 0,
      spawnPty: pty.spawnPty,
    });
    await until(() => pty.written() === 'x\r');

    await session.key('\u001b');
    // `send` presses the Return that submits a turn; `key` must not, or an
    // arrow key would submit whatever was half-typed in the composer.
    expect(pty.written()).toBe('x\r\u001b');
  });
});
