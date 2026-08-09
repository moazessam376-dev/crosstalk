import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CrosstalkConfig, LadderRung, Participant } from '../../src/contracts/index.js';
import { doctor, type Finding } from '../../src/harness/doctor.js';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
let repo = '';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function tempRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'crosstalk-doctor-'));
  temporaryDirectories.push(directory);
  await git(directory, ['init']);
  await git(directory, ['config', 'user.name', 'Crosstalk Tests']);
  await git(directory, ['config', 'user.email', 'tests@crosstalk.invalid']);
  await writeFile(join(directory, 'README.md'), 'doctor\n', 'utf8');
  await git(directory, ['add', 'README.md']);
  await git(directory, ['commit', '-m', 'initial']);
  return directory;
}

function participant(id: string, role: Participant['role'], overrides: Partial<Participant> = {}): Participant {
  return {
    id,
    role,
    harness: 'codex-app',
    lifecycle: 'attached',
    workspace: '.',
    ...overrides,
  };
}

function cfg(options: {
  ladder?: LadderRung[];
  leaders?: number;
  workers?: number;
  participants?: Participant[];
} = {}): CrosstalkConfig {
  const participants = options.participants ?? [
    ...Array.from({ length: options.leaders ?? 1 }, (_, index) => participant(index === 0 ? 'leader' : `leader-${index}`, 'leader')),
    ...Array.from({ length: options.workers ?? 2 }, (_, index) => participant(`worker-${index}`, 'worker')),
  ];

  return {
    version: 1,
    project: { repo: '.', mainBranch: 'main' },
    participants,
    policy: {
      selfCritique: { required: true, minRounds: 1 },
      leaderCritique: { maxRounds: 2 },
      dispute: {
        maxRounds: 3,
        ladder: options.ladder ?? ['discriminating_test', 'third_agent', 'leader'],
        rungTimeouts: { discriminating_test: '30m', third_agent: '30m', human: '4h' },
      },
      taskAcceptance: { method: 'leader' },
    },
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

describe('doctor', () => {
  it('rejects a ladder whose last rung is not terminal', async () => {
    const findings = await doctor(cfg({ ladder: ['discriminating_test', 'third_agent'] }), repo);

    expect(findings).toContainEqual(expect.objectContaining({ level: 'reject', code: 'NON_TERMINAL_LADDER' }));
  }, 60_000);

  it('rejects supervised lifecycle on an app harness', async () => {
    const findings = await doctor(cfg({
      participants: [
        participant('leader', 'leader'),
        participant('codex', 'worker', { lifecycle: 'supervised', harness: 'codex-app' }),
      ],
    }), repo);

    expect(findings).toContainEqual(expect.objectContaining({ level: 'reject', code: 'SUPERVISED_GUI_HARNESS' }));
  }, 60_000);

  it('rejects a worker whose workspace resolves to the repo root', async () => {
    const findings = await doctor(cfg({
      participants: [
        participant('leader', 'leader'),
        participant('codex', 'worker', { workspace: '.' }),
      ],
    }), repo);

    expect(findings).toContainEqual(expect.objectContaining({ level: 'reject', code: 'WORKER_IN_REPO_ROOT' }));
  }, 60_000);

  it('allows the leader to occupy the repo root', async () => {
    const findings = await doctor(cfg({
      participants: [participant('leader', 'leader', { workspace: '.' })],
    }), repo);

    expect(findings.filter((finding) => finding.code === 'WORKER_IN_REPO_ROOT')).toHaveLength(0);
  }, 60_000);

  it('rejects zero or multiple leaders', async () => {
    expect(await doctor(cfg({ leaders: 0 }), repo))
      .toContainEqual(expect.objectContaining({ code: 'LEADER_COUNT' }));
    expect(await doctor(cfg({ leaders: 2 }), repo))
      .toContainEqual(expect.objectContaining({ code: 'LEADER_COUNT' }));
  }, 60_000);

  it('warns, not rejects, with a single worker and names the lost rung', async () => {
    const findings = await doctor(cfg({ workers: 1 }), repo);
    const warning = findings.find((finding) => finding.code === 'THIRD_AGENT_UNAVAILABLE') as Finding | undefined;

    expect(warning).toBeDefined();
    expect(warning?.level).toBe('warn');
    expect(warning?.message).toContain('third_agent');
  }, 60_000);

  it('every finding carries a remedy', async () => {
    const findings = await doctor(cfg({ workers: 1, ladder: ['third_agent'] }), repo);

    for (const finding of findings) expect(finding.remedy.length).toBeGreaterThan(0);
  }, 60_000);

  it('short-circuits missing repository prerequisites to one reject', async () => {
    const emptyDirectory = await mkdtemp(join(tmpdir(), 'crosstalk-doctor-empty-'));
    temporaryDirectories.push(emptyDirectory);

    const findings = await doctor(cfg(), emptyDirectory);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('reject');
  }, 60_000);
});
