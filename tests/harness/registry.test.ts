import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRegistry, probeTier } from '../../src/harness/registry.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

describe('harness registry', () => {
  it('ships CLI and app variants as separate keys', async () => {
    const registry = await loadRegistry();
    for (const key of ['claude-code-cli', 'claude-code-app', 'codex-cli', 'codex-app', 'cursor-cli', 'cursor-app']) {
      expect(registry.has(key)).toBe(true);
    }
  });

  it('marks every app variant unsupervisable', async () => {
    const registry = await loadRegistry();
    for (const [key, descriptor] of registry) {
      if (key.endsWith('-app')) expect(descriptor.supervisable).toBe(false);
    }
  });

  it('falls back to shell when the mcp probe is unverified', async () => {
    const descriptor = {
      key: 'codex-app',
      briefFile: 'AGENTS.md',
      mcp: 'unverified' as const,
      supervisable: false,
    };
    expect(await probeTier(descriptor, process.cwd())).toBe('shell');
  });

  it('uses mcp when the configured registration file exists and is writable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosstalk-harness-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, 'mcp.json'), '{}\n', 'utf8');

    expect(await probeTier({
      key: 'test-cli',
      briefFile: 'AGENTS.md',
      mcp: 'stdio',
      mcpConfigPath: 'mcp.json',
      supervisable: true,
    }, directory)).toBe('mcp');
  });
});

/**
 * CT-2. The old probe asked whether the file at `mcpConfigPath` was writable —
 * but `init` is what creates that file, so the answer described Crosstalk's own
 * output rather than the harness, and flipped from `shell` to `mcp` the moment
 * `init` ran. `doctor` then reported no MCP_PROBE_FALLBACK, asserting the tier
 * was healthy on the strength of a file we had just written to ourselves.
 */
describe('probeTier describes the harness, not our own output', () => {
  it('gives the same answer before and after a registration exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosstalk-probe-'));
    temporaryDirectories.push(directory);
    const cursor = {
      key: 'cursor-app',
      briefFile: '.cursor/rules/crosstalk.mdc',
      mcp: 'stdio' as const,
      mcpConfigPath: '.cursor/mcp.json',
      supervisable: false,
    };

    // Nothing written yet — the harness is no less MCP-capable for that.
    expect(await probeTier(cursor, directory)).toBe('mcp');

    await mkdir(join(directory, '.cursor'), { recursive: true });
    await writeFile(join(directory, '.cursor', 'mcp.json'), '{}\n', 'utf8');

    // The property that was broken: the tier must not move because we wrote a file.
    expect(await probeTier(cursor, directory)).toBe('mcp');
  });

  it('refuses the mcp tier for an unverified transport, and for a path outside the workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosstalk-probe-'));
    temporaryDirectories.push(directory);

    // codex-app: `unverified` and no path at all. Nothing to register.
    expect(await probeTier({
      key: 'codex-app', briefFile: 'AGENTS.md', mcp: 'unverified', supervisable: false,
    }, directory)).toBe('shell');

    // codex-cli: a real stdio transport, but at `~/.codex/config.toml`. B3
    // never writes outside the repository, so there is no registration to read.
    expect(await probeTier({
      key: 'codex-cli', briefFile: 'AGENTS.md', mcp: 'stdio', mcpConfigPath: '~/.codex/config.toml', supervisable: true,
    }, directory)).toBe('shell');
  });
});
