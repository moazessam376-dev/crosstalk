import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit } from '../../src/cli/init.js';

/**
 * `.mcp.json` belongs to the user, not to Crosstalk.
 *
 * The first version of `writeMcpConfig` wrote the whole file, so running
 * `crosstalk init` on any real project silently deleted every MCP server the
 * user had configured. `crosstalk.yaml` and the tokens were already preserved
 * across a re-init — this was the one path that was not, and the only one that
 * destroyed something a person had written by hand.
 *
 * Found by running `init` against a repo that already had one, which is what
 * anyone testing this on their own project would do first.
 */

const execFile = promisify(execFileCallback);
const dirs: string[] = [];
let repo = '';

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mcp-merge-'));
  dirs.push(dir);
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: dir, windowsHide: true });
  await execFile('git', ['config', 'user.email', 'test@crosstalk.invalid'], { cwd: dir, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'crosstalk test'], { cwd: dir, windowsHide: true });
  await writeFile(join(dir, 'README.md'), '# probe\n', 'utf8');
  // A worker worktree needs a commit to branch from, and B3 writes into one.
  await execFile('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: dir, windowsHide: true });
  return dir;
}

const read = async (path: string): Promise<Record<string, any>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;

beforeEach(async () => {
  repo = await tempRepo();
}, 60_000);

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);

describe('crosstalk init and an existing .mcp.json', () => {
  it('keeps every server the user already had', async () => {
    const path = join(repo, '.mcp.json');
    await writeFile(path, JSON.stringify({
      mcpServers: {
        'my-existing-server': { command: 'node', args: ['important.js'] },
        another: { command: 'uvx', args: ['some-tool'] },
      },
    }, null, 2), 'utf8');

    await runInit({ repo, participants: [], force: false });

    const merged = await read(path);
    expect(Object.keys(merged['mcpServers'] as object).sort()).toEqual(['another', 'crosstalk', 'my-existing-server']);
    expect(merged['mcpServers']['my-existing-server']).toEqual({ command: 'node', args: ['important.js'] });
    expect(merged['mcpServers']['crosstalk']['env']['CROSSTALK_REPO']).toBeTruthy();
  }, 60_000);

  it('preserves unrelated top-level keys', async () => {
    const path = join(repo, '.mcp.json');
    await writeFile(path, JSON.stringify({ $schema: 'https://example.invalid/schema', mcpServers: {} }), 'utf8');

    await runInit({ repo, participants: [], force: false });

    expect((await read(path))['$schema']).toBe('https://example.invalid/schema');
  }, 60_000);

  it('replaces only its own entry when re-run', async () => {
    await runInit({ repo, participants: [], force: false });
    const path = join(repo, '.mcp.json');
    const first = await read(path);

    const withExtra = { ...first, mcpServers: { ...first['mcpServers'], mine: { command: 'x' } } };
    await writeFile(path, JSON.stringify(withExtra), 'utf8');

    await runInit({ repo, participants: [], force: true });

    const second = await read(path);
    expect(second['mcpServers']['mine']).toEqual({ command: 'x' });
    expect(second['mcpServers']['crosstalk']).toBeDefined();
  }, 60_000);

  it('writes the file when there is none', async () => {
    await runInit({ repo, participants: [], force: false });

    expect((await read(join(repo, '.mcp.json')))['mcpServers']['crosstalk']).toBeDefined();
  }, 60_000);

  it('gives every MCP-capable participant its own registration and its own token', async () => {
    const result = await runInit({
      repo,
      participants: ['leader:leader:claude-code-app', 'w:worker:cursor-app'],
      force: false,
    });

    // Each lands in its own workspace at its own harness's path — one shared
    // registration means two agents present one token, and `from` is the field
    // the ledger attributes by.
    const leaderEntry = (await read(join(repo, '.mcp.json')))['mcpServers']['crosstalk'];
    const workerEntry = (await read(join(repo, '.crosstalk', 'worktrees', 'w', '.cursor', 'mcp.json')))['mcpServers']['crosstalk'];

    expect(leaderEntry['env']['CROSSTALK_TOKEN_FILE']).toContain('tokens');
    expect(workerEntry['env']['CROSSTALK_TOKEN_FILE']).toContain('tokens');
    expect(leaderEntry['env']['CROSSTALK_TOKEN_FILE']).not.toBe(workerEntry['env']['CROSSTALK_TOKEN_FILE']);

    // Referenced, never embedded: this file is not a place for a live token.
    expect(leaderEntry['env']).not.toHaveProperty('CROSSTALK_TOKEN');
    expect(workerEntry['env']).not.toHaveProperty('CROSSTALK_TOKEN');

    // And the two token files really do hold different secrets.
    const [leaderToken, workerToken] = await Promise.all([
      readFile(leaderEntry['env']['CROSSTALK_TOKEN_FILE'] as string, 'utf8'),
      readFile(workerEntry['env']['CROSSTALK_TOKEN_FILE'] as string, 'utf8'),
    ]);
    expect(leaderToken.trim()).not.toBe(workerToken.trim());
    expect(result.mcp.filter((r) => r.written)).toHaveLength(2);
  }, 60_000);

  it('writes nothing for a harness it cannot register, and prints it instead', async () => {
    // The shipped default roster: codex-app declares `mcp: unverified` and has
    // no mcpConfigPath at all. Without this branch B3 goes green while the
    // symptom it exists to fix — a worker with no registration — survives.
    const result = await runInit({ repo, participants: [], force: false });

    const codex = result.mcp.find((entry) => entry.participantId === 'codex');
    expect(codex?.written).toBe(false);
    expect(codex?.reason).toMatch(/unverified|mcpConfigPath/i);
    // Printed, so the user can add it by hand rather than being told nothing.
    expect(JSON.stringify(codex?.entry)).toContain('CROSSTALK_TOKEN_FILE');

    // The neighbouring case that must still be written.
    expect(result.mcp.find((entry) => entry.participantId === 'leader')?.written).toBe(true);
  }, 60_000);

  it('refuses to write outside the repository it was pointed at', async () => {
    // codex-cli's mcpConfigPath is ~/.codex/config.toml. Editing a file in the
    // user's home directory is not something `init` on a repo may do.
    const result = await runInit({ repo, participants: ['l:leader:claude-code-app', 'c:worker:codex-cli'], force: false });

    const codex = result.mcp.find((entry) => entry.participantId === 'c');
    expect(codex?.written).toBe(false);
    expect(codex?.reason).toMatch(/outside the repository/i);
  }, 60_000);

  // Refusing is the point: rewriting JSON we could not parse is how the
  // original damage would happen a second time, to a file we understand even
  // less than the first.
  it('refuses to touch a file it cannot parse, and leaves it byte-for-byte', async () => {
    const path = join(repo, '.mcp.json');
    const garbage = '{ this is not json ';
    await writeFile(path, garbage, 'utf8');

    await expect(runInit({ repo, participants: [], force: false })).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path, 'utf8')).toBe(garbage);
  }, 60_000);
});
