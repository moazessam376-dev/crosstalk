import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SUBSCRIBER_BACKLOG,
  backlogOf,
  startDaemon,
  writeFrame,
  type DaemonHandle,
} from '../../src/daemon/server.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { ServerResponse } from 'node:http';

/**
 * A subscriber that stops reading must not be able to grow the daemon without
 * bound.
 *
 * SSE has no application-level backpressure. `response.write` returns false
 * when the socket is full and Node buffers the remainder in memory with no
 * signal that anything is wrong, so a client that connects and never reads — a
 * suspended laptop, a frozen tab, a `curl` piped into something stalled — is
 * indistinguishable from a healthy one until the process dies. Measured before
 * the fix: one such client queued 704 MB in five seconds.
 *
 * Dropping it is safe because resume exists. `id:` is the seq and the stream
 * replays from the log on reconnect, so a subscriber that cannot keep up loses
 * its socket and no events.
 */

const dirs: string[] = [];

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
  - id: leader
    role: leader
    harness: claude-code-app
    lifecycle: attached
    workspace: .
`;

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-backpressure-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    await rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('the drop threshold', () => {
  /**
   * A fake response whose socket reports whatever backlog the test wants.
   *
   * The real flood is not reproducible under the test runner — it throttles the
   * writes well below the threshold, and an earlier version of this file
   * "passed" identically with the fix removed, which is worse than no test. So
   * the decision is pinned here and the plumbing was measured by hand against
   * the built daemon: 60 frames of 60 KB queue ~2.8 MB on a paused
   * subscriber's socket, and a few hundred trips the cap and closes it.
   */
  function responseWithBacklog(bytes: number): ServerResponse {
    return {
      write: () => true,
      socket: { writableLength: bytes },
    } as unknown as ServerResponse;
  }

  const event = { seq: 1, kind: 'message', room: '#floor', from: '@human', ts: '', body: 'x' } as unknown as CrosstalkEvent;

  it('keeps a subscriber that is keeping up', () => {
    expect(writeFrame(responseWithBacklog(0), event)).toBe(true);
    expect(writeFrame(responseWithBacklog(MAX_SUBSCRIBER_BACKLOG), event)).toBe(true);
  });

  it('drops one that is further behind than the cap', () => {
    expect(writeFrame(responseWithBacklog(MAX_SUBSCRIBER_BACKLOG + 1), event)).toBe(false);
  });

  /**
   * The bug this replaced measured `response.writableLength`, which is the
   * `OutgoingMessage`'s own buffer. It flushes into the socket eagerly and so
   * sits near zero however far behind the reader is — 400 frames and 24 MB of
   * real backlog never moved it off zero. The queue that grows is the socket's.
   */
  it('reads the backlog off the socket, not off the response', () => {
    expect(backlogOf(responseWithBacklog(4096))).toBe(4096);
    // A response whose socket has already gone is not "infinitely behind".
    expect(backlogOf({ socket: null } as unknown as ServerResponse)).toBe(0);
  });
});

describe('a subscriber that reads', () => {
  it('keeps serving events to a subscriber that does read', async () => {
    const dir = await tempRepo();
    const daemon: DaemonHandle = await startDaemon({ repo: dir });
    try {
      const token = daemon.tokens.get('@human')!;
      const response = await fetch(`${daemon.url}/stream`, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      });
      const reader = response.body!.getReader();

      await fetch(`${daemon.url}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'message', room: '#floor', body: 'still here' }),
      });

      let seen = '';
      while (!seen.includes('still here')) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      expect(seen).toContain('still here');
      await reader.cancel();
    } finally {
      await daemon.close();
    }
  }, 20_000);
});
