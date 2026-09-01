import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { Inbox } from '../../src/core/inbox.js';

/**
 * `GET /inbox` must not answer an unchanged standing status instantly.
 *
 * It returned as soon as `next` was anything but `idle`, and with a shape
 * configured `next` is the phase status — an unmet gate, which stays unmet
 * until somebody meets it. So every poll came back at once with nothing unread,
 * the wake loop wrote a turn and polled again, and the pair span as fast as
 * HTTP allowed. Every seat's composer filled with the same sentence.
 *
 * A change in status is news. The same status is not.
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
`;

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-inbox-spin-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function inboxOf(daemon: DaemonHandle, who: string, timeoutS: number): Promise<Inbox> {
  const response = await fetch(`${daemon.url}/inbox?timeout_s=${timeoutS}`, {
    headers: { authorization: `Bearer ${daemon.tokens.get(who)!}` },
  });
  return (await response.json()) as Inbox;
}

describe('polling a seat with an unmet gate', () => {
  it('answers the first time, so a seat learns what is blocking it', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    const first = await inboxOf(daemon, 'peer-1', 1);
    expect(first.next).toBeDefined();
    expect(first.next).not.toBe('idle');
  }, 20_000);

  /**
   * The spin, pinned. Asking again with the same gate unmet has to block for
   * the timeout rather than return at once — that difference is the whole bug.
   */
  it('blocks on the second ask rather than answering the same thing again', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    await inboxOf(daemon, 'peer-1', 1);

    const started = Date.now();
    await inboxOf(daemon, 'peer-1', 1);
    const waited = Date.now() - started;

    // It held the poll open. Before the fix this came back in single-digit ms,
    // and the loop above it wrote a turn every time it did.
    expect(waited).toBeGreaterThan(700);
  }, 20_000);

  /** Per seat: what blocks one is not what the next one has been told. */
  it('still answers a different seat that has not been told yet', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    await inboxOf(daemon, 'peer-1', 1);

    const started = Date.now();
    const other = await inboxOf(daemon, 'peer-2', 1);
    expect(Date.now() - started).toBeLessThan(700);
    expect(other.next).not.toBe('idle');
  }, 20_000);

  /** Something actually said still arrives at once, however stale the status. */
  it('returns immediately when there is something unread', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    await inboxOf(daemon, 'peer-1', 1);

    await fetch(`${daemon.url}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemon.tokens.get('@human')!}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'message', room: '#floor', body: 'start now' }),
    });

    const started = Date.now();
    const next = await inboxOf(daemon, 'peer-1', 5);
    expect(Date.now() - started).toBeLessThan(700);
    expect(next.unread.length).toBeGreaterThan(0);
  }, 20_000);
});
