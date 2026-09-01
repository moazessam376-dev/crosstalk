import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveHubDist, sendHubMissing, serveAsset } from './hub.js';
import type { AddressInfo } from 'node:net';

import type { CrosstalkConfig } from '../contracts/config.js';
import type { CrosstalkEvent, DraftEvent, EventKind } from '../contracts/events.js';
import { refuseOversizeBody } from '../contracts/events.js';
import { ProtocolError } from '../contracts/errors.js';
import type { ParticipantId } from '../contracts/participant.js';
import { FLOOR, HUMAN_ID } from '../contracts/room.js';
import { EventLog } from '../core/log.js';
import { renderInbox, type Inbox } from '../core/inbox.js';
import { phaseStatus, type PhaseStatus } from '../core/phase.js';
import { SHAPES, shapeNamed } from '../core/shape.js';
import { workspaceGates } from '../workspace/gates.js';
import { seatBranches } from '../workspace/git.js';
import { applyEvent, project, type HubState } from '../core/projection.js';
import { LadderTimers, SYSTEM_ID, expireRung, testRungReason } from './ladder.js';
import { STALENESS_POLL_MS, checkStaleness } from './staleness.js';
import { workspaceWarning } from './workspace.js';
import { Presence } from './presence.js';
import { SessionRegistry, type SessionHandle } from '../harness/sessions.js';
import { discoverModels } from '../harness/models.js';
import { configureGithub } from '../cli/github.js';
import { currentRungOf } from '../core/decisions.js';
import { dmId, normaliseRoom } from '../core/rooms.js';
import { refuseMessage, type MessageDraft } from '../core/says.js';
import { isMessageTag } from '../contracts/say.js';

import {
  DAEMON_STATUS,
  DERIVED_AUTHOR_FIELDS,
  DIRECTLY_APPENDABLE,
  EVENT_KIND_ROUTE,
  PROTOCOL_STATUS,
  type EventsResponse,
  type WireError,
  type WriteResponse,
} from './contract.js';
import {
  acknowledgeTask,
  addEvidence,
  addressesParticipant,
  assignTask,
  board,
  castVote,
  proposeTest,
  createTask,
  myTasks,
  openDecision,
  raiseClaim,
  requireRoomMembership,
  respondToClaim,
  roster,
  setTaskState,
  submitTask,
  type HandlerContext,
} from './handlers.js';
import { loadConfig } from './config.js';
import { acquireLock, recordLockUrl, releaseLock } from './lock.js';
import { isBlockedPort, NoUsablePortError, pickUsablePort } from './ports.js';
import { DaemonError } from './errors.js';
import { probeCliHarnesses } from '../harness/path.js';
import { loadRegistry } from '../harness/registry.js';

/**
 * The default interface. Never `localhost`: it resolves to `::1` first on
 * Windows, which strands IPv4 clients on a server that started fine.
 *
 * That is an argument about the *name*, and it survives `--host` (CT-14a):
 * the interface became settable, the spelling did not.
 */
const HOST = '127.0.0.1';

/**
 * Why binding this interface is worth saying out loud, or `undefined` for one
 * that needs no warning.
 *
 * The whole 127/8 block is loopback, not just `127.0.0.1` — `127.0.0.53` is
 * where systemd-resolved lives and it never leaves the machine either.
 */
export function exposureWarning(host: string): string | undefined {
  const loopback = host === '::1' || host === 'localhost' || /^127\./.test(host);
  if (loopback) return undefined;

  return `Serving on ${host}, which is not loopback: anyone who can reach this machine can reach the hub. The token in the URL is the only thing guarding it, so treat that URL as the credential it is.`;
}
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LIMIT = 1000;
/** Spec §6.2: return by ~50s regardless of the requested timeout, to stay inside harness tool timeouts. */
const AWAIT_CAP_S = 50;
/** Contract §6. Long enough to be cheap, short enough to beat an idle reaper. */
const HEARTBEAT_MS = 15_000;

/**
 * The most scrolled-off lines one request will return.
 *
 * A whole 5,000-line buffer is about half a megabyte of JSON, and a reader
 * scrolling up wants the screenful it is about to show, not the session. The
 * page is generous enough that a fast flick does not stutter and small enough
 * that no single response is worth streaming.
 */
const SCROLLBACK_PAGE = 500;

/**
 * The shortest gap between two screen frames on the wire.
 *
 * A TUI repaints far faster than anyone can read, and a stream with no floor
 * would put every intermediate frame of a spinner on the socket. At 40ms the
 * mirror is quicker than the eye and the traffic is bounded: measured against a
 * repainting full-screen app, 3.3 KB/sec for the one seat whose panel is open.
 *
 * This is the number the old design was afraid of, and it was right to be — it
 * rejected streaming *pty bytes*, which is tens of kilobytes a second of escape
 * sequences. Streaming the reconstruction instead is an order of magnitude
 * cheaper, and it is the difference between a keystroke landing in 3ms and in
 * the 1,009ms that was measured through the poll.
 */
const SCREEN_FRAME_MS = 40;

export interface DaemonHandle {
  url: string;
  /** The interface actually bound, which `url` does not always reveal. */
  host: string;
  /** One per participant — spec §6.1. A single shared token makes `from` self-asserted. */
  tokens: ReadonlyMap<ParticipantId, string>;
  /**
   * The CLI sessions this daemon is mirroring.
   *
   * Exposed so a test can put a real process behind `/sessions/:id/screen`
   * without launching a team, and so an embedder that spawns seats its own way
   * can register them. `/launch` registers into this same one.
   */
  sessions: SessionRegistry;
  /**
   * Re-read the roster and its tokens after something has rewritten them.
   *
   * `/launch` calls this itself; it is on the handle so an embedder that
   * staffs a team its own way can too, and so a test can prove a seat added
   * after startup can actually authenticate.
   */
  reload(): Promise<void>;
  close(): Promise<void>;
}

/**
 * What the hub can learn about the GitHub mirror.
 *
 * Not an event, and deliberately. The mirror has no write path into the log and
 * that is what makes "mirror failure never blocks the protocol" structural
 * rather than a discipline (`mirror/index.ts`). Reporting its health through a
 * route keeps the one-way street intact.
 */
export interface MirrorStatus {
  /** A `mirror:` block exists in the config. Absent is a gap, not a failure. */
  configured: boolean;
  /** It started and is running. False when `gh` or a credential is missing. */
  enabled: boolean;
  lastDrain?: { completed: number; retrying: number };
  lastError?: string;
}

export interface StartDaemonOptions {
  repo: string;
  port?: number;
  /**
   * Read per request, never captured: `up` starts the daemon before the mirror,
   * because the mirror consumes the daemon's `/stream`. A snapshot taken here
   * would report `enabled: false` forever.
   */
  mirrorStatus?: () => MirrorStatus;
  /**
   * The interface to bind. Defaults to loopback and should stay there: the hub
   * carries the whole conversation and a bearer token is all that guards it.
   * CT-14a — the operator wanted to check the hub from a phone and there was no
   * supported way, so every workaround was a proxy in front of a server that
   * could have bound the interface itself.
   */
  host?: string;
  /** Overrides where the built hub is read from. Defaults beside the package's own code. */
  hubDist?: string;
}

export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonHandle> {
  const repo = resolve(opts.repo);
  const host = opts.host ?? HOST;
  const config = await loadConfig(repo);

  const stateDir = join(repo, '.crosstalk');
  const lockPath = join(stateDir, 'daemon.lock');
  const daemonJsonPath = join(stateDir, 'daemon.json');

  await mkdir(join(stateDir, 'tokens'), { recursive: true });
  await acquireLock(lockPath);

  let log: EventLog | undefined;
  let server: Server | undefined;
  try {
    const tokens = await loadOrMintTokens(config, stateDir);
    log = await EventLog.open(join(stateDir, 'events.jsonl'));

    const daemon = new Daemon(
      config,
      tokens,
      log,
      opts.hubDist ?? resolveHubDist(import.meta.url),
      opts.repo,
      ...(opts.mirrorStatus === undefined ? [] : [opts.mirrorStatus]),
    );
    await daemon.init();
    server = createServer((request, response) => {
      void daemon.handle(request, response);
    });
    const url = await listen(server, host, opts.port);

    await writeFile(
      daemonJsonPath,
      JSON.stringify({ version: 1, url, pid: process.pid, startedAt: new Date().toISOString() }),
      { encoding: 'utf8', mode: 0o600 },
    );
    await recordLockUrl(lockPath, url);

    return buildHandle({ url, host, tokens, server, daemon, lockPath, daemonJsonPath });
  } catch (error) {
    // Never leave a lock behind for a daemon that failed to start.
    server?.close();
    await log?.close().catch(() => {});
    await releaseLock(lockPath);
    throw error;
  }
}

function buildHandle(parts: {
  url: string;
  host: string;
  tokens: Map<ParticipantId, string>;
  server: Server;
  daemon: Daemon;
  lockPath: string;
  daemonJsonPath: string;
}): DaemonHandle {
  const { url, host, tokens, server, daemon, lockPath, daemonJsonPath } = parts;

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await daemon.drainWaiters();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await daemon.close();
      await unlink(daemonJsonPath).catch(() => {});
      await releaseLock(lockPath);
    })();
    return closed;
  };

  // SIGTERM is not delivered on Windows the way it is elsewhere, so shutdown
  // handles signals *and* POST /shutdown, and relies on neither arriving.
  const onSignal = (): void => {
    void close();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  daemon.onShutdownRequest = close;

  return { url, host, tokens, sessions: daemon.sessions, reload: () => daemon.reload(), close };
}

function bindOnce(server: Server, host: string, port: number): Promise<number> {
  return new Promise((done, fail) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        fail(new DaemonError('PORT_IN_USE', `Port ${port} is already bound`));
        return;
      }
      // A `--host` this machine has no interface for. Left raw, it exits with a
      // stack trace naming EADDRNOTAVAIL, which says nothing about the flag the
      // operator just typed.
      if (error.code === 'EADDRNOTAVAIL' || error.code === 'ENOTFOUND' || error.code === 'EINVAL') {
        fail(new DaemonError(
          'HOST_UNAVAILABLE',
          `No interface on this machine has the address ${host}. Use 127.0.0.1 for loopback, 0.0.0.0 for every interface, or one of this machine's own addresses.`,
        ));
        return;
      }
      fail(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      done((server.address() as AddressInfo).port);
    };

    // `once` on both, each removing the other: a retry re-enters this function
    // on the same server object, and a listener left behind from a previous
    // attempt would settle the wrong promise.
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Binds, refusing to hand back a port `fetch` and browsers will not connect to.
 *
 * An explicit `--port` is honoured or rejected, never silently moved: someone
 * who asked for a specific port and got a different one has a worse problem
 * than an error message. Only an ephemeral bind retries. See `ports.ts`.
 */
async function listen(server: Server, host: string, port?: number): Promise<string> {
  // The url is what a person clicks, so it names an address a browser can
  // actually reach. A wildcard bind is not one: `http://0.0.0.0:7411` is a
  // valid thing to listen on and a poor thing to hand someone, and loopback is
  // included in every wildcard bind anyway.
  const reachable = host === '0.0.0.0' || host === '::' ? HOST : host;
  const shown = reachable.includes(':') ? `[${reachable}]` : reachable;

  if (port !== undefined) {
    if (isBlockedPort(port)) {
      throw new DaemonError(
        'PORT_BLOCKED',
        `Port ${port} is on the WHATWG blocked-port list, so browsers and fetch refuse it even though a server can bind it. Choose another port.`,
      );
    }
    return `http://${shown}:${await bindOnce(server, host, port)}`;
  }

  try {
    const assigned = await pickUsablePort(
      () => bindOnce(server, host, 0),
      () => new Promise<void>((closed) => server.close(() => closed())),
    );
    return `http://${shown}:${assigned}`;
  } catch (error) {
    if (error instanceof NoUsablePortError) {
      throw new DaemonError('PORT_BLOCKED', error.message);
    }
    throw error;
  }
}

/**
 * Reuses a token already on disk, minting only what is missing.
 *
 * `crosstalk init` writes tokens and embeds one of them in `.mcp.json`, which
 * is static. Re-minting on every start would invalidate that file the second
 * time anyone runs `crosstalk up`, and the agent whose token went stale would
 * see its tools fail with a 401 it had no way to explain.
 */
async function loadOrMintTokens(
  config: CrosstalkConfig,
  stateDir: string,
): Promise<Map<ParticipantId, string>> {
  const tokens = new Map<ParticipantId, string>();
  for (const participant of config.participants) {
    const path = join(stateDir, 'tokens', tokenFilename(participant.id));
    const existing = await readFile(path, 'utf8').then((raw) => raw.trim()).catch(() => '');
    if (existing !== '') {
      tokens.set(participant.id, existing);
      continue;
    }

    const token = randomBytes(32).toString('hex');
    tokens.set(participant.id, token);
    await writeFile(path, token, {
      encoding: 'utf8',
      // A no-op on Windows. `doctor` says so rather than claiming a protection we do not have.
      mode: 0o600,
    });
  }
  return tokens;
}

/**
 * `@human` is a legal ParticipantId but PARTICIPANT_ID_PATTERN rejects it, so
 * the '@' is stripped for the filename and `doctor` reserves the plain id
 * `human` — otherwise a participant named `human` silently shares the human's
 * credential, which is two participants behind one token all over again.
 */
export function tokenFilename(id: ParticipantId): string {
  return id.startsWith('@') ? id.slice(1) : id;
}

interface Subscriber {
  response: ServerResponse;
  heartbeat: NodeJS.Timeout;
}

interface Waiter {
  who: ParticipantId;
  resolve(events: CrosstalkEvent[]): void;
  timer: NodeJS.Timeout;
}

class Daemon {
  onShutdownRequest: (() => Promise<void>) | undefined;

  /**
   * Not `readonly`: the hub can staff a team after the daemon is up.
   *
   * A roster used to be fixed at startup, which made the launcher's picker
   * decorative — you could choose seats in the browser and the only thing that
   * could happen was a refusal, because tokens are minted from this. `reload`
   * replaces both together, so a roster written by `/launch` is a roster this
   * daemon can actually authenticate.
   */
  #config: CrosstalkConfig;
  #byToken: Map<string, ParticipantId>;
  readonly #log: EventLog;
  readonly #hubDist: string;
  #state: HubState;
  /** In-flight joins, not a done-set: concurrent first requests must all wait on the same append. */
  readonly #joins = new Map<ParticipantId, Promise<CrosstalkEvent[]>>();
  readonly #waiters = new Set<Waiter>();
  readonly #subscribers = new Set<Subscriber>();
  readonly #delivered = new Map<ParticipantId, number>();

  /**
   * Where a seat starts reading when nobody has told it anything yet.
   *
   * Not zero. `#delivered` lives in memory and starts empty, so a seat's first
   * poll used to be answered with *the entire log* — every message from every
   * previous run in that repository, handed over as "new since your last turn"
   * and typed into its composer as one turn. The board is append-only and kept
   * across runs by design (`down` says so), so this got worse every restart:
   * thirty-eight events on the fourth launch of the night, none of them from a
   * conversation that seat was in.
   *
   * A seat cannot have missed what was said before it existed. The floor of a
   * fresh run is the head of the log, and `/launch` moves it there again for
   * everyone, because a launch is a new run and nobody in it is behind.
   */
  #floorSeq = 0;
  #writeTail: Promise<unknown> = Promise.resolve();
  /** Serializes whole write handlers, not just appends — see the call site. */
  #handlerTail: Promise<unknown> = Promise.resolve();
  /**
   * Rung timers. Driven by appended events, so every path that enters a rung
   * arms one without each caller having to remember.
   */
  readonly #ladderTimers = new LadderTimers((decisionId, reason) => {
    void this.#expireRung(decisionId, reason);
  });
  #stalenessPoll: ReturnType<typeof setInterval> | undefined;
  /** One sweep at a time: two overlapping ones both read state before either's
   *  marks land, and emit the same `evidence_stale` twice. */
  #sweeping: Promise<void> | undefined;
  /** Keyed by participant and reported cwd. Empty string means "checked, nothing wrong". */
  readonly #workspaceWarnings = new Map<string, string>();
  readonly #presence = new Presence();
  /**
   * The CLI sessions this daemon started, so the hub can mirror them.
   *
   * Only seats launched from here appear: a seat someone started in their own
   * terminal has no pipe into this process, and reporting it as mirrorable
   * would be the "control that cannot work" defect all over again. `/sessions`
   * says which is which.
   */
  readonly #sessions = new SessionRegistry();

  /** The mirror registry, so `startDaemon` can hand it to whoever spawns seats. */
  get sessions(): SessionRegistry {
    return this.#sessions;
  }

  /** Absolute path to the clone. `config.project.repo` is relative to the config file. */
  readonly #repo: string;

  /** Defaults to "nothing configured", which is the truth until `up` says otherwise. */
  readonly #mirrorStatus: () => MirrorStatus;

  constructor(
    config: CrosstalkConfig,
    tokens: Map<ParticipantId, string>,
    log: EventLog,
    hubDist: string,
    repo: string,
    mirrorStatus: () => MirrorStatus = () => ({ configured: false, enabled: false }),
  ) {
    this.#config = config;
    this.#log = log;
    this.#hubDist = hubDist;
    this.#repo = repo;
    this.#mirrorStatus = mirrorStatus;
    this.#byToken = new Map([...tokens].map(([id, token]) => [token, id]));
    this.#state = project([]);
  }

  /**
   * Re-read the roster and its tokens from disk.
   *
   * Called after `/launch` writes a new one. Deliberately narrow: the log, the
   * projection, presence and every open subscriber are untouched, because none
   * of them depend on who is seated — the projection is derived from events and
   * presence is keyed by id. What changes is who may authenticate and who the
   * roster reports, which is exactly what staffing a team changes.
   *
   * Token minting is additive (`runInit` keeps any file that already exists),
   * so a seat that was already here keeps the token it has been using and its
   * open connections stay valid.
   */
  async reload(): Promise<void> {
    const config = await loadConfig(this.#repo);
    const tokens = await loadOrMintTokens(config, join(resolve(this.#repo), '.crosstalk'));
    this.#config = config;
    this.#byToken = new Map([...tokens].map(([id, token]) => [token, id]));
  }

  async init(): Promise<void> {
    const log = await this.#log.read();
    this.#state = project(log);
    // Everything already on the board happened before this daemon existed, so
    // it is history, not a backlog. See `#floorSeq`.
    this.#floorSeq = this.#log.lastSeq;
    // A daemon restarted mid-rung picks the clock back up from the last
    // `rung_entered`; one restarted past the deadline advances immediately
    // rather than losing the rung.
    this.#ladderTimers.rearm(log, this.#state, this.#config, Date.now());

    // A merge that landed while the daemon was down is the common case and
    // nothing else will notice it.
    await this.#sweepStaleness();
    // Crosstalk does not own the user's git and cannot hook their merges, so
    // it polls. Unref'd, or close() waits on the timer.
    this.#stalenessPoll = setInterval(() => {
      void this.#sweepStaleness();
    }, STALENESS_POLL_MS);
    if (typeof this.#stalenessPoll.unref === 'function') this.#stalenessPoll.unref();
  }

  /**
   * Re-evaluate evidence against the main branch.
   *
   * Never throws: `checkStaleness` rejects when `mainBranch` is not a branch of
   * the clone, and an unhandled rejection inside a timer takes the daemon with
   * it. A repo we cannot read is a reason to stay quiet, not to die.
   */
  async #sweepStaleness(): Promise<void> {
    if (this.#sweeping !== undefined) return this.#sweeping;

    const daemon = this;
    const sweep = (async () => {
      try {
        await checkStaleness({
          repo: daemon.#repo,
          mainBranch: daemon.#config.project.mainBranch,
          who: SYSTEM_ID,
          // A getter, so a sweep that awaits a git call still sees the state
          // its own appends produced.
          get state(): HubState {
            return daemon.#state;
          },
          append: (draft: DraftEvent) => daemon.#append(draft),
        });
      } catch {
        // Reported nowhere on purpose: a poll that logged on every tick in a
        // repo without the branch would drown the console. The next sweep
        // retries in 30s.
      } finally {
        daemon.#sweeping = undefined;
      }
    })();
    this.#sweeping = sweep;
    return sweep;
  }

  /**
   * Anything the caller should know about its own process, not its request.
   *
   * Cached by (participant, cwd): the answer only changes when a process moves,
   * and the check walks the filesystem. A long-poll that re-canonicalises a
   * path every 50s for the life of a session is waste nobody asked for.
   */
  async #processWarnings(who: ParticipantId, request: IncomingMessage): Promise<string[]> {
    // Percent-encoded by the client, because a path is not guaranteed to be
    // Latin-1 and header values are. Decoded defensively: a malformed value is
    // a reason to say nothing, not to fail the request it rode in on.
    const raw = headerValue(request, 'x-crosstalk-cwd');
    if (raw === undefined) return [];
    let cwd: string;
    try {
      cwd = decodeURIComponent(raw);
    } catch {
      return [];
    }

    const key = `${who}\u0000${cwd}`;
    let warning = this.#workspaceWarnings.get(key);
    if (warning === undefined) {
      warning = (await workspaceWarning(this.#config, this.#repo, who, cwd)) ?? '';
      this.#workspaceWarnings.set(key, warning);
    }
    return warning === '' ? [] : [warning];
  }

  /** A rung ran out of time. No request is in flight, so the daemon signs it. */
  async #expireRung(decisionId: string, reason: string): Promise<void> {
    try {
      const decision = this.#state.decisions.get(decisionId);
      const current = decision === undefined ? undefined : currentRungOf(decision, this.#state);
      // `discriminating_test` says *why* it failed rather than only that it
      // did: the ledger charges a missing test to the side that owed it.
      const actual =
        current?.rung === 'discriminating_test' && decision !== undefined
          ? testRungReason(this.#ladderTimers.proposalsFor(decisionId), decision, this.#state)
          : reason;
      await expireRung(this.#context(SYSTEM_ID), decisionId, actual);
    } catch {
      // A failed escalation must not take the daemon down with it; the rung
      // stays where it is and the next response re-evaluates.
    }
  }

  /** Resolves every pending long poll so close() cannot hang on a 50s timer. */
  async drainWaiters(): Promise<void> {
    for (const subscriber of [...this.#subscribers]) {
      clearInterval(subscriber.heartbeat);
      this.#subscribers.delete(subscriber);
      subscriber.response.end();
    }
    for (const waiter of [...this.#waiters]) {
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve([]);
    }
  }

  async close(): Promise<void> {
    this.#ladderTimers.stop();
    if (this.#stalenessPoll !== undefined) clearInterval(this.#stalenessPoll);
    await this.#writeTail.catch(() => {});
    await this.#log.close();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.#route(request, response);
    } catch (error) {
      this.#fail(response, error);
    }
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${HOST}`);
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (path === '/health' && method === 'GET') {
      // The only unauthenticated route that answers with data, and it carries
      // nothing from the log.
      send(response, 200, { ok: true, version: 1, pid: process.pid });
      return;
    }

    if (method === 'GET' && await this.#serveFrontDoor(url, path, response)) return;

    const who = this.#authenticate(request);
    // Every authenticated response says who the caller turned out to be, so the
    // MCP layer can attach it to every tool result without each tool
    // remembering to. An agent whose harness found the wrong `.mcp.json` can
    // then detect that in its first call rather than after a human notices the
    // message bodies disagree with the `from` field.
    response.setHeader('x-crosstalk-you', who);
    // Presence is "heard from recently", not "has ever spoken". Stamped on
    // every authenticated request, including this one.
    this.#presence.touch(who, Date.now());
    // CT-9. The harness reports where it actually is; the daemon is the only
    // party that knows where the config says it should be.
    const warnings = await this.#processWarnings(who, request);
    if (warnings.length > 0) {
      // Percent-encoded, and not optional: header values are Latin-1, and this
      // message contains an em-dash. `setHeader` throws ERR_INVALID_CHAR on it,
      // which 500s the request — and a 500 has no `warnings` in its body, so
      // the "stays quiet" tests passed against the failure while the one that
      // asserted the warning was the only one that noticed.
      response.setHeader('x-crosstalk-warning', warnings.map(encodeURIComponent).join(','));
    }
    const joined = await this.#ensureJoined(who);
    const ctx = this.#context(who);

    // Reads first: none of them append.
    if (path === '/config.json' && method === 'GET') {
      // The hub learns who it is from the cookie it was bootstrapped with,
      // rather than from anything baked into the bundle at build time.
      //
      // `maxRounds` for the same reason: the round counter is a fact about this
      // project's policy, and the hub hard-coded 3 in two places that then
      // disagreed with each other. Served, never assumed.
      send(response, 200, {
        version: 1,
        self: who,
        streamUrl: '/stream',
        room: FLOOR,
        maxRounds: this.#config.policy.dispute.maxRounds,
      });
      return;
    }
    if (path === '/mirror' && method === 'GET') {
      // Called, not read: `up` starts the daemon before the mirror, so a value
      // captured at construction reports `enabled: false` for the life of the
      // process — indistinguishable from a mirror that failed to start.
      //
      // `configured` comes from the config rather than from that callback,
      // because the two answer different questions. Whether a `mirror:` block
      // exists is a fact about the file, which this daemon reloads; whether the
      // mirror is *running* is a fact about a process started before the block
      // could have been written from the hub. Reading both from the runtime
      // callback meant configuring the mirror here left the rail still saying
      // "no mirror configured" until a restart.
      const runtime = this.#mirrorStatus();
      send(response, 200, {
        ...runtime,
        configured: runtime.configured || this.#config.mirror?.github !== undefined,
      });
      return;
    }
    if (path === '/mirror' && method === 'POST') {
      // The one config write the hub can make, and the reason nobody ever
      // configured the mirror: it was a YAML block with no documented shape and
      // no route, so `crosstalk github <url>` from a terminal was the only door
      // and the hub could not offer the field at all.
      if (who !== HUMAN_ID) {
        send(response, 403, wire('daemon', 'ROLE_NOT_PERMITTED', 'configuring the mirror is the human seat'));
        return;
      }
      const payload = (await readJsonBody(request)) as { url?: unknown; login?: unknown };
      if (typeof payload.url !== 'string' || payload.url.trim() === '') {
        send(response, 400, wire('daemon', 'MALFORMED_BODY', 'send `url` — a GitHub repository to mirror to'));
        return;
      }
      try {
        const configured = await configureGithub({
          repo: this.#repo,
          url: payload.url,
          ...(typeof payload.login === 'string' && payload.login.trim() !== ''
            ? { login: payload.login.trim() }
            : {}),
        });
        // Re-read, so `GET /mirror` stops saying unconfigured without a restart.
        await this.reload();
        send(response, 200, {
          repo: `${configured.repo.owner}/${configured.repo.repo}`,
          remote: configured.remote,
          humanLogin: configured.humanLogin,
        });
      } catch (error) {
        send(
          response,
          400,
          wire('daemon', 'MALFORMED_BODY', error instanceof Error ? error.message : 'could not configure the mirror'),
        );
      }
      return;
    }
    if (path === '/events' && method === 'GET') {
      send(response, 200, await this.#readEvents(url));
      return;
    }
    if (path === '/stream' && method === 'GET') {
      await this.#openStream(request, response, url);
      return;
    }
    if (path === '/await' && method === 'GET') {
      send(response, 200, await this.#awaitTurn(who, url));
      return;
    }
    if (path === '/inbox' && method === 'GET') {
      send(response, 200, await this.#inboxTurn(who, url));
      return;
    }
    if (path === '/harnesses' && method === 'GET') {
      // Availability *and* what each harness can be put on. The launcher used
      // to carry its own hard-coded copy of both, so a Codex seat was offered
      // Claude models and a model nobody had added to a React array could not
      // be chosen at all.
      const registry = await loadRegistry();
      const spawnable = [...registry.values()].filter((descriptor) => descriptor.spawn !== undefined);
      // Asked, not assumed. A hand-written list goes stale in the one direction
      // that matters: the operator's Codex offers luna, terra and sol, and the
      // registry offered `gpt-5.3-codex`, which does not exist for them. Codex
      // answers `model/list` over its app server; Claude Code names its aliases
      // in its own `--help`. Whatever cannot be discovered falls back to the
      // registry, marked as such, and every field stays free text either way.
      const catalog = await Promise.all(
        spawnable.map(async (descriptor) => {
          const discovered = await discoverModels(descriptor.key, descriptor);
          return {
            id: descriptor.key,
            label: descriptor.label ?? descriptor.key,
            models: discovered.models.map((model) => model.id),
            catalogue: discovered.models,
            modelSource: discovered.source,
            // Whether a seat on this harness can be watched in the hub. The
            // launcher was reading a `-live` suffix, which is a naming
            // convention rather than a contract.
            watchable: descriptor.turnFormat === 'interactive',
          };
        }),
      );
      send(response, 200, { harnesses: await probeCliHarnesses(), catalog });
      return;
    }
    if (path === '/phase' && method === 'GET') {
      const phase = await this.phase();
      send(response, 200, phase ?? { shape: null });
      return;
    }

    if (path === '/shapes' && method === 'GET') {
      // The launcher's picker. Seats and phases come out with it so the hub can
      // show what a shape will actually do before anyone commits tokens to it.
      send(response, 200, {
        shapes: [...SHAPES.values()].map((shape) => ({
          name: shape.name,
          summary: shape.summary,
          seats: shape.seats.map((seat) => ({ role: seat.role, count: seat.count })),
          phases: shape.phases.map((phase) => ({
            id: phase.id,
            intent: phase.intent,
            writes: phase.writes,
            gates: phase.exit.map((gate) => ({ id: gate.id, by: gate.by, quorum: gate.quorum ?? 'any' })),
          })),
        })),
      });
      return;
    }

    if (path === '/sessions' && method === 'GET') {
      // What each CLI is doing *now* — the hub's mirror. Presence comes from
      // the seat's own tool hooks, so it reports what the seat is doing rather
      // than what it last said, which is the difference between a live view and
      // a transcript.
      const now = Date.now();
      const phase = await this.phase();
      const registry = await loadRegistry();
      send(response, 200, {
        phase: phase ?? null,
        seats: this.#config.participants
          .filter((participant) => participant.role !== 'human')
          .map((participant) => ({
            id: participant.id,
            role: participant.role,
            harness: participant.harness,
            model: participant.model ?? null,
            effort: participant.effort ?? null,
            workspace: participant.workspace,
            present: this.#presence.isPresent(participant.id, now),
            activity: this.#presence.activityOf(participant.id, now) ?? null,
            // Seats launched interactive are named after themselves, so this is
            // the handle to attach to from a phone. Which ones those are is the
            // registry's `turnFormat`, not a suffix on the key — the suffix is
            // a naming convention and this was reading it as a contract.
            remoteControl:
              registry.get(participant.harness)?.turnFormat === 'interactive' ? participant.id : null,
            // Whether this daemon holds the pipe. A seat someone started in
            // their own terminal is real and working and cannot be mirrored,
            // and the hub must say so rather than draw a dead terminal.
            mirrored: this.#sessions.get(participant.id) !== undefined,
          })),
      });
      return;
    }

    const screenParams = matchPath(path, '/sessions/:id/screen');
    if (screenParams !== undefined && method === 'GET') {
      const seat = decodeURIComponent(screenParams[0]!);
      const session = this.#sessions.get(seat);
      if (session === undefined) {
        send(response, 404, wire('daemon', 'NO_MIRRORED_SESSION', `no mirrored session for ${seat}`));
        return;
      }
      const snapshot = session.screen();
      // The version the watcher already has. Answering "unchanged" for the cost
      // of a number is what makes a mirror pollable at a second's cadence
      // without shipping a grid per seat per tick.
      const since = Number(url.searchParams.get('since') ?? '-1');
      if (snapshot !== undefined && Number.isFinite(since) && snapshot.version === since) {
        send(response, 200, { seat, unchanged: true, version: snapshot.version, running: session.running });
        return;
      }
      send(response, 200, {
        seat,
        unchanged: false,
        running: session.running,
        exitCode: session.exitCode ?? null,
        canPush: session.canPush,
        screen: snapshot ?? null,
      });
      return;
    }

    const historyParams = matchPath(path, '/sessions/:id/scrollback');
    if (historyParams !== undefined && method === 'GET') {
      // What scrolled off, windowed. The lines used to be destroyed at the
      // point they left the grid — measured, 200 written and 31 reachable — so
      // there was nothing for a route like this to serve.
      const seat = decodeURIComponent(historyParams[0]!);
      const session = this.#sessions.get(seat);
      if (session === undefined) {
        send(response, 404, wire('daemon', 'NO_MIRRORED_SESSION', `no mirrored session for ${seat}`));
        return;
      }
      const from = Number(url.searchParams.get('from') ?? '0');
      const count = Number(url.searchParams.get('count') ?? String(SCROLLBACK_PAGE));
      const page = session.scrollback(
        Number.isFinite(from) ? from : 0,
        Number.isFinite(count) ? Math.min(Math.max(0, count), SCROLLBACK_PAGE) : SCROLLBACK_PAGE,
      );
      // A seat that was never captured has no history, which is not the same
      // answer as a seat whose history is empty.
      send(response, 200, page === undefined ? { seat, captured: false } : { seat, captured: true, ...page });
      return;
    }

    const streamParams = matchPath(path, '/sessions/:id/screen/stream');
    if (streamParams !== undefined && method === 'GET') {
      const seat = decodeURIComponent(streamParams[0]!);
      const session = this.#sessions.get(seat);
      if (session === undefined) {
        send(response, 404, wire('daemon', 'NO_MIRRORED_SESSION', `no mirrored session for ${seat}`));
        return;
      }
      this.#streamScreen(response, seat, session);
      return;
    }

    if (path === '/roster' && method === 'GET') {
      const present = (id: ParticipantId): boolean => this.#presence.isPresent(id, Date.now());
      send(response, 200, {
        ...roster(ctx, this.#pendingWaiters(), present, (id) => this.#presence.activityOf(id, Date.now())),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
      return;
    }
    if (path === '/board' && method === 'GET') {
      send(response, 200, board(this.#state));
      return;
    }
    if (path === '/tasks/mine' && method === 'GET') {
      send(response, 200, myTasks(ctx));
      return;
    }
    const roomParams = matchPath(path, '/rooms/:room/events');
    if (roomParams !== undefined && method === 'GET') {
      send(response, 200, await this.#readRoom(ctx, decodeURIComponent(roomParams[0]!), url));
      return;
    }

    const inputParams = matchPath(path, '/sessions/:id/input');
    if (inputParams !== undefined && method === 'POST') {
      // Typing into somebody's CLI is not a protocol act — it never reaches the
      // log, so it cannot be mistaken for something the team decided. It is the
      // operator leaning over and using the keyboard, and it is the human seat's
      // to do.
      if (who !== HUMAN_ID) {
        send(response, 403, wire('daemon', 'ROLE_NOT_PERMITTED', 'POST /sessions/:id/input requires the human seat'));
        return;
      }
      const seat = decodeURIComponent(inputParams[0]!);
      const session = this.#sessions.get(seat);
      if (session === undefined) {
        send(response, 404, wire('daemon', 'NO_MIRRORED_SESSION', `no mirrored session for ${seat}`));
        return;
      }
      const payload = (await readJsonBody(request)) as {
        turn?: unknown;
        keys?: unknown;
        rows?: unknown;
        cols?: unknown;
      };
      // A resize is input in the same sense a keystroke is: it never reaches
      // the log, and it is the operator's window telling the seat how much room
      // it has. `pty.resize` existed from the first day and nothing ever called
      // it, so every seat ran at 32×110 whatever the hub was showing.
      if (typeof payload.rows === 'number' && typeof payload.cols === 'number') {
        if (!Number.isFinite(payload.rows) || !Number.isFinite(payload.cols)) {
          send(response, 400, wire('daemon', 'MALFORMED_BODY', '`rows` and `cols` must be numbers'));
          return;
        }
        session.resize(payload.rows, payload.cols);
        send(response, 200, { seat, sent: 'resize' });
        return;
      }
      if (typeof payload.keys === 'string') {
        await session.key(payload.keys);
        send(response, 200, { seat, sent: 'keys' });
        return;
      }
      if (typeof payload.turn !== 'string' || payload.turn.trim() === '') {
        send(response, 400, wire('daemon', 'MALFORMED_BODY', 'send `turn` (a prompt) or `keys` (raw bytes)'));
        return;
      }
      if (!session.canPush) {
        send(response, 409, wire('daemon', 'SESSION_CANNOT_TAKE_TURN', `${seat} cannot take a turn after it starts`));
        return;
      }
      await session.send(payload.turn);
      send(response, 200, { seat, sent: 'turn' });
      return;
    }

    if (path === '/presence' && method === 'POST') {
      // Not an event: it never reaches the log, so it never reaches the
      // projection and never competes with what was decided. A harness hook
      // calls this on every tool use, which is thousands of times a run.
      const payload = (await readJsonBody(request)) as {
        verb?: unknown;
        path?: unknown;
        working?: unknown;
        blocked?: unknown;
      };
      const verb = typeof payload.verb === 'string' ? payload.verb : 'working';
      const file = typeof payload.path === 'string' ? payload.path : undefined;
      // An empty string clears it, so the supervisor can report recovery
      // without inventing a reason.
      const blocked = typeof payload.blocked === 'string' && payload.blocked !== '' ? payload.blocked : undefined;
      this.#presence.note(
        who,
        {
          verb,
          working: payload.working !== false,
          ...(file === undefined ? {} : { path: file }),
          ...(blocked === undefined ? {} : { blocked }),
        },
        Date.now(),
      );
      send(response, 204, {});
      return;
    }

    if (path === '/shutdown' && method === 'POST') {
      requireShutdownAuthority(this.#config, who);
      send(response, 200, { events: [...joined, ...(await this.#partAll())] } satisfies WriteResponse);
      // Answer first: a caller that never gets a reply cannot tell a clean stop
      // from a crash.
      setImmediate(() => void this.onShutdownRequest?.());
      return;
    }

    const handler = this.#writeHandler(path, method);
    if (handler === undefined) {
      throw new DaemonError('UNKNOWN_ROUTE', `No route for ${method} ${path}`);
    }

    const body = await readJsonBody(request);
    rejectDerivedAuthorFields(body);
    // Serialized: a handler validates against state and *then* appends, and two
    // concurrent raises both computed `C-${claims.size + 1}` from the same
    // snapshot — two distinct claims under one id, silently merged by the
    // projection. The append queue cannot fix that on its own because the id is
    // minted before the queue is reached; the validate-and-append pair has to
    // be atomic. Loopback traffic from a handful of agents, so the serial write
    // path costs nothing anyone can observe.
    send(response, 201, {
      events: [...joined, ...(await this.#enqueueWrite(() => handler(ctx, body)))],
    } satisfies WriteResponse);
  }

  #writeHandler(
    path: string,
    method: string,
  ): ((ctx: HandlerContext, body: Record<string, unknown>) => Promise<CrosstalkEvent[]>) | undefined {
    if (method !== 'POST') return undefined;

    if (path === '/events') return (ctx, body) => this.#appendMessage(ctx, body);
    if (path === '/claims') return raiseClaim;
    if (path === '/tasks') return createTask;
    if (path === '/tasks/assign') return assignTask;
    if (path === '/compose') return (ctx, body) => this.#composeJob(ctx, body);
    if (path === '/launch') return (ctx, body) => this.#launch(ctx, body);
    if (path === '/decisions') return openDecision;

    const claimResponse = matchPath(path, '/claims/:id/response');
    if (claimResponse) return (ctx, body) => respondToClaim(ctx, claimResponse[0]!, body);

    const claimEvidence = matchPath(path, '/claims/:id/evidence');
    if (claimEvidence) return (ctx, body) => addEvidence(ctx, claimEvidence[0]!, body);

    const ack = matchPath(path, '/tasks/:id/ack');
    if (ack) return (ctx, body) => acknowledgeTask(ctx, ack[0]!, body);

    const submit = matchPath(path, '/tasks/:id/submit');
    if (submit) return (ctx, body) => submitTask(ctx, submit[0]!, body);

    const state = matchPath(path, '/tasks/:id/state');
    if (state) return (ctx, body) => setTaskState(ctx, state[0]!, body);

    const vote = matchPath(path, '/decisions/:id/vote');
    if (vote) return (ctx, body) => castVote(ctx, vote[0]!, body);

    const test = matchPath(path, '/decisions/:id/test');
    if (test) return (ctx, body) => proposeTest(ctx, test[0]!, body);

    return undefined;
  }

  #context(who: ParticipantId): HandlerContext {
    // `state` is a getter so a handler that appends and then reads sees its own write.
    const daemon = this;
    return {
      who,
      config: this.#config,
      repo: this.#repo,
      get state(): HubState {
        return daemon.#state;
      },
      // A getter for the same reason as `state`: a rung entered late in a
      // request must rank on who was live at that moment, not at dispatch.
      get seenAt(): ReadonlyMap<ParticipantId, number> {
        return daemon.#presence.seenAt();
      },
      append: (draft: DraftEvent) => this.#append(draft),
    };
  }

  /**
   * The unauthenticated surface: the bootstrap redirect and the static bundle.
   *
   * The shell is served without a credential deliberately — it is the same
   * bundle shipped in the npm package and holds no session data. Everything
   * that reads the log still authenticates (contract §3).
   */
  async #serveFrontDoor(url: URL, path: string, response: ServerResponse): Promise<boolean> {
    const bootstrap = url.searchParams.get('t');
    if (path === '/' && bootstrap !== null) {
      if (!this.#byToken.has(bootstrap)) {
        throw new DaemonError('UNAUTHENTICATED', 'That bootstrap token is not a participant token');
      }
      // 302 to '/' so the token leaves the address bar before the hub loads:
      // it is never typed, never in history beyond one entry, and never sent
      // as a Referer from the page itself.
      response.writeHead(302, {
        location: '/',
        'set-cookie': `ct_token=${bootstrap}; HttpOnly; SameSite=Strict; Path=/`,
        'cache-control': 'no-store',
      });
      response.end();
      return true;
    }

    if (path !== '/' && !path.startsWith('/assets/') && path !== '/favicon.ico') return false;

    if (await serveAsset(response, this.#hubDist, path)) return true;
    if (path === '/') {
      sendHubMissing(response, this.#hubDist);
      return true;
    }
    return false;
  }

  #authenticate(request: IncomingMessage): ParticipantId {
    const header = request.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    const cookie = readCookie(request.headers.cookie, 'ct_token');
    // A bearer token always beats a cookie, so a CLI run from a browser-adjacent
    // context cannot be silently re-identified as `@human`.
    const who = this.#byToken.get(bearer ?? cookie ?? '');

    if (who === undefined) {
      // Says nothing about which tokens exist.
      throw new DaemonError('UNAUTHENTICATED', 'A valid participant token is required');
    }
    return who;
  }

  async #readEvents(url: URL): Promise<EventsResponse> {
    const since = readNonNegativeInt(url.searchParams.get('since'), 0, 'since');
    const limit = Math.min(
      readNonNegativeInt(url.searchParams.get('limit'), MAX_LIMIT, 'limit'),
      MAX_LIMIT,
    );

    // `since` is exclusive on both this path and SSE resume, so one word means
    // one thing and a reconnect can neither duplicate nor skip an event.
    // `readFrom` is inclusive, hence `since + 1`.
    const events = (await this.#log.readFrom(since + 1)).slice(0, limit);

    return {
      events,
      // The last seq *in this response*: a client paging with `since=lastSeq`
      // cannot step over a gap when the page was truncated.
      lastSeq: events.length > 0 ? events[events.length - 1]!.seq : since,
    };
  }

  async #readRoom(ctx: HandlerContext, requested: string, url: URL): Promise<EventsResponse> {
    // The read path too, not just the write. The filter below compares the raw
    // string, so normalising only on append would give a room that accepts
    // messages under one spelling and then returns none of them under the other.
    const room = normaliseRoom(requested);
    requireRoomMembership(ctx, room);
    const since = readNonNegativeInt(url.searchParams.get('since'), 0, 'since');
    const events = (await this.#log.readFrom(since + 1)).filter((event) => event.room === room);
    return {
      events,
      lastSeq: events.length > 0 ? events[events.length - 1]!.seq : since,
    };
  }

  async #awaitTurn(
    who: ParticipantId,
    url: URL,
  ): Promise<{ events: CrosstalkEvent[] } | { idle: true }> {
    const requested = readNonNegativeInt(url.searchParams.get('timeout_s'), AWAIT_CAP_S, 'timeout_s');
    const timeoutMs = Math.min(requested, AWAIT_CAP_S) * 1000;
    const mark = readNonNegativeInt(
      url.searchParams.get('since'),
      this.#delivered.get(who) ?? this.#floorSeq,
      'since',
    );

    const ready = (await this.#log.readFrom(mark + 1)).filter((event) =>
      addressesParticipant(event, who, this.#state),
    );
    if (ready.length > 0) return this.#deliver(who, ready);

    const events = await new Promise<CrosstalkEvent[]>((done) => {
      const waiter: Waiter = {
        who,
        resolve: (value) => {
          clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
          done(value);
        },
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          done([]);
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });

    return events.length > 0 ? this.#deliver(who, events) : { idle: true };
  }

  /**
   * Start a run from the hub: pick a shape, name the seats, type the prompt.
   *
   * The spawning itself is `runCompose`, unchanged — the daemon is only the
   * thing with a port on it. Deliberately fire-and-forget: `runCompose` returns
   * a `supervise()` that runs until every seat exits, and a launch request that
   * waited for that would hold a socket open for hours and time out long before
   * the team finished.
   */
  async #launch(ctx: HandlerContext, body: Record<string, unknown>): Promise<CrosstalkEvent[]> {
    const role = this.#config.participants.find((participant) => participant.id === ctx.who)?.role;
    if (ctx.who !== HUMAN_ID && role !== 'human') {
      throw new DaemonError('ROLE_NOT_PERMITTED', 'POST /launch requires the human seat');
    }
    const job = body['job'];
    if (typeof job !== 'string' || job.trim() === '') {
      throw new DaemonError('MALFORMED_BODY', '`job` is required');
    }
    const seats = body['seats'];
    if (seats !== undefined && !Array.isArray(seats)) {
      throw new DaemonError('MALFORMED_BODY', '`seats` must be a list of id:role:harness strings');
    }
    const shape = body['shape'];
    if (shape !== undefined && typeof shape !== 'string') {
      throw new DaemonError('MALFORMED_BODY', '`shape` must be a string');
    }
    if (typeof shape === 'string' && !SHAPES.has(shape)) {
      throw new DaemonError('MALFORMED_BODY', `no shape named ${shape}`);
    }

    // Staffing the team is the hub's job, not a thing you have to have done at
    // the command line first.
    //
    // This used to refuse any roster the daemon was not already running, and
    // that made the launcher's picker decorative: you could choose seats in the
    // browser and the only outcome was an error telling you to edit a YAML file
    // and restart. The reason was real — `runInit` will not overwrite a roster,
    // and forcing it would have written seats whose tokens this daemon had
    // never minted, so they could not have called back — but the fix was to
    // mint and reload, not to refuse.
    // The job goes on the board first, and the floor is set *after* it.
    //
    // Order matters, and getting it wrong delivered the job twice. `runCompose`
    // types the job into each seat as its opening turn — that is the path that
    // survives a start-up dialog, because it keeps offering until the seat is
    // at a prompt. Posting to #floor is for the operator and for anyone who
    // joins later. With the floor set before the append, the job was also above
    // it, so the wake loop handed the same text over a second time and every
    // seat opened on its brief printed twice.
    //
    // Setting the floor after covers both at once: everything already on the
    // board belongs to runs before this one — handing that to a fresh team as
    // "new since your last turn" is how its first act became reading someone
    // else's finished argument — and the job itself is delivered by exactly one
    // path.
    const posted = await this.#appendMessage(ctx, { kind: 'message', room: FLOOR, body: job.trim() });
    this.#floorSeq = this.#log.lastSeq;
    this.#delivered.clear();

    const requested = (seats ?? []) as string[];
    // A shape change is grounds to re-staff on its own. The roster can be
    // identical and the team still be a different team: `trio-contract` and
    // three unshaped peers seat the same three people and are not the same
    // thing to run, and the briefs each seat reads are written by `init`.
    const restaffing =
      rosterDiffers(this.#config.participants, requested) ||
      (typeof shape === 'string' && shape !== this.#config.shape);

    const { runCompose } = await import('../cli/compose.js');
    void (async () => {
      if (restaffing) {
        // `runInit` writes the roster, builds each seat's worktree and brief,
        // and mints tokens for the new ones while keeping every token that
        // already exists. Then this daemon picks all of it up in place.
        const { runInit } = await import('../cli/init.js');
        await runInit({
          repo: this.#repo,
          participants: requested,
          force: true,
          ...(typeof shape === 'string' ? { shape } : {}),
        });
        await this.reload();
      }
      const result = await runCompose({
        repo: this.#repo,
        job: job.trim(),
        // Already written and reloaded above, so `runCompose` spawns the roster
        // rather than writing it a second time.
        participants: [],
        ...(typeof shape === 'string' ? { shape } : {}),
        // What makes the mirror possible: the seats this daemon starts publish
        // their sessions here, so `/sessions/:id/screen` has something to read
        // and `/sessions/:id/input` has somewhere to write.
        sessions: this.#sessions,
        // The job reaches the board through this handler's own append below, so
        // compose must not post it a second time.
        postJob: async () => {},
      });
      await result.supervise();
    })().catch(async (error: unknown) => {
      // A launch that dies silently looks exactly like a team that joined and
      // said nothing, which is the failure this whole project exists to stop.
      const reason = error instanceof Error ? error.message : String(error);
      await this.#log.append({ kind: 'message', room: FLOOR, from: HUMAN_ID, body: `launch failed: ${reason}` });
    });

    return posted;
  }

  async #composeJob(ctx: HandlerContext, body: Record<string, unknown>): Promise<CrosstalkEvent[]> {
    const role = this.#config.participants.find((participant) => participant.id === ctx.who)?.role;
    if (ctx.who !== HUMAN_ID && role !== 'human') {
      throw new DaemonError('ROLE_NOT_PERMITTED', 'POST /compose requires the human seat');
    }
    const job = body['job'];
    if (typeof job !== 'string' || job.trim() === '') {
      throw new DaemonError('MALFORMED_BODY', '`job` is required');
    }
    return this.#appendMessage(ctx, { kind: 'message', room: FLOOR, body: job.trim() });
  }

  /**
   * The last standing status each seat was told, so it is not told again.
   *
   * Keyed by participant because the status is per-role: what blocks a peer is
   * not what blocks the human seat watching them.
   */
  readonly #lastStatus = new Map<ParticipantId, string>();

  async #inboxTurn(who: ParticipantId, url: URL): Promise<Inbox> {
    const wait = url.searchParams.get('wait') !== '0';
    const role = this.#config.participants.find((participant) => participant.id === who)?.role ?? 'observer';
    const peek = new URL(url.href);
    peek.searchParams.set('timeout_s', '0');
    const peeked = await this.#awaitTurn(who, peek);
    const unread = 'events' in peeked ? peeked.events : [];
    const phase = await this.phase();
    const inbox = renderInbox({ who, role, unread, state: this.#state, ...(phase === undefined ? {} : { phase }) });
    // A #floor job or an assigned task is already work. Waiting 50s after that
    // is how the Quorum builder spent eight polls idle while the job sat on the board.
    //
    // But "there is work" is a standing condition, not an event, and returning
    // on it every time turns the wake loop into a hot spin: the seat is told
    // the same unmet gate as fast as HTTP allows, forever. Measured once the
    // shape started reaching the config — every seat's composer filling with
    // dozens of identical board notices, which is where a run's context went
    // before it had written a line of code.
    //
    // So a *changed* status returns immediately and an unchanged one blocks.
    // The seat still learns about new work the moment it appears, and learns
    // about it once.
    if (unread.length > 0 || !wait) return inbox;
    const status = inbox.next;
    if (status !== undefined && status !== 'idle' && this.#lastStatus.get(who) !== status) {
      this.#lastStatus.set(who, status);
      return inbox;
    }
    const blocked = await this.#awaitTurn(who, url);
    const later = 'events' in blocked ? blocked.events : [];
    const after = await this.phase();
    return renderInbox({ who, role, unread: later, state: this.#state, ...(after === undefined ? {} : { phase: after }) });
  }

  /**
   * Where the team is, recomputed per turn rather than stored.
   *
   * The workspace gates shell out to git, so this is the one derived value that
   * costs something. It is still per-turn and not cached: a cached phase that
   * disagreed with the repository would be exactly the "belief written as a
   * fact" that the whole delivery repair is about.
   */
  async phase(): Promise<PhaseStatus | undefined> {
    const shape = shapeNamed(this.#config.shape);
    if (shape === undefined) return undefined;

    const seats = this.#config.participants.filter(
      (participant) => participant.id !== HUMAN_ID && participant.role !== 'human',
    );
    const needed = shape.phases.flatMap((phase) => phase.exit.filter((gate) => gate.by === 'workspace').map((gate) => gate.id));
    const contractPath = this.#config.contractPath ?? shape.contract;

    let workspace;
    try {
      workspace = await workspaceGates({
        repo: this.#repo,
        base: this.#config.project.mainBranch,
        // The config wins, then the shape's own default. Falling back to the
        // shape is what stops a shape shipping a gate nothing can ever meet:
        // `contractPath` is optional in the config and no code path has ever
        // set it.
        ...(contractPath === undefined ? {} : { contractPath }),
        branches: await seatBranches(this.#repo, seats),
        needed,
      });
    } catch {
      // A repository that cannot be read is not a reason to stop delivering
      // turns. The gate reports unchecked and the seat sees why.
      workspace = new Map();
    }

    return phaseStatus(shape, {
      events: this.#state.messages,
      participants: seats.map((seat) => seat.id),
      workspace,
    });
  }

  /**
   * Server-sent events. Contract §6.
   *
   * Frames carry no `event:` name on purpose: the hub subscribes with
   * `stream.onmessage`, which only ever fires for the default type. A named
   * frame would leave it connected, silent, and reporting `connected` — the
   * blank-screen failure this project has already shipped once.
   */
  async #openStream(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    // The browser resends Last-Event-ID on reconnect; `?since=` is for
    // everything that is not a browser. Both are exclusive, like /events.
    const header = request.headers['last-event-id'];
    const resumeFrom = readNonNegativeInt(
      typeof header === 'string' ? header : url.searchParams.get('since'),
      0,
      'Last-Event-ID',
    );

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Nothing proxies loopback today, but a buffering proxy turns a live
      // stream into a stalled page and the symptom looks like a dead daemon.
      'x-accel-buffering': 'no',
    });

    for (const event of await this.#log.readFrom(resumeFrom + 1)) writeFrame(response, event);

    const heartbeat = setInterval(() => {
      // A comment line: EventSource ignores it, and it keeps the connection
      // from being reaped by an idle timeout somewhere in between. It is also
      // the only thing that notices an idle subscriber which stopped reading —
      // without traffic there is no write to discover the backlog with.
      response.write(':hb\n\n');
      if (backlogOf(response) > MAX_SUBSCRIBER_BACKLOG) {
        clearInterval(heartbeat);
        this.#subscribers.delete(subscriber);
        response.destroy();
      }
    }, HEARTBEAT_MS);

    const subscriber: Subscriber = { response, heartbeat };
    this.#subscribers.add(subscriber);
    request.on('close', () => {
      clearInterval(heartbeat);
      this.#subscribers.delete(subscriber);
    });
  }

  /**
   * One seat's screen, pushed.
   *
   * The panel used to poll. It asked for 800ms and the browser gave it 1,000 —
   * hidden tabs have their timers clamped, and the hub tab is hidden whenever it
   * is not frontmost — so a keystroke took about a second to appear on a path
   * whose two slow halves measured 2.8ms and 3.2ms. Everything else in the
   * mirror was already fast; the wait was the only defect.
   *
   * Only the open seat is ever streamed, which is the same rule the poll had:
   * a hub with six seats must not spend six sockets to draw one terminal.
   */
  #streamScreen(response: ServerResponse, seat: string, session: SessionHandle): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let sentAt = 0;
    let closed = false;
    let done = (): void => {
      closed = true;
    };

    const frame = (): void => {
      if (closed) return;
      // A subscriber that stopped reading is a socket whose buffer only grows.
      // The log stream has always reaped these; a screen stream ships far more
      // bytes per second, so it needs it more.
      if (backlogOf(response) > MAX_SUBSCRIBER_BACKLOG) {
        done();
        response.destroy();
        return;
      }
      sentAt = Date.now();
      const snapshot = session.screen();
      response.write(
        `data: ${JSON.stringify({
          seat,
          running: session.running,
          exitCode: session.exitCode ?? null,
          canPush: session.canPush,
          screen: snapshot ?? null,
        })}\n\n`,
      );
    };

    // Coalesced rather than debounced: a debounce would hold the last frame of
    // a burst back until the burst stopped, which is precisely the frame the
    // operator is waiting to see. This sends immediately when it can and
    // schedules exactly one catch-up when it cannot.
    const onChange = (): void => {
      if (closed || timer !== undefined) return;
      const wait = Math.max(0, SCREEN_FRAME_MS - (Date.now() - sentAt));
      if (wait === 0) {
        frame();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        frame();
      }, wait);
    };

    frame();
    const unwatch = session.watch(onChange);
    const heartbeat = setInterval(() => response.write(':hb\n\n'), HEARTBEAT_MS);

    done = (): void => {
      if (closed) return;
      closed = true;
      unwatch();
      clearInterval(heartbeat);
      if (timer !== undefined) clearTimeout(timer);
    };
    response.on('close', done);
  }

  #deliver(who: ParticipantId, events: CrosstalkEvent[]): { events: CrosstalkEvent[] } {
    this.#delivered.set(who, events[events.length - 1]!.seq);
    return { events };
  }

  #pendingWaiters(): Set<ParticipantId> {
    return new Set([...this.#waiters].map((waiter) => waiter.who));
  }

  async #appendMessage(ctx: HandlerContext, body: Record<string, unknown>): Promise<CrosstalkEvent[]> {
    const kind = body['kind'];
    if (typeof kind !== 'string' || !(kind in EVENT_KIND_ROUTE)) {
      throw new DaemonError('MALFORMED_BODY', `Unknown event kind: ${String(kind)}`);
    }
    if (kind !== DIRECTLY_APPENDABLE) {
      // A generic append would be a back door around every validator in the
      // project: `claim_raised` carries a whole Claim, so a client could
      // hand-build one and never touch validateRaise.
      throw new DaemonError(
        'EVENT_KIND_NOT_APPENDABLE',
        `${kind} is not directly appendable — use ${EVENT_KIND_ROUTE[kind as EventKind]}`,
      );
    }

    const to = body['to'];
    if (to !== undefined && typeof to !== 'string') {
      throw new DaemonError('MALFORMED_BODY', 'message `to` must be a participant id');
    }
    const ref = body['ref'];
    if (ref !== undefined && typeof ref !== 'string') {
      throw new DaemonError('MALFORMED_BODY', 'message `ref` must be a string');
    }
    const head = body['head'];
    if (head !== undefined && typeof head !== 'string') {
      throw new DaemonError('MALFORMED_BODY', 'message `head` must be a string');
    }
    const task = body['task'];
    if (task !== undefined && typeof task !== 'string') {
      throw new DaemonError('MALFORMED_BODY', 'message `task` must be a string');
    }

    // `to` with no room opens the side room. This is the whole of the fix for
    // the 312 messages that named one seat and were read by three: `to` alone
    // could never remove a reader, because `#floor` membership delivers to
    // everyone and `to` only adds a wake on top. A room is what narrows it, and
    // reaching one used to mean hand-building `dm:a~b` — which no MCP seat did,
    // in 1187 events, having been told twice to.
    const named = body['room'];
    const room = typeof named === 'string' && named !== ''
      ? named
      : typeof to === 'string'
        ? dmId(ctx.who, to)
        : undefined;
    if (room === undefined) {
      throw new DaemonError('MALFORMED_BODY', 'message requires a room, or a `to` naming one seat');
    }

    // `body` falls back to `head`, and this is the load-bearing half of the
    // amendment: every reader that predates it — the projection, the mirror,
    // `boardTurn`, every card — treats `body` as the message, and an empty one
    // would render as a blank card and an empty turn.
    const written = body['body'];
    const text = typeof written === 'string' ? written : typeof head === 'string' ? head : undefined;
    if (text === undefined) {
      throw new DaemonError('MALFORMED_BODY', 'message requires a body, or a `head`');
    }

    const refusal = this.#refuseSchema(ctx.who, {
      room,
      tag: body['tag'],
      head,
      body: written,
      to,
      ref,
    });
    if (refusal !== null) {
      throw new DaemonError('MESSAGE_REFUSED', refusal);
    }

    // The cap is enforced here rather than in each tool so both tiers get it:
    // the shell CLI and the MCP facade are two spellings of one interface, and
    // beacon-1 showed what happens when they drift.
    const oversize = refuseOversizeBody(text, ctx.who);
    if (oversize !== null) {
      throw new DaemonError('MESSAGE_TOO_LONG', oversize);
    }

    // Before membership and before the append, so `dm:leader~codex` and
    // `dm:codex~leader` cannot become two rooms holding one conversation.
    const canonical = normaliseRoom(room);
    requireRoomMembership(ctx, canonical);

    return [
      await ctx.append({
        kind: 'message',
        from: ctx.who,
        room: canonical,
        body: text,
        ...(to === undefined ? {} : { to }),
        ...(ref === undefined ? {} : { ref }),
        ...(isMessageTag(body['tag']) ? { tag: body['tag'] } : {}),
        ...(head === undefined ? {} : { head }),
        ...(task === undefined ? {} : { task }),
      }),
    ];
  }

  /**
   * Hold this seat to the message schema, or do not.
   *
   * Gated on the shape naming tags for the seat's role, so a project with no
   * shape — every repository already using Crosstalk — writes exactly what it
   * wrote before. `@human` is exempt for the same reason it is exempt from the
   * length cap: the operator is not a seat and is not being taught anything.
   */
  #refuseSchema(who: ParticipantId, draft: MessageDraft): string | null {
    if (who === HUMAN_ID) return null;
    const shape = shapeNamed(this.#config.shape);
    if (shape === undefined) return null;
    const role = this.#config.participants.find((participant) => participant.id === who)?.role;
    const allowed = shape.seats.find((seat) => seat.role === role)?.tags;
    if (allowed === undefined) return null;

    return refuseMessage(draft, {
      from: who,
      allowed,
      roster: this.#config.participants.map((participant) => participant.id),
    });
  }

  /**
   * Presence is derived from the transport, never asserted by a client: the
   * daemon stamps `participant_joined` the first time a token is presented in
   * this daemon's lifetime, taking the whole Participant from config.
   */
  async #ensureJoined(who: ParticipantId): Promise<CrosstalkEvent[]> {
    const inFlight = this.#joins.get(who);
    if (inFlight !== undefined) {
      // Wait for it, but do not re-report it: whoever triggered the join owns
      // the event. Waiting matters — a request that runs ahead of its own join
      // fails its room-membership check, because membership is projected from
      // `participant_joined`.
      await inFlight;
      return [];
    }

    const participant = this.#config.participants.find((candidate) => candidate.id === who);
    if (participant === undefined) return [];

    // Registered before the first await so two concurrent first requests
    // cannot both start a join.
    const join = this.#append({ kind: 'participant_joined', from: who, participant }).then(
      (event) => [event],
    );
    this.#joins.set(who, join);
    return join;
  }

  /**
   * Closes presence for everyone who joined, so a log replayed after a clean
   * stop does not show a room still full of participants who left hours ago.
   */
  async #partAll(): Promise<CrosstalkEvent[]> {
    const events: CrosstalkEvent[] = [];
    for (const who of [...this.#joins.keys()]) {
      this.#joins.delete(who);
      events.push(await this.#append({ kind: 'participant_left', from: who, participantId: who }));
    }
    return events;
  }

  /**
   * One write handler at a time. A failure must not poison the chain — the
   * next writer runs whatever became of this one.
   */
  #enqueueWrite<T>(run: () => Promise<T>): Promise<T> {
    const queued = this.#handlerTail.then(run);
    this.#handlerTail = queued.catch(() => {});
    return queued;
  }

  /** Every write funnels through here: one EventLog, one seq sequence, no gaps. */
  async #append(draft: DraftEvent): Promise<CrosstalkEvent> {
    const queued = this.#writeTail.then(async () => {
      const event = await this.#log.append(draft);
      this.#state = applyEvent(this.#state, event);
      this.#ladderTimers.observe(event, this.#state, this.#config);
      return event;
    });
    this.#writeTail = queued.catch(() => {});
    const event = await queued;
    // Scheduled outside the write queue on purpose: `checkStaleness` appends,
    // and appending from inside the queue callback deadlocks on it.
    if (event.kind === 'task_state' && event.state === 'merged') {
      setImmediate(() => void this.#sweepStaleness());
    }
    this.#wake(event);
    for (const subscriber of [...this.#subscribers]) {
      if (writeFrame(subscriber.response, event)) continue;
      // Too far behind to catch up. It reconnects with Last-Event-ID and the
      // stream resumes from the log; holding the socket open would only trade
      // one stalled reader for the whole daemon's memory.
      clearInterval(subscriber.heartbeat);
      this.#subscribers.delete(subscriber);
      subscriber.response.destroy();
    }
    return event;
  }

  /**
   * A `@human` message needs no separate priority path: every addressing event
   * resolves its waiter immediately, so nothing is ever queued behind anything.
   */
  #wake(event: CrosstalkEvent): void {
    for (const waiter of [...this.#waiters]) {
      if (addressesParticipant(event, waiter.who, this.#state)) {
        waiter.resolve([event]);
      }
    }
  }

  #fail(response: ServerResponse, error: unknown): void {
    if (response.headersSent) return;
    if (error instanceof ProtocolError) {
      send(response, PROTOCOL_STATUS[error.code], wire('protocol', error.code, error.message));
      return;
    }
    if (error instanceof DaemonError) {
      send(response, DAEMON_STATUS[error.code], wire('daemon', error.code, error.message, error.url));
      return;
    }
    send(response, 500, wire('daemon', 'MALFORMED_BODY', (error as Error)?.message ?? 'Internal error'));
  }
}

/** Stopping the hub is not something any participant should be able to do to the others. */
function requireShutdownAuthority(config: CrosstalkConfig, who: ParticipantId): void {
  const role = config.participants.find((candidate) => candidate.id === who)?.role;
  if (who !== HUMAN_ID && role !== 'leader' && role !== 'human') {
    throw new DaemonError('ROLE_NOT_PERMITTED', 'POST /shutdown requires the leader or @human');
  }
}

/**
 * Whether a requested roster is different from the one already seated.
 *
 * Compared on id, role and harness — the three the spec's first fields carry,
 * and the three that decide who can talk to the daemon. Model and effort are
 * per-seat argv: changing them re-spawns a seat differently but does not change
 * who it is, so they are not grounds for rewriting the roster.
 *
 * Used to decide whether `/launch` has to re-staff before it spawns. It is a
 * question, not a gate — an earlier version returned a refusal message here,
 * which turned every roster chosen in the hub into an error telling the
 * operator to go and edit YAML.
 */
export function rosterDiffers(
  running: readonly { id: string; role: string; harness: string }[],
  requested: readonly string[],
): boolean {
  if (requested.length === 0) return false;
  const seated = new Map(
    running
      .filter((participant) => participant.role !== 'human')
      .map((participant) => [participant.id, participant] as const),
  );
  if (seated.size !== requested.length) return true;

  return requested.some((spec) => {
    const [id, role, harness] = spec.split(':');
    if (id === undefined) return true;
    const participant = seated.get(id);
    return participant === undefined || participant.role !== role || participant.harness !== harness;
  });
}

/** Matches `/tasks/:id/ack` shapes, returning the captured segments. */
function matchPath(path: string, pattern: string): string[] | undefined {
  const actual = path.split('/').filter(Boolean);
  const expected = pattern.split('/').filter(Boolean);
  if (actual.length !== expected.length) return undefined;

  const captured: string[] = [];
  for (const [index, segment] of expected.entries()) {
    if (segment.startsWith(':')) {
      captured.push(actual[index]!);
      continue;
    }
    if (segment !== actual[index]) return undefined;
  }
  return captured;
}

/**
 * How much a single subscriber may fall behind before it is dropped.
 *
 * SSE has no application-level backpressure: `response.write` returns false
 * when the socket is full and Node buffers the rest in memory, forever, with no
 * signal that anything is wrong. A client that connects and never reads —
 * a suspended laptop, a tab the OS froze, a `curl` piped into something
 * stalled — makes the daemon grow without bound. Measured: one such client
 * queued 704 MB in five seconds and took RSS from 41 MB to 1.36 GB. Node's own
 * docs say the process "will abort unconditionally".
 *
 * Dropping the connection is safe precisely because resume exists: `id:` is the
 * seq, EventSource reconnects on its own with `Last-Event-ID`, and
 * `#openStream` replays from the log. A subscriber that cannot keep up loses
 * its socket and nothing else.
 */
export const MAX_SUBSCRIBER_BACKLOG = 8 * 1024 * 1024;

/**
 * How far behind a subscriber is, in bytes waiting to reach it.
 *
 * Read off the **socket**, not off the `ServerResponse`. An `OutgoingMessage`
 * flushes into the socket eagerly, so its own `writableLength` stays near zero
 * however far behind the reader is — measured: 400 frames and 24 MB of backlog
 * with `response.writableLength` never once above the threshold. The queue that
 * actually grows is the socket's.
 */
export function backlogOf(response: ServerResponse): number {
  return response.socket?.writableLength ?? 0;
}

/**
 * `id:` is the seq, so Last-Event-ID resume needs no separate cursor.
 *
 * Returns false when this subscriber is too far behind to keep.
 *
 * Exported for the test that pins the drop threshold. The end-to-end behaviour
 * — a paused reader building a real backlog until the daemon hangs up on it —
 * was verified by direct measurement against the built daemon (60 frames of
 * 60 KB queue ~2.8 MB on the subscriber's socket; a few hundred passes the cap
 * and the socket is closed). It is not reproducible under the test runner,
 * which throttles the flood well below the threshold, so what is pinned here
 * is the decision rather than the plumbing.
 */
export function writeFrame(response: ServerResponse, event: CrosstalkEvent): boolean {
  response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  return backlogOf(response) <= MAX_SUBSCRIBER_BACKLOG;
}

function wire(
  domain: 'protocol' | 'daemon',
  code: WireError['error']['code'],
  message: string,
  url?: string,
): WireError {
  return { error: { domain, code, message, ...(url === undefined ? {} : { url }) } };
}

/** A single header value, or undefined. Node hands back an array for repeats. */
function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.trim() === '' ? undefined : value;
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function rejectDerivedAuthorFields(body: Record<string, unknown>): void {
  for (const field of DERIVED_AUTHOR_FIELDS) {
    if (field in body) {
      // Rejected rather than stripped: silently dropping it would let a client
      // believe it had spoken as someone else.
      throw new DaemonError(
        'FROM_NOT_ALLOWED',
        `\`${field}\` is derived from the presenting token and must not be sent`,
      );
    }
  }
  // Evidence carries its own author field, and it is derived too.
  const evidence = body['evidence'];
  for (const item of Array.isArray(evidence) ? evidence : [evidence]) {
    if (item !== null && typeof item === 'object' && 'by' in (item as object)) {
      throw new DaemonError(
        'FROM_NOT_ALLOWED',
        '`evidence.by` is derived from the presenting token and must not be sent',
      );
    }
  }
}

function readNonNegativeInt(raw: string | null, fallback: number, name: string): number {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new DaemonError('MALFORMED_BODY', `${name} must be a non-negative integer`);
  }
  return value;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new DaemonError('PAYLOAD_TOO_LARGE', 'Request body exceeds 1 MiB');
    }
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DaemonError('MALFORMED_BODY', 'Request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DaemonError('MALFORMED_BODY', 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
