import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { HarnessSession } from '../../src/harness/session.js';

/**
 * One run at a time.
 *
 * The operator asked what happens if they start a run while one is going, and
 * guessed things would break. They were right, and worse than they thought:
 * nothing guarded it at any layer. `SessionRegistry.register` overwrote the
 * handle, orphaning a pty that no longer had a `stop` to be killed with, and
 * two `driveSupervised` loops then raced one `#delivered` cursor.
 *
 * The refusal is the fix, and the thing the refusal must not do is tidy up.
 * Stopping a seat kills its process. It does not touch the worktree, because
 * the diff in there is work the operator has not pushed yet and they asked for
 * a clean board, not a clean tree.
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

/** A seat whose process we can hold open, then watch be stopped. */
function fakeSession(): HarnessSession & { stopped: number; die(): void } {
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const session = {
    stopped: 0,
    exited,
    stop: () => {
      session.stopped += 1;
      settle(0);
    },
    die: () => settle(0),
    screen: () => undefined,
    scrollback: () => undefined,
    resize: () => {},
    send: async () => {},
    key: async () => {},
    watch: () => () => {},
    canPush: true,
  };
  return session as unknown as HarnessSession & { stopped: number; die(): void };
}

async function open(): Promise<DaemonHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-one-run-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  const daemon = await startDaemon({ repo: dir });
  daemons.push(daemon);
  return daemon;
}

function auth(daemon: DaemonHandle): Record<string, string> {
  return {
    authorization: `Bearer ${daemon.tokens.get('@human')!}`,
    'content-type': 'application/json',
  };
}

const run = promisify(execFile);

/** `git status --porcelain`, which is the whole state of the tree in one string. */
async function porcelain(dir: string): Promise<string> {
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: dir });
  return stdout;
}

async function startRun(daemon: DaemonHandle, body: object = {}): Promise<Response> {
  return fetch(`${daemon.url}/runs`, {
    method: 'POST',
    headers: auth(daemon),
    body: JSON.stringify(body),
  });
}

/** One seat's state on the roster. */
async function stateOf(daemon: DaemonHandle, id: string): Promise<string | undefined> {
  const response = await fetch(`${daemon.url}/roster`, { headers: auth(daemon) });
  const body = (await response.json()) as { participants: { id: string; status: string }[] };
  return body.participants.find((participant) => participant.id === id)?.status;
}

/** Poll rather than sleep — the roster is derived, so there is no event to wait on. */
async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error('condition never held');
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

describe('starting a run while one is live', () => {
  it('refuses, and names who is still running', async () => {
    const daemon = await open();
    const session = fakeSession();
    daemon.sessions.register('peer-1', session);

    const response = await startRun(daemon);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('RUN_IN_PROGRESS');
    // Naming the seat is the whole point: "a run is in progress" tells the
    // operator nothing they can act on, and stopping a seat is destructive
    // enough that they should be told which one before they agree to it.
    expect(body.error.message).toContain('peer-1');
    expect(session.stopped).toBe(0);
  });

  it('stops the live seats when the operator says end', async () => {
    const daemon = await open();
    const session = fakeSession();
    daemon.sessions.register('peer-1', session);

    const response = await startRun(daemon, { end: true });

    expect(response.status).toBe(201);
    expect(session.stopped).toBe(1);
    // The handle is kept, dead — the mirror still shows the screen it died on.
    expect(daemon.sessions.get('peer-1')).toBeDefined();
  });

  it('leaves a run with no live seats alone, without asking for end', async () => {
    // The neighbouring case, so the refusal is not just "always refuse". A
    // daemon that has never staffed anyone must still be able to start a run,
    // and so must one whose seats have all exited.
    const daemon = await open();
    const session = fakeSession();
    daemon.sessions.register('peer-1', session);
    session.die();
    await session.exited;
    await Promise.resolve();

    expect((await startRun(daemon)).status).toBe(201);
  });

  it('stops the process and leaves the worktree exactly as it was', async () => {
    // The one thing ending a run must not do.
    //
    // A stopped seat has uncommitted work in its tree. The operator asked for a
    // clean board; throwing away a diff they have not pushed is a different and
    // much worse operation, and it is one they would discover hours later. So
    // this asserts on the tree byte-for-byte, before and after — `git checkout
    // .` or a `clean -fd` in `#endRun` would pass every other test here.
    const daemon = await open();
    const dir = dirs[dirs.length - 1]!;
    await run('git', ['init', '-q'], { cwd: dir });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await run('git', ['config', 'user.name', 'test'], { cwd: dir });
    await writeFile(join(dir, 'tracked.txt'), 'committed\n', 'utf8');
    await run('git', ['add', 'tracked.txt'], { cwd: dir });
    await run('git', ['commit', '-qm', 'first'], { cwd: dir });
    // A modified tracked file and an untracked one: `checkout .` takes the
    // first, `clean -fd` takes the second, and only both catch both.
    await writeFile(join(dir, 'tracked.txt'), 'edited but not committed\n', 'utf8');
    await writeFile(join(dir, 'scratch.txt'), 'never added\n', 'utf8');

    const before = await porcelain(dir);
    expect(before).toContain('tracked.txt');
    expect(before).toContain('scratch.txt');

    const session = fakeSession();
    daemon.sessions.register('peer-1', session);
    expect((await startRun(daemon, { end: true })).status).toBe(201);

    expect(session.stopped).toBe(1);
    expect(await porcelain(dir)).toBe(before);
  }, 30_000);

  it('stops calling a dead seat awaiting_turn', async () => {
    // `/await` parks for up to fifty seconds. A seat that died one second in
    // went on being reported `awaiting_turn` for the next forty-nine, so the
    // roster showed a working team where there was a corpse — the exact
    // "looks fine, is not" failure this project exists to stop.
    const daemon = await open();
    const session = fakeSession();
    daemon.sessions.register('peer-1', session);

    // A long park on purpose. With a short one the seat would drop off the
    // roster when its own timer expired, and this test would pass with the
    // filter deleted — it has to be the death that removes it, not the clock.
    const parked = fetch(`${daemon.url}/await?timeout_s=20`, {
      headers: { authorization: `Bearer ${daemon.tokens.get('peer-1')!}` },
    });
    await until(async () => (await stateOf(daemon, 'peer-1')) === 'awaiting_turn');

    session.die();
    await session.exited;

    const died = Date.now();
    await until(async () => (await stateOf(daemon, 'peer-1')) !== 'awaiting_turn');
    expect(Date.now() - died).toBeLessThan(5_000);
    await parked;
  }, 30_000);

  it('does not hang on a seat that will not exit', async () => {
    // A wedged pty must not hold the request open. Five seconds is the cap; a
    // launch that never answers is indistinguishable from a dead daemon.
    const daemon = await open();
    const stubborn = {
      exited: new Promise<number | null>(() => {}),
      stop: () => {},
      screen: () => undefined,
      scrollback: () => undefined,
      resize: () => {},
      send: async () => {},
      key: async () => {},
      watch: () => () => {},
      canPush: true,
    } as unknown as HarnessSession;
    daemon.sessions.register('peer-1', stubborn);

    const started = Date.now();
    const response = await startRun(daemon, { end: true });
    const took = Date.now() - started;

    expect(response.status).toBe(201);
    // Bounded by the grace period, not by the seat.
    expect(took).toBeLessThan(15_000);
  }, 30_000);
});
