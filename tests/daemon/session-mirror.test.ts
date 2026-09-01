import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);

import { rosterDiffers, startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { openSession, type HarnessSession } from '../../src/harness/session.js';

/**
 * The mirror, end to end, against a real process on a real pty.
 *
 * Everything below the route is exercised by unit tests — the escape parser
 * against strings, the session seam against a fake pty. What only an
 * integration test can catch is the seam between them: that a real terminal's
 * output reaches the route, that `since` actually suppresses an unchanged
 * frame, and that a POST to `/input` arrives as keystrokes the process reads.
 *
 * A shell rather than a CLI harness on purpose. It costs no tokens, it is on
 * every machine this will ever run on, and it emits exactly the escapes we care
 * about when told to.
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
  - id: codex
    role: peer
    harness: codex-cli
    lifecycle: supervised
    workspace: .
`;

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-session-mirror-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

async function get(d: DaemonHandle, path: string, who = '@human'): Promise<Response> {
  return fetch(`${d.url}${path}`, { headers: { authorization: `Bearer ${d.tokens.get(who)!}` } });
}

async function post(d: DaemonHandle, path: string, body: unknown, who = '@human'): Promise<Response> {
  return fetch(`${d.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${d.tokens.get(who)!}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Poll until the predicate holds, so the test never races the process. */
async function until(check: () => Promise<boolean>, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 40));
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
    // The job is typed after a delay in production; these scripts get theirs
    // from the shell, so nothing should be typed at all.
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

describe('mirroring a seat over HTTP', () => {
  it('serves the screen a real terminal actually drew', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'process.stdout.write("reading harbor.ts"); setTimeout(() => {}, 30000);'));

      await until(async () => {
        const response = await get(daemon, '/sessions/opus/screen');
        const body = (await response.json()) as { screen?: { rows: { text: string }[][] } };
        return body.screen?.rows[0]?.[0]?.text === 'reading harbor.ts';
      });
    } finally {
      await daemon.close();
    }
  });

  /**
   * The economy the whole design rests on. A TUI repaints constantly; if every
   * repaint shipped a grid, six seats at a second's cadence would be six grids
   * a second for a screen nobody could see move.
   */
  it('answers unchanged for the cost of a number when nothing moved', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'process.stdout.write("settled"); setTimeout(() => {}, 30000);'));

      let version = -1;
      await until(async () => {
        const body = (await (await get(daemon, '/sessions/opus/screen')).json()) as {
          screen?: { version: number; rows: unknown[] };
        };
        if (body.screen === undefined) return false;
        version = body.screen.version;
        return version > 0;
      });

      const second = (await (await get(daemon, `/sessions/opus/screen?since=${version}`)).json()) as {
        unchanged: boolean;
        screen?: unknown;
      };
      expect(second.unchanged).toBe(true);
      expect(second.screen).toBeUndefined();
    } finally {
      await daemon.close();
    }
  });

  it('delivers a typed turn to the process as keystrokes', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      // Reads one line and echoes it back, which is the whole round trip: the
      // route wrote to a pty and a real process read it.
      daemon.sessions.register('opus', seat(dir, 'process.stdin.once("data", (d) => process.stdout.write(`\\nGOT[${String(d).trim()}]`)); setTimeout(() => {}, 30000);'));
      await until(async () => (await get(daemon, '/sessions/opus/screen')).ok);

      const sent = await post(daemon, '/sessions/opus/input', { turn: 'look at the tick' });
      expect(sent.status).toBe(200);

      await until(async () => {
        const body = (await (await get(daemon, '/sessions/opus/screen')).json()) as {
          screen?: { rows: { text: string }[][] };
        };
        const text = (body.screen?.rows ?? []).map((row) => row.map((run) => run.text).join('')).join('\n');
        return text.includes('GOT[look at the tick]');
      });
    } finally {
      await daemon.close();
    }
  });

  /**
   * Typing into someone's CLI is not a protocol act — it never reaches the log,
   * so it can never be mistaken for something the team decided. It is the
   * operator leaning over and using the keyboard, and it is theirs alone.
   */
  it('refuses input from a seat that is not the human', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'setTimeout(() => {}, 30000);'));

      const response = await post(daemon, '/sessions/opus/input', { turn: 'do as I say' }, 'codex');
      expect(response.status).toBe(403);
    } finally {
      await daemon.close();
    }
  });

  /**
   * A seat someone started in their own shell is real, is working, and cannot
   * be watched from here. Saying so is the difference between an honest gap and
   * a terminal that never fills.
   */
  it('says a seat it never started has no terminal, rather than drawing an empty one', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      const response = await get(daemon, '/sessions/codex/screen');
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('NO_MIRRORED_SESSION');

      const listed = (await (await get(daemon, '/sessions')).json()) as {
        seats: { id: string; mirrored: boolean }[];
      };
      expect(listed.seats.find((s) => s.id === 'codex')?.mirrored).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  it('keeps the screen a seat died on, which is the one worth reading', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'process.stdout.write("fatal: contract not frozen"); process.exit(3);'));

      await until(async () => {
        const body = (await (await get(daemon, '/sessions/opus/screen')).json()) as {
          running: boolean;
          screen?: { rows: { text: string }[][] };
        };
        const text = (body.screen?.rows ?? []).map((row) => row.map((run) => run.text).join('')).join('');
        return body.running === false && text.includes('fatal: contract not frozen');
      });
    } finally {
      await daemon.close();
    }
  });
});

/**
 * Staffing a team from the hub.
 *
 * The launcher's roster picker was decorative until this worked: `runInit`
 * refuses to overwrite a roster, so every launch into a configured repo failed
 * with "already exists", and forcing it would have written seats whose tokens
 * this daemon never minted — a team that starts and cannot call back. The fix
 * is to write, mint and reload, so what is checked here is only *whether* a
 * re-staff is needed.
 */
describe('deciding whether to re-staff', () => {
  const running = [
    { id: '@human', role: 'human', harness: 'human' },
    { id: 'opus', role: 'peer', harness: 'claude-code-live' },
  ];

  it('leaves the roster alone when it is already the one seated', () => {
    expect(rosterDiffers(running, ['opus:peer:claude-code-live'])).toBe(false);
    // Model and effort re-spawn a seat differently; they do not change who it
    // is, so they are not grounds for rewriting the roster and re-minting.
    expect(rosterDiffers(running, ['opus:peer:claude-code-live:claude-sonnet-5:low'])).toBe(false);
    // No seats named means "use the roster you have".
    expect(rosterDiffers(running, [])).toBe(false);
  });

  it('re-staffs for a seat that is not seated', () => {
    expect(rosterDiffers(running, ['peer-1:peer:claude-code-live'])).toBe(true);
  });

  it('re-staffs when a seat changes role or harness', () => {
    expect(rosterDiffers(running, ['opus:leader:claude-code-live'])).toBe(true);
    expect(rosterDiffers(running, ['opus:peer:codex-cli'])).toBe(true);
  });

  it('re-staffs when the team changes size', () => {
    expect(rosterDiffers(running, ['opus:peer:claude-code-live', 'codex:peer:codex-cli'])).toBe(true);
  });

  /**
   * The reload is what makes a re-staffed seat able to speak. A roster written
   * without it authenticates nobody.
   */
  it('authenticates a seat added after the daemon started', async () => {
    const dir = await tempRepo();
    // `runInit` builds a worktree per seat, so this one needs a real repository
    // rather than just a config file.
    await execFile('git', ['init', '-q'], { cwd: dir });
    await execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    const daemon = await startDaemon({ repo: dir });
    try {
      const before = await fetch(`${daemon.url}/roster`, {
        headers: { authorization: `Bearer ${daemon.tokens.get('@human')!}` },
      });
      expect(before.ok).toBe(true);

      const { runInit } = await import('../../src/cli/init.js');
      await runInit({
        repo: dir,
        participants: ['opus:peer:claude-code-live', 'codex:peer:codex-cli', 'newcomer:peer:codex-cli'],
        force: true,
      });
      await daemon.reload();

      const minted = (await readFile(join(dir, '.crosstalk', 'tokens', 'newcomer'), 'utf8')).trim();
      const answered = await fetch(`${daemon.url}/roster`, {
        headers: { authorization: `Bearer ${minted}` },
      });
      expect(answered.status).toBe(200);
      expect(answered.headers.get('x-crosstalk-you')).toBe('newcomer');
    } finally {
      await daemon.close();
    }
  }, 30_000);
});
