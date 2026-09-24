import { describe, expect, it } from 'vitest';

import { withMcpRegistration, withSeatModel } from '../../src/cli/compose.js';
import { loadRegistry, probeTier } from '../../src/harness/registry.js';
import { briefPathFor, localBriefFile } from '../../src/harness/brief.js';

/**
 * A Codex seat Crosstalk can actually run.
 *
 * Three things were wrong with one, and each was silent: `--effort high` is not
 * a `codex exec` flag, so a seat with an effort died on argument parsing; the
 * brief went to `AGENTS.local.md`, which the binary has never opened; and MCP
 * lived in `~/.codex/config.toml`, which `init` refuses to write, so the seat
 * was briefed for the shell and given a `crosstalk` command that is not on
 * PATH.
 */

describe('model and effort, in the binary’s own words', () => {
  it('uses -m and a config override for codex, which has no --effort', () => {
    expect(withSeatModel(['codex', 'exec', '--json'], { model: 'gpt-5.6-sol', effort: 'high' })).toEqual([
      'codex',
      'exec',
      '--json',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="high"',
    ]);
  });

  it('leaves claude on --model and --effort', () => {
    expect(withSeatModel(['claude'], { model: 'claude-opus-5', effort: 'high' })).toEqual([
      'claude',
      '--model',
      'claude-opus-5',
      '--effort',
      'high',
    ]);
  });

  it('does not repeat an effort the spawn line already pins', () => {
    const pinned = ['codex', 'exec', '-c', 'model_reasoning_effort="low"'];
    expect(withSeatModel(pinned, { effort: 'high' })).toEqual(pinned);
  });
});

describe('the MCP registration on the command line', () => {
  const entry = {
    command: 'node',
    args: ['C:\\src\\crosstalk\\dist\\mcp\\index.js'],
    env: { CROSSTALK_REPO: 'C:\\repo', CROSSTALK_TOKEN_FILE: 'C:\\repo\\.crosstalk\\tokens\\lead' },
  };

  it('spells the same entry .mcp.json carries as three -c overrides', () => {
    const argv = withMcpRegistration(['codex', 'exec'], entry);
    expect(argv).toEqual([
      'codex',
      'exec',
      '-c',
      'mcp_servers.crosstalk.command="node"',
      '-c',
      'mcp_servers.crosstalk.args=["C:\\\\src\\\\crosstalk\\\\dist\\\\mcp\\\\index.js"]',
      '-c',
      'mcp_servers.crosstalk.env={CROSSTALK_REPO="C:\\\\repo",CROSSTALK_TOKEN_FILE="C:\\\\repo\\\\.crosstalk\\\\tokens\\\\lead"}',
    ]);
  });

  it('touches nothing for a harness that is not codex, or when there is nothing to hand over', () => {
    expect(withMcpRegistration(['claude'], entry)).toEqual(['claude']);
    expect(withMcpRegistration(['codex', 'exec'], undefined)).toEqual(['codex', 'exec']);
  });
});

describe('the registry’s word on codex', () => {
  it('drives codex-cli by resume, briefs it at AGENTS.override.md, and hands it MCP on spawn', async () => {
    const codex = (await loadRegistry()).get('codex-cli')!;
    expect(codex.turnFormat).toBe('resume');
    expect(codex.briefSuffix).toBe('override');
    expect(codex.mcpInject).toBe('codex-config');
    expect(codex.spawn).toContain('workspace-write');
  });

  it('puts a spawnable codex seat on the mcp tier, since the registration travels with the process', async () => {
    const codex = (await loadRegistry()).get('codex-cli')!;
    expect(await probeTier(codex, '/nowhere')).toBe('mcp');
  });

  it('writes the brief where the binary looks', async () => {
    const codex = (await loadRegistry()).get('codex-cli')!;
    expect(localBriefFile(codex.briefFile, undefined, codex.briefSuffix)).toBe('AGENTS.override.md');
    const worker = { id: 'luna', role: 'worker' as const, harness: 'codex-cli', lifecycle: 'supervised' as const, workspace: '.crosstalk/worktrees/luna' };
    expect(briefPathFor(worker, codex.briefFile, '/repo', codex.briefSuffix)).toBe('AGENTS.override.md');
    // And the default is unchanged for everyone else.
    expect(localBriefFile('CLAUDE.md')).toBe('CLAUDE.local.md');
  });
});
