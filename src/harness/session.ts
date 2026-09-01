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

/** What a keyboard sends for Return. Not `\n`: that is Line Feed. */
const RETURN = '\r';

/**
 * The gap between typing a turn and pressing Return.
 *
 * A terminal UI that reads text and its Return in one chunk sees a *paste*, and
 * a Return inside a paste is a newline, not a submit. So the turn was typed and
 * never sent: the seat sat with the job in its composer, looking alive and
 * doing nothing — the exact failure the trailing newline was added to prevent,
 * arriving by the other door.
 *
 * Measured against three live Claude Code seats: one write of `text` + Return
 * never submitted once, and every board wake stacked another unsent copy into
 * the composer until it filled the screen. The same text followed by a separate
 * write of Return submitted every time.
 *
 * The number is a coalescing window, not a draw time — `readyDelayMs` is what
 * waits for the TUI to be ready. This only has to outlast the reads being
 * merged.
 */
export const SUBMIT_DELAY_MS = 250;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Raised instead of pressing Return at something that is not a composer.
 *
 * Named rather than silent because the two ways this can go wrong are both
 * things an operator has to be told: a seat that never gets its job, and a seat
 * that gets killed by the attempt.
 */
export class NotAtAPromptError extends Error {
  constructor(who: string) {
    super(`${who} is not at a prompt: it did not echo what was typed, so Return would answer whatever is on screen`);
    this.name = 'NotAtAPromptError';
  }
}

/**
 * Screens where Return means something other than "submit this turn".
 *
 * Heuristic, and deliberately so: there is no protocol for "the TUI is asking
 * you something", so the only signal is what it drew. These are the lines the
 * harnesses actually put on screen when they are waiting on a person — a
 * confirmation with a default, a trust prompt, a y/n. Matching one is treated
 * as "not at a prompt", which is the safe direction: the cost of a false match
 * is a turn delivered a few seconds late, and the cost of a miss is a seat
 * answering "No, exit" and dying before it has read its brief.
 */
const CONFIRMATION_SIGNATURES = [
  'enter to confirm',
  'esc to cancel',
  'do you trust',
  'yes, i accept',
  'no, exit',
  '(y/n)',
  'press enter to continue',
];

export function awaitingConfirmation(screenText: string): boolean {
  const flat = screenText.toLowerCase();
  return CONFIRMATION_SIGNATURES.some((signature) => flat.includes(signature));
}

/** How much of a turn has to be echoed back before Return is safe to press. */
const ECHO_PROBE = 24;

/**
 * How long to keep offering the opening job to a seat that is not at a prompt.
 *
 * Generous on purpose: the thing in the way is usually a confirmation only the
 * operator may answer, and they may be three tabs away. A seat that gets its
 * job four minutes late is a seat that works; one that gave up after five
 * seconds is a seat that has to be relaunched.
 */
const FIRST_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const FIRST_TURN_RETRY_MS = 4000;

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Whether what was just typed is actually on the screen.
 *
 * The Return that submits a turn is the same keystroke that answers a modal,
 * and a seat does not always come up at a composer: Claude Code opens on a
 * bypass-permissions confirmation whose default option is **No, exit**. Typing
 * a job at a fixed delay and pressing Return into that selects "No, exit", and
 * the seat is gone before it has read a line of its brief — measured, three
 * seats at once, all `exited 1`.
 *
 * So look first. If the text came back on the screen, there is a text field
 * under the cursor and Return submits it. If it did not, this is a dialog, a
 * pager, a splash — something where Return means something else — and the
 * caller is told rather than guessing.
 *
 * A prefix, not the whole turn: a brief is longer than the screen is wide and
 * wraps, and the composer scrolls once it is deeper than its box.
 */
export function showsTyped(screen: Screen, typed: string): boolean {
  const needle = flatten(typed).slice(0, ECHO_PROBE);
  if (needle === '') return true;
  return flatten(screen.text()).includes(needle);
}

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
  /** Interactive only: the gap between typing a turn and pressing Return. */
  submitDelayMs?: number;
  /** Interactive only: how long to keep offering the opening job. */
  readyTimeoutMs?: number;
  /** Told when the opening job could not be delivered, so nothing is silent. */
  onStuck?: (message: string) => void;
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
    if (!interactive) {
      transport.write(frame(turn));
      return;
    }
    // A terminal takes typing, not envelopes — and the Return that submits it
    // has to arrive as its own keystroke. See SUBMIT_DELAY_MS.
    const who = args.argv[0] ?? 'the seat';
    // Look before typing. A seat that is waiting on a confirmation is not a
    // seat that is waiting for a turn, and letters at a menu are keystrokes.
    if (screen !== undefined && awaitingConfirmation(screen.text())) {
      throw new NotAtAPromptError(who);
    }
    const typed = turn.replace(/\n/g, ' ');
    transport.write(typed);
    await pause(args.submitDelayMs ?? SUBMIT_DELAY_MS);
    // And look again before pressing Return, because a dialog can draw itself
    // in between: at start-up the composer accepts the text, the confirmation
    // paints over it, and Return then answers *that*. Checking only that the
    // text was echoed passes in exactly that case — measured, three seats,
    // every launch, all `exited 1` two seconds in.
    if (screen !== undefined && (awaitingConfirmation(screen.text()) || !showsTyped(screen, typed))) {
      throw new NotAtAPromptError(who);
    }
    transport.write(RETURN);
  };

  // An interactive session has to finish drawing before it will accept input,
  // and drawing is not the only thing it might be doing: Claude Code opens on a
  // confirmation nobody but the operator may answer. So the opening job is
  // offered until the seat is actually at a prompt, rather than fired once at a
  // guess of a delay — which is how the job used to land in a dialog.
  if (interactive) {
    void (async () => {
      await pause(args.readyDelayMs ?? 4000);
      const deadline = Date.now() + (args.readyTimeoutMs ?? FIRST_TURN_TIMEOUT_MS);
      for (;;) {
        try {
          await send(args.first);
          return;
        } catch (error) {
          if (!(error instanceof NotAtAPromptError)) throw error;
          if (Date.now() >= deadline) {
            // Never silent. A seat that never got its job looks exactly like a
            // seat ignoring the room, and that ambiguity is the thing this
            // project exists to remove.
            args.onStuck?.(
              'is waiting on something on its own screen — its job has not been delivered. Open its terminal in the hub and answer it.',
            );
            return;
          }
          await pause(FIRST_TURN_RETRY_MS);
        }
      }
    })();
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
