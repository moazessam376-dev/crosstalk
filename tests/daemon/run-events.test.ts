import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';

/**
 * Opening a finished run.
 *
 * The run picker listed older runs and clicking one did nothing: `onView` was
 * never wired and no route stood behind it. A menu whose rows are inert is the
 * "control that cannot work" failure this project exists to catch, and it is
 * worse here than most — the operator's whole complaint was that they could
 * not get *away* from the last session, and the fix would have left them
 * unable to get back to it.
 *
 * This is the deliberate exception to the read clamps. Those exist so a live
 * reader never sees across a run boundary by accident; this is the operator
 * asking, by name, for one specific finished run.
 */

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
  - id: peer-1
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
`;

async function open(): Promise<DaemonHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-runview-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  const daemon = await startDaemon({ repo: dir });
  daemons.push(daemon);
  return daemon;
}

function auth(daemon: DaemonHandle, who = '@human'): Record<string, string> {
  return {
    authorization: `Bearer ${daemon.tokens.get(who)!}`,
    'content-type': 'application/json',
  };
}

async function say(daemon: DaemonHandle, body: string): Promise<void> {
  await fetch(`${daemon.url}/events`, {
    method: 'POST',
    headers: auth(daemon),
    body: JSON.stringify({ kind: 'message', room: '#floor', body }),
  });
}

async function newRun(daemon: DaemonHandle): Promise<void> {
  await fetch(`${daemon.url}/runs`, { method: 'POST', headers: auth(daemon), body: '{}' });
}

async function runIds(daemon: DaemonHandle): Promise<{ id: string; current: boolean }[]> {
  const response = await fetch(`${daemon.url}/runs`, { headers: auth(daemon) });
  return ((await response.json()) as { runs: { id: string; current: boolean }[] }).runs;
}

async function eventsOf(daemon: DaemonHandle, runId: string, who = '@human'): Promise<Response> {
  return fetch(`${daemon.url}/runs/${encodeURIComponent(runId)}/events`, {
    headers: auth(daemon, who),
  });
}

function bodies(events: CrosstalkEvent[]): string[] {
  return events
    .map((event) => (event as { body?: string }).body)
    .filter((body): body is string => body !== undefined);
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

describe('reading one finished run', () => {
  it('returns that run’s events and stops at the next boundary', async () => {
    const daemon = await open();
    await say(daemon, 'first run');
    await newRun(daemon);
    await say(daemon, 'second run');
    await newRun(daemon);
    await say(daemon, 'third run');

    const runs = await runIds(daemon);
    const middle = runs.filter((run) => !run.current)[0]!;
    const events = ((await (await eventsOf(daemon, middle.id)).json()) as { events: CrosstalkEvent[] }).events;

    expect(bodies(events)).toContain('second run');
    // The boundary is what the clamp is for, and both edges matter: an
    // off-by-one at the start swallows the previous run's tail, and one at the
    // end swallows this run's own.
    expect(bodies(events)).not.toContain('first run');
    expect(bodies(events)).not.toContain('third run');
  }, 30_000);

  it('reads a run that has been archived out of the live log', async () => {
    const daemon = await open();
    await say(daemon, 'the archived one');
    await newRun(daemon);
    await say(daemon, 'the live one');

    const older = (await runIds(daemon)).find((run) => !run.current)!;
    await fetch(`${daemon.url}/runs/${older.id}/archive`, { method: 'POST', headers: auth(daemon) });

    const events = ((await (await eventsOf(daemon, older.id)).json()) as { events: CrosstalkEvent[] }).events;
    expect(bodies(events)).toContain('the archived one');
    // And the live log no longer has it, which is what makes this the archive
    // being read rather than the log.
    const live = await fetch(`${daemon.url}/events?since=0`, { headers: auth(daemon) });
    expect(JSON.stringify(await live.json())).not.toContain('the archived one');
  }, 30_000);

  it('reads the current run too, so the picker has one behaviour', async () => {
    const daemon = await open();
    await say(daemon, 'right now');

    const current = (await runIds(daemon)).find((run) => run.current)!;
    const events = ((await (await eventsOf(daemon, current.id)).json()) as { events: CrosstalkEvent[] }).events;

    expect(bodies(events)).toContain('right now');
  }, 30_000);

  it('refuses an id that is not one, before it can become a path', async () => {
    const daemon = await open();
    for (const id of ['../../events', '..%2f..%2fevents.jsonl', 'nope']) {
      const response = await eventsOf(daemon, id);
      expect(response.status, id).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code, id).toBe('UNKNOWN_RUN');
    }
  }, 30_000);

  it('is the operator’s, not a seat’s', async () => {
    // Every run-shaped action is the operator's. A seat reading across a
    // boundary by asking for another run by name would be the exact hole the
    // clamps exist to close — the operator said archiving must mean "the
    // agents are not reading the old events".
    const daemon = await open();
    await say(daemon, 'private to this run');
    const current = (await runIds(daemon)).find((run) => run.current)!;

    const response = await eventsOf(daemon, current.id, 'peer-1');

    expect(response.status).toBe(403);
  }, 30_000);
});
