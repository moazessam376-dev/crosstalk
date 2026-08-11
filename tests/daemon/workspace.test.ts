import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, type CrosstalkConfig } from '../../src/contracts/config.js';
import type { Participant } from '../../src/contracts/participant.js';
import { isWithin, workspaceWarning } from '../../src/daemon/workspace.js';

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
