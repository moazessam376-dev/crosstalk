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
  await execFile('git', ['init'], { cwd: dir, windowsHide: true });
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
