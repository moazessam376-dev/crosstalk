import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { EventsResponse } from '../../src/daemon/contract.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

const execFile = promisify(execFileCallback);

/**
 * A5's wiring, not A5's logic.
 *
 * `tests/daemon/staleness.test.ts` proves `checkStaleness` behaves. It cannot
 * prove the daemon ever calls it — every other daemon suite runs in a temp dir
 * that is not a git repo, so the sweep throws, the catch swallows it, and the
 * suite is green either way. That seam is the one this project has already
 * shipped broken once: 28 green tests over a screen nothing handed data to.
 *
 * So this builds a real repository, really orphans an evidence commit, and
 * asserts the daemon notices with nobody asking it to.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

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
`;

async function repoWithConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-stale-wire-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.name', 'Crosstalk Tests']);
  await git(dir, ['config', 'user.email', 'tests@crosstalk.invalid']);
  await writeFile(join(dir, 'README.md'), 'one\n', 'utf8');
  // Never `git add .` here: it would sweep the untracked crosstalk.yaml into a
  // commit, and a later checkout would delete the daemon's own config.
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'one']);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

const auth = (d: DaemonHandle, id: string) => ({ authorization: `Bearer ${d.tokens.get(id)!}` });

async function events(d: DaemonHandle): Promise<CrosstalkEvent[]> {
  const response = await fetch(`${d.url}/events`, { headers: auth(d, 'leader') });
  return ((await response.json()) as EventsResponse).events;
}

describe('the daemon really sweeps for stale evidence', () => {
  it('marks evidence orphaned by a rebase, with no client asking', { timeout: 120_000 }, async () => {
    const repo = await repoWithConfig();

    // A commit on a side branch, cited as evidence, then rebased away.
    await writeFile(join(repo, 'work.txt'), 'work\n', 'utf8');
    await git(repo, ['add', 'work.txt']);
    await git(repo, ['commit', '-m', 'work']);
    const orphan = await git(repo, ['rev-parse', 'HEAD']);

    let daemon = await startDaemon({ repo });
    try {
      const raised = await fetch(`${daemon.url}/claims`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(daemon, 'leader') },
        body: JSON.stringify({
          against: 'codex',
          target: 'src/economy.ts:41',
          assertion: 'staffing coefficient applied twice',
          severity: 'defect',
          falsifier: 'the focused ledger check would print two rows rather than one',
          evidence: [{ kind: 'command', command: 'npm test', output: 'ok', sha: orphan }],
        }),
      });
      expect(raised.status).toBe(201);
    } finally {
      await daemon.close();
    }

    // Rewrite it out of main. The object still exists; it is simply no longer
    // an ancestor — the state a rebase leaves somebody else's evidence in.
    await git(repo, ['reset', '--hard', 'HEAD~1']);
    await writeFile(join(repo, 'other.txt'), 'other\n', 'utf8');
    await git(repo, ['add', 'other.txt']);
    await git(repo, ['commit', '-m', 'other']);
    expect(await git(repo, ['rev-parse', 'HEAD'])).not.toBe(orphan);

    // Restarting is the common case: a merge landed while the daemon was down.
    daemon = await startDaemon({ repo });
    try {
      const stale = (await events(daemon)).filter((e) => e.kind === 'evidence_stale');
      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({ claimId: 'C-1', sha: orphan, room: 'dispute:C-1' });
    } finally {
      await daemon.close();
    }
  });

  it('leaves evidence that is still an ancestor alone', { timeout: 120_000 }, async () => {
    // The neighbouring case. Without it, a sweep that marked everything stale
    // would pass the test above.
    const repo = await repoWithConfig();
    const live = await git(repo, ['rev-parse', 'HEAD']);

    let daemon = await startDaemon({ repo });
    try {
      await fetch(`${daemon.url}/claims`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(daemon, 'leader') },
        body: JSON.stringify({
          against: 'codex',
          target: 'src/economy.ts:41',
          assertion: 'staffing coefficient applied twice',
          severity: 'defect',
          falsifier: 'the focused ledger check would print two rows rather than one',
          evidence: [{ kind: 'command', command: 'npm test', output: 'ok', sha: live }],
        }),
      });
    } finally {
      await daemon.close();
    }

    await writeFile(join(repo, 'more.txt'), 'more\n', 'utf8');
    await git(repo, ['add', 'more.txt']);
    await git(repo, ['commit', '-m', 'more']);

    daemon = await startDaemon({ repo });
    try {
      expect((await events(daemon)).filter((e) => e.kind === 'evidence_stale')).toHaveLength(0);
    } finally {
      await daemon.close();
    }
  });
});
