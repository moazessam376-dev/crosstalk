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
});
