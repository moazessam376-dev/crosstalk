import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireError, WriteResponse } from '../../src/daemon/contract.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: leader
    role: leader
    harness: claude-code-app
    lifecycle: attached
    workspace: .
  - id: codex
    role: worker
    harness: codex-app
    lifecycle: attached
    workspace: .crosstalk/worktrees/codex
  - id: reviewer
    role: spoc
    harness: claude-code-app
    lifecycle: attached
    workspace: .
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
policy:
  selfCritique:
    required: true
    minRounds: 1
  leaderCritique:
    maxRounds: 2
  dispute:
    maxRounds: 3
    ladder: [discriminating_test, third_agent, leader]
    rungTimeouts:
      discriminating_test: 30m
      third_agent: 30m
  taskAcceptance:
    method: spoc
    delegate: reviewer
`;

const TASK = {
  id: 'T-01',
  title: 'Build the log',
  brief: 'Implement the append-only event log.',
  specRefs: ['§5.2'],
  assignee: 'codex',
  deps: [],
  acceptance: ['ledger appends by seq'],
  branch: 'ct/T-01',
};

const CRITIQUE = { rounds: 1, findings: [], critic: 'self' };

async function withDaemon<T>(fn: (d: DaemonHandle) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-spoc-'));
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  const daemon = await startDaemon({ repo: dir });
  try {
    return await fn(daemon);
  } finally {
    await daemon.close();
  }
}

function auth(d: DaemonHandle, id: string): Record<string, string> {
  return { authorization: `Bearer ${d.tokens.get(id)!}` };
}

async function post(d: DaemonHandle, path: string, body: unknown, id: string): Promise<Response> {
  return fetch(`${d.url}${path}`, {
    method: 'POST',
    headers: { ...auth(d, id), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(d: DaemonHandle, path: string, id: string): Promise<Response> {
  return fetch(`${d.url}${path}`, { headers: auth(d, id) });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function stateOf(daemon: DaemonHandle, id: string): Promise<string | undefined> {
  const { tasks } = await readJson<{ tasks: { id: string; state: string }[] }>(
    await get(daemon, '/board', 'leader'),
  );
  return tasks.find((task) => task.id === id)?.state;
}

async function toSubmitted(daemon: DaemonHandle): Promise<void> {
  await post(daemon, '/tasks', TASK, 'leader');
  await post(daemon, '/tasks/T-01/state', { state: 'assigned' }, 'leader');
  await post(daemon, '/tasks/T-01/ack', { restatement: 'build the log', ambiguities: [] }, 'codex');
  await post(daemon, '/tasks/T-01/state', { state: 'in_progress' }, 'codex');
  await post(daemon, '/tasks/T-01/submit', { critique: CRITIQUE }, 'codex');
  await post(daemon, '/tasks/T-01/state', { state: 'submitted' }, 'codex');
  expect(await stateOf(daemon, 'T-01')).toBe('submitted');
}

describe('SPOC acceptance', () => {
  it('refuses a worker accept under method: spoc, and permits the SPOC', async () => {
    await withDaemon(async (daemon) => {
      await toSubmitted(daemon);

      const worker = await post(daemon, '/tasks/T-01/state', { state: 'accepted' }, 'codex');
      expect(worker.status).toBe(403);
      expect((await readJson<WireError>(worker)).error.code).toBe('NOT_TASK_AUTHORITY');
      expect(await stateOf(daemon, 'T-01')).toBe('submitted');

      const leader = await post(daemon, '/tasks/T-01/state', { state: 'accepted' }, 'leader');
      expect(leader.status).toBe(403);
      expect(await stateOf(daemon, 'T-01')).toBe('submitted');

      const spoc = await post(daemon, '/tasks/T-01/state', { state: 'accepted' }, 'reviewer');
      expect(spoc.status).toBe(201);
      expect(await stateOf(daemon, 'T-01')).toBe('accepted');
    });
  });

  it('lets @human override a SPOC accept', async () => {
    await withDaemon(async (daemon) => {
      await toSubmitted(daemon);
      const human = await post(daemon, '/tasks/T-01/state', { state: 'accepted' }, '@human');
      expect(human.status).toBe(201);
      expect(await stateOf(daemon, 'T-01')).toBe('accepted');
    });
  });

  it('lets SPOC reject submitted work back to in_progress, and refuses the assignee', async () => {
    await withDaemon(async (daemon) => {
      await toSubmitted(daemon);

      const assignee = await post(
        daemon,
        '/tasks/T-01/state',
        { state: 'in_progress', reason: 'I changed my mind' },
        'codex',
      );
      expect(assignee.status).toBe(403);
      expect((await readJson<WireError>(assignee)).error.code).toBe('NOT_TASK_AUTHORITY');
      expect(await stateOf(daemon, 'T-01')).toBe('submitted');

      const reject = await post(
        daemon,
        '/tasks/T-01/state',
        { state: 'in_progress', reason: 'header count still contradicts hide-resolved' },
        'reviewer',
      );
      expect(reject.status).toBe(201);
      expect(await stateOf(daemon, 'T-01')).toBe('in_progress');
    });
  });

  it('refuses SPOC assign and SPOC merge', async () => {
    await withDaemon(async (daemon) => {
      const assigned = await post(
        daemon,
        '/tasks/assign',
        { ...TASK, id: 'T-02' },
        'reviewer',
      );
      expect(assigned.status).toBe(403);
      expect((await readJson<WireError>(assigned)).error.code).toBe('NOT_TASK_AUTHORITY');

      await toSubmitted(daemon);
      await post(daemon, '/tasks/T-01/state', { state: 'accepted' }, 'reviewer');
      const merged = await post(daemon, '/tasks/T-01/state', { state: 'merged' }, 'reviewer');
      expect(merged.status).toBe(403);
      expect((await readJson<WireError>(merged)).error.code).toBe('NOT_TASK_AUTHORITY');
      expect(await stateOf(daemon, 'T-01')).toBe('accepted');

      expect((await post(daemon, '/tasks/T-01/state', { state: 'merged' }, 'leader')).status).toBe(201);
      expect(await stateOf(daemon, 'T-01')).toBe('merged');
    });
  });
});
