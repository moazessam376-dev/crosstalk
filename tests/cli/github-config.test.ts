import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { configureGithub, parseRepoUrl } from '../../src/cli/github.js';

/**
 * Turning the mirror on should be one command.
 *
 * It was a hand-edit of an undocumented YAML shape — `init` writes no mirror
 * key, and `doctor`'s remedy text said to add one yourself — and then the next
 * `init --force`, which the hub runs on every re-staffing, threw it away.
 */

const execFile = promisify(execFileCallback);

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
`;

type Mirror = { github: { enabled: boolean; mode: string; pollSeconds: number; humanLogin?: string } };

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-github-'));
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: dir, windowsHide: true });
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  return dir;
}

async function mirrorOf(dir: string): Promise<Mirror | undefined> {
  return (parse(await readFile(join(dir, 'crosstalk.yaml'), 'utf8')) as { mirror?: Mirror }).mirror;
}

async function remoteOf(dir: string): Promise<string> {
  const { stdout } = await execFile('git', ['remote', 'get-url', 'origin'], { cwd: dir, windowsHide: true });
  return stdout.trim();
}

describe('reading a repository out of what someone pasted', () => {
  it('takes the three forms people actually have in the clipboard', () => {
    for (const input of [
      'https://github.com/moazessam376-dev/crosstalk',
      'https://github.com/moazessam376-dev/crosstalk.git',
      'git@github.com:moazessam376-dev/crosstalk.git',
      'moazessam376-dev/crosstalk',
    ]) {
      expect(parseRepoUrl(input), input).toEqual({
        owner: 'moazessam376-dev',
        repo: 'crosstalk',
        url: 'https://github.com/moazessam376-dev/crosstalk.git',
      });
    }
  });

  it('refuses what it cannot read rather than guessing', () => {
    for (const input of ['', 'crosstalk', 'https://gitlab.com/a/b', 'https://github.com/only-an-owner']) {
      expect(() => parseRepoUrl(input), input).toThrow();
    }
  });
});

describe('configureGithub', () => {
  it('writes the mirror block and points origin at the repo', async () => {
    const dir = await repo();
    await configureGithub({ repo: dir, url: 'https://github.com/moazessam376-dev/crosstalk' });

    expect(await mirrorOf(dir)).toEqual({
      github: { enabled: true, mode: 'two-way-human', pollSeconds: 30, humanLogin: 'moazessam376-dev' },
    });
    expect(await remoteOf(dir)).toBe('https://github.com/moazessam376-dev/crosstalk.git');
  });

  it('defaults humanLogin to the owner, and lets it be overridden', async () => {
    // Without humanLogin, two-way-human degrades to one-way on any org repo:
    // `author_association === 'OWNER'` matched 0 of 300 comments across three
    // org repos, and 98 of 98 on the user-owned one. The owner segment is the
    // right guess for a personal repo and the wrong one for an org, so it is a
    // default rather than a rule.
    const dir = await repo();
    await configureGithub({ repo: dir, url: 'https://github.com/some-org/thing', login: 'moazessam376-dev' });

    expect((await mirrorOf(dir))!.github.humanLogin).toBe('moazessam376-dev');
  });

  it('moves an origin that already points somewhere else', async () => {
    const dir = await repo();
    await execFile('git', ['remote', 'add', 'origin', 'https://github.com/old/place.git'], { cwd: dir, windowsHide: true });

    await configureGithub({ repo: dir, url: 'moazessam376-dev/crosstalk' });

    expect(await remoteOf(dir)).toBe('https://github.com/moazessam376-dev/crosstalk.git');
  });

  it('leaves the rest of the config exactly as it found it', async () => {
    const dir = await repo();
    await configureGithub({ repo: dir, url: 'moazessam376-dev/crosstalk' });

    const after = parse(await readFile(join(dir, 'crosstalk.yaml'), 'utf8')) as {
      version: number;
      project: { mainBranch: string };
      participants: { id: string }[];
    };
    expect(after.version).toBe(1);
    expect(after.project.mainBranch).toBe('main');
    expect(after.participants.map((p) => p.id)).toEqual(['@human']);
  });
});
