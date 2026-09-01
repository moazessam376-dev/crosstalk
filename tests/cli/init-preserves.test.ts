import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { runInit } from '../../src/cli/init.js';

/**
 * What survives a regeneration.
 *
 * This is the whole reason "nobody ever configures the GitHub mirror". The
 * mirror is enabled by hand-editing `crosstalk.yaml`, because `init` writes no
 * mirror key and `doctor` tells you to add one. Then `init --force` rebuilds the
 * file from `configuredShape` and `configuredRoster`, which carry the shape and
 * the participants and nothing else — and the hub calls `runInit({force:true})`
 * on every launch whose roster or shape differs. So the block is gone before the
 * first message, every time, and the operator has no way to find out except by
 * re-reading the file.
 *
 * `contractPath` had the same hole, which is half of why the contract gate was
 * unmeetable.
 */

const execFile = promisify(execFileCallback);

async function repoWithCommit(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-init-preserves-'));
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 'test@crosstalk.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'crosstalk test'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), '# preserve\n', 'utf8');
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  return repo;
}

type Config = {
  shape?: string;
  contractPath?: string;
  mirror?: { github: { enabled: boolean; mode: string; pollSeconds: number; humanLogin?: string } };
  participants: { id: string }[];
};

async function configOf(repo: string): Promise<Config> {
  return parse(await readFile(join(repo, 'crosstalk.yaml'), 'utf8')) as Config;
}

const ROSTER = ['peer-1:peer:claude-code-app', 'peer-2:peer:claude-code-app'];

describe('init --force keeps what it did not write', { timeout: 90_000 }, () => {
  it('carries the mirror block through a regeneration', async () => {
    const repo = await repoWithCommit();
    await runInit({ repo, participants: ROSTER, force: false });

    // What an operator does today, following doctor's own remedy text.
    const edited = await configOf(repo);
    edited.mirror = {
      github: { enabled: true, mode: 'two-way-human', pollSeconds: 30, humanLogin: 'moazessam376-dev' },
    };
    await writeFile(join(repo, 'crosstalk.yaml'), stringify(edited), 'utf8');

    await runInit({ repo, participants: ROSTER, force: true });

    const after = await configOf(repo);
    expect(after.mirror).toEqual({
      github: { enabled: true, mode: 'two-way-human', pollSeconds: 30, humanLogin: 'moazessam376-dev' },
    });
  });

  it('carries contractPath through a regeneration', async () => {
    const repo = await repoWithCommit();
    await runInit({ repo, participants: ROSTER, force: false });

    const edited = await configOf(repo);
    edited.contractPath = 'src/shared/contract.ts';
    await writeFile(join(repo, 'crosstalk.yaml'), stringify(edited), 'utf8');

    await runInit({ repo, participants: ROSTER, force: true });

    expect((await configOf(repo)).contractPath).toBe('src/shared/contract.ts');
  });

  it('writes neither key when there was none, so a fresh config stays clean', async () => {
    // The neighbouring case. Preserving must not mean inventing: an absent
    // mirror means no mirror, and `MirrorConfig` says so in as many words.
    const repo = await repoWithCommit();
    await runInit({ repo, participants: ROSTER, force: false });

    const after = await configOf(repo);
    expect(after.mirror).toBeUndefined();
    expect(after.contractPath).toBeUndefined();
  });
});
