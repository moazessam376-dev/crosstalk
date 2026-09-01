import { execFile as execFileCb } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { GhTransport } from '../../src/mirror/github.js';

const execFile = promisify(execFileCb);

/**
 * The half of the PR path that is not GitHub.
 *
 * `grep` confirmed nothing in `src/` ever ran `git push`, and a seat branch
 * exists only inside that seat's worktree — so `gh pr create --head ct/opus`
 * was asking GitHub to open a pull request against a ref it had never seen.
 * The mirror's per-task PR machinery has therefore never usefully run; last
 * session the seats pushed by hand and the gap went unnoticed.
 *
 * Proved against a local bare remote with `gh` stubbed, so the claim is checked
 * without publishing anything to anybody's repository. What is *not* covered
 * here, and should be said rather than implied: the real `gh pr create` round
 * trip against a real GitHub repo.
 */

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A `gh` that records what it was asked and answers `pr list` plausibly. */
async function stubGh(dir: string): Promise<{ path: string; calls: () => Promise<string> }> {
  const log = join(dir, 'gh-calls.txt');
  const path = join(dir, 'gh');
  await writeFile(
    path,
    [
      '#!/bin/sh',
      `echo "$@" >> ${JSON.stringify(log)}`,
      'case "$2" in',
      // `findPullRequestByBranch` parses this.
      '  list) echo \'[{"number":7,"url":"https://example.invalid/pr/7","state":"OPEN","isDraft":true}]\' ;;',
      '  *) echo "https://example.invalid/pr/7" ;;',
      'esac',
      'exit 0',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, calls: () => readFile(log, 'utf8').catch(() => '') };
}

async function repoWithRemote(): Promise<{ repo: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ct-push-'));
  dirs.push(root);
  const remote = join(root, 'remote.git');
  const repo = join(root, 'work');

  await execFile('git', ['init', '-q', '--bare', remote]);
  await execFile('git', ['init', '-q', repo]);
  const git = (args: string[]) => execFile('git', args, { cwd: repo });
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['config', 'user.name', 'test']);
  await git(['remote', 'add', 'origin', remote]);
  await writeFile(join(repo, 'README.md'), 'seed\n', 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'seed']);
  return { repo, remote };
}

describe('opening a pull request for a seat branch', () => {
  it('pushes the branch first, so there is a head to open against', async () => {
    const { repo, remote } = await repoWithRemote();
    const gh = await stubGh(repo);

    await execFile('git', ['checkout', '-q', '-b', 'ct/opus'], { cwd: repo });
    await writeFile(join(repo, 'harbor.ts'), 'export const x = 1;\n', 'utf8');
    await execFile('git', ['add', '-A'], { cwd: repo });
    await execFile('git', ['commit', '-q', '-m', 'work'], { cwd: repo });

    // Nothing on the remote yet: this is every seat branch, every run.
    const before = await execFile('git', ['branch', '-a'], { cwd: remote });
    expect(before.stdout).not.toContain('ct/opus');

    const transport = (await GhTransport.create(repo, 'main', gh.path))!;
    const created = await transport.createDraftPullRequest({
      branch: 'ct/opus',
      title: 'harbor',
      body: 'the slice',
    });

    const after = await execFile('git', ['branch', '-a'], { cwd: remote });
    expect(after.stdout).toContain('ct/opus');
    expect(created.number).toBe(7);
    expect(await gh.calls()).toContain('pr create');
  });

  it('re-pushes a branch that moved, which a rebase makes ordinary', async () => {
    const { repo } = await repoWithRemote();
    const gh = await stubGh(repo);
    const transport = (await GhTransport.create(repo, 'main', gh.path))!;

    await execFile('git', ['checkout', '-q', '-b', 'ct/opus'], { cwd: repo });
    await writeFile(join(repo, 'a.ts'), '1\n', 'utf8');
    await execFile('git', ['add', '-A'], { cwd: repo });
    await execFile('git', ['commit', '-q', '-m', 'first'], { cwd: repo });
    await transport.createDraftPullRequest({ branch: 'ct/opus', title: 't', body: 'b' });

    // Rewrite the branch, as a rebase does, and open again — the restart path.
    await execFile('git', ['commit', '-q', '--amend', '-m', 'first, amended'], { cwd: repo });
    await expect(
      transport.createDraftPullRequest({ branch: 'ct/opus', title: 't', body: 'b' }),
    ).resolves.toMatchObject({ number: 7 });
  });
});
