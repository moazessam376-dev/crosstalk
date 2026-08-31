import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { Inbox } from '../../src/core/inbox.js';

/**
 * A seat is not handed the history of runs it was not in.
 *
 * The delivery mark lives in memory and started at zero, and the event log is
 * append-only and kept across runs on purpose — `down` says so in as many
 * words. So every daemon start answered every seat's first poll with *the
 * entire log*: every message, every launch, every "supervised child exited"
 * from every previous attempt, rendered into a single turn and typed into the
 * seat's composer.
 *
 * The operator watched it grow all night — by the fourth launch, thirty-eight
 * events of someone else's finished argument pasted into a terminal they had
 * focused, before the team had read a line of its brief. It is also why
 * relaunching felt like landing back in the previous run: it was.
 *
 * A seat cannot have missed what was said before it existed.
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
  - id: peer-2
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
`;

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-replay-'));
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

async function say(daemon: DaemonHandle, body: string): Promise<void> {
  await fetch(`${daemon.url}/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${daemon.tokens.get('@human')!}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ kind: 'message', room: '#floor', body }),
  });
}

async function inboxOf(daemon: DaemonHandle, who: string): Promise<Inbox> {
  const response = await fetch(`${daemon.url}/inbox?wait=0`, {
    headers: { authorization: `Bearer ${daemon.tokens.get(who)!}` },
  });
  return (await response.json()) as Inbox;
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('a seat joining a daemon that has a past', () => {
  it('is not handed the log of a previous run', async () => {
    const dir = await repo();

    const first = await open(dir);
    await say(first, 'the previous run said this');
    await say(first, 'and this, at length');
    await first.close();
    daemons.pop();

    // A new daemon over the same repository — a relaunch, which is what the
    // operator did four times.
    const second = await open(dir);
    const inbox = await inboxOf(second, 'peer-1');

    const bodies = inbox.unread.map((card) => JSON.stringify(card));
    expect(bodies.join(' ')).not.toContain('the previous run said this');
    expect(inbox.unread).toHaveLength(0);
  }, 30_000);

  it('still delivers what is said after it starts', async () => {
    const dir = await repo();

    const first = await open(dir);
    await say(first, 'old news');
    await first.close();
    daemons.pop();

    const second = await open(dir);
    await inboxOf(second, 'peer-1');
    await say(second, 'this one is live');

    const inbox = await inboxOf(second, 'peer-1');
    expect(JSON.stringify(inbox.unread)).toContain('this one is live');
    expect(JSON.stringify(inbox.unread)).not.toContain('old news');
  }, 30_000);

  /**
   * The board keeps everything — that is the point of an append-only log, and
   * the operator still has to be able to read what happened. Only *delivery* is
   * bounded; nothing is deleted.
   */
  it('keeps the history readable, it just stops pushing it', async () => {
    const dir = await repo();

    const first = await open(dir);
    await say(first, 'the previous run said this');
    await first.close();
    daemons.pop();

    const second = await open(dir);
    const response = await fetch(`${second.url}/events?since=0`, {
      headers: { authorization: `Bearer ${second.tokens.get('@human')!}` },
    });
    expect(JSON.stringify(await response.json())).toContain('the previous run said this');
  }, 30_000);
});
