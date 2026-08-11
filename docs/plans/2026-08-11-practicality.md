# Making Crosstalk practical — implementation plan

Spec: [`docs/specs/2026-08-11-practicality-design.md`](../specs/2026-08-11-practicality-design.md)
Base: `ac520f6` · Branch: `ct/practicality`

Baseline before any change: `569/569` pass, typecheck and build clean.
`tests/mirror/wiring.test.ts` needs `--testTimeout=45000` on a loaded machine
(see the spec's note); at the default 5s its six cases time out under load and
pass in ~2.8s each when given room.

TDD, per task: write the failing test, run it, confirm it fails *for the reason
expected*, then implement. A test that passes on its first run has demonstrated
nothing.

Tasks are ordered by severity and are independent unless a dependency is named.

---

## T-1 — `init` never reuses a stale `ct/<id>-base` (CT-12)

**Files:** `src/cli/init.ts`, `src/workspace/git.ts`, `tests/cli/worktree-freshness.test.ts` (new)

**Behaviour**

In `addWorktree`, before the existing-branch fallback checks anything out:

- `ct/<id>-base` absent → unchanged, `createWorktree` with `-b`
- present and an **ancestor** of the main branch → fast-forward to the main
  branch, then add the worktree; report it
- present and **diverged** → `CliError`, naming the branch, its commit and the
  main-branch commit, and stop

Ancestry via `git merge-base --is-ancestor`, run through `execFile`, never a
shell. The main branch comes from `config.project.mainBranch`, not a hard-coded
`main`.

`purgeWorkspaces` additionally deletes each `ct/<id>-base` after removing its
worktree. This is the tidy half; T-1's guard is what actually holds, because a
branch can be left behind by routes other than `--purge`.

**Tests** (both sides of the discrimination)

1. purge → three commits on `main` → `init` → worker worktree HEAD **equals**
   `main` HEAD, and the worked file holds the newest content. Fails today: the
   reproduction gives `v1` against `main`'s `v4`.
2. commit *on* `ct/<id>-base` so it diverges → `init` → refuses, message names
   the branch; the worktree is **not** created and the divergent commit still
   exists.
3. `down --purge` leaves no `ct/*-base` branch.

**Done when:** all three pass; the reproduction script reports "worktree is at
current main".

---

## T-2 — The brief names the directory it sits in (CT-13)

**Files:** `src/harness/templates/worker.md`, `src/harness/templates/leader.md`,
`src/harness/brief.ts`, `tests/harness/brief.test.ts`

**Behaviour**

`renderBrief` takes the absolute path of the directory the brief is written
into and passes it as a new `workspaceAbsolute` token. The templates say the
agent is already there and must not change directory. `{{workspace}}` stays
available for the relative form where that is the right thing to state.

`writeBrief` already computes `resolve(repo, participant.workspace, ...)`; the
same resolution feeds the template, so the path in the text and the path of the
file cannot drift.

**Tests**

1. A worker brief rendered for workspace `.crosstalk/worktrees/codex` contains
   the absolute path of that directory, and `path.isAbsolute` holds.
2. **The discriminating one:** the path named in the brief, resolved from the
   directory the brief was written into, is that same directory — not the repo
   root. Asserting only "contains an absolute path" passes on the repo root,
   which is exactly the bug.
3. The leader's brief still names the repo root, because that genuinely is the
   leader's workspace.

**Done when:** all three pass, and no template contains an unresolved token
(`brief.ts` already throws on one).

---

## T-3 — The hub URL is always printed, and no TTY means no browser (CT-11)

**Files:** `src/cli/index.ts`, `tests/cli/front-door.test.ts`

**Behaviour**

In `cmdUp`, restructure the tail:

- print `Hub: <url>?t=<token>` on **every** path, before any browser attempt
- attempt the open only when `--no-open` is absent **and** `process.stdout.isTTY`
- when the open is skipped for want of a TTY, say so in one dim line

`cmdDoctor` prints the same tokenised URL when a daemon is running, read from
`.crosstalk/daemon.json`, so a lost banner is recoverable.

**Tests**

1. `up --no-open` prints a line matching `Hub: http://127.0.0.1:\d+/\?t=[0-9a-f]{64}`.
2. `up` **without** `--no-open`, stdout not a TTY, prints the same line — this is
   the one that fails today.
3. `doctor` against a running daemon prints the tokenised URL.

**Done when:** all three pass and `repro-ct11.ps1` shows the `Hub:` line.

---

## T-4 — Long messages collapse with an expand control (CT-16)

**Files:** `src/ui/cards/MessageCard.tsx`, `src/ui/theme.css`, `tests/ui/message-card.test.tsx`

**Behaviour**

`MessageCard` holds local `expanded` state. Past a threshold on body length the
body renders clamped to a fixed height with a fade, plus a button reading
`Show more (N lines)` / `Show less`. Below the threshold nothing changes — no
control, no wrapper, identical DOM to today.

Clamping is CSS (`-webkit-line-clamp`), so the full text stays in the DOM and
remains selectable, findable by browser search, and readable by a screen reader.
The button carries `aria-expanded`.

**Tests**

1. A short body renders in full with **no** expand control.
2. A long body renders the control, and the card carries the collapsed marker.
3. Clicking expands: marker cleared, `aria-expanded` true.
4. The full text is present in the DOM in both states — this is what makes
   clamping honest rather than truncation.

Then, per AGENTS.md: build it, serve it, open it, and look. A component test
proves the card draws correctly given props, never that the stream hands it any.

**Done when:** the four pass, and the measured height of the 1327-char message
from the spec drops from 250px to the clamp.

---

## T-5 — `ct task create` and `ct task state` (CT-14b)

**Files:** `src/cli/index.ts`, `tests/cli/task-commands.test.ts` (new)

**Behaviour**

Two subcommands under `task`, over the endpoints the MCP tools already use:

```
ct task create --as leader --id T-01 --title '...' --brief '...' \
               --assignee codex --branch track-a/core \
               [--spec-ref R]... [--dep T-00]... [--acceptance '...']...
ct task state <id> --as <id> --state in_progress [--reason '...']
```

`create` → `POST /tasks` with `{id,title,brief,assignee,branch,specRefs,deps,acceptance}`.
`state` → `POST /tasks/:id/state` with `{state,reason?}`.

Field names match `createTask` (`handlers.ts:121`) and `setTaskState`
(`handlers.ts:224`) exactly. No validation is duplicated in the CLI: the daemon
owns the rules and its refusals are the ones agents must learn to read. Both
names go into `HANDLERS`, so `CLI_COMMANDS` — which
`tests/harness/brief-vocabulary.test.ts` checks the briefs against — picks them
up automatically.

**Tests**

1. `task create` against a live daemon appends `task_created`; `ct board` lists it.
2. `task state` moves it and appends `task_state`.
3. A **worker** calling `task create` is refused by the daemon and the CLI exits
   non-zero with the daemon's own message — the CLI must not invent a check, and
   must not swallow one.

**Depends on:** nothing. **Note:** update the brief's shell-tier transport block,
which currently says the task gates are MCP-only. `brief-vocabulary.test.ts`
will fail if that text names a command that does not exist.

---

## T-6 — `up --host` (CT-14a)

**Files:** `src/daemon/server.ts`, `src/cli/index.ts`, `tests/daemon/host.test.ts` (new)

**Behaviour**

`StartDaemonOptions.host`, defaulting to `127.0.0.1`. `--host` on `up` threads
through. Any host other than a loopback address prints a warning naming the
exposure and the fact that the token is the only guard.

The comment at `server.ts:56` stays and stays true: the *name* remains
`127.0.0.1` rather than `localhost`, because `localhost` resolves to `::1` first
on Windows. `--host` changes the interface, not that reasoning.

**Tests**

1. Default binds loopback; the reported url still says `127.0.0.1`.
2. `--host 0.0.0.0` binds and the url is reachable over a non-loopback local
   address.
3. A non-loopback host emits the warning; loopback does not.

---

## T-7 — Side rooms (CT-18 + the ordering bug)

**Files:** `src/core/rooms.ts`, `src/cli/index.ts`, `src/ui/layout/Dock.tsx`,
`tests/core/rooms.test.ts`, `tests/cli/dm.test.ts` (new)

**Behaviour**

1. `normaliseRoom(id)` sorts the two parts of a `dm:` id through the same
   comparator `dmId` uses, and the daemon applies it before membership and
   before append. `dm:leader~codex` and `dm:codex~leader` become one room.
2. `ct dm --as <id> --with <id> --body '...'` builds the id via `dmId`.
3. The dock's participant list gets a control opening a side room with that
   participant, selecting it in the sidebar.

Called **side rooms** in the UI and briefs, with the human's presence stated:
`withHuman()` puts `@human` in every room, so these are not private.

**Tests**

1. `normaliseRoom('dm:leader~codex') === 'dm:codex~leader'`, and posting to both
   spellings yields **one** room in the projection. Fails today.
2. `ct dm` posts into the sorted id.
3. Membership is unchanged by normalisation.

---

## T-8 — `doctor` names what is absent (CT-17, CT-19)

**Files:** `src/harness/doctor.ts`, `tests/harness/doctor.test.ts`

**Behaviour**

Two warnings, both non-blocking:

- `PARTICIPANT_NO_MODEL` — a non-human participant with no `model`. Remedy names
  `--participant id:role:harness:model`.
- `MIRROR_UNCONFIGURED` — `config.mirror` absent entirely. Says mirroring is off
  and not yet reachable from `init`, so an unbuilt feature and a deliberately
  disabled one stop looking identical.

**Tests**

1. A participant without a model warns; one with a model does not.
2. Absent `mirror` warns; `enabled: false` does **not** warn with
   `MIRROR_UNCONFIGURED` — a deliberate choice is not a gap.
3. Neither is `reject`, so neither blocks `up`.

---

## T-9 — Regression test for the pinned composer (CT-15)

**Files:** `tests/ui/layout.test.tsx`

Already fixed; currently unpinned by any test. Assert the composer is **not** a
descendant of `.stream-scroll`. Verified by inverting it: moving the composer
inside the scroll container must turn this red.

---

## Order

T-1, T-2, T-3 first — they are the ones that make a day possible. Then T-5 and
T-4. Then T-6, T-7, T-8, T-9.

## Evidence

Per AGENTS.md: `npm test`, `npm run typecheck`, `npm run build`, each with its
output and the SHA it ran at. UI work is additionally built, served and looked
at. `npm test` is not a build — vitest transpiles without typechecking, so a
green suite can sit on code `tsc` rejects.
