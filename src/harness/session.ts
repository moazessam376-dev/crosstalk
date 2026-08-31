import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

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
  /** Whether `send` does anything. False for a harness that reads its prompt once. */
  readonly canPush: boolean;
  readonly exited: Promise<number | null>;
  stop(): void;
}

/**
 * A pty, because Claude Code decides it is non-interactive by looking at its
 * own stdin.
 *
 * Spawned from an ordinary background process, `claude --remote-control` exits
 * immediately with "Input must be provided either through stdin or as a prompt
 * argument when using --print" — with no terminal it falls back to print mode,
 * and Remote Control has nothing to attach to. `script` allocates a pty and
 * hands it over, which is the whole trick. It is in every BSD and macOS base
 * system, so it costs no dependency.
 *
 * `-q` suppresses the transcript header; `/dev/null` throws the typescript
 * away, since the seat's own log is what anyone reads.
 */
export function underPty(argv: string[]): string[] {
  return ['script', '-q', '/dev/null', ...argv];
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
  /** Interactive only: how long to let the TUI draw before typing the job. */
  readyDelayMs?: number;
}): HarnessSession {
  const spawn = args.spawn ?? defaultSpawn;
  const interactive = args.turnFormat === 'interactive';
  const push = args.turnFormat === 'stream-json' || interactive;

  // An interactive seat is a terminal, so its argv is wrapped in a pty and the
  // job is typed rather than appended. Appending it would put the whole brief
  // on the command line of a session that is about to render a prompt box.
  const base = interactive ? underPty(args.argv) : args.argv;
  const [file, ...rest] = push ? base : [...base, args.first];
  if (file === undefined) throw new Error('session argv is empty');

  const child = spawn(file, rest, {
    cwd: args.cwd,
    ...(args.env === undefined ? {} : { env: args.env }),
  });

  const exited = new Promise<number | null>((settle) => {
    child.once('close', (code) => settle(code));
    // A spawn that fails (ENOENT on the binary) never emits `close`, and a
    // supervisor waiting on a promise that cannot settle hangs the whole run.
    child.once('error', () => settle(null));
  });

  const send = async (turn: string): Promise<void> => {
    if (!push) {
      throw new Error(`${file} cannot take a turn after it starts`);
    }
    const stdin = child.stdin;
    if (stdin === null || stdin.destroyed) return;
    // A terminal takes typing, not envelopes. The trailing newline is the
    // Return that submits it; without it the text sits in the composer and the
    // seat looks alive while doing nothing.
    const payload = interactive ? `${turn.replace(/\n/g, ' ')}\n` : frame(turn);
    await new Promise<void>((done, fail) => {
      stdin.write(payload, (error) => (error ? fail(error) : done()));
    });
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
    canPush: push,
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
