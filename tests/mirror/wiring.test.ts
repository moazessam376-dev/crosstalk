import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { runInit } from '../../src/cli/init.js';
import { startMirror } from '../../src/mirror/index.js';
import { humanTokenPath } from '../../src/mirror/poll.js';
import { FakeGitHub } from './fake-github.js';

import type { MirrorConfig } from '../../src/contracts/config.js';

/**
 * The seam a unit test cannot see.
 *
 * Every other file here proves the mirror does the right thing *given* events.
 * None of them prove anything hands it events. This drives a real daemon over
 * real loopback HTTP through the real `GET /stream` and asserts on GitHub state
 * at the far end — the "28 green tests over a screen that rendered empty"
 * failure AGENTS.md records, in the one subsystem where it would be invisible.
 *
 * The only fake is GitHub itself, which is the boundary the plan says to fake.
 */

const ENABLED: MirrorConfig = {
  github: { enabled: true, mode: 'two-way-human', pollSeconds: 1 },
};

async function initialised(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-wiring-'));
  await runInit({ repo, participants: [], force: false });
  return repo;
}

async function withDaemon<T>(repo: string, fn: (d: DaemonHandle) => Promise<T>): Promise<T> {
  const daemon = await startDaemon({ repo });
  try {
    return await fn(daemon);
  } finally {
    await daemon.close();
  }
}

async function api(
  daemon: DaemonHandle,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(new URL(path, daemon.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function newTask(id: string) {
  return {
    id,
    title: 'Make the refund path idempotent',
    brief: 'A retried charge must credit once.',
    specRefs: [],
    assignee: 'codex',
    deps: [],
    acceptance: ['A retried charge credits once.'],
    branch: `ct/${id}-refund`,
  };
}

describe('the mirror against a live daemon', () => {
  it('opens nothing for a task the leader has only drafted', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const leader = daemon.tokens.get('leader')!;
      const human = (await readFile(humanTokenPath(repo), 'utf8')).trim();
      const github = new FakeGitHub();

      expect((await api(daemon, '/tasks', leader, newTask('T-01'))).status).toBeLessThan(300);

      const mirror = await startMirror({
        repo,
        url: daemon.url,
        token: human,
        config: ENABLED,
        transport: github,
        intervalMs: 60_000,
      });

      await settle(mirror);
      await mirror.stop();

      expect(mirror.state.tasks.get('T-01')?.state).toBe('draft');
      expect(github.pulls).toHaveLength(0);
    });
  });

  it('opens a draft pull request once the task is assigned, and marks it ready on submit', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const leader = daemon.tokens.get('leader')!;
      const human = (await readFile(humanTokenPath(repo), 'utf8')).trim();
      const github = new FakeGitHub();

      await api(daemon, '/tasks', leader, newTask('T-02'));

      const mirror = await startMirror({
        repo,
        url: daemon.url,
        token: human,
        config: ENABLED,
        transport: github,
        intervalMs: 60_000,
      });

      await ok(api(daemon, '/tasks/T-02/state', leader, { state: 'assigned' }));
      await settle(mirror);

      expect(github.pulls).toHaveLength(1);
      expect(github.pulls[0]).toMatchObject({ branch: 'ct/T-02-refund', isDraft: true });

      // The real lifecycle, gates included: `submitted` is not reachable from
      // `assigned` in one step, and a test that pretended otherwise would be
      // asserting against a transition the protocol refuses.
      const codex = daemon.tokens.get('codex')!;
      await ok(
        api(daemon, '/tasks/T-02/ack', codex, {
          restatement: 'Make the retried charge credit once.',
          ambiguities: [],
        }),
      );
      await ok(api(daemon, '/tasks/T-02/state', codex, { state: 'in_progress' }));
      await ok(
        api(daemon, '/tasks/T-02/submit', codex, {
          critique: { rounds: 1, findings: [], critic: 'self' },
        }),
      );
      await ok(api(daemon, '/tasks/T-02/state', codex, { state: 'submitted' }));

      await settle(mirror);
      await mirror.stop();

      expect(mirror.state.tasks.get('T-02')?.state).toBe('submitted');

      expect(github.pulls).toHaveLength(1);
      expect(github.pulls[0]?.isDraft).toBe(false);
    });
  });

  it('does not touch GitHub at all when the mirror is disabled', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const leader = daemon.tokens.get('leader')!;
      const human = (await readFile(humanTokenPath(repo), 'utf8')).trim();
      const github = new FakeGitHub();

      await api(daemon, '/tasks', leader, newTask('T-03'));
      await api(daemon, '/tasks/T-03/state', leader, { state: 'assigned' });

      const mirror = await startMirror({
        repo,
        url: daemon.url,
        token: human,
        config: { github: { enabled: false, mode: 'off', pollSeconds: 1 } },
        transport: github,
        intervalMs: 60_000,
      });

      await settle(mirror);
      await mirror.stop();

      expect(mirror.enabled).toBe(false);
      expect(github.calls).toHaveLength(0);
    });
  });

  /**
   * The protocol must be unharmed by a mirror that cannot reach GitHub — not
   * "does not throw", but byte-identical to a run without one.
   */
  it('leaves the event log identical to an unmirrored run when GitHub is unreachable', async () => {
    const logs: string[] = [];

    for (const offline of [true, false]) {
      const repo = await initialised();
      await withDaemon(repo, async (daemon) => {
        const leader = daemon.tokens.get('leader')!;
        const human = (await readFile(humanTokenPath(repo), 'utf8')).trim();
        const github = new FakeGitHub();
        github.offline = offline;

        const mirror = await startMirror({
          repo,
          url: daemon.url,
          token: human,
          config: ENABLED,
          transport: github,
          intervalMs: 60_000,
        });

        expect((await api(daemon, '/tasks', leader, newTask('T-09'))).status).toBeLessThan(300);
        const moved = await api(daemon, '/tasks/T-09/state', leader, { state: 'assigned' });
        expect(moved.status).toBeLessThan(300);

        await settle(mirror);
        await mirror.stop();

        const raw = await readFile(join(repo, '.crosstalk', 'events.jsonl'), 'utf8');
        logs.push(
          raw
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const event = JSON.parse(line) as Record<string, unknown>;
              delete event['ts'];
              return JSON.stringify(event);
            })
            .join('\n'),
        );
      });
    }

    expect(logs[0]).toBe(logs[1]);
  });
});

/** Lets the SSE frames arrive, then reconciles without waiting for the timer. */
async function settle(mirror: { drainNow(): Promise<unknown> }): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await mirror.drainNow();
  }
}

/** Fails loudly on a refused request instead of quietly asserting on a no-op. */
async function ok(pending: Promise<Response>): Promise<void> {
  const response = await pending;
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }
}
