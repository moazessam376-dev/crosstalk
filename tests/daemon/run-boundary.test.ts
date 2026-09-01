import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { isRunStart } from '../../src/core/runs.js';

/**
 * A run is a range of the log, and every reader stops at its edge.
 *
 * Measured before this existed: the operator's daemon had been up for a day
 * serving a repository whose `events.jsonl` held 1187 events, and every page
 * load replayed all of them, because `GET /stream` without a `since` starts at
 * seq 1 and the hub never sent one. "Every time I access crosstalk I get the
 * last session's stuff."
 *
 * The half that is easy to get wrong is not the read window. `#state` is a
 * projection of the *whole* log, so clamping reads alone would leave
 * `/board` showing the previous run's tasks and — the one that is a correctness
 * bug rather than a display one — `assertedGates` scanning every `#floor`
 * message for `ref: gate:<id>`, so a previous run's gate assertion marks this
 * run's gate met. The boundary resets the projection; that is what these tests
 * are mostly about.
 */

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
shape: trio-contract
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
  - id: peer-2
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
  - id: lead
    role: leader
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
`;

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-runs-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

async function open(dir: string): Promise<DaemonHandle> {
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

async function say(daemon: DaemonHandle, body: string, who = '@human', extra: object = {}): Promise<void> {
  const response = await fetch(`${daemon.url}/events`, {
    method: 'POST',
    headers: auth(daemon, who),
    body: JSON.stringify({ kind: 'message', room: '#floor', body, ...extra }),
  });
  if (!response.ok) throw new Error(`say failed: ${response.status} ${await response.text()}`);
}

async function beginRun(daemon: DaemonHandle, job?: string): Promise<void> {
  const response = await fetch(`${daemon.url}/runs`, {
    method: 'POST',
    headers: auth(daemon),
    body: JSON.stringify(job === undefined ? {} : { job }),
  });
  if (!response.ok) throw new Error(`begin failed: ${response.status} ${await response.text()}`);
}

/** A task, which only the leader may create — hence the `lead` seat above. */
async function task(daemon: DaemonHandle, id: string, title: string): Promise<Response> {
  return fetch(`${daemon.url}/tasks`, {
    method: 'POST',
    headers: auth(daemon, 'lead'),
    body: JSON.stringify({
      id,
      title,
      brief: 'the slice',
      assignee: 'peer-1',
      branch: `ct/${id}`,
    }),
  });
}

async function eventsSince(daemon: DaemonHandle, since: number): Promise<CrosstalkEvent[]> {
  const response = await fetch(`${daemon.url}/events?since=${since}`, { headers: auth(daemon) });
  return ((await response.json()) as { events: CrosstalkEvent[] }).events;
}

/** Everything the stream replays to a client that claims to have seen nothing. */
async function streamReplay(daemon: DaemonHandle, lastEventId = '0'): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(`${daemon.url}/stream`, {
    headers: { ...auth(daemon), 'last-event-id': lastEventId },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  let text = '';
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((done) =>
        setTimeout(() => done({ done: true, value: undefined }), 300),
      ),
    ]);
    if (next.done === true) break;
    text += new TextDecoder().decode(next.value);
  }
  controller.abort();
  return text;
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

describe('reading across a run boundary', () => {
  it('does not serve the previous run to a reader asking from zero', async () => {
    const daemon = await open(await repo());
    await say(daemon, 'the previous run said this');
    await beginRun(daemon);
    await say(daemon, 'and this run says that');

    const events = await eventsSince(daemon, 0);
    const text = JSON.stringify(events);
    expect(text).not.toContain('the previous run said this');
    expect(text).toContain('and this run says that');
  }, 30_000);

  it('still serves this run when asked from inside it', async () => {
    // The neighbouring case: a clamp that returns nothing would pass the test
    // above and be useless. Paging within the current run has to keep working.
    const daemon = await open(await repo());
    await beginRun(daemon);
    await say(daemon, 'first in the run');
    await say(daemon, 'second in the run');

    const all = await eventsSince(daemon, 0);
    const marker = all.find((event) => isRunStart(event))!;
    const after = await eventsSince(daemon, marker.seq);

    expect(JSON.stringify(after)).toContain('first in the run');
    expect(JSON.stringify(after)).toContain('second in the run');
  }, 30_000);

  it('clamps a stale Last-Event-ID instead of replaying from it', async () => {
    // A browser that was connected during the previous run reconnects with the
    // seq it last saw. Honouring it verbatim replays the run that just ended.
    const daemon = await open(await repo());
    await say(daemon, 'the previous run said this');
    await beginRun(daemon);
    await say(daemon, 'and this run says that');

    const replay = await streamReplay(daemon, '0');
    expect(replay).not.toContain('the previous run said this');
    expect(replay).toContain('and this run says that');
  }, 30_000);

  it('does not hand a seat the previous run, even when it asks from zero', async () => {
    // `src/mcp/tools.ts` exposes `since` on the inbox tool, so this is reachable
    // by any agent, not just by a hand-written request.
    const daemon = await open(await repo());
    await say(daemon, 'the previous run said this');
    await beginRun(daemon);

    const response = await fetch(`${daemon.url}/await?since=0&timeout_s=0`, {
      headers: auth(daemon, 'peer-1'),
    });
    expect(JSON.stringify(await response.json())).not.toContain('the previous run said this');
  }, 30_000);
});

describe('the board across a run boundary', () => {
  it('starts empty, and fills with what this run does', async () => {
    const daemon = await open(await repo());
    const created = await task(daemon, 'T-1', 'from the previous run');
    expect(created.ok).toBe(true);

    const before = await (await fetch(`${daemon.url}/board`, { headers: auth(daemon) })).json();
    expect(JSON.stringify(before)).toContain('from the previous run');

    await beginRun(daemon);

    const after = await (await fetch(`${daemon.url}/board`, { headers: auth(daemon) })).json();
    expect(JSON.stringify(after)).not.toContain('from the previous run');

    // And the neighbouring case, so "empty board" is not the whole behaviour.
    expect((await task(daemon, 'T-2', 'from this run')).ok).toBe(true);
    const now = await (await fetch(`${daemon.url}/board`, { headers: auth(daemon) })).json();
    expect(JSON.stringify(now)).toContain('from this run');
  }, 30_000);

  it('does not let a previous run\'s gate assertion satisfy this run\'s gate', async () => {
    // The reason the boundary resets the projection rather than filtering
    // reads. `assertedGates` scans every `#floor` message for `ref: gate:<id>`
    // with no notion of when — so without the reset, a team that asserted
    // `contract-exists` yesterday starts today with it already met.
    const daemon = await open(await repo());
    await say(daemon, 'the contract is frozen', '@human', { ref: 'gate:contract-exists' });

    const before = await (await fetch(`${daemon.url}/phase`, { headers: auth(daemon, 'peer-1') })).json();
    expect(JSON.stringify(before)).toContain('contract-exists');

    await beginRun(daemon);

    const after = (await (
      await fetch(`${daemon.url}/phase`, { headers: auth(daemon, 'peer-1') })
    ).json()) as { gates?: { id: string; met: boolean }[] };
    const gate = after.gates?.find((entry) => entry.id === 'contract-exists');
    expect(gate?.met ?? false).toBe(false);
  }, 30_000);
});

describe('a run boundary that outlives the daemon', () => {
  it('is recovered from the log, not held in memory', async () => {
    const dir = await repo();
    const first = await open(dir);
    await say(first, 'the previous run said this');
    await beginRun(first);
    await say(first, 'and this run says that');
    await first.close();
    daemons.pop();

    const second = await open(dir);
    const text = JSON.stringify(await eventsSince(second, 0));
    expect(text).not.toContain('the previous run said this');
    expect(text).toContain('and this run says that');
  }, 30_000);

  it('reissues participant_joined, so the roster is this run\'s', async () => {
    // `#joins` is an in-flight map that survives a launch, so without clearing
    // it a new run emits no joins at all and the hub shows the previous run's
    // participants — present on a board they were never in.
    const daemon = await open(await repo());
    await fetch(`${daemon.url}/inbox?wait=0`, { headers: auth(daemon, 'peer-1') });
    await beginRun(daemon);
    await fetch(`${daemon.url}/inbox?wait=0`, { headers: auth(daemon, 'peer-1') });

    const events = await eventsSince(daemon, 0);
    const joined = events.filter((event) => event.kind === 'participant_joined');
    expect(joined.map((event) => event.from)).toContain('peer-1');
  }, 30_000);

  it('wakes a parked seat instead of leaving it in a dead long poll', async () => {
    // A seat sitting in a 50s `/await` is not addressed by the marker and, once
    // the projection resets, is not a member of anything either — so without an
    // explicit release the new run opens with up to fifty seconds of silence.
    const daemon = await open(await repo());
    const parked = fetch(`${daemon.url}/await?timeout_s=30`, { headers: auth(daemon, 'peer-1') });
    await new Promise((done) => setTimeout(done, 200));

    const started = Date.now();
    await beginRun(daemon);
    await parked;
    // Elapsed, not just the value: the assertion is that it came back promptly.
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);
});

describe('putting a run away', () => {
  async function runs(daemon: DaemonHandle): Promise<{ id: string; archived: boolean; current: boolean; events: number }[]> {
    const response = await fetch(`${daemon.url}/runs`, { headers: auth(daemon) });
    return ((await response.json()) as { runs: never[] }).runs;
  }

  it('lists what is there, including the log that predates any boundary', async () => {
    // Every repository that existed before runs did is one long unnamed run.
    // Hiding it would be a worse answer than naming it: it is exactly the 1187
    // events the operator wanted to put away.
    const daemon = await open(await repo());
    await say(daemon, 'from before there were runs');
    expect((await runs(daemon)).map((run) => run.current)).toEqual([true]);

    await beginRun(daemon);
    const listed = await runs(daemon);
    expect(listed).toHaveLength(2);
    // Newest first.
    expect(listed[0]!.current).toBe(true);
    expect(listed[1]!.current).toBe(false);
  }, 30_000);

  it('moves a finished run out of the live log and keeps serving the current one', async () => {
    const dir = await repo();
    const daemon = await open(dir);
    await say(daemon, 'the previous run said this');
    await beginRun(daemon);
    await say(daemon, 'and this run says that');

    const older = (await runs(daemon)).find((run) => !run.current)!;
    const response = await fetch(`${daemon.url}/runs/${older.id}/archive`, {
      method: 'POST',
      headers: auth(daemon),
    });
    expect(response.status).toBe(200);

    // Off the live log...
    const live = await readFile(join(dir, '.crosstalk', 'events.jsonl'), 'utf8');
    expect(live).not.toContain('the previous run said this');
    expect(live).toContain('and this run says that');
    // ...and into its own file, still listed, still readable.
    const archived = await readFile(join(dir, '.crosstalk', 'runs', `${older.id}.jsonl`), 'utf8');
    expect(archived).toContain('the previous run said this');
    expect((await runs(daemon)).find((run) => run.id === older.id)?.archived).toBe(true);

    // And the board did not lose the run it is in.
    expect(JSON.stringify(await eventsSince(daemon, 0))).toContain('and this run says that');
  }, 30_000);

  it('refuses to archive the run being written to', async () => {
    const daemon = await open(await repo());
    await say(daemon, 'live');
    const current = (await runs(daemon)).find((run) => run.current)!;
    const response = await fetch(`${daemon.url}/runs/${current.id}/archive`, {
      method: 'POST',
      headers: auth(daemon),
    });
    expect(response.status).toBe(409);
  }, 30_000);

  it('will not delete without the id typed back, and will not delete what is not archived', async () => {
    const dir = await repo();
    const daemon = await open(dir);
    await say(daemon, 'the previous run said this');
    await beginRun(daemon);
    const older = (await runs(daemon)).find((run) => !run.current)!;

    // Not archived yet: there is nothing to delete, and the live log is not it.
    expect(
      (
        await fetch(`${daemon.url}/runs/${older.id}`, {
          method: 'DELETE',
          headers: auth(daemon),
          body: JSON.stringify({ confirm: older.id }),
        })
      ).status,
    ).toBe(409);

    await fetch(`${daemon.url}/runs/${older.id}/archive`, { method: 'POST', headers: auth(daemon) });

    // Archived, but unconfirmed — and `true` is not a confirmation.
    //
    // Not `r-00000000-0000-000000` in this list: that is the id the log before
    // the first boundary is given, so on this fixture it is the *right* answer.
    // It deleted the archive and the assertion caught it.
    for (const confirm of [undefined, true, 'yes', 'r-20990101-0000-abcdef']) {
      const response = await fetch(`${daemon.url}/runs/${older.id}`, {
        method: 'DELETE',
        headers: auth(daemon),
        body: JSON.stringify({ confirm }),
      });
      expect(response.status, JSON.stringify(confirm)).toBe(409);
    }
    expect(await readFile(join(dir, '.crosstalk', 'runs', `${older.id}.jsonl`), 'utf8')).toContain('previous run');

    const done = await fetch(`${daemon.url}/runs/${older.id}`, {
      method: 'DELETE',
      headers: auth(daemon),
      body: JSON.stringify({ confirm: older.id }),
    });
    expect(done.status).toBe(200);
    await expect(readFile(join(dir, '.crosstalk', 'runs', `${older.id}.jsonl`), 'utf8')).rejects.toThrow();
  }, 30_000);

  it('refuses a run id that is really a path', async () => {
    // The id reaches `join`, so it is validated as an id first. Encoded and
    // bare, because the router decodes.
    const daemon = await open(await repo());
    for (const hostile of ['..%2F..%2Fpackage.json', '..', '%2Fetc%2Fpasswd']) {
      const response = await fetch(`${daemon.url}/runs/${hostile}/archive`, {
        method: 'POST',
        headers: auth(daemon),
      });
      expect([404, 400], hostile).toContain(response.status);
    }
  }, 30_000);

  it('is the operator\'s to do, not a seat\'s', async () => {
    const daemon = await open(await repo());
    await beginRun(daemon);
    const older = (await runs(daemon)).find((run) => !run.current);
    const response = await fetch(`${daemon.url}/runs/${older?.id ?? 'x'}/archive`, {
      method: 'POST',
      headers: auth(daemon, 'peer-1'),
    });
    expect(response.status).toBe(403);
  }, 30_000);
});
