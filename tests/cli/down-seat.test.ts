import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

/**
 * Stopping the daemon is an operator act, not a leader act.
 *
 * `down` authenticated as `leader` by default, which predates flat peer
 * rosters. On the shape the bench actually runs — three peers, no leader —
 * there is no such seat and no such token, so a bare `crosstalk down` failed
 * with "No token for leader" and named a fix (`crosstalk init`) that would not
 * have helped. The operator had to know to pass `--as @human` to stop their own
 * daemon.
 *
 * Measured mid-run while tearing down a leaderless team, which is exactly when
 * nobody wants to be reading a CLI's argument list.
 */

const execFile = promisify(execFileCallback);

const CLI = new URL('../../dist/cli/index.js', import.meta.url).pathname;

const FLAT_ROSTER = `version: 1
project:
  repo: .
  mainBranch: main
shape: trio-contract
participants:
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
  - id: peer-1
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
  - id: peer-2
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
`;

const daemons: DaemonHandle[] = [];

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.close().catch(() => {});
  }
});

async function flatRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-down-seat-'));
  await writeFile(join(repo, 'crosstalk.yaml'), FLAT_ROSTER, 'utf8');
  return repo;
}

describe('stopping a leaderless team', () => {
  it('stops without being told which seat to authenticate as', async () => {
    const repo = await flatRepo();
    const daemon = await startDaemon({ repo });
    daemons.push(daemon);

    // No `--as`. There is no leader on this roster and there never will be.
    const { stdout } = await execFile(process.execPath, [CLI, 'down', '--repo', repo], { windowsHide: true });

    expect(stdout).toContain('Daemon stopped');
    // And it cleaned up after itself, which is the other half of `down`.
    expect(await readdir(join(repo, '.crosstalk'))).not.toContain('daemon.json');
  }, 60_000);
});
