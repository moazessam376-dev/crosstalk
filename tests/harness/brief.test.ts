import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PolicyConfig, Participant } from '../../src/contracts/index.js';
import type { HarnessDescriptor } from '../../src/harness/registry.js';
import { briefVersion, renderBrief, writeBrief } from '../../src/harness/brief.js';

const temporaryDirectories: string[] = [];

function worker(overrides: Partial<Participant> = {}): Participant {
  return {
    id: 'codex',
    role: 'worker',
    harness: 'codex-app',
    lifecycle: 'attached',
    workspace: '.',
    ...overrides,
  };
}

function descriptor(overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor {
  return {
    key: 'codex-app',
    briefFile: 'AGENTS.md',
    mcp: 'unverified',
    supervisable: false,
    ...overrides,
  };
}

function policy(options: { maxRounds?: number } = {}): PolicyConfig {
  return {
    selfCritique: { required: true, minRounds: 1 },
    leaderCritique: { maxRounds: 2 },
    dispute: {
      maxRounds: options.maxRounds ?? 3,
      ladder: ['discriminating_test', 'third_agent', 'leader'],
      rungTimeouts: { discriminating_test: '30m', third_agent: '30m' },
    },
    taskAcceptance: { method: 'leader' },
  };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

describe('brief generation', () => {
  it('embeds a stable version hash in the brief', () => {
    const content = renderBrief(worker(), descriptor(), policy(), 'mcp');
    const version = briefVersion(content);

    expect(version).toMatch(/^ct-brief-[0-9a-f]{8}$/);
    expect(version).toBe(briefVersion(renderBrief(worker(), descriptor(), policy(), 'mcp')));
    expect(content).toContain(`<!-- crosstalk brief version: ${version} -->`);
  });

  it('changes version when the policy changes', () => {
    const a = renderBrief(worker(), descriptor(), policy({ maxRounds: 3 }), 'mcp');
    const b = renderBrief(worker(), descriptor(), policy({ maxRounds: 5 }), 'mcp');

    expect(briefVersion(a)).not.toBe(briefVersion(b));
  });

  it('tells a shell-tier participant to use the CLI, not MCP tools', () => {
    const content = renderBrief(worker(), descriptor(), policy(), 'shell');

    expect(content).toContain('crosstalk claim raise');
    expect(content).not.toContain('raise_claim(');
  });

  it('states the contest-is-correct rule verbatim in every worker brief', () => {
    expect(renderBrief(worker(), descriptor(), policy(), 'mcp'))
      .toContain('Contesting a finding you believe is wrong is correct behavior');
  });

  it('uses the leader template for the leader role', () => {
    const content = renderBrief(
      worker({ id: 'leader', role: 'leader', harness: 'claude-code-app' }),
      descriptor({ key: 'claude-code-app', briefFile: 'CLAUDE.md' }),
      policy(),
      'mcp',
    );

    expect(content).toContain('# Crosstalk leader brief');
    expect(content).not.toContain('# Crosstalk worker brief');
  });

  it('writes a rendered brief inside the participant workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosstalk-brief-'));
    temporaryDirectories.push(directory);
    const participant = worker({ workspace: 'agents/codex' });

    await writeBrief(participant, descriptor(), policy(), 'shell', directory);
    await writeBrief(participant, descriptor(), policy(), 'mcp', directory);

    const content = await readFile(join(directory, 'agents', 'codex', 'AGENTS.md'), 'utf8');
    expect(content).toContain('# Crosstalk worker brief');
    expect(content).toContain('raise_claim(');
  });
});
