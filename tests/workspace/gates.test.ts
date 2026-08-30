import { describe, expect, it } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { contractExists, noSharedFiles } from '../../src/workspace/gates.js';

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile('git', args, { cwd });
}

/** A repo with `main`, and one branch per seat. */
async function repoWithBranches(branches: Record<string, Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-gates-'));
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'bench@example.com');
  await git(dir, 'config', 'user.name', 'bench');
  await writeFile(join(dir, 'README.md'), 'base\n', 'utf8');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'base');

  for (const [branch, files] of Object.entries(branches)) {
    await git(dir, 'checkout', '-b', branch, 'main');
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(dir, path, '..'), { recursive: true }).catch(() => {});
      await writeFile(join(dir, path), body, 'utf8');
    }
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', `work on ${branch}`);
  }
  await git(dir, 'checkout', 'main');
  return dir;
}

describe('the contract gate', () => {
  it('refuses a contract that does not exist, and says so by name', async () => {
    const dir = await repoWithBranches({});
    const gate = await contractExists(dir, 'src/contract.ts');

    expect(gate.met).toBe(false);
    expect(gate.missing).toContain('src/contract.ts');
  });

  it('refuses an empty one — a touched file is not an agreement', async () => {
    const dir = await repoWithBranches({});
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/contract.ts'), '', 'utf8');

    expect((await contractExists(dir, 'src/contract.ts')).met).toBe(false);
  });

  it('passes once it has content', async () => {
    const dir = await repoWithBranches({});
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/contract.ts'), 'export interface Ship {}\n', 'utf8');

    expect((await contractExists(dir, 'src/contract.ts')).met).toBe(true);
  });
});

describe('the no-shared-files gate', () => {
  it('passes when the split held', async () => {
    const dir = await repoWithBranches({
      'ct/opus': { 'src/world.ts': 'world\n' },
      'ct/sonnet': { 'src/sim.ts': 'sim\n' },
      'ct/luna': { 'src/game.ts': 'game\n' },
    });

    const gate = await noSharedFiles(dir, 'main', [
      { seat: 'opus', branch: 'ct/opus' },
      { seat: 'sonnet', branch: 'ct/sonnet' },
      { seat: 'luna', branch: 'ct/luna' },
    ]);
    expect(gate.met).toBe(true);
  });

  it('names the file and both seats when two wrote the same one', async () => {
    const dir = await repoWithBranches({
      'ct/opus': { 'src/fleet.ts': 'opus version\n' },
      'ct/sonnet': { 'src/fleet.ts': 'sonnet version\n' },
    });

    const gate = await noSharedFiles(dir, 'main', [
      { seat: 'opus', branch: 'ct/opus' },
      { seat: 'sonnet', branch: 'ct/sonnet' },
    ]);

    // This is beacon-1's seam bug caught before it ships, and the message has
    // to say who has to decide — a count would send both seats re-reading.
    expect(gate.met).toBe(false);
    expect(gate.missing).toContain('src/fleet.ts');
    expect(gate.missing).toContain('opus');
    expect(gate.missing).toContain('sonnet');
  });

  it('treats a seat that has not branched yet as having collided with nobody', async () => {
    const dir = await repoWithBranches({ 'ct/opus': { 'src/world.ts': 'world\n' } });

    const gate = await noSharedFiles(dir, 'main', [
      { seat: 'opus', branch: 'ct/opus' },
      { seat: 'sonnet', branch: 'ct/sonnet' },
    ]);
    expect(gate.met).toBe(true);
  });

  it('does not blame a seat for what landed on main while it was away', async () => {
    const dir = await repoWithBranches({
      'ct/opus': { 'src/world.ts': 'world\n' },
      'ct/sonnet': { 'src/sim.ts': 'sim\n' },
    });
    // main moves on, touching a file opus owns. Two-dot diffs would now report
    // sonnet as having changed it, and the gate would fail every seat.
    await git(dir, 'checkout', 'main');
    await writeFile(join(dir, 'src-note.md'), 'moved on\n', 'utf8');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'main moves');

    const gate = await noSharedFiles(dir, 'main', [
      { seat: 'opus', branch: 'ct/opus' },
      { seat: 'sonnet', branch: 'ct/sonnet' },
    ]);
    expect(gate.met).toBe(true);
  });
});
