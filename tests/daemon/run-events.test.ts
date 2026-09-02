import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { RunSummary } from '../../src/core/runs.js';

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

async function runIds(daemon: DaemonHandle): Promise<RunSummary[]> {
  const response = await fetch(`${daemon.url}/runs`, { headers: auth(daemon) });
  return ((await response.json()) as { runs: RunSummary[] }).runs;
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

describe('archiving a run that has older runs beneath it', () => {
  it('keeps each run in its own file, and loses none of them', async () => {
    /**
     * The defect this exists for, measured before the fix:
     *
     * `archiveBefore` moves a *prefix* of the log, so archiving the middle run
     * of three swept the first run's events into the middle run's file. The
     * first run vanished from `/runs`, its id became unreachable, and nothing
     * said so — one archive of 7 events where there should have been two, of 3
     * and 4. Silent, and it destroys the operator's ability to find a run.
     *
     * A prefix structure means "put this one away" has to mean "and the ones
     * before it": they cannot stay in a live log the prefix has been cut out
     * of. So they all go, each into the file named after it.
     */
    const daemon = await open();
    await say(daemon, 'run one');
    await newRun(daemon);
    await say(daemon, 'run two');
    await newRun(daemon);
    await say(daemon, 'run three');

    const before = await runIds(daemon);
    expect(before).toHaveLength(3);
    // The *newest* finished run — the one an operator reaches for first,
    // because the picker lists newest first.
    const middle = before.filter((run) => !run.current)[0]!;
    const oldest = before.filter((run) => !run.current).at(-1)!;

    const response = await fetch(`${daemon.url}/runs/${middle.id}/archive`, {
      method: 'POST',
      headers: auth(daemon),
    });
    expect(response.status).toBe(200);

    // Still three runs. The older one is archived too — it had to be, since
    // its events are below the prefix that moved — but it is still itself.
    const after = await runIds(daemon);
    expect(after).toHaveLength(3);
    expect(after.map((run) => run.id).sort()).toEqual(before.map((run) => run.id).sort());

    // And each file holds its own run, not both.
    const middleEvents = ((await (await eventsOf(daemon, middle.id)).json()) as { events: CrosstalkEvent[] }).events;
    const oldestEvents = ((await (await eventsOf(daemon, oldest.id)).json()) as { events: CrosstalkEvent[] }).events;
    expect(bodies(middleEvents)).toContain('run two');
    expect(bodies(middleEvents)).not.toContain('run one');
    expect(bodies(oldestEvents)).toContain('run one');
    expect(bodies(oldestEvents)).not.toContain('run two');
  }, 30_000);

  it('leaves the current run alone', async () => {
    // The neighbouring case: "and the ones before it" must not become "and
    // everything", or archiving would take the run being written to.
    //
    // Honest about what this pins: no single-line mutation kills it. Dropping
    // `!entry.current` from the filter is a no-op, because a current run has no
    // `endedSeq` and falls back to its own `firstSeq` — which archives
    // everything *below* it, exactly as before. The current run is protected by
    // the refusal at the top of `#archiveRun` and by that fallback, and the
    // filter is defence in depth. This is here as a behaviour check on the
    // outcome, not as a test of one line.
    const daemon = await open();
    await say(daemon, 'run one');
    await newRun(daemon);
    await say(daemon, 'still going');

    const older = (await runIds(daemon)).find((run) => !run.current)!;
    await fetch(`${daemon.url}/runs/${older.id}/archive`, { method: 'POST', headers: auth(daemon) });

    const current = (await runIds(daemon)).find((run) => run.current)!;
    expect(current.archived).toBe(false);
    const live = await fetch(`${daemon.url}/events?since=0`, { headers: auth(daemon) });
    expect(JSON.stringify(await live.json())).toContain('still going');
  }, 30_000);
});
