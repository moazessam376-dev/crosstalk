import type { HarnessSession } from './session.js';
import type { ScreenSnapshot, ScrollbackPage } from './screen.js';

/**
 * The live sessions this process is supervising, keyed by seat.
 *
 * The hub's mirror needs two things the log cannot give it: what a seat's
 * terminal shows right now, and a way to type into it. Neither is protocol —
 * a screen is not an event and typing into a CLI is not `say` — so neither
 * belongs in the log, and putting them there would make the mirror a
 * participant in the conversation it is supposed to be watching.
 *
 * What makes this a registry rather than a global: `compose` may run from the
 * CLI, where nothing is watching and no registry exists, or from the daemon's
 * `/launch`, where the daemon's own registry is passed in. The seam is the
 * argument, so the CLI path costs nothing and the daemon path needs no
 * singleton.
 */
export interface SessionHandle {
  readonly id: string;
  screen(): ScreenSnapshot | undefined;
  /** A window onto what has scrolled off. `undefined` for an uncaptured seat. */
  scrollback(from: number, count: number): ScrollbackPage | undefined;
  /**
   * Re-shape the terminal to what the operator is looking at.
   *
   * Both halves or neither: the pty and the reconstructed screen have to agree
   * on geometry, and a mirror that disagreed with its pty would wrap text in
   * one place and not the other.
   */
  resize(rows: number, cols: number): void;
  send(turn: string): Promise<void>;
  key(bytes: string): Promise<void>;
  /** Told when the screen changes, so a watcher does not have to ask. */
  watch(onChange: () => void): () => void;
  readonly canPush: boolean;
  /** Set once the process has gone. A dead seat's last screen is still worth reading. */
  readonly exitCode: number | null | undefined;
  readonly running: boolean;
  /**
   * Kill the process, and *only* the process.
   *
   * No `git checkout`, no `clean`, no worktree removal. A seat that is stopped
   * mid-edit has uncommitted work in its worktree and that work is the
   * operator's — throwing it away because they wanted the board clear is a
   * different, much worse operation than the one they asked for.
   * `purgeWorkspaces` exists for that and is reachable only from `down
   * --purge`, where it is spelled out.
   */
  stop(): void;
  /** Settles with the exit code. Awaited with a timeout, never bare. */
  readonly exited: Promise<number | null>;
}

export class SessionRegistry {
  readonly #sessions = new Map<string, SessionHandle>();

  /**
   * Registering a seat also arms its own removal — or rather, deliberately does
   * not. An exited seat keeps its handle so the mirror can show the screen it
   * died on, which is the single most useful screen in the run and the one a
   * cleanup-on-exit registry would throw away first.
   */
  register(id: string, session: HarnessSession): SessionHandle {
    /**
     * Refusing to orphan a live pty.
     *
     * This was a bare `set`. Registering a second time over a running seat
     * dropped the only reference to the first process — nothing held it, and
     * `SessionHandle` had no `stop`, so it could not have been killed even
     * deliberately. It kept running, kept its worktree, and kept answering
     * `/await`, so two `driveSupervised` loops raced one `#delivered` cursor
     * and each took roughly half of what the other was owed.
     *
     * Overwriting a seat that has *exited* stays legal: keeping a dead seat's
     * handle is the deliberate choice made above, and re-seating that id is
     * exactly what starting a new run does.
     */
    const previous = this.#sessions.get(id);
    if (previous?.running === true) {
      throw new Error(`${id} is already running. End the current run before seating it again.`);
    }

    let exitCode: number | null | undefined;
    let running = true;
    void session.exited.then((code) => {
      exitCode = code;
      running = false;
    });

    const handle: SessionHandle = {
      id,
      screen: () => session.screen(),
      scrollback: (from, count) => session.scrollback(from, count),
      resize: (rows, cols) => session.resize(rows, cols),
      send: (turn) => session.send(turn),
      key: (bytes) => session.key(bytes),
      watch: (onChange) => session.watch(onChange),
      canPush: session.canPush,
      get exitCode() {
        return exitCode;
      },
      get running() {
        return running;
      },
      stop: () => session.stop(),
      exited: session.exited,
    };
    this.#sessions.set(id, handle);
    return handle;
  }

  get(id: string): SessionHandle | undefined {
    return this.#sessions.get(id);
  }

  ids(): string[] {
    return [...this.#sessions.keys()];
  }

  /** The seats with a process still behind them, in registration order. */
  live(): SessionHandle[] {
    return [...this.#sessions.values()].filter((session) => session.running);
  }

  get size(): number {
    return this.#sessions.size;
  }
}
