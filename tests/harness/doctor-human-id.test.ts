import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN_ID, type CrosstalkConfig, type Participant } from '../../src/contracts/index.js';
import { doctor } from '../../src/harness/doctor.js';

/**
 * `crosstalk init` writes `@human` into every config it generates, and the very
 * next thing a new user runs is `crosstalk doctor`. Before this, that sequence
 * printed `REJECT INVALID_PARTICIPANT_ID` on a repository the tool had just
 * created itself — the first two commands of the product disagreeing.
 *
 * The rule is real: participant ids become worktree directory names, and `@` is
 * not safe in one. `@human` simply never gets a worktree. Found by Track G
 * running the real sequence, not by any test.
 */

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
let repo = '';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function tempRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'crosstalk-human-id-'));
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
  // Workers get their own worktree, exactly as `crosstalk init` writes them.
  // With `workspace: '.'` a worker resolves to the repo root and doctor
  // rejects it — correctly — which made an earlier version of this file assert
  // against a config the product never produces.
  const workspace = role === 'worker' ? `.crosstalk/worktrees/${id.replace(/^@/, '')}` : '.';
  return { id, role, harness: 'codex-app', lifecycle: 'attached', workspace };
}

/** Exactly what `crosstalk init` writes for the human. */
function humanParticipant(): Participant {
  return { id: HUMAN_ID, role: 'human', harness: 'human', lifecycle: 'attached', workspace: '.' };
}

function cfg(participants: Participant[]): CrosstalkConfig {
  return {
    version: 1,
    project: { repo: '.', mainBranch: 'main' },
    participants,
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
  };
}

const invalidId = (findings: Awaited<ReturnType<typeof doctor>>) =>
  findings.filter((f) => f.code === 'INVALID_PARTICIPANT_ID');

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

describe('doctor and the reserved human id', () => {
  it('accepts the config `crosstalk init` generates', async () => {
    const findings = await doctor(
      cfg([participant('leader', 'leader'), participant('codex', 'worker'), humanParticipant()]),
      repo,
    );

    expect(invalidId(findings)).toEqual([]);
  }, 60_000);

  // The neighbouring case. Without it the fix could be "never reject any id"
  // and every assertion above would still pass.
  it('still rejects any other id carrying an @', async () => {
    const findings = await doctor(
      cfg([participant('leader', 'leader'), participant('@codex', 'worker'), humanParticipant()]),
      repo,
    );

    expect(invalidId(findings)).toHaveLength(1);
    expect(invalidId(findings)[0]?.message).toContain('@codex');
  }, 60_000);

  // `@human` is exempt because it is the reserved singleton with no worktree —
  // not because its role is `human`. A second participant claiming that role
  // under a worktree-unsafe id is still a reject.
  it('exempts the id, not the role', async () => {
    const findings = await doctor(
      cfg([participant('leader', 'leader'), participant('codex', 'worker'), participant('@operator', 'human')]),
      repo,
    );

    expect(invalidId(findings)).toHaveLength(1);
    expect(invalidId(findings)[0]?.message).toContain('@operator');
  }, 60_000);

  // The second REJECT on the same fresh repo. It was missed for an hour
  // because it sat below a `head -20` in the reviewer's terminal, which is why
  // this asserts on the whole set of rejects rather than on one code.
  it('emits no reject at all for the config `crosstalk init` generates', async () => {
    const findings = await doctor(
      cfg([participant('leader', 'leader'), participant('codex', 'worker'), humanParticipant()]),
      repo,
    );

    expect(findings.filter((f) => f.level === 'reject')).toEqual([]);
  }, 60_000);

  it('still rejects an unknown harness on a non-human participant', async () => {
    const findings = await doctor(
      cfg([
        participant('leader', 'leader'),
        { id: 'codex', role: 'worker', harness: 'not-a-harness', lifecycle: 'attached', workspace: '.crosstalk/worktrees/codex' },
        humanParticipant(),
      ]),
      repo,
    );

    const unknown = findings.filter((f) => f.code === 'UNKNOWN_HARNESS');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toContain('codex');
  }, 60_000);
});
