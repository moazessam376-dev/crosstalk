import { describe, expect, it, afterEach } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runInit } from '../../src/cli/init.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { CLI_COMMANDS } from '../../src/cli/index.js';

const execFile = promisify(execFileCallback);
const CLI = join(process.cwd(), 'dist', 'cli', 'index.js');
const GIT_TEST_TIMEOUT = 60_000;

/**
 * `crosstalk runs`, driven as the operator would.
 *
 * The hub's run picker and this are two spellings of one interface — the
 * repo's standing rule, and it exists because beacon-1 shipped a CLI and a hub
 * that had drifted into disagreeing. So these drive the **built** CLI as a
 * subprocess: an argument the parser rejects is exactly the defect these are
 * for, and calling the handler directly would not see it.
 *
 * The one thing this surface has that the hub's does not is a way to refuse.
 * The hub asks the operator to type the run id before it will delete an
 * archive; a terminal cannot insist like that, so it insists on a flag — and
 * says what would be lost rather than asking "are you sure?".
 */
const daemons: DaemonHandle[] = [];

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.close().catch(() => undefined);
});

async function project(): Promise<{ repo: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-runs-cli-'));
  await execFile('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 't@e.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'test'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), '# t\n', 'utf8');
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  await runInit({ repo, participants: [], force: false });

  const daemon = await startDaemon({ repo });
  daemons.push(daemon);
  return { repo };
}

async function ct(repo: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFile('node', [CLI, ...args, '--repo', repo], { windowsHide: true });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: (failure.stdout ?? '') + (failure.stderr ?? '') };
  }
}

async function ids(repo: string): Promise<{ id: string; current: boolean }[]> {
  const { out } = await ct(repo, ['runs', '--json']);
  return (JSON.parse(out) as { runs: { id: string; current: boolean }[] }).runs;
}

describe('crosstalk runs', () => {
  it('is a command the CLI knows, and the help says so', () => {
    // `brief-vocabulary.test.ts` reads the first word after `` `crosstalk ``
    // out of the usage text, so a command in HANDLERS and absent from USAGE
    // is one an agent is never told about.
    expect(CLI_COMMANDS).toContain('runs');
  });

  it('lists what the picker lists, and starts a new one', async () => {
    const { repo } = await project();
    await ct(repo, ['say', '--as', '@human', '--tag', 'note', '--head', 'first run']);

    const started = await ct(repo, ['runs', 'new']);
    expect(started.code).toBe(0);

    const runs = await ids(repo);
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.current)).toHaveLength(1);
    // And the board it left behind is empty, which is the whole point.
    const events = await ct(repo, ['events', '--as', '@human', '--json']);
    expect(events.out).not.toContain('first run');
  }, GIT_TEST_TIMEOUT);

  it('stamps the run list with the operator’s own clock', async () => {
    // `startedAt.slice(0, 16)` is five characters cheaper and three hours wrong
    // east of Greenwich. That exact slice was on every card in the hub until it
    // was caught by putting two labels for one run side by side; a run list is
    // the one place nothing compares it to anything, so it is checked here.
    const { repo } = await project();
    await ct(repo, ['say', '--as', '@human', '--tag', 'note', '--head', 'now']);

    const { out } = await ct(repo, ['runs']);
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    // To the hour, not the minute: a test that straddles :59 would be flaky.
    expect(out).toContain(
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:`,
    );
  }, GIT_TEST_TIMEOUT);

  it('archives a finished run out of the live log', async () => {
    const { repo } = await project();
    await ct(repo, ['say', '--as', '@human', '--tag', 'note', '--head', 'the old one']);
    await ct(repo, ['runs', 'new']);

    const older = (await ids(repo)).find((run) => !run.current)!;
    const archived = await ct(repo, ['runs', 'archive', older.id]);

    expect(archived.code).toBe(0);
    expect(await readdir(join(repo, '.crosstalk', 'runs'))).toEqual([`${older.id}.jsonl`]);
  }, GIT_TEST_TIMEOUT);

  it('refuses to delete an archive without --yes, and says what would be lost', async () => {
    // The only irreversible act in the product. A confirmation prompt would be
    // unusable from a script and a bare `rm` would be too easy; naming the
    // consequence and requiring the flag is the version that survives both.
    const { repo } = await project();
    await ct(repo, ['say', '--as', '@human', '--tag', 'note', '--head', 'the old one']);
    await ct(repo, ['runs', 'new']);
    const older = (await ids(repo)).find((run) => !run.current)!;
    await ct(repo, ['runs', 'archive', older.id]);

    const refused = await ct(repo, ['runs', 'rm', older.id]);

    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('permanently');
    expect(refused.out).toContain('--yes');
    // Refused means refused: the file is still there.
    expect(await readdir(join(repo, '.crosstalk', 'runs'))).toEqual([`${older.id}.jsonl`]);

    const done = await ct(repo, ['runs', 'rm', older.id, '--yes']);
    expect(done.code).toBe(0);
    expect(await readdir(join(repo, '.crosstalk', 'runs'))).toEqual([]);
  }, GIT_TEST_TIMEOUT);

  it('will not delete a run that has not been archived', async () => {
    // The daemon's rule, not the CLI's — repeated here only to check the CLI
    // passes the refusal through rather than swallowing it.
    const { repo } = await project();
    await ct(repo, ['say', '--as', '@human', '--tag', 'note', '--head', 'still live']);
    const current = (await ids(repo)).find((run) => run.current)!;

    const refused = await ct(repo, ['runs', 'rm', current.id, '--yes']);

    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('Archive it first');
  }, GIT_TEST_TIMEOUT);

  it('names the subcommand it did not understand', async () => {
    const { repo } = await project();
    const wrong = await ct(repo, ['runs', 'delete', 'r-20260902-1412-a3f1c9']);
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain('delete');
  }, GIT_TEST_TIMEOUT);
});
