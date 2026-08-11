import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CrosstalkConfig, LadderRung, Participant } from '../../src/contracts/index.js';
import { doctor, installSkewFinding, type Finding } from '../../src/harness/doctor.js';

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
  rungTimeouts?: CrosstalkConfig['policy']['dispute']['rungTimeouts'];
  taskAcceptance?: CrosstalkConfig['policy']['taskAcceptance']['method'];
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
        rungTimeouts: options.rungTimeouts ?? { discriminating_test: '30m', third_agent: '30m', human: '4h' },
      },
      taskAcceptance: { method: options.taskAcceptance ?? 'leader' },
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

/**
 * CT-17 and CT-19. An unbuilt feature and a deliberately disabled one looked
 * identical, and the uninformative outcome was the default one: `init` never
 * prompts for a model, so the roster it writes has none and the hub has nothing
 * to show — while `doctor` said nothing about either.
 */
describe('doctor names what is absent, not only what is wrong', () => {
  function findingsFor(config: CrosstalkConfig): Promise<Finding[]> {
    return doctor(config, repo);
  }

  it('warns once for every participant missing a model, not once each', async () => {
    // A default `init` already emits two warnings and `up` prints them above the
    // banner. One line per participant would make a correct first run look like
    // a fault report.
    const none = await findingsFor(cfg({ workers: 2 }));
    const model = none.filter((f) => f.code === 'PARTICIPANT_NO_MODEL');

    expect(model).toHaveLength(1);
    expect(model[0]!.level).toBe('warn');
    expect(model[0]!.message).toContain('worker-0');
    expect(model[0]!.message).toContain('worker-1');
  }, 60_000);

  it('stays quiet when every participant declares a model', async () => {
    // The neighbouring case, without which the check is just always-on noise.
    const declared = cfg({
      participants: [
        participant('lead', 'leader', { model: 'opus-5' }),
        participant('w', 'worker', { model: 'gpt-5.5-codex' }),
      ],
    });

    expect(await findingsFor(declared)).not.toContainEqual(
      expect.objectContaining({ code: 'PARTICIPANT_NO_MODEL' }),
    );
  }, 60_000);

  it('says mirroring is unbuilt when the key is absent, and not when it is off on purpose', async () => {
    expect(await findingsFor(cfg())).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'MIRROR_UNCONFIGURED' }),
    );

    // `enabled: false` is a decision, not a gap. Warning about it would train
    // the operator to ignore the line.
    const disabled: CrosstalkConfig = { ...cfg(), mirror: { github: { enabled: false, mode: 'two-way-human', pollSeconds: 30 } } };
    expect(await findingsFor(disabled)).not.toContainEqual(
      expect.objectContaining({ code: 'MIRROR_UNCONFIGURED' }),
    );
  }, 60_000);

  it('neither blocks a start', async () => {
    const findings = await findingsFor(cfg());
    for (const code of ['PARTICIPANT_NO_MODEL', 'MIRROR_UNCONFIGURED']) {
      expect(findings.find((f) => f.code === code)?.level).toBe('warn');
    }
  }, 60_000);

  /**
   * The ordinary daily case `init` cannot see. `init` only inspects a base
   * branch whose worktree is *gone*; a worktree that exists and is registered
   * but has fallen behind is never examined, and that is the one the operator
   * hand-fixed with `git merge --ff-only main` in three worktrees at once.
   */
  it('warns when a live worker worktree has fallen behind the main branch', async () => {
    await git(repo, ['branch', '-M', 'main']);
    const worktree = join(repo, '.crosstalk', 'worktrees', 'w');
    await git(repo, ['worktree', 'add', '-q', '-b', 'ct/w-base', worktree]);

    const behind = cfg({
      participants: [participant('lead', 'leader'), participant('w', 'worker', { workspace: '.crosstalk/worktrees/w' })],
    });

    // Level: at main, nothing to say.
    expect(await findingsFor(behind)).not.toContainEqual(
      expect.objectContaining({ code: 'WORKTREE_BEHIND_MAIN' }),
    );

    // Main moves on; the worktree does not.
    await writeFile(join(repo, 'README.md'), 'moved on\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    await git(repo, ['commit', '-m', 'second']);

    const findings = await findingsFor(behind);
    expect(findings).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'WORKTREE_BEHIND_MAIN' }),
    );
    expect(findings.find((f) => f.code === 'WORKTREE_BEHIND_MAIN')!.message).toContain('w');
  }, 60_000);
});

describe('rules that keep a config from stranding work', () => {
  it('rejects a vote-based taskAcceptance, and accepts the two that resolve', async () => {
    // C-15. `majority`/`unanimous` parse and validate, then refuse every
    // acceptance with NOT_TASK_AUTHORITY naming a decision route nothing opens
    // — the task sits in `submitted` forever and the log says only that
    // somebody was not authorised.
    for (const method of ['majority', 'unanimous'] as const) {
      expect(await doctor(cfg({ taskAcceptance: method }), repo)).toContainEqual(
        expect.objectContaining({ level: 'reject', code: 'TASK_ACCEPTANCE_UNIMPLEMENTED' }),
      );
    }
    // Both sides: the implemented methods must stay accepted, or the check is
    // just refusing everything.
    for (const method of ['leader', 'human'] as const) {
      expect(await doctor(cfg({ taskAcceptance: method }), repo)).not.toContainEqual(
        expect.objectContaining({ code: 'TASK_ACCEPTANCE_UNIMPLEMENTED' }),
      );
    }
  }, 60_000);

  it('reserves the id `crosstalk`, as it reserves `human`', async () => {
    const reserved = cfg({ participants: [participant('crosstalk', 'leader'), participant('w', 'worker')] });
    expect(await doctor(reserved, repo)).toContainEqual(
      expect.objectContaining({ level: 'reject', code: 'RESERVED_PARTICIPANT_ID' }),
    );

    // `crosstalk` names the MCP server entry and the tool; an ordinary id does not.
    const fine = cfg({ participants: [participant('lead', 'leader'), participant('w', 'worker')] });
    expect(await doctor(fine, repo)).not.toContainEqual(
      expect.objectContaining({ code: 'RESERVED_PARTICIPANT_ID' }),
    );
  }, 60_000);

  it('warns when the CLI on PATH is a different install, and stays quiet otherwise', async () => {
    // CT-1. Both roots supplied, so the rule is exercised without depending on
    // the machine happening to have a divergent global install.
    const here = resolve('/opt/crosstalk');
    expect(await installSkewFinding(here, resolve('/opt/crosstalk-leader'))).toMatchObject({
      level: 'warn',
      code: 'CLI_INSTALL_SKEW',
    });
    // Same install, and no global install at all: both silent. A warning that
    // fires either way would be noise on every correctly-configured machine.
    expect(await installSkewFinding(here, here)).toBeUndefined();
    expect(await installSkewFinding(here, undefined)).toBeUndefined();
  }, 60_000);
});

describe('doctor', () => {
  it('rejects a timeout on the last rung, and accepts the same ladder without one', async () => {
    const ladder: LadderRung[] = ['discriminating_test', 'third_agent', 'human'];
    const timed = { discriminating_test: '30m' as const, third_agent: '30m' as const, human: '4h' as const };

    // The last rung never arms a timer, so a timeout configured on it is dead
    // config that reads as a working escalation. Track A's C-2.
    expect(await doctor(cfg({ ladder, rungTimeouts: timed }), repo)).toContainEqual(
      expect.objectContaining({ level: 'reject', code: 'TERMINAL_RUNG_TIMEOUT' }),
    );

    // Both sides: a check that refused every `human`-terminated ladder would
    // pass the assertion above while being entirely wrong.
    const untimed = { discriminating_test: '30m' as const, third_agent: '30m' as const };
    expect(await doctor(cfg({ ladder, rungTimeouts: untimed }), repo)).not.toContainEqual(
      expect.objectContaining({ code: 'TERMINAL_RUNG_TIMEOUT' }),
    );

    // And the shipped default — which sets `human: '4h'` while ending on
    // `leader` — must stay accepted: the timeout is only dead on the *last* rung.
    expect(await doctor(cfg(), repo)).not.toContainEqual(
      expect.objectContaining({ code: 'TERMINAL_RUNG_TIMEOUT' }),
    );
  }, 60_000);

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
