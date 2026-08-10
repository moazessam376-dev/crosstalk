import type { CrosstalkEvent } from '../contracts/events.js';

export interface WriteResponse {
  events: CrosstalkEvent[];
}

export interface EventsResponse {
  events: CrosstalkEvent[];
  lastSeq: number;
}

export type AwaitResponse = { events: CrosstalkEvent[] } | { idle: true };

/**
 * A daemon refusal, carried through with its own vocabulary intact.
 *
 * The daemon answers `EVENT_KIND_NOT_APPENDABLE` with a message naming the
 * route that *would* have worked. Collapsing that into "request failed" is the
 * failure worth defending against — not a hostile agent, but a capable one that
 * found the wrong door and got an unhelpful answer. Contract §4, §8.
 */
export class DaemonRequestError extends Error {
  constructor(
    readonly status: number,
    readonly domain: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonRequestError';
  }
}

interface WireError {
  error?: { domain?: unknown; code?: unknown; message?: unknown };
}

export class DaemonClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    return this.request<T>('GET', path + searchSuffix(query), undefined);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    if (!response.ok) throw toError(response.status, text);
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
}

function toError(status: number, text: string): DaemonRequestError {
  let parsed: WireError | undefined;
  try {
    parsed = JSON.parse(text) as WireError;
  } catch {
    parsed = undefined;
  }

  const error = parsed?.error;
  const domain = typeof error?.domain === 'string' ? error.domain : 'transport';
  const code = typeof error?.code === 'string' ? error.code : `HTTP_${status}`;
  const message = typeof error?.message === 'string' ? error.message : text || `HTTP ${status}`;

  return new DaemonRequestError(status, domain, code, message);
}

function searchSuffix(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const rendered = params.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

/**
 * Room ids carry `#`, `:` and `~`. Unencoded, `#floor` in a URL path is an
 * empty path plus a fragment and the `#` never reaches the server — which fails
 * silently rather than loudly, so it gets its own function and its own test.
 * Contract §5.2.
 */
export function roomPath(room: string): string {
  return `/rooms/${encodeURIComponent(room)}/events`;
}
