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
export interface AttachmentRecord {
  sha: string;
  name: string;
  type: string;
  bytes: number;
}

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
  /**
   * The identity this client's token resolved to, as the daemon reports it.
   *
   * Undefined until the first response, because it is the daemon's answer and
   * not something the client may assume: which participant a token belongs to
   * depends on which `.mcp.json` the harness found, and that is precisely the
   * thing agents have been getting wrong.
   */
  you: string | undefined;

  /**
   * Things the daemon noticed about this process rather than this request —
   * currently, running outside the workspace the config declares for `you`.
   * Replaced per response, not accumulated: it is a statement about now.
   */
  warnings: string[] = [];

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Send a file the seat already has on disk, and get back the record for it.
   *
   * The MCP server runs in the seat's own process on the same machine as the
   * daemon, so a path is all an agent needs to spend — it never pays the
   * tokens of a base64 blob, which for a screenshot is most of a context
   * window for something it was not asked to look at.
   */
  async putFile(bytes: Uint8Array, type: string, name: string): Promise<AttachmentRecord> {
    const response = await this.fetchImpl(`${this.url}/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': type,
        // Percent-encoded for the same reason `x-crosstalk-cwd` is: header
        // values are Latin-1 and a filename is not guaranteed to be.
        'x-crosstalk-filename': encodeURIComponent(name),
        'x-crosstalk-cwd': encodeURIComponent(process.cwd()),
      },
      // A view over the file's bytes. Typed loosely because `BodyInit` is a
      // DOM lib type this project's tsconfig does not pull in.
      body: bytes as unknown as Parameters<typeof fetch>[1] extends { body?: infer B } ? B : never,
    });
    const text = await response.text();
    if (!response.ok) throw toError(response.status, text);
    return (JSON.parse(text) as { attachment: AttachmentRecord }).attachment;
  }

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
        // CT-9. The daemon knows where the config says this participant should
        // be; only the process knows where it actually is. Sent on every
        // request rather than once on connect, because the MCP server is
        // long-lived and a harness that relocates mid-session is the exact
        // case that caused this.
        //
        // Percent-encoded: header values are Latin-1 and a path is not
        // guaranteed to be, so an accented directory name would otherwise
        // throw inside `fetch` and take every tool call with it.
        'x-crosstalk-cwd': encodeURIComponent(process.cwd()),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    // Captured before the ok-check: a refusal is exactly when knowing which
    // identity the token resolved to matters most.
    const you = response.headers.get('x-crosstalk-you');
    if (you !== null) this.you = you;

    // Percent-encoded by the daemon, because header values are Latin-1 and
    // these sentences are not.
    const warned = response.headers.get('x-crosstalk-warning');
    this.warnings = warned === null ? [] : warned.split(',').map(decodeURIComponent);

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
