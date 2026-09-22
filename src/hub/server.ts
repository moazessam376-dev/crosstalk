import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HUMAN } from '../board/agents.js';
import { Board } from '../board/board.js';
import { BoardError, isRecord } from '../board/fsutil.js';
import { merge, readFrom, senders, type Line } from '../board/messages.js';
import { currentRun, listRuns, openRun, runPaths } from '../board/runs.js';
import { waitForChange } from '../board/wait.js';
import { PAGE } from './page.js';

export interface Hub {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;
const HEARTBEAT_MS = 15_000;

export async function startHub(root: string, options: { port?: number; host?: string } = {}): Promise<Hub> {
  const token = randomBytes(16).toString('hex');
  const board = new Board(root);
  const closing = new AbortController();

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://hub');
    if (url.pathname === '/' && url.searchParams.get('t') === token) {
      response.writeHead(302, { 'set-cookie': `ct=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
      response.end();
      return;
    }
    if (!hasToken(request, token)) {
      reply(response, 403, 'text/plain', 'Open the hub from the URL that `ct hub` printed.');
      return;
    }

    const route = `${request.method ?? 'GET'} ${url.pathname}`;
    if (route === 'GET /') return reply(response, 200, 'text/html; charset=utf-8', PAGE);
    if (route === 'GET /api/runs') {
      return json(response, 200, { current: (await currentRun(root))?.id ?? null, runs: await listRuns(root) });
    }
    if (route === 'GET /api/stream') return stream(request, response, url.searchParams.get('run'));
    if (route === 'POST /api/send') {
      try {
        const body = await readBody(request);
        const result = await board.send(HUMAN, String(body['to'] ?? ''), String(body['text'] ?? ''));
        return json(response, 200, { result });
      } catch (error) {
        if (error instanceof BoardError) return json(response, 400, { error: error.message });
        throw error;
      }
    }
    return reply(response, 404, 'text/plain', 'not found');
  }

  async function stream(request: IncomingMessage, response: ServerResponse, id: string | null): Promise<void> {
    const run = id === null || id === '' ? await currentRun(root) : await openRun(root, id);
    if (run === undefined) return json(response, 404, { error: 'no run yet' });
    const { msgs } = runPaths(run);

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    const gone = new AbortController();
    request.on('close', () => gone.abort());
    const stop = (): void => gone.abort();
    closing.signal.addEventListener('abort', stop, { once: true });

    const offsets: Record<string, number> = {};
    while (!gone.signal.aborted) {
      const queues = new Map<string, Line[]>();
      for (const sender of await senders(msgs)) {
        const chunk = await readFrom(msgs, sender, offsets[sender] ?? 0);
        offsets[sender] = chunk.end;
        queues.set(sender, chunk.lines);
      }
      for (const line of merge(queues)) write(response, `data: ${JSON.stringify(line.msg)}\n\n`);
      await waitForChange(msgs, HEARTBEAT_MS, gone.signal);
      write(response, ':hb\n\n');
    }
    closing.signal.removeEventListener('abort', stop);
    if (!response.writableEnded) response.end();
  }

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, host, () => done());
  });
  const { port } = server.address() as AddressInfo;
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    url: `http://${shown}:${port}/?t=${token}`,
    close: async () => {
      closing.abort();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function hasToken(request: IncomingMessage, token: string): boolean {
  return (request.headers.cookie ?? '').split(';').some((part) => part.trim() === `ct=${token}`);
}

function write(response: ServerResponse, text: string): void {
  if (!response.writableEnded && !response.destroyed) response.write(text);
}

function reply(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type });
  response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  reply(response, status, 'application/json', JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BoardError('message too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
