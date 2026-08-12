import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import type { WireError } from '../../src/daemon/contract.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

/**
 * The wiring, not the plumbing: `tests/workspace/submit.test.ts` proves
 * `commitOwnedPaths` behaves, and this proves the daemon actually calls it —
 * on the transition into `submitted`, and nowhere else.
 *
 * The "nowhere else" half matters as much as the first. `POST /tasks/:id/submit`
 * is named for the human act but lands in `self_reviewed`, and committing there
 * would commit mid-critique, while the assignee is still changing the code its
 * own review is about.
 */

const execFile = promisify(execFileCallback);
const dirs: string[] = [];

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
    workspace: .
    owns:
      - src/codex/
  - id: cursor
    role: worker
    harness: cursor-app
    lifecycle: attached
    workspace: .crosstalk/worktrees/cursor
`;

const TASK = {
  id: 'T-01',
  title: 'Build the log',
  brief: 'A brief.',
  specRefs: ['§4.1'],
  assignee: 'codex',
  deps: [],
  acceptance: ['seq is monotonic'],
  branch: 'ct/T-01-log',
};

const CRITIQUE = { rounds: 1, findings: [], critic: 'codex subagent' };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

/** A real repository: the submit path runs real git, which AGENTS.md requires. */
async function sharedRootRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-shared-root-'));
  dirs.push(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@crosstalk.invalid']);
  await git(dir, ['config', 'user.name', 'crosstalk test']);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  await git(dir, ['add', 'crosstalk.yaml']);
  await git(dir, ['commit', '-qm', 'initial']);
  return dir;
}

async function post(d: DaemonHandle, path: string, body: unknown, id: string): Promise<Response> {
  return fetch(`${d.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${d.tokens.get(id)!}` },
    body: JSON.stringify(body),
  });
}

async function edit(repo: string, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), body, 'utf8');
}

/** Drives T-01 from nothing to `self_reviewed`, which is every gate before the commit. */
async function upToSelfReview(d: DaemonHandle): Promise<void> {
  await post(d, '/tasks', TASK, 'leader');
  await post(d, '/tasks/T-01/state', { state: 'assigned' }, 'leader');
  await post(d, '/tasks/T-01/ack', { restatement: 'build the log', ambiguities: [] }, 'codex');
  await post(d, '/tasks/T-01/state', { state: 'in_progress' }, 'codex');
  await post(d, '/tasks/T-01/submit', { critique: CRITIQUE }, 'codex');
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);

describe('a submit from an agent sharing the repository root', { timeout: 90_000 }, () => {
  it('commits the assignee\'s owned paths onto the task branch', async () => {
    const repo = await sharedRootRepo();
    const daemon = await startDaemon({ repo });
    try {
      await edit(repo, 'src/codex/log.ts', 'export const append = () => 1;\n');
      await upToSelfReview(daemon);

      const response = await post(daemon, '/tasks/T-01/state', { state: 'submitted' }, 'codex');

      expect(response.status).toBe(201);
      expect(await git(repo, ['show', '--name-only', '--format=', 'ct/T-01-log']))
        .toContain('src/codex/log.ts');
    } finally {
      await daemon.close();
    }
  });

  it('does not commit at self-review, only at submit', async () => {
    // The endpoint named `/submit` lands in `self_reviewed`. A commit there
    // would capture the code mid-critique.
    const repo = await sharedRootRepo();
    const daemon = await startDaemon({ repo });
    try {
      await edit(repo, 'src/codex/log.ts', 'export const append = () => 1;\n');
      await upToSelfReview(daemon);

      await expect(git(repo, ['rev-parse', '--verify', 'ct/T-01-log'])).rejects.toThrow();
    } finally {
      await daemon.close();
    }
  });

  it('refuses the submit, in-band, when the agent wrote outside its subtree', async () => {
    const repo = await sharedRootRepo();
    const daemon = await startDaemon({ repo });
    try {
      await edit(repo, 'src/codex/log.ts', 'export const append = () => 1;\n');
      await edit(repo, 'src/cursor/frame.ts', 'export const frame = () => 2;\n');
      await upToSelfReview(daemon);

      const response = await post(daemon, '/tasks/T-01/state', { state: 'submitted' }, 'codex');

      expect(response.status).toBe(409);
      const body = (await response.json()) as WireError;
      expect(body.error.code).toBe('SUBMIT_OUTSIDE_OWNERSHIP');
      // Naming the path is the whole value: the agent can move it or widen its
      // declaration, and can do neither if it is only told "refused".
      expect(body.error.message).toContain('src/cursor/frame.ts');
    } finally {
      await daemon.close();
    }
  });

  it('leaves the task unsubmitted when the commit was refused', async () => {
    // A `task_state` event claiming a submit that produced no commit would put
    // the log and the branch permanently out of step, and the mirror publishes
    // from the log.
    const repo = await sharedRootRepo();
    const daemon = await startDaemon({ repo });
    try {
      await edit(repo, 'src/cursor/frame.ts', 'export const frame = () => 2;\n');
      await upToSelfReview(daemon);
      await post(daemon, '/tasks/T-01/state', { state: 'submitted' }, 'codex');

      const events = await (await fetch(`${daemon.url}/events`, {
        headers: { authorization: `Bearer ${daemon.tokens.get('leader')!}` },
      })).json() as { events: { kind: string; state?: string }[] };

      expect(events.events.some((event) => event.kind === 'task_state' && event.state === 'submitted')).toBe(false);
    } finally {
      await daemon.close();
    }
  });

  it('leaves a worktree-based assignee completely alone', async () => {
    // Every project configured before shared root looks like this. If declaring
    // no `owns` changed how a submit behaves, this change would have broken all
    // of them.
    const repo = await sharedRootRepo();
    const daemon = await startDaemon({ repo });
    try {
      const forCursor = { ...TASK, id: 'T-02', assignee: 'cursor', branch: 'ct/T-02-frame' };
      await edit(repo, 'anywhere/at/all.ts', 'export const anything = () => 3;\n');
      await post(daemon, '/tasks', forCursor, 'leader');
      await post(daemon, '/tasks/T-02/state', { state: 'assigned' }, 'leader');
      await post(daemon, '/tasks/T-02/ack', { restatement: 'frame', ambiguities: [] }, 'cursor');
      await post(daemon, '/tasks/T-02/state', { state: 'in_progress' }, 'cursor');
      await post(daemon, '/tasks/T-02/submit', { critique: CRITIQUE }, 'cursor');

      const response = await post(daemon, '/tasks/T-02/state', { state: 'submitted' }, 'cursor');

      expect(response.status).toBe(201);
      // No branch was created: nothing committed on its behalf, exactly as before.
      await expect(git(repo, ['rev-parse', '--verify', 'ct/T-02-frame'])).rejects.toThrow();
    } finally {
      await daemon.close();
    }
  });
});
