import { describe, expect, it } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runInit } from '../../src/cli/init.js';

const execFile = promisify(execFileCallback);

async function repoWithCommit(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-peer-worktrees-'));
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 'test@crosstalk.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'crosstalk test'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), '# peers\n', 'utf8');
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  return repo;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The beacon-1 launch failure, as a test.
 *
 * `init` built worktrees for `worker` seats only, and the flat peer roster was
 * added without touching that predicate. Three peer seats launched into
 * directories holding nothing but their brief; one improvised by writing source
 * into an ignored path and posted an environment note that misled the board for
 * ten minutes, and the operator rebuilt real worktrees around it mid-run.
 *
 * Nothing failed loudly, which is why it needs a test rather than a fix.
 */
describe('init gives every seat that writes code a checkout', { timeout: 90_000 }, () => {
  it('builds a worktree for a peer, not only for a worker', async () => {
    const repo = await repoWithCommit();

    await runInit({
      repo,
      force: false,
      participants: [
        'opus:peer:claude-code-app',
        'sonnet:peer:claude-code-app',
      ],
    });

    expect(await isDirectory(join(repo, '.crosstalk', 'worktrees', 'opus'))).toBe(true);
    expect(await isDirectory(join(repo, '.crosstalk', 'worktrees', 'sonnet'))).toBe(true);
  });

  it('gives each peer its own branch, so two seats never share a head', async () => {
    const repo = await repoWithCommit();

    await runInit({
      repo,
      force: false,
      participants: ['opus:peer:claude-code-app', 'sonnet:peer:claude-code-app'],
    });

    const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo,
      windowsHide: true,
    });
    // `git worktree list` prints forward slashes on every platform, including
    // Windows, where `join` would give backslashes. Comparing in git's spelling
    // rather than the platform's is what the assertion is actually about.
    const listed = stdout.replace(/\\/g, '/');
    expect(listed).toContain('.crosstalk/worktrees/opus');
    expect(listed).toContain('.crosstalk/worktrees/sonnet');
  });
});
