import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PolicyConfig, Participant } from '../../src/contracts/index.js';
import type { HarnessDescriptor } from '../../src/harness/registry.js';
import { briefVersion, localBriefFile, renderBrief, writeBrief } from '../../src/harness/brief.js';

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

/**
 * CT-13. The brief named `participant.workspace` â€” repo-relative, correct for
 * `crosstalk.yaml`, wrong for a file an agent reads while standing in that
 * workspace. From inside it the path does not resolve, and the one directory
 * where it does is the repository root: the leader's workspace, and the identity
 * collision CT-8/CT-9 are about.
 *
 * Observed: the `binding` (Cursor) session tried to move to the repo root twice
 * on startup. It was not misbehaving â€” it was following its brief.
 */
describe('a brief names a workspace the agent can resolve from where it stands', () => {
  const WORKSPACE = '.crosstalk/worktrees/codex';

  it('names the workspace absolutely, not relative to the repo root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ct-brief-'));
    temporaryDirectories.push(repo);

    const content = renderBrief(worker({ workspace: WORKSPACE }), descriptor(), policy(), 'shell', repo);

    expect(content).toContain(join(repo, '.crosstalk', 'worktrees', 'codex'));
    expect(content).not.toMatch(/your workspace is `\.crosstalk/);
  });

  /**
   * The discriminating case, and the one a looser assertion gets wrong.
   *
   * `cursor-*` declares a `briefFile` of `.cursor/rules/crosstalk.mdc`, so the
   * directory the brief *file* lands in is two levels below the workspace.
   * Naming that directory would satisfy "contains an absolute path" and
   * "resolves from where the brief was written" while telling a cursor agent it
   * lives in `<workspace>/.cursor/rules` â€” reproducing CT-13 for the one harness
   * that actually wandered.
   */
  it('names the workspace root even when the brief file sits below it', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ct-brief-'));
    temporaryDirectories.push(repo);

    const cursor = descriptor({ key: 'cursor-app', briefFile: '.cursor/rules/crosstalk.mdc' });
    const content = renderBrief(worker({ harness: 'cursor-app', workspace: WORKSPACE }), cursor, policy(), 'shell', repo);

    expect(content).toContain(join(repo, '.crosstalk', 'worktrees', 'codex'));
    expect(content).not.toContain(join(repo, '.crosstalk', 'worktrees', 'codex', '.cursor'));
  });

  it('does not name the repository root for a worker', async () => {
    // The failure mode itself: the root is where the relative path resolved,
    // and it is the leader's workspace.
    const repo = await mkdtemp(join(tmpdir(), 'ct-brief-'));
    temporaryDirectories.push(repo);

    const content = renderBrief(worker({ workspace: WORKSPACE }), descriptor(), policy(), 'shell', repo);
    const stated = /already in your workspace: (.+)/.exec(content)?.[1]?.trim();

    expect(stated).toBeDefined();
    expect(stated).not.toBe(repo);
    expect(stated).toBe(join(repo, '.crosstalk', 'worktrees', 'codex'));
  });

  it('names the repository root for the leader, whose workspace that is', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ct-brief-'));
    temporaryDirectories.push(repo);

    const content = renderBrief(
      worker({ id: 'leader', role: 'leader', workspace: '.' }),
      descriptor(),
      policy(),
      'shell',
      repo,
    );
    const stated = /already in your workspace: (.+)/.exec(content)?.[1]?.trim();

    expect(stated).toBe(repo);
  });

  it('tells the agent not to change directory', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ct-brief-'));
    temporaryDirectories.push(repo);

    const content = renderBrief(worker({ workspace: WORKSPACE }), descriptor(), policy(), 'shell', repo);

    expect(content).toMatch(/do not change directory/i);
  });
});

describe('brief generation', () => {
  it('embeds a stable version hash in the brief', () => {
    const content = renderBrief(worker(), descriptor(), policy(), 'mcp', '/repo');
    const version = briefVersion(content);

    expect(version).toMatch(/^ct-brief-[0-9a-f]{8}$/);
    expect(version).toBe(briefVersion(renderBrief(worker(), descriptor(), policy(), 'mcp', '/repo')));
    expect(content).toContain(`<!-- crosstalk brief version: ${version} -->`);
  });

  it('changes version when the policy changes', () => {
    const a = renderBrief(worker(), descriptor(), policy({ maxRounds: 3 }), 'mcp', '/repo');
    const b = renderBrief(worker(), descriptor(), policy({ maxRounds: 5 }), 'mcp', '/repo');

    expect(briefVersion(a)).not.toBe(briefVersion(b));
  });

  it('tells a shell-tier participant to use the CLI, not MCP tools', () => {
    const content = renderBrief(worker(), descriptor(), policy(), 'shell', '/repo');

    // `crosstalk claim raise` was the assertion here, and it pinned a command
    // that has never existed â€” the test agreed with the brief and both were
    // wrong. `claim` and `respond` are the real top-level commands.
    expect(content).toContain('crosstalk claim --as');
    expect(content).not.toContain('raise_claim(');
  });

  it('states the contest-is-correct rule verbatim in every worker brief', () => {
    expect(renderBrief(worker(), descriptor(), policy(), 'mcp', '/repo'))
      .toContain('Contesting a finding you believe is wrong is correct behavior');
  });

  it('uses the leader template for the leader role', () => {
    const content = renderBrief(
      worker({ id: 'leader', role: 'leader', harness: 'claude-code-app' }),
      descriptor({ key: 'claude-code-app', briefFile: 'CLAUDE.md' }),
      policy(),
      'mcp',
      '/repo',
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

    // CT-4: the local path, never `AGENTS.md`. That one is tracked in most
    // repositories, so writing the brief there left every worker's worktree
    // dirty and a `git add -A` committed a worker brief over the project's.
    const content = await readFile(join(directory, 'agents', 'codex', 'AGENTS.local.md'), 'utf8');
    expect(content).toContain('# Crosstalk worker brief');
    expect(content).toContain('raise_claim(');

    // The neighbouring case: the tracked file must not have been created at all.
    await expect(readFile(join(directory, 'agents', 'codex', 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });

  it('derives the local brief name for every shape the registry uses', () => {
    expect(localBriefFile('CLAUDE.md')).toBe('CLAUDE.local.md');
    expect(localBriefFile('AGENTS.md')).toBe('AGENTS.local.md');
    expect(localBriefFile('.cursor/rules/crosstalk.mdc')).toBe('.cursor/rules/crosstalk.local.mdc');
    // No extension: still has to land somewhere git is not watching.
    expect(localBriefFile('BRIEF')).toBe('BRIEF.local');
  });
});
