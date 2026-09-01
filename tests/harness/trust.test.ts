import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { trustWorkspaces, untrusted, TRUST_KEY } from '../../src/harness/trust.js';

/**
 * A workspace path in this platform's own spelling.
 *
 * `trustWorkspaces` resolves what it is given, because a trust entry has to
 * match the absolute path the harness will look up. The tests wrote `/tmp/…`
 * literals, which resolve to `D:\tmp\…` on Windows — so they asserted a POSIX
 * string against a correctly-resolved Windows one and failed on a platform the
 * code was right about.
 */
function seat(name: string): string {
  return resolve(tmpdir(), name);
}

async function configWith(body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-trust-'));
  const path = join(dir, '.claude.json');
  await writeFile(path, JSON.stringify(body), 'utf8');
  return path;
}

describe('pre-accepting folder trust', () => {
  it('marks a workspace trusted', async () => {
    const path = await configWith({ projects: {} });

    const added = await trustWorkspaces([seat('seat-a')], path);

    expect(added).toEqual([seat('seat-a')]);
    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(after.projects[seat('seat-a')][TRUST_KEY]).toBe(true);
  });

  it('keeps every other key in the operator’s config', async () => {
    // This file holds their MCP servers and onboarding state. Writing it
    // wholesale to add one boolean would be a poor trade for a launch flag.
    const path = await configWith({
      numStartups: 41,
      mcpServers: { linear: { command: 'linear-mcp' } },
      projects: { '/tmp/other': { mcpServers: {}, [TRUST_KEY]: false, lastCost: 3 } },
    });

    await trustWorkspaces([seat('seat-a')], path);

    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(after.numStartups).toBe(41);
    expect(after.mcpServers.linear.command).toBe('linear-mcp');
    expect(after.projects['/tmp/other'].lastCost).toBe(3);
  });

  it('keeps a project’s own settings when flipping its trust', async () => {
    const path = await configWith({
      projects: { [seat('seat-a')]: { allowedTools: ['Read'], [TRUST_KEY]: false } },
    });

    await trustWorkspaces([seat('seat-a')], path);

    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(after.projects[seat('seat-a')].allowedTools).toEqual(['Read']);
    expect(after.projects[seat('seat-a')][TRUST_KEY]).toBe(true);
  });

  it('does not rewrite the file when every path is already trusted', async () => {
    const path = await configWith({ projects: { [seat('seat-a')]: { [TRUST_KEY]: true } } });
    const before = await readFile(path, 'utf8');

    expect(await trustWorkspaces([seat('seat-a')], path)).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('writes a config that does not exist yet rather than refusing to launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-trust-none-'));
    const path = join(dir, '.claude.json');

    await trustWorkspaces([seat('seat-a')], path);

    expect(JSON.parse(await readFile(path, 'utf8')).projects[seat('seat-a')][TRUST_KEY]).toBe(true);
  });

  it('reports which seats would stall, so a launch can refuse early', async () => {
    const path = await configWith({
      projects: { [seat('seat-a')]: { [TRUST_KEY]: true }, [seat('seat-b')]: { [TRUST_KEY]: false } },
    });

    expect(await untrusted([seat('seat-a'), seat('seat-b'), seat('seat-c')], path)).toEqual([
      seat('seat-b'),
      seat('seat-c'),
    ]);
  });
});
