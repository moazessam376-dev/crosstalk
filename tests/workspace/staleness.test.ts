import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Claim, Evidence, Task } from '../../src/contracts/index.js';
import { evaluateStaleness, evaluateTaskStaleness } from '../../src/workspace/staleness.js';

const execFile = promisify(execFileCallback);
const temporaryRepositories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function tempRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'crosstalk-stale-'));
  temporaryRepositories.push(repo);

  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Crosstalk Tests']);
  await git(repo, ['config', 'user.email', 'tests@crosstalk.invalid']);
  await writeFile(join(repo, 'README.md'), 'first\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'first']);
  await git(repo, ['branch', '-M', 'main']);
  await writeFile(join(repo, 'README.md'), 'second\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'second']);

  return repo;
}

async function commitOnOrphanBranch(repo: string, name = 'orphan'): Promise<string> {
  await git(repo, ['checkout', '--orphan', name]);
  await git(repo, ['read-tree', '--empty']);
  await rm(join(repo, 'README.md'), { force: true });
  await writeFile(join(repo, `${name}.txt`), `${name}\n`, 'utf8');
  await git(repo, ['add', `${name}.txt`]);
  await git(repo, ['commit', '-m', name]);
  const orphan = await git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['checkout', 'main']);
  // Deleted so the commit is *orphaned*, not merely unmerged: staleness now
  // means no local branch reaches the sha, and a live `orphan` branch would
  // keep its commit legitimately fresh.
  await git(repo, ['branch', '-D', name]);
  return orphan;
}

function evidence(sha: string, stale?: boolean): Evidence {
  return {
    kind: 'command',
    command: 'npm test',
    sha,
    by: 'codex',
    ...(stale === undefined ? {} : { stale }),
  };
}

/**
 * §5.4's own story, run for real rather than mocked: a branch is rebased onto
 * main and fast-forwarded in, so the commit its evidence was gathered at is
 * rewritten and no longer reachable from the branch it was merged into.
 */
async function rebaseWorkOntoMain(repo: string): Promise<{ before: string; head: string }> {
  await git(repo, ['checkout', '-b', 'work']);
  await writeFile(join(repo, 'work.txt'), 'work\n', 'utf8');
  await git(repo, ['add', 'work.txt']);
  await git(repo, ['commit', '-m', 'work']);
  const before = await git(repo, ['rev-parse', 'HEAD']);

  await git(repo, ['checkout', 'main']);
  await writeFile(join(repo, 'README.md'), 'third\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'third']);

  await git(repo, ['checkout', 'work']);
  await git(repo, ['rebase', 'main']);
  await git(repo, ['checkout', 'main']);
  await git(repo, ['merge', '--ff-only', 'work']);

  return { before, head: await git(repo, ['rev-parse', 'main']) };
}

function claim(id: string, items: Evidence[]): Claim {
  return {
    id,
    raisedBy: 'leader',
    against: 'codex',
    target: 'src/example.ts:1',
    assertion: 'the example is correct',
    severity: 'defect',
    falsifier: 'the example output differs from the expected output',
    evidence: items,
    state: 'open',
    rounds: 0,
  };
}

afterEach(async () => {
  while (temporaryRepositories.length > 0) {
    const repo = temporaryRepositories.pop();
    if (repo !== undefined) {
      await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}, 60_000);

describe('evidence staleness', () => {
  it('reports evidence whose sha is not an ancestor of head', async () => {
    const repo = await tempRepo();
    const orphan = await commitOnOrphanBranch(repo);
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const claims = [claim('C-1', [evidence(orphan)]), claim('C-2', [evidence(head)])];

    expect(await evaluateStaleness(claims, head, repo)).toEqual([{ claimId: 'C-1', sha: orphan }]);
  }, 60_000);

  it('does not re-report evidence already marked stale', async () => {
    const repo = await tempRepo();
    const orphan = await commitOnOrphanBranch(repo);
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const claims = [claim('C-1', [evidence(orphan, true)])];

    expect(await evaluateStaleness(claims, head, repo)).toEqual([]);
  }, 60_000);

  it('reports evidence gathered at a commit a real rebase rewrote', async () => {
    const repo = await tempRepo();
    const { before, head } = await rebaseWorkOntoMain(repo);
    const claims = [claim('C-1', [evidence(before)]), claim('C-2', [evidence(head)])];

    expect(await evaluateStaleness(claims, head, repo)).toEqual([{ claimId: 'C-1', sha: before }]);
  }, 60_000);

  // `merge-base --is-ancestor` exits 128 on an object the repository does not
  // hold, which `isAncestor` rethrows — so without this one pruned sha ends the
  // whole sweep and every other claim goes unchecked.
  it('reports evidence at a sha this repository has never held', async () => {
    const repo = await tempRepo();
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const missing = '0123456789abcdef0123456789abcdef01234567';

    expect(await evaluateStaleness([claim('C-1', [evidence(missing)])], head, repo)).toEqual([
      { claimId: 'C-1', sha: missing },
    ]);
  }, 60_000);

  // The neighbouring case for the one above: a genuine git failure must not be
  // laundered into "everything is stale", which would fire an event per claim.
  it('rethrows when the repository itself cannot answer', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'crosstalk-stale-bare-'));
    temporaryRepositories.push(notARepo);

    await expect(
      evaluateStaleness([claim('C-1', [evidence('0123456789abcdef0123456789abcdef01234567')])], 'HEAD', notARepo),
    ).rejects.toThrow();
  }, 60_000);
});

/**
 * F3's gap, still open: `evaluateStaleness` is claim-scoped, so nothing could
 * decide that a *submitted task's* evidence went stale — which is the other
 * half of §5.4. "Submission evidence" is `Task.critique.findings[].closedBy`,
 * the only `Evidence` reachable from a `Task`.
 */
describe('task submission staleness', () => {
  it('reports the task whose submission evidence a rebase orphaned, and not its neighbour', async () => {
    const repo = await tempRepo();
    const { before, head } = await rebaseWorkOntoMain(repo);
    const tasks = [taskWithEvidence('T-1', [before]), taskWithEvidence('T-2', [head])];

    expect(await evaluateTaskStaleness(tasks, head, repo)).toEqual([{ taskId: 'T-1', sha: before }]);
  }, 60_000);

  it('reports every distinct stale sha on one task', async () => {
    const repo = await tempRepo();
    const orphanA = await commitOnOrphanBranch(repo, 'orphan-a');
    const orphanB = await commitOnOrphanBranch(repo, 'orphan-b');
    const head = await git(repo, ['rev-parse', 'HEAD']);

    expect(orphanA).not.toBe(orphanB);
    expect(await evaluateTaskStaleness([taskWithEvidence('T-1', [orphanA, orphanB])], head, repo)).toEqual([
      { taskId: 'T-1', sha: orphanA },
      { taskId: 'T-1', sha: orphanB },
    ]);
  }, 60_000);

  it('reports nothing for a task that has never been self-reviewed', async () => {
    const repo = await tempRepo();
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const bare = taskWithEvidence('T-1', []);
    delete bare.critique;

    expect(await evaluateTaskStaleness([bare], head, repo)).toEqual([]);
  }, 60_000);
});

function taskWithEvidence(id: string, shas: string[]): Task {
  return {
    id,
    title: 'Build the log',
    brief: 'Implement the append-only event log.',
    specRefs: ['§5.2'],
    assignee: 'codex',
    deps: [],
    acceptance: ['the log appends by seq'],
    state: 'submitted',
    branch: `ct/${id}-log`,
    critique: {
      rounds: 1,
      critic: 'codex subagent',
      findings: shas.map((sha) => ({
        assertion: 'the log appends by seq',
        closedBy: [evidence(sha)],
      })),
    },
  };
}
