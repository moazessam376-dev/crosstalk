import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCompose, selectSpawnTargets } from '../../src/cli/compose.js';
import { SessionRegistry } from '../../src/harness/sessions.js';
import type { PtyProcess, SpawnPty } from '../../src/harness/pty.js';
import type { Participant } from '../../src/contracts/participant.js';
import type { HarnessDescriptor } from '../../src/harness/registry.js';

function participant(id: string, role: Participant['role'], harness: string, lifecycle: Participant['lifecycle']): Participant {
  return { id, role, harness, lifecycle, workspace: '.' };
}

describe('compose spawn selection', () => {
  it('spawns only supervised CLI harnesses, and attaches GUI ones', () => {
    const registry = new Map<string, HarnessDescriptor>([
      ['codex-cli', { key: 'codex-cli', briefFile: 'AGENTS.md', mcp: 'stdio', supervisable: true, spawn: ['codex', 'exec', '--json'] }],
      ['cursor-app', { key: 'cursor-app', briefFile: '.cursor/rules/crosstalk.mdc', mcp: 'stdio', supervisable: false }],
    ]);
    const { spawn, attach } = selectSpawnTargets(
      [
        participant('leader', 'leader', 'cursor-app', 'attached'),
        participant('codex', 'worker', 'codex-cli', 'supervised'),
        participant('cursor', 'worker', 'cursor-app', 'attached'),
      ],
      registry,
    );

    expect(spawn.map((entry) => entry.id)).toEqual(['codex']);
    expect(attach.map((entry) => entry.id)).toEqual(['leader', 'cursor']);
  });
});

describe('runCompose', () => {
  it('refuses a roster with no leader', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ct-compose-'));
    await expect(
      runCompose({
        repo,
        job: 'ship it',
        participants: ['codex:worker:codex-app'],
        postJob: async () => undefined,
        spawn: () => undefined,
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/leader/) });
  });

  it('posts the job once and does not execFile a GUI harness', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ct-compose-'));
    await writeFile(
      join(repo, 'crosstalk.yaml'),
      `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: leader
    role: leader
    harness: claude-code-app
    lifecycle: attached
    workspace: .
  - id: cursor
    role: worker
    harness: cursor-app
    lifecycle: attached
    workspace: .
policy:
  selfCritique: { required: true, minRounds: 1 }
  leaderCritique: { maxRounds: 2 }
  dispute: { maxRounds: 3, ladder: [leader], rungTimeouts: {} }
  taskAcceptance: { method: leader }
`,
      'utf8',
    );

    let posts = 0;
    const spawned: string[][] = [];
    const result = await runCompose({
      repo,
      job: 'Cut tasks from this job.',
      participants: [],
      postJob: async () => {
        posts += 1;
      },
      spawn: (argv) => {
        spawned.push(argv);
      },
    });

    expect(posts).toBe(1);
    expect(result.posted).toBe(true);
    expect(spawned).toEqual([]);
    expect(result.attached).toContain('leader');
  });

  it('starts a supervisable child via execFile, not a GUI one', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ct-compose-'));
    await writeFile(
      join(repo, 'crosstalk.yaml'),
      `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: leader
    role: leader
    harness: claude-code-cli
    lifecycle: supervised
    workspace: .
  - id: cursor
    role: worker
    harness: cursor-app
    lifecycle: attached
    workspace: .
policy:
  selfCritique: { required: true, minRounds: 1 }
  leaderCritique: { maxRounds: 2 }
  dispute: { maxRounds: 3, ladder: [leader], rungTimeouts: {} }
  taskAcceptance: { method: leader }
`,
      'utf8',
    );

    const spawned: string[][] = [];
    await runCompose({
      repo,
      job: 'Cut tasks from this job.',
      participants: [],
      postJob: async () => undefined,
      spawn: (argv) => {
        spawned.push(argv);
      },
    });

    expect(spawned.length).toBe(1);
    expect(spawned[0]![0]).toBe('claude');
    expect(spawned.some((argv) => argv[0] === 'cursor' || argv[0] === 'cursor-app')).toBe(false);
  });
});

/**
 * The path the hub's launcher actually takes: pick a shape, drop a prompt, and
 * end up looking at the seats' terminals.
 *
 * Verified with an injected pty rather than a real CLI, which keeps it free and
 * offline. What it pins is the wiring the hub depends on and nothing below it —
 * that a launched seat lands in the registry the mirror routes read, and that it
 * was opened with capture on, since a registered seat with no screen is a
 * terminal in the hub that never fills.
 */
describe('a run launched from the hub', () => {
  function fakePty(): { spawnPty: SpawnPty; opened: string[] } {
    const opened: string[] = [];
    const spawnPty: SpawnPty = (spec): PtyProcess => {
      opened.push(spec.file);
      return {
        write: () => {},
        onData: () => {},
        onExit: () => {},
        resize: () => {},
        kill: () => {},
      };
    };
    return { spawnPty, opened };
  }

  async function repoWithInteractiveSeats(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'ct-launch-'));
    await writeFile(
      join(repo, 'crosstalk.yaml'),
      `version: 1
project: { repo: ., mainBranch: main }
participants:
  - { id: "@human", role: human, harness: human, lifecycle: attached, workspace: . }
  - { id: peer-1, role: peer, harness: claude-code-live, lifecycle: supervised, workspace: . }
  - { id: peer-2, role: peer, harness: claude-code-live, lifecycle: supervised, workspace: . }
policy:
  selfCritique: { required: true, minRounds: 1 }
  leaderCritique: { maxRounds: 2 }
  dispute: { maxRounds: 3, ladder: [leader], rungTimeouts: {} }
  taskAcceptance: { method: leader }
`,
      'utf8',
    );
    return repo;
  }

  it('registers every seat it starts, so the hub has a terminal to mirror', async () => {
    const repo = await repoWithInteractiveSeats();
    const sessions = new SessionRegistry();
    const pty = fakePty();

    await runCompose({
      repo,
      job: 'Build the shelter sim.',
      participants: [],
      postJob: async () => undefined,
      trust: false,
      sessions,
      spawnPty: pty.spawnPty,
    });

    expect(sessions.ids().sort()).toEqual(['peer-1', 'peer-2']);
    expect(pty.opened).toEqual(['claude', 'claude']);
    // Registered *and* capturing. A seat in the registry whose session never
    // reconstructed a screen shows the operator an empty terminal forever.
    expect(sessions.get('peer-1')!.screen()).toBeDefined();
  });

  /**
   * Capture is a parse per chunk of terminal output. A `compose` run from a
   * shell has nobody watching it through a browser, so it must not pay for a
   * screen nobody reads.
   */
  it('reconstructs no screen when nothing is there to watch', async () => {
    const repo = await repoWithInteractiveSeats();
    const pty = fakePty();

    const result = await runCompose({
      repo,
      job: 'Build the shelter sim.',
      participants: [],
      postJob: async () => undefined,
      trust: false,
      spawnPty: pty.spawnPty,
    });

    expect(result.spawned.sort()).toEqual(['peer-1', 'peer-2']);
    expect(pty.opened).toHaveLength(2);
  });
});
