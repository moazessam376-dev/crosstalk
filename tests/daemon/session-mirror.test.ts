import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { rosterMismatch, startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
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
    argv: ['sh', '-c', script],
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
  while (sessions.length > 0) sessions.pop()!.stop();
  while (dirs.length > 0) {
    await rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('mirroring a seat over HTTP', () => {
  it('serves the screen a real terminal actually drew', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      daemon.sessions.register('opus', seat(dir, 'printf "reading harbor.ts"; sleep 30'));

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
      daemon.sessions.register('opus', seat(dir, 'printf "settled"; sleep 30'));

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
      daemon.sessions.register('opus', seat(dir, 'read line; printf "\\nGOT[%s]" "$line"; sleep 30'));
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
      daemon.sessions.register('opus', seat(dir, 'sleep 30'));

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
      daemon.sessions.register('opus', seat(dir, 'printf "fatal: contract not frozen"; exit 3'));

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
 * Launching from the hub, and the one thing it cannot do.
 *
 * Every launch into a repo that already had a `crosstalk.yaml` used to fail
 * with "already exists", because the launcher always asked to write a roster.
 * Forcing that would be worse than the error: the daemon reads its participants
 * and mints their tokens at startup, so seats written afterwards have no
 * credentials and no way to call back — a team that starts and cannot speak.
 */
describe('launching a roster', () => {
  it('accepts the roster the daemon is running', () => {
    const running = [
      { id: '@human', role: 'human', harness: 'human' },
      { id: 'opus', role: 'peer', harness: 'claude-code-live' },
    ];
    expect(rosterMismatch(running, ['opus:peer:claude-code-live:claude-opus-5:high'])).toBeUndefined();
    // Model and effort are per-seat argv and change nothing about a token.
    expect(rosterMismatch(running, ['opus:peer:claude-code-live:claude-sonnet-5:low'])).toBeUndefined();
    // No seats named at all means "use the roster you have".
    expect(rosterMismatch(running, [])).toBeUndefined();
  });

  it('refuses a seat the daemon never seated, and says what it is running', () => {
    const running = [{ id: 'opus', role: 'peer', harness: 'claude-code-live' }];
    const reason = rosterMismatch(running, ['peer-1:peer:claude-code-live']);
    expect(reason).toContain('peer-1');
    expect(reason).toContain('opus');
    expect(reason).toMatch(/restart/i);
  });

  it('refuses a seat whose role or harness was changed', () => {
    const running = [{ id: 'opus', role: 'peer', harness: 'claude-code-live' }];
    expect(rosterMismatch(running, ['opus:leader:claude-code-live'])).toMatch(/role and harness/);
    expect(rosterMismatch(running, ['opus:peer:codex-cli'])).toMatch(/codex-cli/);
  });
});
