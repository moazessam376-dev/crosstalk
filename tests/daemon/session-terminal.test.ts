import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { openSession, type HarnessSession } from '../../src/harness/session.js';

/**
 * The three things a mirrored terminal could not do, against a real pty.
 *
 * All three were measured against a running hub before any of this was written:
 * a session that had printed 200 lines could be asked for 31 of them, a
 * keystroke took 1,009ms to appear while the pty round trip was 3ms, and every
 * seat ran at 32×110 no matter what window the operator had open.
 *
 * A shell rather than an agent CLI, for the same reason the neighbouring mirror
 * test uses one: it costs nothing, it is on every machine, and it emits exactly
 * the escapes under test when told to.
 */

/**
 * A budget that fits the slowest machine this runs on, not the fastest.
 *
 * Vitest's 5s default is a claim about how long a test may take, and every
 * test in this file spawns a real process on a real pty and waits for it to
 * paint. On Windows that is ConPTY plus a node start — measured at 6.9s for
 * the file against 0.9s here — so the default failed a passing test with
 * "timed out in 5000ms" while the code under test was fine. The hook budget
 * moves for the same reason: teardown now *waits* for each child to die.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const dirs: string[] = [];
const sessions: HarnessSession[] = [];

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
  - id: opus
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
`;

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-session-terminal-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

async function get(d: DaemonHandle, path: string): Promise<Response> {
  return fetch(`${d.url}${path}`, { headers: { authorization: `Bearer ${d.tokens.get('@human')!}` } });
}

async function post(d: DaemonHandle, path: string, body: unknown): Promise<Response> {
  return fetch(`${d.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${d.tokens.get('@human')!}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function until(check: () => Promise<boolean>, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error('timed out waiting for the session');
}

function seat(cwd: string, script: string): HarnessSession {
  const session = openSession({
    // `node -e` rather than `sh -c`: a mirror is a cross-platform claim, and
    // Windows has no `sh`, so these tests were simply absent on the platform
    // most likely to break a pty.
    argv: [process.execPath, '-e', script],
    cwd,
    first: '',
    turnFormat: 'interactive',
    readyDelayMs: 10 ** 6,
    capture: {},
  });
  sessions.push(session);
  return session;
}

afterEach(async () => {
  // Stop, then *wait* for the process to actually be gone. Windows refuses to
  // remove a directory any process still holds a handle on, and `stop()` only
  // sends the signal — so tearing down immediately raced the child's death and
  // failed with EBUSY on every one of these tests.
  const stopping = sessions.splice(0).map(async (session) => {
    session.stop();
    await Promise.race([session.exited, new Promise((done) => setTimeout(done, 2000))]);
  });
  await Promise.all(stopping);
  // `maxRetries` for the same reason: the handle can outlive the process by a
  // moment, and a retry is cheaper than a flake.
  while (dirs.length > 0) {
    await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('scrolling back through a seat', () => {
  it('serves lines that have left the screen', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'for (let i = 1; i <= 200; i++) console.log(`line-${i}`); setTimeout(() => {}, 30000);'));

      await until(async () => {
        const body = (await (await get(daemon, '/sessions/opus/screen')).json()) as {
          screen?: { rows: { text: string }[][] };
        };
        return JSON.stringify(body.screen?.rows ?? []).includes('line-200');
      });

      const page = (await (await get(daemon, '/sessions/opus/scrollback?from=0&count=3')).json()) as {
        captured: boolean;
        total: number;
        from: number;
        rows: { text: string }[][];
      };

      expect(page.captured).toBe(true);
      // The measured defect was 169 of 200 lines gone. line-1 has to be here.
      expect(page.total).toBeGreaterThan(150);
      expect(page.rows.map((row) => row.map((run) => run.text).join('').trim())).toEqual([
        'line-1',
        'line-2',
        'line-3',
      ]);
    } finally {
      await daemon.close();
    }
  });

  it('caps one response rather than shipping the whole buffer', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'for (let i = 1; i <= 2000; i++) console.log(`line-${i}`); setTimeout(() => {}, 30000);'));
      await until(async () => {
        const body = (await (await get(daemon, '/sessions/opus/scrollback?from=0&count=1')).json()) as {
          total?: number;
        };
        return (body.total ?? 0) > 1500;
      });

      const page = (await (await get(daemon, '/sessions/opus/scrollback?from=0&count=99999')).json()) as {
        rows: unknown[];
      };
      expect(page.rows.length).toBeLessThanOrEqual(500);
    } finally {
      await daemon.close();
    }
  });

  it('says so when a seat has no mirrored session at all', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      expect((await get(daemon, '/sessions/nobody/scrollback')).status).toBe(404);
    } finally {
      await daemon.close();
    }
  });
});

describe('streaming a seat', () => {
  it('pushes a frame without being asked again', async () => {
    // The whole point: the poll was clamped to a second by the browser, and a
    // keystroke that reached the pty in 3ms took 1,009ms to appear.
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'process.stdout.write("first"); setTimeout(() => process.stdout.write("\\nsecond"), 600); setTimeout(() => {}, 30000);'));

      const response = await get(daemon, '/sessions/opus/screen/stream');
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let seen = '';
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && !seen.includes('second')) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
      await reader.cancel();

      expect(seen).toContain('first');
      // The second frame arrived because the screen changed, not because
      // anything asked for it a second time.
      expect(seen).toContain('second');
      expect(seen.split('data: ').length).toBeGreaterThan(2);
    } finally {
      await daemon.close();
    }
  });

  it('404s for a seat this daemon does not hold', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      expect((await get(daemon, '/sessions/nobody/screen/stream')).status).toBe(404);
    } finally {
      await daemon.close();
    }
  });
});

describe('resizing a seat', () => {
  it('re-shapes the mirror to the window the operator actually has', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'setTimeout(() => {}, 30000);'));
      await until(async () => (await get(daemon, '/sessions/opus/screen')).ok);

      const answer = await post(daemon, '/sessions/opus/input', { rows: 44, cols: 160 });
      expect(answer.status).toBe(200);
      expect(await answer.json()).toMatchObject({ sent: 'resize' });

      const body = (await (await get(daemon, '/sessions/opus/screen')).json()) as {
        screen: { cols: number; rows: unknown[] };
      };
      expect(body.screen.cols).toBe(160);
      expect(body.screen.rows).toHaveLength(44);
    } finally {
      await daemon.close();
    }
  });

  it('reaches the process, which is the half that matters', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      // The process asks the kernel what its terminal measures, over and over.
      // Resizing only the mirror would leave the application wrapping at the
      // old width, which is worse than not resizing at all — so the assertion
      // is on what the pty told the process, not on what the mirror believes.
      daemon.sessions.register(
        'opus',
        // The process asks the kernel what its terminal measures, over and
        // over — node reports the pty's own idea of it, which is the half that
        // has to change for a resize to have been real.
        seat(
          dir,
          'setInterval(() => process.stdout.write(`\\rSIZE:${process.stdout.rows}x${process.stdout.columns}   `), 100);',
        ),
      );
      await until(async () => {
        const body = (await (await get(daemon, '/sessions/opus/screen')).json()) as {
          screen?: { rows: { text: string }[][] };
        };
        return JSON.stringify(body.screen?.rows ?? []).includes('SIZE:32x110');
      });

      await post(daemon, '/sessions/opus/input', { rows: 40, cols: 132 });

      await until(async () => {
        const body = (await (await get(daemon, '/sessions/opus/screen')).json()) as {
          screen?: { rows: { text: string }[][] };
        };
        return JSON.stringify(body.screen?.rows ?? []).includes('SIZE:40x132');
      });
    } finally {
      await daemon.close();
    }
  });

  it('refuses a resize it cannot make sense of', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'setTimeout(() => {}, 30000);'));
      const answer = await post(daemon, '/sessions/opus/input', { rows: Number.NaN, cols: 100 });
      expect(answer.status).toBe(400);
    } finally {
      await daemon.close();
    }
  });

  it('is the human seat\'s to do, like every other input', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'setTimeout(() => {}, 30000);'));
      const response = await fetch(`${daemon.url}/sessions/opus/input`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.tokens.get('opus')!}`, 'content-type': 'application/json' },
        body: JSON.stringify({ rows: 40, cols: 100 }),
      });
      expect(response.status).toBe(403);
    } finally {
      await daemon.close();
    }
  });
});
