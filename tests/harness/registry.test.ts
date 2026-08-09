import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
