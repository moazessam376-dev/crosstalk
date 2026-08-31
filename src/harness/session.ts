import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import { Screen, type ScreenSnapshot } from './screen.js';
import { spawnPty as defaultSpawnPty, type SpawnPty } from './pty.js';

/**
 * How a harness takes a turn after it has started.
 *
 * `stream-json` is the only one wired: newline-delimited JSON on stdin, which
 * Claude Code accepts under `--input-format stream-json`. A message written
 * while the model is mid-turn is queued and answered in order — verified
 * against the real binary before this module existed, because the whole point
 * of the seam is that the claim is checkable per harness rather than assumed
 * for all of them.
 *
 * A harness with no `turnFormat` reads its prompt once and cannot be handed
 * another. `codex exec` is that shape: it takes stdin as a single block. So the
 * capability is declared in the registry and read here, and Delivery falls back
 * to pull for the seats that lack it — rather than every seat paying for the
 * weakest harness, which is what a single spawn path would have forced.
 */
export type TurnFormat = 'stream-json' | 'interactive';

export interface HarnessSession {
  /** Hand the harness one more turn. Rejects when this harness cannot take one. */
  send(turn: string): Promise<void>;
  /**
   * Write bytes to the session's input with nothing added.
   *
   * `send` is a turn: it strips newlines and appends the Return that submits
   * it. This is a keystroke — an arrow key, Escape, Ctrl-C — for the operator
   * driving a mirrored terminal from the hub, where the point is that the seat
   * receives exactly what a person at the keyboard would have sent.
   */
  key(bytes: string): Promise<void>;
  /** Whether `send` does anything. False for a harness that reads its prompt once. */
  readonly canPush: boolean;
  /**
   * What the seat's terminal currently shows, reconstructed from its output.
   *
   * `undefined` for a harness whose output was never captured. The snapshot's
   * `version` is stable while the screen is unchanged, so a watcher can hold a
   * cursor and be told "nothing new" for the cost of a number.
   */
  screen(): ScreenSnapshot | undefined;
  readonly exited: Promise<number | null>;
  stop(): void;
}

/**
 * The geometry every interactive seat runs at, and the geometry its mirror is
 * reconstructed at.
 *
 * One constant, because a disagreement between the two is exactly the bug that
 * makes a mirror subtly wrong — text wrapping in the mirror where the real
 * screen did not wrap. `openSession` sets the pty to this and sizes the
 * `Screen` from the same numbers.
 */
export const PTY_SIZE = { rows: 32, cols: 110 } as const;

export type SpawnProcess = (
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => ChildProcess;

/**
 * One turn, as Claude Code's streaming input expects it.
 *
 * Deliberately the same envelope a user message arrives in, so a board card
 * lands in the seat's queue exactly where an operator's message would — that
 * equivalence is what makes the wake feel like being spoken to instead of like
 * polling a service.
 */
function frame(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

export function openSession(args: {
  argv: string[];
  cwd: string;
  /** The job. Written as the first turn when pushing, appended to argv when not. */
  first: string;
  turnFormat?: TurnFormat;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnProcess;
  /** Injected in tests, so the pty path is exercised without a real terminal. */
  spawnPty?: SpawnPty;
  /** Interactive only: how long to let the TUI draw before typing the job. */
  readyDelayMs?: number;
  /**
   * Reconstruct the seat's terminal from its output, so the hub can mirror it.
   *
   * Off by default: capture costs a parse per chunk, and a seat nobody is
   * watching should not pay for a screen nobody reads. `runCompose` turns it on
   * for the seats it registers.
   */
  capture?: { rows?: number; cols?: number } | false;
}): HarnessSession {
  const interactive = args.turnFormat === 'interactive';
  const push = args.turnFormat === 'stream-json' || interactive;

  const screen = args.capture === false || args.capture === undefined
    ? undefined
    : new Screen(args.capture.rows ?? PTY_SIZE.rows, args.capture.cols ?? PTY_SIZE.cols);

  const transport = interactive
    ? interactiveTransport(args, screen)
    : pipeTransport(args, push, screen);

  const send = async (turn: string): Promise<void> => {
    if (!push) throw new Error(`${args.argv[0]} cannot take a turn after it starts`);
    // A terminal takes typing, not envelopes. The trailing newline is the
    // Return that submits it; without it the text sits in the composer and the
    // seat looks alive while doing nothing.
    transport.write(interactive ? `${turn.replace(/\n/g, ' ')}\n` : frame(turn));
    await Promise.resolve();
  };

  // An interactive session has to finish drawing before it will accept input.
  // Typing into the splash screen loses the job silently, which reads exactly
  // like a seat that joined and then ignored the board.
  if (interactive) {
    setTimeout(() => void send(args.first), args.readyDelayMs ?? 4000);
  } else if (push) {
    void send(args.first);
  }

  return {
    send,
    key: async (bytes: string) => {
      transport.write(bytes);
      await Promise.resolve();
    },
    canPush: push,
    screen: () => screen?.snapshot(),
    exited: transport.exited,
    stop: transport.stop,
  };
}

interface Transport {
  write(data: string): void;
  exited: Promise<number | null>;
  stop(): void;
}

/**
 * An interactive seat, on a real pty.
 *
 * The job is not appended to argv: appending it would put the whole brief on
 * the command line of a process that is about to render a prompt box.
 */
function interactiveTransport(
  args: { argv: string[]; cwd: string; env?: NodeJS.ProcessEnv; spawnPty?: SpawnPty },
  screen: Screen | undefined,
): Transport {
  const [file, ...rest] = args.argv;
  if (file === undefined) throw new Error('session argv is empty');

  const child = (args.spawnPty ?? defaultSpawnPty)({
    file,
    args: rest,
    cwd: args.cwd,
    ...(args.env === undefined ? {} : { env: args.env }),
    cols: PTY_SIZE.cols,
    rows: PTY_SIZE.rows,
  });

  if (screen !== undefined) child.onData((chunk) => screen.write(chunk));

  const exited = new Promise<number | null>((settle) => {
    child.onExit((code) => settle(code));
  });

  return {
    write: (data) => child.write(data),
    exited,
    stop: () => child.kill(),
  };
}

/** Everything that is not a terminal: stdin is a pipe and stays one. */
function pipeTransport(
  args: { argv: string[]; cwd: string; first: string; env?: NodeJS.ProcessEnv; spawn?: SpawnProcess },
  push: boolean,
  screen: Screen | undefined,
): Transport {
  const spawn = args.spawn ?? defaultSpawn;
  const [file, ...rest] = push ? args.argv : [...args.argv, args.first];
  if (file === undefined) throw new Error('session argv is empty');

  const child = spawn(file, rest, {
    cwd: args.cwd,
    ...(args.env === undefined ? {} : { env: args.env }),
  });

  if (screen !== undefined) {
    const feed = (chunk: Buffer | string): void => screen.write(chunk.toString());
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
  }

  const exited = new Promise<number | null>((settle) => {
    child.once('close', (code) => settle(code));
    // A spawn that fails (ENOENT on the binary) never emits `close`, and a
    // supervisor waiting on a promise that cannot settle hangs the whole run.
    child.once('error', () => settle(null));
  });

  return {
    write: (data) => {
      const stdin = child.stdin;
      if (stdin === null || stdin.destroyed) return;
      stdin.write(data);
    },
    exited,
    stop: () => {
      child.stdin?.end();
      child.kill();
    },
  };
}

const defaultSpawn: SpawnProcess = (file, argv, options) =>
  nodeSpawn(file, argv, {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
