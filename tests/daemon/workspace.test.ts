import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, type CrosstalkConfig } from '../../src/contracts/config.js';
import type { Participant } from '../../src/contracts/participant.js';
import { isWithin, workspaceWarning } from '../../src/daemon/workspace.js';
import { PRESENCE_TTL_MS, Presence } from '../../src/daemon/presence.js';

const REPO = resolve('/repo');

const CONFIG: CrosstalkConfig = {
  version: 1,
  project: { repo: '.', mainBranch: 'main' },
  participants: [
    { id: 'leader', role: 'leader', harness: 'claude-code-app', lifecycle: 'attached', workspace: '.' },
    {
      id: 'codex',
      role: 'worker',
      harness: 'codex-app',
      lifecycle: 'attached',
      workspace: '.crosstalk/worktrees/codex',
    },
  ] as Participant[],
  policy: DEFAULT_POLICY,
};

describe('isWithin', () => {
  it('accepts the directory itself', async () => {
    expect(await isWithin(join(REPO, 'a'), join(REPO, 'a'))).toBe(true);
  });

  it('accepts a descendant', async () => {
    expect(await isWithin(join(REPO, 'a'), join(REPO, 'a', 'b', 'c'))).toBe(true);
  });

  it('rejects a sibling', async () => {
    expect(await isWithin(join(REPO, 'a'), join(REPO, 'b'))).toBe(false);
  });

  it('rejects a sibling whose name merely starts the same', async () => {
    // A string prefix test says `codex-2` is inside `codex`. This is why the
    // check walks ancestors instead.
    expect(await isWithin(join(REPO, 'wt', 'codex'), join(REPO, 'wt', 'codex-2'))).toBe(false);
  });

  it('rejects an ancestor', async () => {
    expect(await isWithin(join(REPO, 'a', 'b'), join(REPO, 'a'))).toBe(false);
  });
});

describe('workspaceWarning', () => {
  it('warns for a process outside its declared workspace', async () => {
    const strayed = join(REPO, '.claude', 'worktrees', 'crosstalk-codex-setup-236158');
    const warning = await workspaceWarning(CONFIG, REPO, 'codex', strayed);

    expect(warning).toBeDefined();
    expect(warning!).toContain('.crosstalk/worktrees/codex');
    expect(warning!).toContain(strayed);
  });

  it('stays quiet inside the workspace', async () => {
    const home = join(REPO, '.crosstalk', 'worktrees', 'codex', 'src');
    expect(await workspaceWarning(CONFIG, REPO, 'codex', home)).toBeUndefined();
  });

  it('stays quiet when no cwd was reported', async () => {
    // The CLI resolves identity from a token file, never from the cwd, so it
    // has nothing to report. Absence must not read as a violation.
    expect(await workspaceWarning(CONFIG, REPO, 'codex', undefined)).toBeUndefined();
  });

  it('treats the leader at the repo root as home', async () => {
    // `workspace: .` is the repo itself, so everything under it is inside.
    expect(await workspaceWarning(CONFIG, REPO, 'leader', join(REPO, 'src'))).toBeUndefined();
  });

  it('says nothing about a participant it does not know', async () => {
    expect(await workspaceWarning(CONFIG, REPO, 'ghost', join(REPO, 'elsewhere'))).toBeUndefined();
  });
});

describe('CT-7 presence expires', () => {
  it('reports a participant present just after it was heard from', () => {
    const presence = new Presence();
    presence.touch('codex', 1_000);
    expect(presence.isPresent('codex', 1_000 + PRESENCE_TTL_MS - 1)).toBe(true);
  });

  it('stops reporting it present once the window has passed', () => {
    // A single read-only `roster --as binding` from a human shell flipped a
    // never-started agent to `active` for the life of the daemon.
    const presence = new Presence();
    presence.touch('binding', 1_000);
    expect(presence.isPresent('binding', 1_000 + PRESENCE_TTL_MS)).toBe(false);
  });

  it('never reports a participant that has said nothing', () => {
    expect(new Presence().isPresent('skeleton', 5_000)).toBe(false);
  });

  it('extends the window each time it is heard from', () => {
    const presence = new Presence();
    presence.touch('codex', 1_000);
    presence.touch('codex', 200_000);
    expect(presence.isPresent('codex', 200_000 + PRESENCE_TTL_MS - 1)).toBe(true);
  });

  it('survives longer than an await_turn long poll', () => {
    // AWAIT_CAP_S is 50s, so an agent parked in `await_turn` refreshes about
    // every 50 seconds. A window shorter than that would mark a correctly
    // behaving agent offline between polls.
    expect(PRESENCE_TTL_MS).toBeGreaterThan(50_000 * 2);
  });
});
