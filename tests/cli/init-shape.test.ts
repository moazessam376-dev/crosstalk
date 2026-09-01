import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { runInit } from '../../src/cli/init.js';

/**
 * The shape is how a team is told to be a team, and until now it reached the
 * config through nothing.
 *
 * `runCompose` took a `shape` and handed it to `runInit`, which had no such
 * option — the spread meant TypeScript never objected and the value was simply
 * dropped. So `config.shape` stayed unset, `shapeNamed(undefined)` returned
 * undefined, `/phase` answered `{shape: null}`, and every seat was briefed
 * without the phases and gates that distinguish `trio-contract` from three
 * people who happen to share a board. The launcher offered a picker whose
 * choice changed nothing about the run.
 */

const execFile = promisify(execFileCallback);

async function repoWithCommit(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-init-shape-'));
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 'test@crosstalk.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'crosstalk test'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), '# shape\n', 'utf8');
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  return repo;
}

async function shapeOf(repo: string): Promise<string | undefined> {
  const config = parse(await readFile(join(repo, 'crosstalk.yaml'), 'utf8')) as { shape?: string };
  return config.shape;
}

const TRIO = ['peer-1:peer:claude-code-app', 'peer-2:peer:claude-code-app', 'peer-3:peer:claude-code-app'];

describe('init carries the team shape', { timeout: 90_000 }, () => {
  it('writes the shape it was given', async () => {
    const repo = await repoWithCommit();
    await runInit({ repo, force: false, participants: TRIO, shape: 'trio-contract' });
    expect(await shapeOf(repo)).toBe('trio-contract');
  });

  /**
   * `init` is also how briefs and `.mcp.json` are regenerated after an edit, so
   * re-running it without naming a shape must not quietly demote the team to
   * no shape at all — the same reason the roster is read back rather than
   * overwritten.
   */
  it('keeps the shape already on disk when none is named', async () => {
    const repo = await repoWithCommit();
    await runInit({ repo, force: false, participants: TRIO, shape: 'trio-contract' });
    await runInit({ repo, force: true, participants: TRIO });
    expect(await shapeOf(repo)).toBe('trio-contract');
  });

  it('leaves a shapeless roster shapeless', async () => {
    const repo = await repoWithCommit();
    await runInit({ repo, force: false, participants: TRIO });
    expect(await shapeOf(repo)).toBeUndefined();
  });

  /** A run is re-shaped by naming a different one, not by editing YAML. */
  it('replaces the shape when a different one is named', async () => {
    const repo = await repoWithCommit();
    await runInit({ repo, force: false, participants: TRIO, shape: 'trio-contract' });
    await runInit({ repo, force: true, participants: ['solo-1:peer:claude-code-app'], shape: 'solo' });
    expect(await shapeOf(repo)).toBe('solo');
  });
});
