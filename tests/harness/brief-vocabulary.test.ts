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

const ROLES: Participant['role'][] = ['leader', 'worker'];

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

  it('still names the gates that do exist, on the tier that has them', () => {
    const brief = renderBrief(participant(), descriptor(), policy, 'mcp', '/repo');
    // Losing the gates entirely would also pass "names nothing wrong".
    expect(brief).toContain('ack_task(');
    expect(brief).toContain('submit_task(');
  });
});
