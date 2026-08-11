import { describe, expect, it, afterEach } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runInit } from '../../src/cli/init.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { CLI_COMMANDS } from '../../src/cli/index.js';

const execFile = promisify(execFileCallback);
const CLI = join(process.cwd(), 'dist', 'cli', 'index.js');
const GIT_TEST_TIMEOUT = 45_000;

/**
 * CT-14b. The CLI covers say, claim, respond, events, await, roster, board and
 * mine — the whole review protocol — but a leader could not create or assign the
 * work any of it is about. `create_task` and `set_task_state` existed only as
 * MCP tools, and Claude Code binds `.mcp.json` at session start, so a leader
 * right after `init` has no MCP connection at all. That is the normal state.
 *
 * These drive the built CLI as a subprocess, because the thing under test is the
 * command surface: an argument the parser rejects is exactly the defect, and
 * calling the handler directly would not see it.
 */
const daemons: DaemonHandle[] = [];

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.close().catch(() => undefined);
});

async function project(): Promise<{ repo: string; url: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-task-'));
  await execFile('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 't@e.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'test'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), '# t\n', 'utf8');
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  await runInit({ repo, participants: [], force: false });

  const daemon = await startDaemon({ repo });
  daemons.push(daemon);
  return { repo, url: daemon.url };
}

async function ct(repo: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFile('node', [CLI, ...args, '--repo', repo], { windowsHide: true });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: (failure.stdout ?? '') + (failure.stderr ?? '') };
  }
}

const CREATE = [
  'task', 'create',
  '--as', 'leader',
  '--id', 'T-01',
  '--title', 'Build the thing',
  '--brief', 'Do it properly',
  '--assignee', 'codex',
  '--branch', 'track-a/core',
];

describe('a leader can assign work from the CLI', () => {
  it(
    'creates a task, and the board lists it',
    async () => {
      const { repo } = await project();

      const created = await ct(repo, CREATE);
      expect(created.code).toBe(0);

      const board = await ct(repo, ['board', '--as', 'leader']);
      expect(board.out).toContain('T-01');
      expect(board.out).toContain('codex');
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    'moves a task through a state',
    async () => {
      const { repo } = await project();
      await ct(repo, CREATE);

      const moved = await ct(repo, ['task', 'state', 'T-01', '--as', 'leader', '--state', 'assigned']);
      expect(moved.code).toBe(0);

      const board = await ct(repo, ['board', '--as', 'leader']);
      expect(board.out).toContain('assigned');
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    'lets the daemon refuse a worker, and carries its reason out',
    async () => {
      // The neighbouring case. The CLI must not invent a permission check of its
      // own — the daemon owns that rule (`requireRole(ctx, 'leader')`) — and it
      // must not swallow the refusal either.
      const { repo } = await project();

      const refused = await ct(repo, [...CREATE.slice(0, 2), '--as', 'codex', ...CREATE.slice(4)]);

      expect(refused.code).not.toBe(0);
      expect(refused.out).toMatch(/leader/i);
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    'names both subcommands when given neither',
    async () => {
      const { repo } = await project();

      const bare = await ct(repo, ['task', '--as', 'leader']);

      expect(bare.code).not.toBe(0);
      expect(bare.out).toContain('create');
      expect(bare.out).toContain('state');
    },
    GIT_TEST_TIMEOUT,
  );

  it('registers exactly one command name, so the brief vocabulary check still holds', () => {
    // `main` dispatches on argv[0] alone, so a key of `task create` is
    // unreachable; and brief-vocabulary.test.ts extracts only the first word
    // after `crosstalk `, so two keys would make the table and the brief
    // disagree about a command that does exist.
    expect(CLI_COMMANDS).toContain('task');
    expect(CLI_COMMANDS).not.toContain('task create');
  });
});
