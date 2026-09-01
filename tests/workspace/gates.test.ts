import { describe, expect, it } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { contractExists, noSharedFiles } from '../../src/workspace/gates.js';
import { createWorktree, seatBranches } from '../../src/workspace/git.js';

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

  it('reports a seat with no branch as unchecked, not as clear', async () => {
    // This used to assert `met: true`, on the argument that a seat which has
    // not pushed has not collided with anyone. True about that seat, and wrong
    // about the gate: `changedFiles` swallowed *every* unknown ref into `[]`,
    // so when the daemon asked about `ct/<id>` while init had created
    // `ct/<id>-base`, all three seats came back empty, the intersection of
    // three empty sets was empty, and the gate reported green for the whole
    // life of the feature. It has never once run against real branches.
    //
    // A gate that cannot tell "nobody collided" from "I could not look" is not
    // a gate. Advancing past Build because a seat produced nothing is also the
    // wrong answer on its own terms.
    const dir = await repoWithBranches({ 'ct/opus': { 'src/world.ts': 'world\n' } });

    const gate = await noSharedFiles(dir, 'main', [
      { seat: 'opus', branch: 'ct/opus' },
      { seat: 'sonnet', branch: 'ct/sonnet' },
    ]);

    expect(gate.met).toBe(false);
    expect(gate.missing).toContain('sonnet');
    expect(gate.missing).toContain('ct/sonnet');
  });

  it('still passes a branch that exists and changed nothing', async () => {
    // The neighbouring case, and the one the old comment was actually right
    // about. An existing branch with an empty diff has genuinely collided with
    // nobody, and must not be confused with a branch that is not there.
    const dir = await repoWithBranches({ 'ct/opus': { 'src/world.ts': 'world\n' } });
    await git(dir, 'branch', 'ct/sonnet', 'main');

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

describe('resolving which branch a seat is on', () => {
  it('reads the branch from git rather than guessing the name', async () => {
    // The bug this exists for: `init` creates `ct/<id>-base`, and the daemon
    // asked `noSharedFiles` about `ct/<id>`. Neither half was obviously wrong
    // on its own, and together they made the gate unfalsifiable. A branch a
    // seat is on is a fact git holds; nothing should be reconstructing it from
    // an id and a convention.
    const dir = await repoWithBranches({});
    await createWorktree(dir, 'peer-1', 'ct/peer-1-base');
    await createWorktree(dir, 'peer-2', 'ct/peer-2-base');

    const resolved = await seatBranches(dir, [
      { id: 'peer-1', workspace: '.crosstalk/worktrees/peer-1' },
      { id: 'peer-2', workspace: '.crosstalk/worktrees/peer-2' },
    ]);

    expect(resolved).toEqual([
      { seat: 'peer-1', branch: 'ct/peer-1-base' },
      { seat: 'peer-2', branch: 'ct/peer-2-base' },
    ]);
  });

  it('leaves out a seat working in the repo root', async () => {
    // The planner sits at the root, which is where merging N branches has to
    // happen. It owns no branch of its own, so it is not a party to a
    // no-shared-files check and must not be reported as an unknown one.
    const dir = await repoWithBranches({});
    await createWorktree(dir, 'peer-1', 'ct/peer-1-base');

    const resolved = await seatBranches(dir, [
      { id: 'planner', workspace: '.' },
      { id: 'peer-1', workspace: '.crosstalk/worktrees/peer-1' },
    ]);

    expect(resolved).toEqual([{ seat: 'peer-1', branch: 'ct/peer-1-base' }]);
  });

  it('carries a seat whose worktree is gone through as unknown, not as absent', async () => {
    // Dropping it would put us back where we started: a seat that cannot be
    // checked, silently not counted.
    const dir = await repoWithBranches({});

    const resolved = await seatBranches(dir, [
      { id: 'peer-1', workspace: '.crosstalk/worktrees/peer-1' },
    ]);

    expect(resolved).toEqual([{ seat: 'peer-1', branch: 'ct/peer-1-base' }]);
    expect((await noSharedFiles(dir, 'main', resolved)).met).toBe(false);
  });
});
