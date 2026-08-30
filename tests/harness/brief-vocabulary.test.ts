import { describe, expect, it } from 'vitest';
import type { PolicyConfig, Participant, Tier } from '../../src/contracts/index.js';
import type { HarnessDescriptor } from '../../src/harness/registry.js';
import { renderBrief } from '../../src/harness/brief.js';
import { CLI_COMMANDS } from '../../src/cli/index.js';
import { TOOLS_BY_NAME } from '../../src/mcp/tools.js';

/**
 * The brief is the first thing every agent reads, and it named commands that do
 * not exist.
 *
 * Shell tier told agents to run `crosstalk acknowledge` and `crosstalk submit`;
 * neither has ever been a command. MCP tier named `acknowledge()` and
 * `submit()`; the real tools are `ack_task` and `submit_task`. Four commands, two
 * fictional, on either transport â€” and it survived a whole protocol repair
 * because nothing compared the brief to the code.
 *
 * Both sets are derived from the real registries rather than restated here. A
 * second hand-written list is how the first one drifted.
 */

function participant(overrides: Partial<Participant> = {}): Participant {
  return { id: 'codex', role: 'worker', harness: 'codex-cli', lifecycle: 'attached', workspace: '.', ...overrides };
}

function descriptor(overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor {
  return { key: 'codex-cli', briefFile: 'AGENTS.md', mcp: 'stdio', supervisable: true, ...overrides };
}

const policy: PolicyConfig = {
  selfCritique: { required: true, minRounds: 1 },
  leaderCritique: { maxRounds: 2 },
  dispute: {
    maxRounds: 3,
    ladder: ['discriminating_test', 'third_agent', 'leader'],
    rungTimeouts: { discriminating_test: '30m', third_agent: '30m' },
  },
  taskAcceptance: { method: 'leader' },
};

/** Every `` `crosstalk <name>` `` the brief tells the agent to run. */
function shellCommandsNamed(brief: string): string[] {
  return [...brief.matchAll(/`(?:crosstalk|ct) ([a-z][a-z-]*)/g)].map((match) => match[1]!);
}

/** Every `` `tool_name(` `` the brief tells the agent to call. */
function mcpToolsNamed(brief: string): string[] {
  return [...brief.matchAll(/`([a-z_][a-z0-9_]*)\(/g)].map((match) => match[1]!);
}

const ROLES: Participant['role'][] = ['leader', 'worker', 'spoc'];

describe('a brief only names commands that exist', () => {
  it.each(ROLES)('shell tier, %s role', (role) => {
    const brief = renderBrief(participant({ role }), descriptor(), policy, 'shell', '/repo');
    const named = shellCommandsNamed(brief);

    // Guard against a vacuous pass: a brief that named nothing would satisfy
    // every assertion below while telling the agent how to do nothing.
    expect(named.length).toBeGreaterThan(0);
    for (const command of named) {
      expect(CLI_COMMANDS, `brief names \`crosstalk ${command}\``).toContain(command);
    }
  });

  it.each(ROLES)('mcp tier, %s role', (role) => {
    const brief = renderBrief(participant({ role }), descriptor(), policy, 'mcp', '/repo');
    const named = mcpToolsNamed(brief);

    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) {
      expect([...TOOLS_BY_NAME.keys()], `brief calls \`${tool}()\``).toContain(tool);
    }
  });

  it('catches the exact names that were wrong, so the check is not decorative', () => {
    // The regressions this test exists for. If someone reintroduces them, the
    // assertions above fail â€” these prove the extractors would actually see them.
    expect(shellCommandsNamed('run `crosstalk acknowledge --task T`')).toEqual(['acknowledge']);
    expect(mcpToolsNamed('call `submit(task_id)` now')).toEqual(['submit']);
    expect(CLI_COMMANDS).not.toContain('acknowledge');
    expect(CLI_COMMANDS).not.toContain('submit');
    expect([...TOOLS_BY_NAME.keys()]).not.toContain('acknowledge');
    expect([...TOOLS_BY_NAME.keys()]).not.toContain('submit');
  });

  /**
   * CT-20. In shared root the brief is the only thing that tells an agent which
   * of several visible namespaces is its own, and which paths it may write.
   * Both are conventions rather than enforcement, and a convention nobody states
   * is not one.
   */
  it('names the MCP server this agent must use, and the paths it owns', () => {
    const brief = renderBrief(
      participant({ id: 'metrics', workspace: '.', owns: ['src/metrics/', 'tests/metrics/'] }),
      descriptor(),
      policy,
      'mcp',
      '/repo',
    );

    expect(brief).toContain('crosstalk-metrics');
    expect(brief).toContain('src/metrics/');
    expect(brief).toContain('tests/metrics/');
  });

  it('tells a shared-root agent to verify its identity rather than assume it', () => {
    // Every namespace is visible to every agent, so picking the right one is a
    // choice that can be got wrong silently. `roster` returns `you`, which makes
    // the check one call — and an agent that skips it posts as somebody else.
    const brief = renderBrief(
      participant({ id: 'metrics', workspace: '.', owns: ['src/metrics/'] }),
      descriptor(),
      policy,
      'mcp',
      '/repo',
    );

    expect(brief).toMatch(/inbox\(/);
  });

  it('does not tell a worktree agent it owns particular paths', () => {
    // The other side. A worker with its own checkout owns all of it, and a list
    // of prefixes there would be a restriction nobody configured.
    const brief = renderBrief(
      participant({ id: 'codex', workspace: '.crosstalk/worktrees/codex' }),
      descriptor(),
      policy,
      'mcp',
      '/repo',
    );

    expect(brief).not.toMatch(/paths you own/i);
  });

  it('still names the gates that do exist, on the tier that has them', () => {
    const brief = renderBrief(participant(), descriptor(), policy, 'mcp', '/repo');
    // Losing the gates entirely would also pass "names nothing wrong".
    expect(brief).toContain('inbox(');
    expect(brief).toContain('act(');
    expect(brief).toContain('claim(');
    expect(brief).not.toContain('ack_task(');
    expect(brief).not.toContain('submit_task(');
  });
});
