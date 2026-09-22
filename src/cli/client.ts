import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CrosstalkEvent } from '../contracts/events.js';
import { tokenFilename } from '../daemon/server.js';

/** Contract §8.3. The shell floor carries validation failures in the exit code. */
export const EXIT = {
  ok: 0,
  protocol: 1,
  usage: 2,
  auth: 3,
  daemon: 4,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface DaemonInfo {
  version: number;
  url: string;
  pid: number;
  startedAt: string;
}

export function stateDir(repo: string): string {
  return join(resolve(repo), '.crosstalk');
}

/**
 * The url is discovered, never configured.
 *
 * The daemon binds an ephemeral port, so any file written before it starts —
 * `.mcp.json`, a config, a shell alias — would disagree with reality the first
 * time someone passes `--port` or the pinned one is taken.
 */
export async function resolveUrl(repo: string): Promise<string> {
  const override = process.env['CROSSTALK_URL'];
  if (override !== undefined && override !== '') return override.replace(/\/$/, '');

  const path = join(stateDir(repo), 'daemon.json');
  try {
    const info = JSON.parse(await readFile(path, 'utf8')) as DaemonInfo;
    if (typeof info.url !== 'string' || info.url === '') throw new Error('no url');
    return info.url.replace(/\/$/, '');
  } catch {
    // Not swallowed: an agent whose tools silently return nothing is the
    // failure this project keeps rediscovering.
    throw new CliError(
      `No daemon found for ${resolve(repo)}`,
      EXIT.daemon,
      'Start one with `crosstalk up`, or set CROSSTALK_URL if it is running elsewhere.',
    );
  }
}

export async function resolveToken(repo: string, as: string | undefined): Promise<string> {
  const fromEnv = process.env['CROSSTALK_TOKEN'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.trim();

  if (as === undefined) {
    throw new CliError(
      'No participant identity',
      EXIT.usage,
      'Pass `--as <id>`, or set CROSSTALK_TOKEN. The daemon derives who you are from the token, so it cannot guess.',
    );
  }

  const path = join(stateDir(repo), 'tokens', tokenFilename(as));
  try {
    const token = (await readFile(path, 'utf8')).trim();
    if (token === '') throw new Error('empty');
    return token;
  } catch {
    throw new CliError(
      `No token for "${as}"`,
      EXIT.auth,
      `Expected it at ${path}. Run \`crosstalk init\`, or check the id against \`ct roster\`.`,
    );
  }
}

export interface WireFailure {
  error: { domain: 'protocol' | 'daemon'; code: string; message: string; url?: string };
}

/** Maps the daemon's status back onto the exit codes the contract publishes. */
export function exitCodeFor(status: number): number {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 409 || status === 422) return EXIT.protocol;
  if (status === 400 || status === 404) return EXIT.usage;
  return EXIT.daemon;
}

export class DaemonClient {
  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  static async open(repo: string, as: string | undefined): Promise<DaemonClient> {
    return new DaemonClient(await resolveUrl(repo), await resolveToken(repo, as));
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new CliError(
        `Cannot reach the daemon at ${this.url}`,
        EXIT.daemon,
        `It may have stopped. Run \`crosstalk up\`. (${(cause as Error).message})`,
      );
    }

    const raw = await response.text();
    if (response.ok) return raw === '' ? {} : JSON.parse(raw);

    let failure: WireFailure | undefined;
    try {
      failure = JSON.parse(raw) as WireFailure;
    } catch {
      /* a non-JSON error body is still an error */
    }

    const code = failure?.error?.code ?? `HTTP_${response.status}`;
    const detail = failure?.error?.message ?? raw.slice(0, 200);
    throw new CliError(`${code}: ${detail}`, exitCodeFor(response.status));
  }

  get<T>(path: string): Promise<T> {
    return this.request('GET', path) as Promise<T>;
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request('POST', path, body) as Promise<T>;
  }
}

export interface WriteResult {
  events: CrosstalkEvent[];
}
