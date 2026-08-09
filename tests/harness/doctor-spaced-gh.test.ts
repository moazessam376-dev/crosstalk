import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CrosstalkConfig, Participant } from '../../src/contracts/index.js';
import { doctor } from '../../src/harness/doctor.js';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
let repo = '';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function tempRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'crosstalk-doctor-gh-'));
  temporaryDirectories.push(directory);
  await git(directory, ['init']);
  await git(directory, ['config', 'user.name', 'Crosstalk Tests']);
  await git(directory, ['config', 'user.email', 'tests@crosstalk.invalid']);
  await writeFile(join(directory, 'README.md'), 'doctor\n', 'utf8');
  await git(directory, ['add', 'README.md']);
  await git(directory, ['commit', '-m', 'initial']);
  return directory;
}

function participant(id: string, role: Participant['role']): Participant {
  return {
    id,
    role,
    harness: 'codex-app',
    lifecycle: 'attached',
    workspace: '.',
  };
}

function config(): CrosstalkConfig {
  return {
    version: 1,
    project: { repo: '.', mainBranch: 'main' },
    participants: [
      participant('leader', 'leader'),
      participant('worker-1', 'worker'),
      participant('worker-2', 'worker'),
    ],
    policy: {
      selfCritique: { required: true, minRounds: 1 },
      leaderCritique: { maxRounds: 2 },
      dispute: {
        maxRounds: 3,
        ladder: ['discriminating_test', 'third_agent', 'leader'],
        rungTimeouts: { discriminating_test: '30m', third_agent: '30m', human: '4h' },
      },
      taskAcceptance: { method: 'leader' },
    },
    mirror: { github: { enabled: true, mode: 'one-way', pollSeconds: 30 } },
  };
}

beforeEach(async () => {
  repo = await tempRepo();
}, 60_000);

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}, 60_000);

describe('doctor GitHub credential probing', () => {
  it.skipIf(process.platform !== 'win32')('reports an unknown credential state for a spaced gh.cmd shim', async () => {
    const ghDirectory = join(repo, 'Program Files', 'GitHub CLI');
    await mkdir(ghDirectory, { recursive: true });
    await writeFile(join(ghDirectory, 'gh.cmd'), '@echo off\r\necho gh-ok %*\r\n', 'utf8');

    const originalPath = process.env.PATH;
    const originalPathFallback = process.env.Path;
    const originalPathExt = process.env.PATHEXT;
    const originalGithubToken = process.env.GITHUB_TOKEN;
    const originalGhToken = process.env.GH_TOKEN;
    try {
      process.env.PATH = [ghDirectory, originalPath ?? originalPathFallback ?? ''].filter(Boolean).join(delimiter);
      process.env.PATHEXT = ['.CMD', ...(originalPathExt ?? '.EXE;.BAT').split(';')
        .filter((extension) => extension.toUpperCase() !== '.CMD')].join(';');
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;

      const findings = await doctor(config(), repo);

      expect(findings).toContainEqual(expect.objectContaining({
        level: 'warn',
        code: 'MIRROR_CREDENTIAL_UNKNOWN',
      }));
      expect(findings.some((finding) => finding.code === 'MIRROR_NO_CREDENTIAL')).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathFallback === undefined) delete process.env.Path;
      else process.env.Path = originalPathFallback;
      if (originalPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathExt;
      if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGithubToken;
      if (originalGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalGhToken;
    }
  }, 60_000);
  it.skipIf(process.platform !== 'win32')('verifies unspaced .cmd and .bat shims instead of reporting unknown credentials', async () => {
    const originalPath = process.env.PATH;
    const originalPathFallback = process.env.Path;
    const originalPathExt = process.env.PATHEXT;
    const originalGithubToken = process.env.GITHUB_TOKEN;
    const originalGhToken = process.env.GH_TOKEN;
    try {
      for (const extension of ['cmd', 'bat']) {
        const ghDirectory = join(repo, `GitHub-CLI-${extension}`);
        await mkdir(ghDirectory, { recursive: true });
        await writeFile(join(ghDirectory, `gh.${extension}`), '@echo off\\r\\necho gh-ok %*\\r\\n', 'utf8');
        process.env.PATH = [ghDirectory, originalPath ?? originalPathFallback ?? ''].filter(Boolean).join(delimiter);
        process.env.PATHEXT = ['.CMD', '.BAT', ...(originalPathExt ?? '.EXE').split(';')]
          .filter((value, index, values) => values.indexOf(value) === index).join(';');
        delete process.env.GITHUB_TOKEN;
        delete process.env.GH_TOKEN;

        const findings = await doctor(config(), repo);

        expect(findings.some((finding) => finding.code === 'MIRROR_CREDENTIAL_UNKNOWN')).toBe(false);
        expect(findings.some((finding) => finding.code === 'MIRROR_NO_CREDENTIAL')).toBe(false);
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathFallback === undefined) delete process.env.Path;
      else process.env.Path = originalPathFallback;
      if (originalPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathExt;
      if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGithubToken;
      if (originalGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalGhToken;
    }
  }, 60_000);
});
