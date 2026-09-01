import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { runInit } from '../../src/cli/init.js';

/**
 * What `init` records about what each participant is actually running.
 *
 * `model` was already collected — `--participant id:role:harness[:model]` has
 * split four fields since it was written. The live project's roster simply was
 * not created with one, which is why its hub reads `claude-code-app · mcp` and
 * why this looked like a missing feature rather than a missing argument.
 *
 * `effort` is the genuinely new field (claim CT-A). A model at two effort
 * levels does not behave alike, so a ledger aggregating outcomes by participant
 * aggregates across it whether or not anything can see it.
 */

const execFile = promisify(execFileCallback);

async function repoWithCommit(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-init-participants-'));
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 'test@crosstalk.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'crosstalk test'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), '# init\n', 'utf8');
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  return repo;
}

async function rosterOf(repo: string): Promise<{ id: string; model?: string; effort?: string }[]> {
  const config = parse(await readFile(join(repo, 'crosstalk.yaml'), 'utf8')) as {
    participants: { id: string; model?: string; effort?: string }[];
  };
  return config.participants;
}

/**
 * `init` builds worktrees and probes every harness, which is minutes rather
 * than seconds on a loaded machine. Every other test that runs the real `init`
 * raises its ceiling for the same reason.
 */
describe('init records what each participant is running', { timeout: 90_000 }, () => {
  it('writes the model and the effort from a five-field spec', async () => {
    const repo = await repoWithCommit();
    await runInit({
      repo,
      force: false,
      participants: ['leader:leader:claude-code-app:opus-5:max'],
    });

    const leader = (await rosterOf(repo)).find((participant) => participant.id === 'leader');

    expect(leader?.model).toBe('opus-5');
    expect(leader?.effort).toBe('max');
  });

  it('still accepts the four-field spec that predates effort', async () => {
    // The compatibility half. Every documented invocation and every existing
    // script uses `id:role:harness[:model]`, and a fifth field that became
    // required would break all of them.
    const repo = await repoWithCommit();
    await runInit({
      repo,
      force: false,
      participants: ['leader:leader:claude-code-app:opus-5'],
    });

    const leader = (await rosterOf(repo)).find((participant) => participant.id === 'leader');

    expect(leader?.model).toBe('opus-5');
    expect(leader?.effort).toBeUndefined();
  });

  /**
   * Shared root is declared by `workspace:` and `owns:`, and neither fits a
   * colon-separated CLI spec — `owns` is a list. So the roster has to be
   * editable in `crosstalk.yaml` and survive the next `init`.
   *
   * It did not. `runInit` reads `--participant` or `DEFAULT_ROSTER` and never
   * looks at the config it is about to overwrite, and `--force` is mandatory
   * once the file exists. So the documented way to regenerate `.mcp.json` and
   * the briefs after an edit was also the way to throw the edit away — silently,
   * replacing a five-participant roster with the two-participant default.
   */
  it('keeps a hand-edited roster when no participant is named', async () => {
    const repo = await repoWithCommit();
    await runInit({ repo, force: false, participants: ['leader:leader:claude-code-app'] });

    const edited = await readFile(join(repo, 'crosstalk.yaml'), 'utf8');
    await writeFile(
      join(repo, 'crosstalk.yaml'),
      edited.replace(
        /participants:\n/,
        'participants:\n  - id: metrics\n    role: worker\n    harness: claude-code-app\n    model: opus-5\n    effort: max\n    lifecycle: attached\n    workspace: .\n    owns:\n      - src/metrics/\n',
      ),
      'utf8',
    );

    await runInit({ repo, force: true, participants: [] });

    const metrics = (await rosterOf(repo)).find((participant) => participant.id === 'metrics') as
      | { id: string; model?: string; effort?: string; owns?: string[]; workspace?: string }
      | undefined;

    expect(metrics).toBeDefined();
    expect(metrics?.owns).toEqual(['src/metrics/']);
    expect(metrics?.workspace).toBe('.');
    expect(metrics?.effort).toBe('max');
  });

  it('lets an explicit participant list replace the roster, because that is what it is for', async () => {
    // The other side. Preservation must not become "you can never change the
    // roster from the command line again".
    const repo = await repoWithCommit();
    await runInit({ repo, force: false, participants: ['leader:leader:claude-code-app'] });
    await runInit({ repo, force: true, participants: ['chief:leader:claude-code-app', 'w:worker:cursor-app'] });

    const ids = (await rosterOf(repo)).map((participant) => participant.id);

    expect(ids).toContain('chief');
    expect(ids).toContain('w');
    expect(ids).not.toContain('leader');
  });

  /**
   * CT-20, and found by running `init` rather than by any test.
   *
   * `ensureWorkspaces` built `.crosstalk/worktrees/<id>` and a `ct/<id>-base`
   * branch for every worker regardless of its declared workspace, so a
   * shared-root roster still produced a directory and a branch per agent that
   * nothing ever checks out — the project-tree clutter shared root was asked
   * for to remove.
   */
  it('builds no worktree for a worker that shares the repository root', async () => {
    const repo = await repoWithCommit();
    await runInit({ repo, force: false, participants: ['leader:leader:claude-code-app'] });

    const roster = await readFile(join(repo, 'crosstalk.yaml'), 'utf8');
    await writeFile(
      join(repo, 'crosstalk.yaml'),
      roster.replace(
        /participants:\n/,
        'participants:\n  - id: metrics\n    role: worker\n    harness: claude-code-app\n    lifecycle: attached\n    workspace: .\n    owns:\n      - fixtures/\n',
      ),
      'utf8',
    );
    await runInit({ repo, force: true, participants: [] });

    const worktrees = (await execFile('git', ['worktree', 'list'], { cwd: repo, windowsHide: true })).stdout;
    expect(worktrees).not.toContain('metrics');
    const branches = (await execFile('git', ['branch', '--list'], { cwd: repo, windowsHide: true })).stdout;
    expect(branches).not.toContain('ct/metrics-base');
  });

  it('still builds one for a worker that declares its own workspace', async () => {
    // The other side. Making the worktree conditional must not make it optional.
    const repo = await repoWithCommit();
    await runInit({ repo, force: false, participants: ['leader:leader:claude-code-app', 'codex:worker:cursor-app'] });

    const worktrees = (await execFile('git', ['worktree', 'list'], { cwd: repo, windowsHide: true })).stdout;
    expect(worktrees).toContain('codex');
  });

  it('writes no effort key at all rather than an empty one', async () => {
    // A written `effort: ""` is worse than no key: it renders as a trailing
    // space beside the model and reads as a configured blank rather than as
    // "nobody said". `model` already behaves this way and `effort` must match.
    const repo = await repoWithCommit();
    await runInit({
      repo,
      force: false,
      participants: ['leader:leader:claude-code-app'],
    });

    expect(await readFile(join(repo, 'crosstalk.yaml'), 'utf8')).not.toMatch(/effort:/);
  });

  it('accepts a SPOC seat and parks it in the repository root', async () => {
    const repo = await repoWithCommit();
    await runInit({
      repo,
      force: false,
      participants: ['leader:leader:claude-code-app', 'reviewer:spoc:claude-code-app'],
    });

    const roster = parse(await readFile(join(repo, 'crosstalk.yaml'), 'utf8')) as {
      participants: { id: string; role: string; workspace: string }[];
    };
    const spoc = roster.participants.find((participant) => participant.id === 'reviewer');

    expect(spoc?.role).toBe('spoc');
    expect(spoc?.workspace).toBe('.');
  });
});
