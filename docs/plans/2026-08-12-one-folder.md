# One project folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent on a project opens one folder, owns a subtree inside it, and the hub shows the effort, model, harness and mirror state that are actually running.

**Architecture:** Approach C from [the spec](../specs/2026-08-12-one-folder-design.md): agents edit in the repository root within declared path prefixes; on submit the daemon commits only the owning participant's paths through a throwaway worktree, so branch-per-task, pull requests and the whole mirror keep working unchanged. Identity stops being inferred from the working directory by giving each participant its own named MCP server in the one root `.mcp.json`.

**Tech Stack:** TypeScript, Node ≥20, vitest, React 18 + Vite for the hub. No new runtime dependencies.

## Global Constraints

- **Two runtime dependencies only** — `@modelcontextprotocol/sdk` and `yaml`. Nothing else may be added to `dependencies`.
- **The log is append-only, ordered by `seq`, never `ts`.**
- **`node:path` always, `execFile` never `exec`.**
- **`src/contracts/` and `tests/fixtures/` are frozen** — see Task 0 for the two amendments this plan makes and the authority for them.
- **The mirror has no write path into the log.** Nothing in this plan may give it one.
- **Green on one platform is not done** — CI is Windows, macOS and Linux; this repo develops on Windows.
- **No `Co-Authored-By` trailers on commits.**
- **`npm test` is not a build.** Every commit that touches `src/` runs `npm run build` and `npm run typecheck` too.
- **For UI work, `npm test` is not the end** — build it, serve it, open it, and look, with a *populated* fixture. An empty hub cannot tell a layout bug from a working layout; that is exactly how CT-15 was reported fixed while broken.

---

## Task 0: The two contract amendments

`AGENTS.md` rule 8 freezes `src/contracts/`: *"Raise a claim instead."* This plan needs two fields there. Both are recorded here as claims with their falsifiers, and ruled on by the leader with the maintainer's approval given in conversation on 2026-08-12.

**Claim CT-A — `Participant` cannot express effort.**
Assertion: the hub cannot show an effort level because no contract field carries one, so any ledger aggregating outcomes by participant aggregates across an invisible variable.
Falsifier: a field on `Participant`, or any event, from which effort can be read. `Dock.tsx:176` and `identity.ts:71` both record its absence in comments; `grep -rn "effort" src/contracts/` returns nothing.
Ruling: **upheld.** Add `effort?: string`.

**Claim CT-B — `Participant` cannot express which paths it owns.**
Assertion: shared-root operation needs a declared, checkable subtree per participant, and no contract field carries one.
Falsifier: any existing field expressing path ownership. `Task` has `branch`, `deps` and `acceptance`; `Participant` has `workspace`, which names one directory a participant lives in, not a set of paths it may write.
Ruling: **upheld.** Add `owns?: string[]`.

**Files:**
- Modify: `src/contracts/participant.ts`

**Interfaces:**
- Produces: `Participant.effort?: string`, `Participant.owns?: string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/contracts/participant-fields.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Participant } from '../../src/contracts/participant.js';

describe('participant fields this plan adds', () => {
  it('carries an effort level and a set of owned paths', () => {
    // Compile-time assertions with a runtime witness, which is how the rest of
    // the suite pins contract shape without a schema library.
    const participant: Participant = {
      id: 'metrics',
      role: 'worker',
      harness: 'claude-code-app',
      model: 'opus-5',
      effort: 'max',
      lifecycle: 'attached',
      workspace: '.',
      owns: ['src/metrics/', 'tests/metrics/'],
    };

    expect(participant.effort).toBe('max');
    expect(participant.owns).toEqual(['src/metrics/', 'tests/metrics/']);
  });

  it('leaves both optional, because every existing config omits them', () => {
    const minimal: Participant = {
      id: 'leader',
      role: 'leader',
      harness: 'claude-code-app',
      lifecycle: 'attached',
      workspace: '.',
    };

    expect(minimal.effort).toBeUndefined();
    expect(minimal.owns).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/contracts/participant-fields.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'effort' does not exist in type 'Participant'`.

- [ ] **Step 3: Add the fields**

In `src/contracts/participant.ts`, after `model?: string`:

```ts
  /**
   * How hard the harness is told to think, e.g. "max", "high", "medium".
   *
   * Free text, not an enum, for the same reason `model` is: harnesses do not
   * agree on the scale, and a union of every harness's words would either
   * exclude one or mean nothing. A model at two effort levels does not behave
   * alike, so a ledger aggregating by participant is aggregating across this
   * whether or not it can see it.
   */
  effort?: string;
  /**
   * Repo-relative path prefixes this participant may write, e.g.
   * `["src/metrics/", "tests/metrics/"]`.
   *
   * Prefixes, not globs: the repo allows two runtime dependencies and neither
   * matches globs, and a hand-rolled matcher that is subtly wrong about `**`
   * would silently mis-scope the submit gate that reads this.
   *
   * Absent means "no declared ownership", which is what every config written
   * before shared root looks like, and which `doctor` requires of any worker
   * whose workspace is the repository root.
   */
  owns?: string[];
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/contracts/participant-fields.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Confirm nothing else broke**

Run: `npm run typecheck`
Expected: clean. Both fields are optional, so every existing `Participant` literal still compiles.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/participant.ts tests/contracts/participant-fields.test.ts docs/plans/2026-08-12-one-folder.md
git commit -m "Add effort and owns to Participant"
```

---

## Task 1: The hub shows effort

The design's format is `harness · model effort · tier` — effort attaches to the model, because it qualifies the model rather than standing beside it. `identity.ts:70-78` documents its absence; that comment gets replaced by the thing it was waiting for.

**Files:**
- Modify: `src/ui/state/identity.ts:79-91`
- Modify: `src/ui/state/derive.ts:8-14` (`ParticipantView`)
- Modify: `src/ui/layout/Dock.tsx:131-140` (pass `effort` into `identityFor`)
- Test: `tests/ui/layout.test.tsx`

**Interfaces:**
- Consumes: `Participant.effort` from Task 0
- Produces: `Identity.effort?: string`; `ParticipantView.effort?: string`; `meta` formatted `harness · model effort · tier`

- [ ] **Step 1: Write the failing test**

Add to `tests/ui/layout.test.tsx`, inside `describe('hub layout regions')`:

```tsx
  it('renders effort attached to the model, as the design has it', () => {
    render(
      createElement(Dock, {
        events: [],
        rooms: [{ id: '#floor', kind: 'floor' }],
        activeRoom: '#floor',
        participants: [
          { id: 'metrics', role: 'worker', status: 'working', tier: 'mcp', harness: 'claude-code-app', model: 'opus-5', effort: 'max', workspace: '.' },
        ],
      }),
    );

    expect(screen.getByTestId('member-metrics')).toHaveTextContent('claude-code-app · opus-5 max · mcp');
  });

  it('renders no effort at all when none is configured', () => {
    // The other side of the discrimination. A default here would put a level on
    // screen that nothing configured — the same mistake `tier` already avoids.
    render(
      createElement(Dock, {
        events: [],
        rooms: [{ id: '#floor', kind: 'floor' }],
        activeRoom: '#floor',
        participants: [
          { id: 'metrics', role: 'worker', status: 'working', tier: 'mcp', harness: 'claude-code-app', model: 'opus-5', workspace: '.' },
        ],
      }),
    );

    expect(screen.getByTestId('member-metrics')).toHaveTextContent('claude-code-app · opus-5 · mcp');
  });

  it('renders effort even when the model is unknown, without a stray space', () => {
    // `model effort` is a join of two optional parts. Rigit's config sets no
    // model, so this is the shape that actually ships first.
    render(
      createElement(Dock, {
        events: [],
        rooms: [{ id: '#floor', kind: 'floor' }],
        activeRoom: '#floor',
        participants: [
          { id: 'metrics', role: 'worker', status: 'working', tier: 'mcp', harness: 'claude-code-app', effort: 'max', workspace: '.' },
        ],
      }),
    );

    expect(screen.getByTestId('member-metrics')).toHaveTextContent('claude-code-app · max · mcp');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui/layout.test.tsx`
Expected: FAIL — `effort` is not a known property of `ParticipantView`.

- [ ] **Step 3: Add `effort` to the view**

In `src/ui/state/derive.ts`, inside `ParticipantView`:

```ts
  /** A model at two effort levels does not behave alike. Shown beside it. */
  effort?: string;
```

Then find where `ParticipantView` objects are built in `derive.ts` and carry `effort` through exactly as `model` is carried — same conditional-spread shape, so an unset effort stays absent rather than becoming `undefined`.

- [ ] **Step 4: Format the meta line**

Replace `identityFor` in `src/ui/state/identity.ts`, and delete the `effort is deliberately absent` block above it:

```ts
/**
 * `harness · model effort · tier`, omitting whatever the log does not carry.
 *
 * Effort attaches to the model rather than standing beside it, because it
 * qualifies the model: "opus-5 max" is a configuration, "opus-5 · max" reads
 * like two peer facts. Joining them separately also keeps the separator count
 * honest when one of the pair is missing — Rigit configures an effort and no
 * model, and `· max ·` with a leading space would be the naive result.
 */
export function identityFor(id: string, participant?: Participant, colour?: string): Identity {
  const engine = [participant?.model, participant?.effort].filter(Boolean).join(' ');
  const meta = [participant?.harness, engine, participant?.transport].filter(Boolean).join(' · ');
  return {
    id,
    initials: initialsFor(id),
    colour: colour ?? hue(id),
    role: participant?.role,
    model: participant?.model,
    effort: participant?.effort,
    harness: participant?.harness,
    tier: participant?.transport,
    meta,
  };
}
```

Add `effort?: string;` to the `Identity` interface beside `model`, and update its `meta` doc comment to `harness · model effort · tier`.

- [ ] **Step 5: Pass it through the Dock**

In `src/ui/layout/Dock.tsx`, in the `identityFor` call at line 132, add `effort: member.effort,` beside `model: member.model,`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/ui/`
Expected: PASS, including the existing `renders participants with their status, harness, model and tier` which must be untouched by this change.

- [ ] **Step 7: Build, typecheck, and look at it**

```bash
npm run build && npm run typecheck
```

Then serve the populated fixture hub, open it, and confirm a member row reads `claude-code-app · opus-5 max · mcp`. Not optional: this is a rendering change and the suite runs in jsdom, which has no layout and no fonts.

- [ ] **Step 8: Commit**

```bash
git add src/ui tests/ui/layout.test.tsx
git commit -m "Show effort beside the model in the roster"
```

---

## Task 2: `init` collects model and effort

Rigit's `crosstalk.yaml` sets no `model:` on any of five participants, which is why the hub shows `claude-code-app · mcp`. The field has existed all along and nothing ever asked for it.

**Files:**
- Modify: `src/cli/init.ts`
- Test: `tests/cli/init-participants.test.ts` (create)

**Interfaces:**
- Consumes: `Participant.effort`, `Participant.owns` from Task 0
- Produces: participants written by `runInit` carry `model` and `effort` when supplied

- [ ] **Step 1: Write the failing test**

Create `tests/cli/init-participants.test.ts`. Use the real-repository helper shape the suite already uses (see `tests/mirror/daemon-seam.test.ts:26-39`) and raise the timeout, because `init` adds worktrees and probes harnesses:

```ts
import { describe, expect, it } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { runInit } from '../../src/cli/init.js';

const execFile = promisify(execFileCallback);

async function repoWithCommit(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-init-participants-'));
  await execFile('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 'test@crosstalk.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'crosstalk test'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), '# init\n', 'utf8');
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  return repo;
}

describe('init records what each participant is running', { timeout: 45_000 }, () => {
  it('writes the model and effort it was given', async () => {
    const repo = await repoWithCommit();
    await runInit({
      repo,
      force: false,
      participants: [
        { id: 'metrics', role: 'worker', harness: 'claude-code-app', model: 'opus-5', effort: 'max', lifecycle: 'attached', workspace: '.crosstalk/worktrees/metrics' },
      ],
    });

    const config = parse(await readFile(join(repo, 'crosstalk.yaml'), 'utf8')) as {
      participants: { id: string; model?: string; effort?: string }[];
    };
    const metrics = config.participants.find((p) => p.id === 'metrics');

    expect(metrics?.model).toBe('opus-5');
    expect(metrics?.effort).toBe('max');
  });

  it('omits both keys rather than writing empty ones when they are unknown', async () => {
    // A written `model: ""` is worse than no key: `doctor`'s
    // PARTICIPANT_NO_MODEL would go quiet and the hub would render a blank.
    const repo = await repoWithCommit();
    await runInit({
      repo,
      force: false,
      participants: [
        { id: 'metrics', role: 'worker', harness: 'claude-code-app', lifecycle: 'attached', workspace: '.crosstalk/worktrees/metrics' },
      ],
    });

    const raw = await readFile(join(repo, 'crosstalk.yaml'), 'utf8');
    expect(raw).not.toMatch(/model:\s*(''|""|$)/m);
    expect(raw).not.toMatch(/effort:/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cli/init-participants.test.ts`
Expected: FAIL on the first test — `effort` is dropped when the config is serialised.

- [ ] **Step 3: Carry both fields through**

Find where `runInit` serialises participants into `crosstalk.yaml` and include `model` and `effort` using the same conditional-spread the codebase uses elsewhere (`...(x === undefined ? {} : { x })`), so an absent value writes no key at all.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/cli/init-participants.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
npm run build && npm run typecheck
git add src/cli/init.ts tests/cli/init-participants.test.ts
git commit -m "Record model and effort when init writes a roster"
```

---

## Task 3: The daemon reports mirror status

The mirror has no write path into the log and this plan does not give it one (spec §6). Status therefore comes from a new endpoint, not from an event.

**Files:**
- Modify: `src/daemon/server.ts` (`StartDaemonOptions`, `#route` near line 538)
- Modify: `src/cli/index.ts` (hand the `MirrorHandle` to the daemon after `up` starts it)
- Test: `tests/daemon/mirror-status.test.ts` (create)

**Interfaces:**
- Consumes: `MirrorHandle` from `src/mirror/index.ts` — `{ enabled: boolean, drainNow(), state, stop() }`
- Produces: `GET /mirror` → `{ configured: boolean, enabled: boolean, lastDrain?: { completed: number, retrying: number }, lastError?: string }`; `StartDaemonOptions.mirrorStatus?: () => MirrorStatus`

- [ ] **Step 1: Write the failing test**

Create `tests/daemon/mirror-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon/server.js';
import { initialisedRepo } from '../helpers/repo.js';

async function get(url: string, path: string, token: string): Promise<unknown> {
  const response = await fetch(new URL(path, url), { headers: { authorization: `Bearer ${token}` } });
  expect(response.ok).toBe(true);
  return response.json();
}

describe('the mirror status endpoint', { timeout: 45_000 }, () => {
  it('reports an unconfigured mirror as unconfigured, not as broken', async () => {
    // The state Rigit is actually in: no `mirror:` block at all. "Not set up"
    // and "set up and failing" are different facts and the operator acts on
    // them differently.
    const repo = await initialisedRepo();
    const daemon = await startDaemon({ repo });
    try {
      const token = (await readFile(join(repo, '.crosstalk', 'tokens', 'leader'), 'utf8')).trim();
      expect(await get(daemon.url, '/mirror', token)).toMatchObject({ configured: false, enabled: false });
    } finally {
      await daemon.close();
    }
  });

  it('reports the last drain when a mirror is attached', async () => {
    const repo = await initialisedRepo();
    const daemon = await startDaemon({
      repo,
      mirrorStatus: () => ({ configured: true, enabled: true, lastDrain: { completed: 3, retrying: 1 } }),
    });
    try {
      const token = (await readFile(join(repo, '.crosstalk', 'tokens', 'leader'), 'utf8')).trim();
      expect(await get(daemon.url, '/mirror', token)).toMatchObject({
        configured: true,
        enabled: true,
        lastDrain: { completed: 3, retrying: 1 },
      });
    } finally {
      await daemon.close();
    }
  });

  it('refuses an unauthenticated caller, like every route that carries data', async () => {
    const repo = await initialisedRepo();
    const daemon = await startDaemon({ repo });
    try {
      const response = await fetch(new URL('/mirror', daemon.url));
      expect(response.ok).toBe(false);
    } finally {
      await daemon.close();
    }
  });
});
```

Extract `initialisedRepo()` into `tests/helpers/repo.ts` from the copy in `tests/mirror/daemon-seam.test.ts:26-39` and have that file import it, so there is one helper rather than a fourth copy.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/daemon/mirror-status.test.ts`
Expected: FAIL — `mirrorStatus` is not in `StartDaemonOptions`, and `/mirror` 404s.

- [ ] **Step 3: Add the type and the option**

In `src/daemon/server.ts`:

```ts
export interface MirrorStatus {
  /** A `mirror:` block exists in the config. */
  configured: boolean;
  /** The mirror started and is running. False when `gh` or a credential is missing. */
  enabled: boolean;
  lastDrain?: { completed: number; retrying: number };
  lastError?: string;
}
```

Add `mirrorStatus?: () => MirrorStatus;` to `StartDaemonOptions`, store it on the daemon, and default it to `() => ({ configured: false, enabled: false })`.

- [ ] **Step 4: Add the route**

In `#route`, with the other reads (after the `/config.json` block, before `/events`), so it sits inside the authenticated section and inherits `x-crosstalk-you`:

```ts
    if (path === '/mirror' && method === 'GET') {
      // Not an event, deliberately. The mirror has no write path into the log
      // (`mirror/index.ts:44-58`) and that one-way street is what makes "mirror
      // failure never blocks the protocol" structural rather than a discipline.
      // A `mirror_status` event would trade that for a status line.
      send(response, 200, this.#mirrorStatus());
      return;
    }
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/daemon/mirror-status.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Wire `up` to it**

In `src/cli/index.ts`, where `startMirror` is called: keep the returned handle, track the last `DrainResult` and the last error, and pass `mirrorStatus: () => ({ configured, enabled: handle.enabled, ... })` into `startDaemon`. `configured` is `config.mirror !== undefined`.

Note the ordering constraint: the daemon starts before the mirror (the mirror reads `/stream`). So `mirrorStatus` must be a closure over a mutable holder, not a value captured at start — a snapshot taken before the mirror exists reports `enabled: false` forever.

- [ ] **Step 7: Commit**

```bash
npm run build && npm run typecheck && npx vitest run tests/daemon/
git add src/daemon/server.ts src/cli/index.ts tests/daemon/mirror-status.test.ts tests/helpers/repo.ts tests/mirror/daemon-seam.test.ts
git commit -m "Report mirror status on its own route"
```

---

## Task 4: The hub shows the mirror

**Files:**
- Create: `src/ui/state/useMirror.ts`
- Modify: `src/ui/layout/Dock.tsx`
- Modify: `src/ui/theme.css`
- Test: `tests/ui/mirror-card.test.tsx` (create)

**Interfaces:**
- Consumes: `GET /mirror` from Task 3
- Produces: `useMirror(): MirrorStatus | undefined`; a `dock-mirror` card

- [ ] **Step 1: Write the failing test**

Create `tests/ui/mirror-card.test.tsx`:

```tsx
// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error TS6142 is expected because the frozen test config omits JSX.
import { Dock } from '../../src/ui/layout/Dock.js';

afterEach(cleanup);

const base = {
  events: [],
  rooms: [{ id: '#floor', kind: 'floor' as const }],
  activeRoom: '#floor',
  participants: [],
};

describe('the mirror card', () => {
  it('says the mirror is not configured, rather than showing nothing', () => {
    // The state Rigit is in. Silence here is indistinguishable from a mirror
    // that is running and quiet, which is the CT-10 mistake in miniature.
    render(createElement(Dock, { ...base, mirror: { configured: false, enabled: false } }));

    expect(screen.getByTestId('dock-mirror')).toHaveTextContent(/not configured/i);
  });

  it('distinguishes configured-but-not-running from running', () => {
    render(createElement(Dock, { ...base, mirror: { configured: true, enabled: false } }));
    expect(screen.getByTestId('dock-mirror')).toHaveTextContent(/not running/i);

    cleanup();
    render(createElement(Dock, {
      ...base,
      mirror: { configured: true, enabled: true, lastDrain: { completed: 4, retrying: 0 } },
    }));
    expect(screen.getByTestId('dock-mirror')).toHaveTextContent('4');
  });

  it('shows a retry count, because a mirror retrying forever looks like one that works', () => {
    render(createElement(Dock, {
      ...base,
      mirror: { configured: true, enabled: true, lastDrain: { completed: 0, retrying: 7 } },
    }));

    expect(screen.getByTestId('dock-mirror')).toHaveTextContent('7');
  });

  it('renders no card at all when the daemon never reported', () => {
    // `undefined` means "not asked yet", which is not the same as "off".
    render(createElement(Dock, base));
    expect(screen.queryByTestId('dock-mirror')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui/mirror-card.test.tsx`
Expected: FAIL — `mirror` is not a `DockProps` property.

- [ ] **Step 3: Add the card**

Add `mirror?: MirrorStatus;` to `DockProps`, and render below the Participants section using the existing `section(...)`/`rows(...)` helpers already in the file:

```ts
    mirror === undefined
      ? null
      : section(
          'Mirror',
          mirror.configured ? (mirror.enabled ? 'running' : 'not running') : 'not configured',
          rows([
            ...(mirror.lastDrain === undefined
              ? []
              : ([
                  ['synced', String(mirror.lastDrain.completed)],
                  ['retrying', String(mirror.lastDrain.retrying)],
                ] as [string, string][])),
            ...(mirror.lastError === undefined ? [] : ([['error', mirror.lastError]] as [string, string][])),
          ]),
          'dock-mirror',
        ),
```

- [ ] **Step 4: Poll it**

Create `src/ui/state/useMirror.ts`: a hook that fetches `/mirror` on mount and every 10 seconds, returns `undefined` until the first response, and swallows errors (a failed status fetch must not blank the hub). Wire it in `App.tsx` and pass the result into `Layout` → `Dock`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/ui/`
Expected: PASS

- [ ] **Step 6: Build it, serve it, open it, look**

```bash
npm run build && npm run typecheck
```

Confirm the card renders and reads `not configured` against a repo with no `mirror:` block — the real current state — and that the dock still scrolls rather than clipping now that it has one more card. CT-15's lesson applies: a dock with three cards and a dock with four are different layouts.

- [ ] **Step 7: Commit**

```bash
git add src/ui tests/ui/mirror-card.test.tsx
git commit -m "Show the mirror in the dock"
```

---

## Task 5: `doctor` requires ownership of a worker in the root

This is the gate that makes shared root safe to allow. `WORKER_IN_REPO_ROOT` stops being unconditional and becomes "not without declared ownership".

**Files:**
- Modify: `src/harness/doctor.ts:321-329`
- Test: `tests/harness/doctor-ownership.test.ts` (create)

**Interfaces:**
- Consumes: `Participant.owns` from Task 0
- Produces: `WORKER_IN_ROOT_WITHOUT_OWNERSHIP` (reject), `OWNERSHIP_OVERLAP` (reject)

- [ ] **Step 1: Write the failing test**

Create `tests/harness/doctor-ownership.test.ts` with four cases, both sides of each discrimination:

```ts
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/harness/doctor.js';
import { initialisedRepo } from '../helpers/repo.js';
import { writeConfig } from '../helpers/config.js';

const worker = (over: Record<string, unknown>) => ({
  id: 'metrics', role: 'worker', harness: 'claude-code-app', lifecycle: 'attached', ...over,
});

describe('ownership is what permits a worker in the repository root', { timeout: 45_000 }, () => {
  it('rejects a worker in the root that declares no ownership', async () => {
    const repo = await initialisedRepo();
    await writeConfig(repo, [worker({ workspace: '.' })]);

    const codes = (await runDoctor({ repo })).findings.map((f) => f.code);
    expect(codes).toContain('WORKER_IN_ROOT_WITHOUT_OWNERSHIP');
  });

  it('permits a worker in the root that declares ownership', async () => {
    const repo = await initialisedRepo();
    await writeConfig(repo, [worker({ workspace: '.', owns: ['src/metrics/'] })]);

    const codes = (await runDoctor({ repo })).findings.map((f) => f.code);
    expect(codes).not.toContain('WORKER_IN_ROOT_WITHOUT_OWNERSHIP');
    expect(codes).not.toContain('WORKER_IN_REPO_ROOT');
  });

  it('rejects two workers whose owned prefixes overlap', async () => {
    // The whole point of the declaration. `src/` contains `src/metrics/`, so
    // these two can clobber each other and the gate must say so.
    const repo = await initialisedRepo();
    await writeConfig(repo, [
      worker({ id: 'metrics', workspace: '.', owns: ['src/metrics/'] }),
      worker({ id: 'skeleton', workspace: '.', owns: ['src/'] }),
    ]);

    const codes = (await runDoctor({ repo })).findings.map((f) => f.code);
    expect(codes).toContain('OWNERSHIP_OVERLAP');
  });

  it('permits sibling prefixes that share a parent without containing each other', async () => {
    // The near-miss. `src/metrics/` and `src/skeleton/` share four characters
    // of prefix and overlap not at all; a naive `startsWith` on the raw strings
    // would also pass this, so the case that matters is the next one.
    const repo = await initialisedRepo();
    await writeConfig(repo, [
      worker({ id: 'metrics', workspace: '.', owns: ['src/metrics/'] }),
      worker({ id: 'skeleton', workspace: '.', owns: ['src/skeleton/'] }),
    ]);

    expect((await runDoctor({ repo })).findings.map((f) => f.code)).not.toContain('OWNERSHIP_OVERLAP');
  });

  it('does not mistake src/metrics-old/ for a child of src/metrics/', async () => {
    // `"src/metrics-old/".startsWith("src/metrics")` is true and wrong. This is
    // the case a prefix check gets wrong if it forgets the separator.
    const repo = await initialisedRepo();
    await writeConfig(repo, [
      worker({ id: 'metrics', workspace: '.', owns: ['src/metrics/'] }),
      worker({ id: 'skeleton', workspace: '.', owns: ['src/metrics-old/'] }),
    ]);

    expect((await runDoctor({ repo })).findings.map((f) => f.code)).not.toContain('OWNERSHIP_OVERLAP');
  });
});
```

`writeConfig(repo, participants)` is a small helper writing a valid `crosstalk.yaml` with `DEFAULT_POLICY`; create it in `tests/helpers/config.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/harness/doctor-ownership.test.ts`
Expected: FAIL — every worker in the root still gets the unconditional `WORKER_IN_REPO_ROOT`.

- [ ] **Step 3: Write the prefix helper**

Create `src/workspace/ownership.ts`:

```ts
import { posix } from 'node:path';

/**
 * Normalises a declared prefix to POSIX form with exactly one trailing slash.
 *
 * The trailing slash is not cosmetic: it is what makes `src/metrics-old/` stop
 * being a child of `src/metrics/`. A prefix check without it answers a question
 * about characters rather than about directories.
 */
export function normalisePrefix(prefix: string): string {
  const posixed = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
  return posixed === '' ? '/' : `${posixed}/`;
}

/** True when `path` is inside `prefix`, treating both as directories. */
export function isWithinPrefix(path: string, prefix: string): boolean {
  const normalised = normalisePrefix(prefix);
  const candidate = path.replace(/\\/g, '/');
  return normalised === '/' || candidate === normalised.slice(0, -1) || candidate.startsWith(normalised);
}

/** True when either prefix contains the other. Sibling prefixes do not overlap. */
export function prefixesOverlap(left: string, right: string): boolean {
  const a = normalisePrefix(left);
  const b = normalisePrefix(right);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Every declared path in `paths` that no prefix in `owns` contains. */
export function outsideOwnership(paths: readonly string[], owns: readonly string[]): string[] {
  return paths.filter((path) => !owns.some((prefix) => isWithinPrefix(path, prefix)));
}

/** Uses `posix.join` so callers never build a prefix with a platform separator. */
export function joinPrefix(...parts: string[]): string {
  return normalisePrefix(posix.join(...parts));
}
```

- [ ] **Step 4: Make the doctor check conditional**

Replace `doctor.ts:321-329`:

```ts
  if (participant.role === 'worker' && workspace === repoRoot) {
    // Shared root is permitted, but only against a declared subtree: that
    // declaration is what the submit gate reads, and without it two workers in
    // one tree can silently overwrite each other. Ownership is the whole
    // safety argument, so its absence is a reject rather than a warning.
    if (participant.owns === undefined || participant.owns.length === 0) {
      findings.push(finding(
        'reject',
        'WORKER_IN_ROOT_WITHOUT_OWNERSHIP',
        `Worker ${participant.id} resolves to the repository root without declaring any owned paths.`,
        'Add `owns:` naming the repo-relative directories this worker may write, or give it its own worktree under .crosstalk/worktrees/<id>.',
      ));
      return findings;
    }
  }
```

Then add a roster-level overlap check where the whole participant list is available, emitting `OWNERSHIP_OVERLAP` with both ids and both prefixes named.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/harness/doctor-ownership.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Break it on purpose**

Delete the trailing slash from `normalisePrefix`'s return and re-run. The `src/metrics-old/` test must go red. If it stays green the test is not testing what it claims and the helper is not covered.

- [ ] **Step 7: Commit**

```bash
npm run build && npm run typecheck && npx vitest run tests/harness/
git add src/workspace/ownership.ts src/harness/doctor.ts tests/harness/doctor-ownership.test.ts tests/helpers/config.ts
git commit -m "Permit a worker in the root only against declared ownership"
```

---

## Task 6: One MCP server per participant

In shared root every harness reads the same root `.mcp.json`, so a single `crosstalk` server makes every agent the same participant — CT-8 and CT-9 verbatim.

**Files:**
- Modify: `src/cli/init.ts:563-579` (`mergeRegistration`)
- Modify: `src/cli/index.ts:147` (the printed registration snippet)
- Test: `tests/cli/mcp-merge.test.ts` (exists — extend it)

**Interfaces:**
- Produces: `.mcp.json` carries `mcpServers['crosstalk-<id>']` per participant sharing that config path

- [ ] **Step 1: Write the failing test**

Add to `tests/cli/mcp-merge.test.ts`:

```ts
  it('registers one server per participant sharing a config path', async () => {
    const repo = await repoWithCommit();
    await runInit({
      repo,
      force: false,
      participants: [
        { id: 'leader', role: 'leader', harness: 'claude-code-app', lifecycle: 'attached', workspace: '.' },
        { id: 'metrics', role: 'worker', harness: 'claude-code-app', lifecycle: 'attached', workspace: '.', owns: ['src/metrics/'] },
      ],
    });

    const written = JSON.parse(await readFile(join(repo, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };

    expect(Object.keys(written.mcpServers).sort()).toEqual(['crosstalk-leader', 'crosstalk-metrics']);
    // The whole point: different tokens, so identity does not depend on which
    // directory the harness happened to start in.
    expect(written.mcpServers['crosstalk-leader']?.env?.['CROSSTALK_TOKEN_FILE'])
      .not.toBe(written.mcpServers['crosstalk-metrics']?.env?.['CROSSTALK_TOKEN_FILE']);
  });

  it('leaves a foreign server in the file untouched', async () => {
    // `mergeRegistration` exists because a previous version destroyed a
    // hand-written config. Renaming our key must not weaken that.
    const repo = await repoWithCommit();
    await writeFile(
      join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { somethingElse: { command: 'noop' } } }, null, 2),
      'utf8',
    );
    await runInit({
      repo,
      force: false,
      participants: [
        { id: 'leader', role: 'leader', harness: 'claude-code-app', lifecycle: 'attached', workspace: '.' },
      ],
    });

    const written = JSON.parse(await readFile(join(repo, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers['somethingElse']).toEqual({ command: 'noop' });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cli/mcp-merge.test.ts`
Expected: FAIL — the file has one key, `crosstalk`.

- [ ] **Step 3: Key the registration by participant**

Change `mergeRegistration(path, entry)` to `mergeRegistration(path, id, entry)` and write `servers[`crosstalk-${id}`] = entry`. Make `id` a required parameter so `tsc` finds every call site rather than letting one keep the old behaviour silently — the same reasoning that made `renderBrief`'s repo parameter required.

Delete any pre-existing bare `crosstalk` key when writing, so a repo initialised before this change does not keep an extra server that authenticates as whoever it names.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/cli/mcp-merge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm run build && npm run typecheck && npm test
git add src/cli tests/cli/mcp-merge.test.ts
git commit -m "Give every participant its own MCP server"
```

---

## Task 7: Briefs name the namespace and the subtree

**Files:**
- Modify: `src/harness/templates/worker.md`, `src/harness/templates/leader.md`
- Modify: `src/harness/brief.ts` (add `serverName` and `ownedPaths` tokens)
- Test: `tests/harness/brief-vocabulary.test.ts`

**Interfaces:**
- Consumes: `Participant.owns`; `crosstalk-<id>` naming from Task 6
- Produces: brief tokens `serverName`, `ownedPaths`

- [ ] **Step 1: Write the failing test**

Add to `tests/harness/brief-vocabulary.test.ts`:

```ts
  it('names the MCP server this agent must use, and the paths it owns', () => {
    const rendered = renderBrief(
      { id: 'metrics', role: 'worker', harness: 'claude-code-app', lifecycle: 'attached', workspace: '.', owns: ['src/metrics/', 'tests/metrics/'] },
      descriptor,
      DEFAULT_POLICY,
      'mcp',
      'D:/Opensource/Rigit',
    );

    expect(rendered).toContain('crosstalk-metrics');
    expect(rendered).toContain('src/metrics/');
    expect(rendered).toContain('tests/metrics/');
  });

  it('tells an agent to verify its own identity rather than assume it', () => {
    // In shared root every namespace is visible and picking the right one is
    // convention. `roster` returns `you`, so the check costs one call — and an
    // agent that skips it posts as somebody else without noticing.
    const rendered = renderBrief(
      { id: 'metrics', role: 'worker', harness: 'claude-code-app', lifecycle: 'attached', workspace: '.', owns: ['src/metrics/'] },
      descriptor,
      DEFAULT_POLICY,
      'mcp',
      'D:/Opensource/Rigit',
    );

    expect(rendered).toMatch(/roster/);
    expect(rendered).toMatch(/\byou\b/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/harness/brief-vocabulary.test.ts`
Expected: FAIL — neither token is rendered.

- [ ] **Step 3: Add the tokens and the template copy**

In `brief.ts`, add `serverName: `crosstalk-${participant.id}`` and `ownedPaths` (the `owns` list, one per line, or a sentence saying the whole repository when absent).

In `worker.md`, replace the workspace paragraph with copy that says: you are already in `{{workspaceAbsolute}}`; do not change directory; your tools are the `{{serverName}}` ones and no others; you may write only `{{ownedPaths}}`; call `roster` first and confirm `you` is `{{id}}` before doing anything else.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/harness/brief-vocabulary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm run build && npm run typecheck
git add src/harness tests/harness/brief-vocabulary.test.ts
git commit -m "Tell each agent its namespace and its subtree"
```

---

## Task 8: Submit commits owned paths through a throwaway worktree

The heart of approach C. `submitTask` (`handlers.ts:167`) gains a commit step that touches no shared git state.

**Files:**
- Create: `src/workspace/submit.ts`
- Modify: `src/daemon/handlers.ts:167`
- Test: `tests/workspace/submit.test.ts` (create)

**Interfaces:**
- Consumes: `createWorktree(repo, id, branch)` and `removeWorktree(...)` from `src/workspace/git.ts`; `outsideOwnership` from Task 5
- Produces: `commitOwnedPaths({ repo, branch, worktreeId, owns, message }): Promise<{ sha: string, files: string[] } | { refused: string[] }>`

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/submit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitOwnedPaths } from '../../src/workspace/submit.js';
import { initialisedRepo } from '../helpers/repo.js';

const execFile = promisify(execFileCallback);

async function edit(repo: string, path: string, body: string): Promise<void> {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), body, 'utf8');
}

describe('committing a submit from a shared root', { timeout: 45_000 }, () => {
  it('commits the owned paths onto the task branch', async () => {
    const repo = await initialisedRepo();
    await edit(repo, 'src/metrics/collect.ts', 'export const collect = () => 1;\n');

    const result = await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'submit-T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    expect(result).toMatchObject({ files: ['src/metrics/collect.ts'] });
    const { stdout } = await execFile('git', ['show', '--name-only', '--format=', 'ct/T-01-metrics'], { cwd: repo, windowsHide: true });
    expect(stdout).toContain('src/metrics/collect.ts');
  });

  it('leaves the working tree on its own branch', async () => {
    // The property that makes this safe: two agents submitting concurrently
    // must not move each other's HEAD. If this test ever fails, approach C is
    // not delivering what it was chosen for.
    const repo = await initialisedRepo();
    const before = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, windowsHide: true })).stdout.trim();
    await edit(repo, 'src/metrics/collect.ts', 'export const collect = () => 1;\n');

    await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'submit-T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    const after = (await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, windowsHide: true })).stdout.trim();
    expect(after).toBe(before);
  });

  it('refuses and names the paths when the agent wrote outside its subtree', async () => {
    // Silently dropping them is the failure mode approach C was chosen against.
    const repo = await initialisedRepo();
    await edit(repo, 'src/metrics/collect.ts', 'export const collect = () => 1;\n');
    await edit(repo, 'src/skeleton/frame.ts', 'export const frame = () => 2;\n');

    const result = await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'submit-T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    expect(result).toEqual({ refused: ['src/skeleton/frame.ts'] });
  });

  it('removes the throwaway worktree afterwards, including on refusal', async () => {
    const repo = await initialisedRepo();
    await edit(repo, 'src/skeleton/frame.ts', 'export const frame = () => 2;\n');

    await commitOwnedPaths({
      repo, branch: 'ct/T-01-metrics', worktreeId: 'submit-T-01',
      owns: ['src/metrics/'], message: 'T-01 metrics',
    });

    const { stdout } = await execFile('git', ['worktree', 'list'], { cwd: repo, windowsHide: true });
    expect(stdout).not.toContain('submit-T-01');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/workspace/submit.test.ts`
Expected: FAIL — `src/workspace/submit.ts` does not exist.

- [ ] **Step 3: Implement it**

`commitOwnedPaths` in `src/workspace/submit.ts`:

1. `git status --porcelain -z` in `repo` to list changed paths (`-z` because paths contain spaces and `--porcelain` quotes them otherwise).
2. `outsideOwnership(changed, owns)` — if non-empty, return `{ refused }` and do nothing else.
3. `createWorktree(repo, worktreeId, branch)` under `.crosstalk/` per rule 9.
4. Copy each owned changed path from the root into the worktree, creating parent directories.
5. `git add -- <paths>` then `git -c user.name=... commit -m message` inside the worktree.
6. Read the sha, then `removeWorktree`, in a `finally` so step 4 or 5 failing still cleans up.

Every git call via `execFile` with `windowsHide: true`, never `exec`. Every path via `node:path`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/workspace/submit.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Break it on purpose**

Comment out the `outsideOwnership` guard. The refusal test must go red and — importantly — the first test must stay green, proving the guard is what the refusal test is testing rather than some incidental failure.

- [ ] **Step 6: Wire it into the handler**

In `submitTask` (`handlers.ts:167`), after `requireAssignee`: if the assignee's `owns` is set, call `commitOwnedPaths`. On `{ refused }`, reject the submit with a protocol error naming the paths. On success, carry on to the existing state transition.

Leave the path unchanged for a participant with no `owns` — that is every existing project, and this task must not change how they behave.

- [ ] **Step 7: Commit**

```bash
npm run build && npm run typecheck && npm test
git add src/workspace/submit.ts src/daemon/handlers.ts tests/workspace/submit.test.ts
git commit -m "Commit a shared-root submit through a throwaway worktree"
```

---

## Task 9: End to end on a real project

**Files:**
- Modify: `docs/RUNNING.md`
- Test: manual, against `D:\Opensource\Rigit`

- [ ] **Step 1: Convert Rigit's roster**

Rewrite `D:\Opensource\Rigit\crosstalk.yaml` so `skeleton`, `metrics` and `binding` have `workspace: .` and an `owns:` list, and every participant carries `model` and `effort`. Keep a copy of the old file first.

- [ ] **Step 2: Run doctor**

```bash
ct doctor
```

Expected: no `WORKER_IN_ROOT_WITHOUT_OWNERSHIP`, no `OWNERSHIP_OVERLAP`.

- [ ] **Step 3: Re-init and check the registration**

Confirm `.mcp.json` holds one `crosstalk-<id>` server per participant with distinct `CROSSTALK_TOKEN_FILE` values, and that `crosstalk.yaml`'s roster survived (`init` preserves it; a bare `--force` would replace it with `DEFAULT_ROSTER`).

- [ ] **Step 4: Open the project once**

Open `D:\Opensource\Rigit` in the harness. Confirm **one** entry in the project list where there were three, and that `roster` reports the expected `you` for each agent.

- [ ] **Step 5: Look at the hub**

Confirm the roster rows read `harness · model effort · tier` and the mirror card reports its real state. Populated hub, not an empty one.

- [ ] **Step 6: Update the docs and commit**

Document shared root and `owns:` in `docs/RUNNING.md`, then:

```bash
git add docs/RUNNING.md
git commit -m "Document shared-root operation"
```

---

## Self-review

**Spec coverage.** §1 verification → Task 0's falsifiers. §2 correction → the spec, not code. §3 ownership → Tasks 5 and 8. §3 approach C commit isolation → Task 8. §4 identity → Tasks 6 and 7. §5 effort/model/harness → Tasks 1 and 2. §6 mirror → Tasks 3 and 4. §7 contract changes → Task 0. §8 declines → nothing to implement. §9 order → task order.

**One gap found and closed:** §6 ends *"`init` should write a `mirror:` block, and CT-19 already covers that."* No task here does it, and it is the difference between the card saying `not configured` forever and the mirror actually running. It belongs to CT-19's own work rather than this plan; **Task 9 Step 5 will therefore show `not configured` on Rigit, and that is the correct result, not a bug.**

**Placeholder scan.** No TBD/TODO. Task 8 Step 3 is prose rather than a code block — deliberate: it is six sequenced git operations whose exact form depends on `createWorktree`'s return, and pinned by four tests that do carry code.

**Type consistency.** `MirrorStatus` is defined in Task 3 and consumed unchanged in Task 4. `commitOwnedPaths` keeps one signature across Tasks 8 Steps 1, 3 and 6. `owns` is `string[]` in Task 0 and everywhere after. `mergeRegistration` gains its `id` parameter in Task 6 only, and Task 6 is the only task that calls it.
