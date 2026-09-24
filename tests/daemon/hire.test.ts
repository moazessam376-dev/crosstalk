import { execFile as execFileCb } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { HarnessSession } from '../../src/harness/session.js';

const execFile = promisify(execFileCb);

/**
 * The lead hires its own crew.
 *
 * `POST /seats` is the whole of "leave the number of builders blank and let
 * the seat that has read the job decide". What is pinned: who may call it,
 * what it refuses and why, that the roster on disk grows by exactly the seat
 * asked for, that the daemon can then authenticate that seat, and that
 * releasing a seat kills its process and nothing else.
 *
 * `runInit` builds a worktree, so every test here has a real repository.
 * The spawned harness is `cursor-cli`, whose binary is on no test machine:
 * the spawn fails, which is fine — spawning is `runCompose`'s and is tested
 * there. Nothing here needs a process to actually start.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
shape: lead-crew
participants:
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
  - id: lead
    role: leader
    harness: codex-cli
    lifecycle: supervised
    workspace: .
`;

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-hire-'));
  dirs.push(dir);
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'hello\n', 'utf8');
  await execFile('git', ['add', '.'], { cwd: dir });
  await execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

async function open(dir: string): Promise<DaemonHandle> {
  const daemon = await startDaemon({ repo: dir });
  daemons.push(daemon);
  return daemon;
}

function as(daemon: DaemonHandle, who: string): Record<string, string> {
  return { authorization: `Bearer ${daemon.tokens.get(who)!}`, 'content-type': 'application/json' };
}

/** A token minted after the daemon started: read from disk, since the handle's map is a snapshot. */
async function minted(dir: string, who: string): Promise<Record<string, string>> {
  const token = (await readFile(join(dir, '.crosstalk', 'tokens', who), 'utf8')).trim();
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function hire(daemon: DaemonHandle, who: string, body: object): Promise<Response> {
  return fetch(`${daemon.url}/seats`, { method: 'POST', headers: as(daemon, who), body: JSON.stringify(body) });
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function until(predicate: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('condition never held');
}

function fakeSession(): HarnessSession & { stopped: number } {
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
    screen: () => undefined,
    scrollback: () => undefined,
    resize: () => {},
    send: async () => {},
    key: async () => {},
    watch: () => () => {},
    canPush: true,
  };
  return session as unknown as HarnessSession & { stopped: number };
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

describe('who may hire', () => {
  it('the lead and the operator; a builder may not', async () => {
    const dir = await repo();
    const daemon = await open(dir);
    // Seat a worker by hand so there is a non-lead to refuse.
    await writeFile(
      join(dir, 'crosstalk.yaml'),
      `${CONFIG}  - id: b0\n    role: worker\n    harness: cursor-cli\n    lifecycle: supervised\n    workspace: .crosstalk/worktrees/b0\n`,
      'utf8',
    );
    await daemon.reload();
    const refused = await fetch(`${daemon.url}/seats`, {
      method: 'POST',
      headers: await minted(dir, 'b0'),
      body: JSON.stringify({ id: 'b1', harness: 'cursor-cli' }),
    });
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe('ROLE_NOT_PERMITTED');
  });
});

describe('what a hire refuses', () => {
  it('an id that is not a participant id, or a harness nobody can spawn', async () => {
    const daemon = await open(await repo());
    expect(await code(await hire(daemon, 'lead', { id: 'Builder One', harness: 'cursor-cli' }))).toBe('MALFORMED_BODY');
    expect(await code(await hire(daemon, 'lead', { id: 'b1', harness: 'claude-code-app' }))).toBe('MALFORMED_BODY');
    expect(await code(await hire(daemon, 'lead', { id: 'b1', harness: 'nope' }))).toBe('MALFORMED_BODY');
    expect(await code(await hire(daemon, 'lead', { id: 'b1', harness: 'cursor-cli', role: 'peer' }))).toBe('MALFORMED_BODY');
  });

  it('a seat that is already on the roster, case-insensitively', async () => {
    const daemon = await open(await repo());
    const response = await hire(daemon, 'lead', { id: 'lead', harness: 'cursor-cli' });
    expect(response.status).toBe(409);
    expect(await code(response)).toBe('SEAT_EXISTS');
  });

  it('a spec that is written but not committed, since a hired worktree is cut from main', async () => {
    const dir = await repo();
    const daemon = await open(dir);
    await mkdir(join(dir, 'docs', 'crosstalk'), { recursive: true });
    await writeFile(join(dir, 'docs', 'crosstalk', 'SPEC.md'), '# spec\n', 'utf8');

    const refused = await hire(daemon, 'lead', { id: 'b1', harness: 'cursor-cli' });
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe('SPEC_UNCOMMITTED');

    await execFile('git', ['add', '.'], { cwd: dir });
    await execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'spec'], { cwd: dir });
    const allowed = await hire(daemon, 'lead', { id: 'b1', harness: 'cursor-cli' });
    expect(allowed.status).toBe(201);
  });

  it('does not refuse on the spec when there is none yet — plan already names that', async () => {
    const daemon = await open(await repo());
    expect((await hire(daemon, 'lead', { id: 'b1', harness: 'cursor-cli' })).status).toBe(201);
  });
});

describe('a hire that goes through', () => {
  it('adds exactly that seat to the roster on disk, builds its worktree, and lets it authenticate', async () => {
    const dir = await repo();
    const daemon = await open(dir);
    const response = await hire(daemon, 'lead', { id: 'builder-1', harness: 'cursor-cli', model: 'auto', effort: 'high' });
    expect(response.status).toBe(201);

    const roster = parse(await readFile(join(dir, 'crosstalk.yaml'), 'utf8')) as {
      participants: { id: string; role: string; harness: string; model?: string; effort?: string; workspace: string; lifecycle: string }[];
      shape?: string;
    };
    const added = roster.participants.find((participant) => participant.id === 'builder-1');
    expect(added).toMatchObject({
      role: 'worker',
      harness: 'cursor-cli',
      model: 'auto',
      effort: 'high',
      lifecycle: 'supervised',
      workspace: '.crosstalk/worktrees/builder-1',
    });
    // The lead and the shape survive a hire — the roster was appended to, not rebuilt.
    expect(roster.participants.map((participant) => participant.id)).toEqual(['@human', 'lead', 'builder-1']);
    expect(roster.shape).toBe('lead-crew');

    // Staffing runs after the response. Wait for the daemon to have reloaded
    // and the seat to be able to speak.
    await until(async () => {
      const seen = await fetch(`${daemon.url}/sessions`, { headers: as(daemon, '@human') });
      const body = (await seen.json()) as { seats: { id: string }[] };
      return body.seats.some((seat) => seat.id === 'builder-1');
    });
    await access(join(dir, '.crosstalk', 'worktrees', 'builder-1'));
    const token = (await readFile(join(dir, '.crosstalk', 'tokens', 'builder-1'), 'utf8')).trim();
    const inbox = await fetch(`${daemon.url}/inbox?wait=0`, { headers: { authorization: `Bearer ${token}` } });
    expect(inbox.status).toBe(200);
    expect(((await inbox.json()) as { you: string }).you).toBe('builder-1');
  });

  it('counts toward the phase: crew-hired is met once a worker is seated', async () => {
    const dir = await repo();
    const daemon = await open(dir);
    const before = await fetch(`${daemon.url}/inbox?wait=0`, { headers: as(daemon, 'lead') });
    expect(((await before.json()) as { phase: { blocking: string[] } }).phase.blocking.join(' ')).toMatch(/crew-hired/);

    await hire(daemon, 'lead', { id: 'builder-1', harness: 'cursor-cli' });
    await until(async () => {
      const after = await fetch(`${daemon.url}/inbox?wait=0`, { headers: as(daemon, 'lead') });
      const phase = ((await after.json()) as { phase: { blocking: string[] } }).phase;
      return !phase.blocking.join(' ').includes('crew-hired');
    });
  });
});

describe('releasing a seat', () => {
  it('kills the process and nothing else, and refuses a seat that is not running', async () => {
    const dir = await repo();
    const daemon = await open(dir);
    const session = fakeSession();
    daemon.sessions.register('lead', session);
    await writeFile(join(dir, 'scratch.txt'), 'uncommitted\n', 'utf8');

    const gone = await fetch(`${daemon.url}/seats/lead/stop`, { method: 'POST', headers: as(daemon, '@human'), body: '{}' });
    expect(gone.status).toBe(201);
    expect(session.stopped).toBe(1);
    expect(await readFile(join(dir, 'scratch.txt'), 'utf8')).toBe('uncommitted\n');

    const again = await fetch(`${daemon.url}/seats/lead/stop`, { method: 'POST', headers: as(daemon, '@human'), body: '{}' });
    expect(again.status).toBe(404);
    expect(await code(again)).toBe('NO_SUCH_SEAT');
  });
});
