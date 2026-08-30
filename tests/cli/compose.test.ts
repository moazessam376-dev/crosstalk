import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCompose, selectSpawnTargets } from '../../src/cli/compose.js';
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
