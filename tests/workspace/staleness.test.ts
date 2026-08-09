import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Claim, Evidence } from '../../src/contracts/index.js';
import { evaluateStaleness } from '../../src/workspace/staleness.js';

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

async function commitOnOrphanBranch(repo: string): Promise<string> {
  await git(repo, ['checkout', '--orphan', 'orphan']);
  await git(repo, ['read-tree', '--empty']);
  await rm(join(repo, 'README.md'), { force: true });
  await writeFile(join(repo, 'orphan.txt'), 'orphan\n', 'utf8');
  await git(repo, ['add', 'orphan.txt']);
  await git(repo, ['commit', '-m', 'orphan']);
  const orphan = await git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['checkout', 'main']);
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
});
