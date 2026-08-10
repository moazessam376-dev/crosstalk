import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { EventsResponse, WireError, WriteResponse } from '../../src/daemon/contract.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: leader
    role: leader
    harness: claude-code-app
    lifecycle: attached
    workspace: .
  - id: codex
    role: worker
    harness: codex-app
    lifecycle: attached
    workspace: .crosstalk/worktrees/codex
`;

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-daemon-'));
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

/** Every test closes its daemon: an orphaned listener holds files open on Windows. */
async function withDaemon<T>(repo: string, fn: (d: DaemonHandle) => Promise<T>): Promise<T> {
  const daemon = await startDaemon({ repo });
  try {
    return await fn(daemon);
  } finally {
    await daemon.close();
  }
}

/**
 * Typed against the contract's own response types, so a change to the wire
 * shape stops this file compiling rather than failing at runtime somewhere else.
 */
async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function auth(daemon: DaemonHandle, id: string): Record<string, string> {
  return { authorization: `Bearer ${daemon.tokens.get(id)!}` };
}

async function post(
  daemon: DaemonHandle,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function allEvents(daemon: DaemonHandle, id: string): Promise<CrosstalkEvent[]> {
  const response = await fetch(`${daemon.url}/events`, { headers: auth(daemon, id) });
  return (await readJson<EventsResponse>(response)).events;
}

const seqsOf = (events: CrosstalkEvent[]): number[] => events.map((event) => event.seq);

describe('daemon', () => {
  it('mints one token per participant, not one shared token', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      expect([...daemon.tokens.keys()].sort()).toEqual(['codex', 'leader']);
      expect(daemon.tokens.get('leader')).not.toBe(daemon.tokens.get('codex'));
      const onDisk = await readFile(join(repo, '.crosstalk', 'tokens', 'codex'), 'utf8');
      expect(onDisk.trim()).toBe(daemon.tokens.get('codex'));
    });
  });

  it('binds loopback and writes a token-free daemon.json', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const raw = await readFile(join(repo, '.crosstalk', 'daemon.json'), 'utf8');
      expect(JSON.parse(raw)).toMatchObject({ version: 1, url: daemon.url, pid: process.pid });
      // Discovery must not hand a reader everyone's identity.
      for (const token of daemon.tokens.values()) expect(raw).not.toContain(token);
    });
  });

  it('refuses a second daemon on the same repo and reports the live url', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      await expect(startDaemon({ repo })).rejects.toMatchObject({
        code: 'DAEMON_ALREADY_RUNNING',
        url: daemon.url,
      });
    });
  });

  it('rejects a request with no bearer token', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      const response = await fetch(`${daemon.url}/events`);
      expect(response.status).toBe(401);
      const payload = await readJson<WireError>(response);
      expect(payload.error).toMatchObject({ domain: 'daemon', code: 'UNAUTHENTICATED' });
      // The refusal must not leak which tokens exist.
      for (const token of daemon.tokens.values()) {
        expect(JSON.stringify(payload)).not.toContain(token);
      }
    });
  });

  it('rejects an unknown bearer token', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      const response = await fetch(`${daemon.url}/events`, {
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(response.status).toBe(401);
    });
  });

  it('derives from from the token', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      const response = await post(
        daemon,
        '/events',
        { kind: 'message', room: '#floor', body: 'hello' },
        auth(daemon, 'codex'),
      );
      expect(response.status).toBe(201);
      const { events } = await readJson<WriteResponse>(response);
      expect(events.find((event) => event.kind === 'message')).toMatchObject({
        from: 'codex',
        room: '#floor',
        body: 'hello',
      });
    });
  });

  it('does not let a token speak as another participant', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      const author = async (id: string): Promise<string | undefined> => {
        const response = await post(
          daemon,
          '/events',
          { kind: 'message', room: '#floor', body: id },
          auth(daemon, id),
        );
        const { events } = await readJson<WriteResponse>(response);
        return events.find((event) => event.kind === 'message')?.from;
      };
      expect(await author('codex')).toBe('codex');
      expect(await author('leader')).toBe('leader');
    });
  });

  it('stamps participant_joined from the token, once per daemon lifetime', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      for (const body of ['one', 'two']) {
        await post(daemon, '/events', { kind: 'message', room: '#floor', body }, auth(daemon, 'codex'));
      }
      const joins = (await allEvents(daemon, 'codex')).filter(
        (event) => event.kind === 'participant_joined',
      );
      expect(joins).toHaveLength(1);
      expect(joins[0]).toMatchObject({ from: 'codex', participant: { id: 'codex', role: 'worker' } });
    });
  });

  it('rejects a payload that sets from rather than ignoring it', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      const response = await post(
        daemon,
        '/events',
        { kind: 'message', room: '#floor', body: 'spoofed', from: 'leader' },
        auth(daemon, 'codex'),
      );
      expect(response.status).toBe(403);
      expect((await readJson<WireError>(response)).error).toMatchObject({
        domain: 'daemon',
        code: 'FROM_NOT_ALLOWED',
      });
    });
  });

  it('refuses to append a protocol-bearing kind through POST /events, naming the route', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      const response = await post(
        daemon,
        '/events',
        {
          kind: 'claim_raised',
          claim: {
            id: 'C-999',
            raisedBy: 'codex',
            against: 'leader',
            target: 'src/x.ts:1',
            assertion: 'hand-built claim',
            severity: 'blocker',
            falsifier: '',
            evidence: [],
            state: 'open',
            rounds: 0,
          },
        },
        auth(daemon, 'codex'),
      );
      expect(response.status).toBe(422);
      const { error } = await readJson<WireError>(response);
      expect(error).toMatchObject({ domain: 'daemon', code: 'EVENT_KIND_NOT_APPENDABLE' });
      expect(error.message).toContain('POST /claims');

      // The forged claim — falsifier and all — must not have reached the log.
      expect((await allEvents(daemon, 'codex')).map((event) => event.kind)).not.toContain('claim_raised');
    });
  });

  it('treats since as exclusive', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      for (const body of ['one', 'two', 'three']) {
        await post(daemon, '/events', { kind: 'message', room: '#floor', body }, auth(daemon, 'leader'));
      }
      const seqs = seqsOf(await allEvents(daemon, 'leader'));
      expect(seqs.length).toBeGreaterThan(2);

      const pivot = seqs[1]!;
      const response = await fetch(`${daemon.url}/events?since=${pivot}`, {
        headers: auth(daemon, 'leader'),
      });
      const payload = await readJson<EventsResponse>(response);
      // Exclusive: the pivot itself must not come back, or every SSE reconnect
      // redelivers one event forever.
      expect(seqsOf(payload.events)).toEqual(seqs.filter((seq) => seq > pivot));
      expect(payload.lastSeq).toBe(seqs[seqs.length - 1]);
    });
  });

  it('returns the whole log when since is absent', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      await post(daemon, '/events', { kind: 'message', room: '#floor', body: 'x' }, auth(daemon, 'leader'));
      expect(seqsOf(await allEvents(daemon, 'leader'))[0]).toBe(1);
    });
  });

  it('reports lastSeq as the end of a truncated page, not the log tail', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      for (const body of ['a', 'b', 'c', 'd']) {
        await post(daemon, '/events', { kind: 'message', room: '#floor', body }, auth(daemon, 'leader'));
      }
      const page = await readJson<EventsResponse>(
        await fetch(`${daemon.url}/events?limit=2`, { headers: auth(daemon, 'leader') }),
      );
      expect(page.events).toHaveLength(2);
      expect(page.lastSeq).toBe(page.events[1]!.seq);

      // Paging on with since=lastSeq must not skip anything.
      const next = await readJson<EventsResponse>(
        await fetch(`${daemon.url}/events?since=${page.lastSeq}`, { headers: auth(daemon, 'leader') }),
      );
      expect(next.events[0]!.seq).toBe(page.lastSeq + 1);
    });
  });

  it('assigns seq through one log across concurrent writers', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          post(
            daemon,
            '/events',
            { kind: 'message', room: '#floor', body: `m${index}` },
            auth(daemon, index % 2 === 0 ? 'leader' : 'codex'),
          ),
        ),
      );
      const events = await allEvents(daemon, 'leader');
      // One writer, one sequence: contiguous from 1, no gaps and no duplicates.
      expect(seqsOf(events)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
      expect(events.filter((event) => event.kind === 'message')).toHaveLength(20);
    });
  });

  it('serves health without a token and leaks no log data', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      const response = await fetch(`${daemon.url}/health`);
      expect(response.status).toBe(200);
      const payload = await readJson<Record<string, unknown>>(response);
      expect(payload).toMatchObject({ ok: true, version: 1, pid: process.pid });
      expect(payload).not.toHaveProperty('lastSeq');
    });
  });

  it('rejects an unknown route', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      const response = await fetch(`${daemon.url}/nope`, { headers: auth(daemon, 'leader') });
      expect(response.status).toBe(404);
      expect((await readJson<WireError>(response)).error.code).toBe('UNKNOWN_ROUTE');
    });
  });

  it('releases the lock on close so the daemon can restart', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async () => {});
    await withDaemon(repo, async (daemon) => {
      expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });

  it('resumes seq from an existing log after restart', async () => {
    const repo = await tempRepo();
    let tailAfterFirstRun = 0;

    await withDaemon(repo, async (daemon) => {
      await post(daemon, '/events', { kind: 'message', room: '#floor', body: 'first' }, auth(daemon, 'leader'));
      const seqs = seqsOf(await allEvents(daemon, 'leader'));
      tailAfterFirstRun = seqs[seqs.length - 1]!;
    });

    await withDaemon(repo, async (daemon) => {
      await post(daemon, '/events', { kind: 'message', room: '#floor', body: 'second' }, auth(daemon, 'leader'));
      const events = await allEvents(daemon, 'leader');

      // Seq continues past the first run rather than restarting at 1, and the
      // whole log stays contiguous — a reset would silently overwrite history
      // in a file that is supposed to be append-only.
      expect(seqsOf(events)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
      expect(events.length).toBeGreaterThan(tailAfterFirstRun);
      expect(events.filter((event) => event.kind === 'message')).toHaveLength(2);
    });
  });

  it('keeps the log LF-terminated with no CR on any platform', async () => {
    const repo = await tempRepo();
    await withDaemon(repo, async (daemon) => {
      await post(daemon, '/events', { kind: 'message', room: '#floor', body: 'x' }, auth(daemon, 'leader'));
    });
    const raw = await readFile(join(repo, '.crosstalk', 'events.jsonl'), 'latin1');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.includes('\r')).toBe(false);
  });
});
