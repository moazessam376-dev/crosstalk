import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import type { CrosstalkConfig } from '../contracts/config.js';
import type { CrosstalkEvent, DraftEvent, EventKind } from '../contracts/events.js';
import { ProtocolError } from '../contracts/errors.js';
import type { ParticipantId } from '../contracts/participant.js';
import { EventLog } from '../core/log.js';
import { applyEvent, project, type HubState } from '../core/projection.js';

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
import { loadConfig } from './config.js';
import { acquireLock, recordLockUrl, releaseLock } from './lock.js';
import { DaemonError } from './errors.js';

/** Loopback only. Never `localhost`: it resolves to ::1 first on Windows, which strands IPv4 clients on a server that started fine. */
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LIMIT = 1000;

export interface DaemonHandle {
  url: string;
  /** One per participant — spec §6.1. A single shared token makes `from` self-asserted. */
  tokens: ReadonlyMap<ParticipantId, string>;
  close(): Promise<void>;
}

export interface StartDaemonOptions {
  repo: string;
  port?: number;
}

export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonHandle> {
  const repo = resolve(opts.repo);
  const config = await loadConfig(repo);

  const stateDir = join(repo, '.crosstalk');
  const lockPath = join(stateDir, 'daemon.lock');
  const daemonJsonPath = join(stateDir, 'daemon.json');

  await mkdir(join(stateDir, 'tokens'), { recursive: true });
  await acquireLock(lockPath);

  let log: EventLog | undefined;
  let server: Server | undefined;
  try {
    const tokens = await mintTokens(config, stateDir);
    log = await EventLog.open(join(stateDir, 'events.jsonl'));

    const daemon = new Daemon(config, tokens, log);
    await daemon.init();
    server = createServer((request, response) => {
      void daemon.handle(request, response);
    });
    const url = await listen(server, opts.port);

    await writeFile(
      daemonJsonPath,
      JSON.stringify({ version: 1, url, pid: process.pid, startedAt: new Date().toISOString() }),
      { encoding: 'utf8', mode: 0o600 },
    );
    await recordLockUrl(lockPath, url);

    return buildHandle({ url, tokens, server, daemon, lockPath, daemonJsonPath });
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
  tokens: Map<ParticipantId, string>;
  server: Server;
  daemon: Daemon;
  lockPath: string;
  daemonJsonPath: string;
}): DaemonHandle {
  const { url, tokens, server, daemon, lockPath, daemonJsonPath } = parts;

  // SIGTERM is not delivered on Windows the way it is elsewhere, so shutdown
  // never relies on a signal arriving — POST /shutdown is the portable path.
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await daemon.close();
      await unlink(daemonJsonPath).catch(() => {});
      await releaseLock(lockPath);
    })();
    return closed;
  };
  const onSignal = (): void => {
    void close();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return { url, tokens, close };
}

function listen(server: Server, port?: number): Promise<string> {
  return new Promise((done, fail) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      fail(
        error.code === 'EADDRINUSE'
          ? new DaemonError('PORT_IN_USE', `Port ${port} is already bound`)
          : error,
      );
    });
    server.listen(port ?? 0, HOST, () => {
      done(`http://${HOST}:${(server.address() as AddressInfo).port}`);
    });
  });
}

async function mintTokens(
  config: CrosstalkConfig,
  stateDir: string,
): Promise<Map<ParticipantId, string>> {
  const tokens = new Map<ParticipantId, string>();
  for (const participant of config.participants) {
    const token = randomBytes(32).toString('hex');
    tokens.set(participant.id, token);
    // `@human` is a legal ParticipantId but PARTICIPANT_ID_PATTERN rejects it,
    // so the '@' is stripped for the filename and `doctor` reserves `human`.
    await writeFile(join(stateDir, 'tokens', tokenFilename(participant.id)), token, {
      encoding: 'utf8',
      // A no-op on Windows. `doctor` says so rather than claiming a protection we do not have.
      mode: 0o600,
    });
  }
  return tokens;
}

export function tokenFilename(id: ParticipantId): string {
  return id.startsWith('@') ? id.slice(1) : id;
}

class Daemon {
  readonly #config: CrosstalkConfig;
  readonly #byToken: Map<string, ParticipantId>;
  readonly #log: EventLog;
  #state: HubState;
  readonly #joined = new Set<ParticipantId>();
  #writeTail: Promise<unknown> = Promise.resolve();

  constructor(config: CrosstalkConfig, tokens: Map<ParticipantId, string>, log: EventLog) {
    this.#config = config;
    this.#log = log;
    this.#byToken = new Map([...tokens].map(([id, token]) => [token, id]));
    this.#state = project([]);
  }

  async init(): Promise<void> {
    this.#state = project(await this.#log.read());
  }

  async close(): Promise<void> {
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

    if (path === '/health' && request.method === 'GET') {
      // The only unauthenticated route, and it carries no log data.
      send(response, 200, { ok: true, version: 1, pid: process.pid });
      return;
    }

    const who = this.#authenticate(request);

    if (path === '/events' && request.method === 'GET') {
      send(response, 200, await this.#readEvents(url));
      return;
    }

    if (path === '/events' && request.method === 'POST') {
      send(response, 201, await this.#appendMessage(request, who));
      return;
    }

    throw new DaemonError('UNKNOWN_ROUTE', `No route for ${request.method ?? 'GET'} ${path}`);
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
    const limit = Math.min(readNonNegativeInt(url.searchParams.get('limit'), MAX_LIMIT, 'limit'), MAX_LIMIT);

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

  async #appendMessage(request: IncomingMessage, who: ParticipantId): Promise<WriteResponse> {
    const body = await readJsonBody(request);
    rejectDerivedAuthorFields(body);

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

    const room = body['room'];
    const text = body['body'];
    if (typeof room !== 'string' || room === '') {
      throw new DaemonError('MALFORMED_BODY', 'message requires a room');
    }
    if (typeof text !== 'string') {
      throw new DaemonError('MALFORMED_BODY', 'message requires a body');
    }
    const to = body['to'];
    if (to !== undefined && typeof to !== 'string') {
      throw new DaemonError('MALFORMED_BODY', 'message `to` must be a participant id');
    }

    const joined = await this.#ensureJoined(who);
    const event = await this.#append({
      kind: 'message',
      from: who,
      room,
      body: text,
      ...(to === undefined ? {} : { to }),
    });

    return { events: [...joined, event] };
  }

  /**
   * Presence is derived from the transport, never asserted by a client: the
   * daemon stamps `participant_joined` the first time a token is presented in
   * this daemon's lifetime, taking the whole Participant from config.
   */
  async #ensureJoined(who: ParticipantId): Promise<CrosstalkEvent[]> {
    if (this.#joined.has(who)) return [];
    // Marked before the await so two concurrent first requests cannot both join.
    this.#joined.add(who);

    const participant = this.#config.participants.find((candidate) => candidate.id === who);
    if (participant === undefined) return [];

    return [await this.#append({ kind: 'participant_joined', from: who, participant })];
  }

  /** Every write funnels through here: one EventLog, one seq sequence, no gaps. */
  async #append(draft: DraftEvent): Promise<CrosstalkEvent> {
    const queued = this.#writeTail.then(async () => {
      const event = await this.#log.append(draft);
      this.#state = applyEvent(this.#state, event);
      return event;
    });
    this.#writeTail = queued.catch(() => {});
    return queued;
  }

  #fail(response: ServerResponse, error: unknown): void {
    if (error instanceof ProtocolError) {
      send(response, PROTOCOL_STATUS[error.code], wire('protocol', error.code, error.message));
      return;
    }
    if (error instanceof DaemonError) {
      send(response, DAEMON_STATUS[error.code], wire('daemon', error.code, error.message, error.url));
      return;
    }
    send(response, 500, wire('daemon', 'MALFORMED_BODY', (error as Error).message ?? 'Internal error'));
  }
}

function wire(
  domain: 'protocol' | 'daemon',
  code: WireError['error']['code'],
  message: string,
  url?: string,
): WireError {
  return { error: { domain, code, message, ...(url === undefined ? {} : { url }) } };
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
