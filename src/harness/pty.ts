import { createRequire } from 'node:module';

/**
 * A real pseudo-terminal, because an interactive CLI will not run without one
 * and there is no way to fake it from a pipe.
 *
 * ## Why not `script`
 *
 * This module replaces `script -q /dev/null …`, which was the obvious
 * dependency-free trick and does not work. `script` calls `tcgetattr` on *its
 * own* stdin, and a daemon spawning it has only a pipe to offer:
 *
 * ```
 * script: tcgetattr/ioctl: Operation not supported on socket
 * ```
 *
 * Measured, not inferred — that is the exact stderr from `spawn('script', …,
 * {stdio: ['pipe', …]})` on this machine. The reason it looked fine when tried
 * by hand is that a hand test runs from a terminal, where stdin *is* a tty. So
 * the trick worked in every check that was made and in none of the conditions
 * it would actually run under, which is the most expensive shape a bug has.
 *
 * Nothing writable can be substituted: `script` wants a character device, and a
 * socketpair and a FIFO both fail the same way. `/dev/null` satisfies it and
 * gives up the input path — and the input path is the whole feature, since it
 * is how a job reaches the seat and how the operator types into it.
 *
 * ## What this costs
 *
 * A native dependency, loaded lazily so that nothing which never opens an
 * interactive seat pays for it. When it is missing the failure is loud and
 * names the fix: a seat that silently degrades to a mode where Remote Control
 * has nothing to attach to is the same defect in a new place.
 */
export interface PtyProcess {
  write(data: string): void;
  onData(handler: (chunk: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  /** The pty's window size. A TUI redraws to it, so the mirror stays faithful. */
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpec {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export type SpawnPty = (spec: PtySpec) => PtyProcess;

/** The shape of `node-pty` this module uses, so nothing here needs its types. */
interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): {
    write(data: string): void;
    onData(handler: (chunk: string) => void): unknown;
    onExit(handler: (event: { exitCode: number }) => void): unknown;
    resize(cols: number, rows: number): void;
    kill(): void;
  };
}

const require = createRequire(import.meta.url);
let cached: NodePty | undefined;

export class PtyUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `interactive seats need a pseudo-terminal and node-pty could not be loaded: ${cause}. ` +
        'Run `npm install` in the crosstalk checkout. If it is installed and still failing, ' +
        'node-pty 1.1.0 publishes its spawn-helper without the executable bit — ' +
        '`chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` — which the postinstall script does.',
    );
    this.name = 'PtyUnavailableError';
  }
}

function loadNodePty(): NodePty {
  if (cached !== undefined) return cached;
  try {
    cached = require('node-pty') as NodePty;
    return cached;
  } catch (error) {
    throw new PtyUnavailableError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * `TERM` names the terminal the reconstructed screen implements, so the harness
 * is never told it may use sequences the mirror does not parse.
 */
export const PTY_TERM = 'xterm-256color';

/**
 * Markers a seat must not inherit from whoever started the daemon.
 *
 * A seat is its own agent, not a sub-agent of the operator's session. When the
 * daemon is itself launched from inside a CLI harness, that harness's session
 * markers are in `process.env` and every seat picks them up — and Claude Code,
 * seeing one, turns transcript saving off, because it believes it is a child
 * whose transcript belongs to a parent. Measured on the first hub-launched
 * team: three seats ran a whole phase with no transcript on disk to review.
 */
export const INHERITED_SESSION_MARKERS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID'] as const;

/** The environment a seat runs in: the operator's, minus what it must not inherit. */
export function seatEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, TERM: PTY_TERM };
  for (const marker of INHERITED_SESSION_MARKERS) delete out[marker];
  return out;
}

export const spawnPty: SpawnPty = (spec) => {
  const child = loadNodePty().spawn(spec.file, spec.args, {
    name: PTY_TERM,
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: seatEnv(spec.env ?? process.env) as NodeJS.ProcessEnv,
  });
  return {
    write: (data) => child.write(data),
    onData: (handler) => void child.onData(handler),
    onExit: (handler) => void child.onExit(({ exitCode }) => handler(exitCode)),
    resize: (cols, rows) => child.resize(cols, rows),
    kill: () => child.kill(),
  };
};
