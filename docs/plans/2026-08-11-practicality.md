# Making Crosstalk practical — implementation plan

Spec: [`docs/specs/2026-08-11-practicality-design.md`](../specs/2026-08-11-practicality-design.md)
Base: `ac520f6` · Branch: `ct/practicality`

Baseline before any change: `569/569` pass, typecheck and build clean.
`tests/mirror/wiring.test.ts` needs `--testTimeout=45000` on a loaded machine
(see the spec's note); at the default 5s its cases time out under load and pass
in ~2.8s each when given room.

TDD, per task: write the failing test, run it, confirm it fails *for the reason
expected*, then implement. A test that passes on its first run has demonstrated
nothing.

**Revision 2**, after one critic round. Sixteen findings; fourteen accepted, two
accepted with a different remedy, none contested. The record is at the end —
several of them were the difference between a repair and a regression.

---

## T-1 — `init` never reuses a stale `ct/<id>-base` (CT-12)

**Files:** `src/cli/init.ts`, `tests/cli/worktree-freshness.test.ts` (new)

**Behaviour**

The check runs in `runInit`'s **pre-write pass**, beside `checkPrerequisites`
(`init.ts:95`) and before `writeFile` at `:100` — not inside `addWorktree`. A
refusal must leave nothing behind: `init` writes the config at `:100` and mints
tokens at `:101-112`, so a throw from `ensureWorkspaces` at `:114` would strand a
half-initialised repo that `init` itself then refuses to re-enter
(`init.ts:54-60`, "crosstalk.yaml already exists"). `front-door.test.ts:296-298`
pins that invariant: on a refusal, nothing is written for `doctor` to complain
about later.

For each worker whose `ct/<id>-base` already exists:

- **ancestor** of the main branch → fast-forward it, and say so
- **diverged** → `CliError` naming the branch, its commit and the main-branch
  commit, before anything is written

The main branch is resolved with `branchSha` (`git.ts:55-64`), whose error text
already names the right remedy, and its failure is converted to a `CliError`.
This matters: `isAncestor` (`git.ts:83-91`) rethrows anything that is not exit
code 1, and git exits **128** for an unknown revision — so on a clone whose
default branch is `master`, calling `isAncestor` directly turns `init` into a raw
stack trace and `EXIT.daemon`.

`runInit` constructs its config at `init.ts:78-83` with `mainBranch: 'main'`
hard-coded and never loads an existing one, so "read it from the config" would be
vacuous today. The value is threaded from that constructed config anyway, so the
day `init` learns to preserve an existing `project.mainBranch` this code is
already correct.

`purgeWorkspaces` additionally deletes each `ct/<id>-base` after removing its
worktree, using a new `deleteBranch` helper in `src/workspace/git.ts` (`isAncestor`
already exists there; do not add a second ancestry helper). The `init` guard is
what actually holds — a branch can be left behind by routes other than `--purge`.

**Tests** (both sides of the discrimination)

1. purge → three commits on `main` → `init` → worker worktree HEAD **equals**
   `main` HEAD and the worked file holds the newest content. Fails today: `v1`
   against `main`'s `v4`.
2. commit *on* `ct/<id>-base` so it diverges → `init` → refuses, message names the
   branch; the worktree is **not** created and the divergent commit still exists.
3. On that refusal, `crosstalk.yaml` was **not** written — the pre-write
   invariant, and the reason the check moved.
4. `down --purge` leaves no `ct/*-base` branch.
5. A repo whose main branch is `master` initialises without throwing.

---

## T-2 — The brief names the workspace it sits in (CT-13)

**Files:** `src/harness/templates/worker.md`, `src/harness/templates/leader.md`,
`src/harness/brief.ts`, `src/harness/doctor.ts`, `tests/harness/brief.test.ts`,
`tests/harness/brief-vocabulary.test.ts`

**Behaviour**

`renderBrief` gains a `workspaceAbsolute` token whose value is
**`resolve(repo, participant.workspace)`** — the workspace root, *not* the
directory the brief file lands in. Those differ: `localBriefFile` only rewrites
the basename (`brief.ts:152-157`), but `harnesses.yaml:24,30` gives
`cursor-cli`/`cursor-app` a `briefFile` of `.cursor/rules/crosstalk.mdc`, so
`dirname(destination)` for a cursor participant is `<workspace>/.cursor/rules`.
Naming that would reproduce CT-13 for `binding` — the one harness that actually
wandered.

The templates say the agent is already there and must not change directory.
`{{workspace}}` stays available for the relative form.

**The signature change has two callers beyond `writeBrief`.** `doctor.ts:320`
renders the expected brief and compares it byte-for-byte (`:321`) and by hash
(`:328`); if it does not pass an identical absolute path, `BRIEF_STALE` fires for
every participant on every `doctor` and every `up` preflight (`index.ts:171-172`).
`checkParticipant` already receives `repoRoot` (`doctor.ts:517`), so thread it
through. `tests/harness/brief-vocabulary.test.ts:55,67` also call `renderBrief`
directly and will not compile otherwise.

**Tests**

1. A worker brief for workspace `.crosstalk/worktrees/codex` names that
   directory absolutely, and `path.isAbsolute` holds.
2. **The discriminating one:** the path the brief names is the workspace root —
   asserted for a `cursor-app` participant, whose brief file sits two directories
   below it. Asserting "the directory the brief was written into" would compare
   the bug to itself and pass.
3. A brief that named the repo root would fail test 2 — that is the CT-13 defect,
   and both neighbouring cases are covered.
4. The leader's brief still names the repo root, because that is its workspace.
5. `doctor` reports **no** `BRIEF_STALE` on a freshly-initialised repo — the
   regression the signature change would otherwise cause.

---

## T-3 — The hub URL is always printed, no TTY means no browser (CT-11)

**Files:** `src/cli/index.ts`, `src/cli/open.ts`, `tests/cli/front-door.test.ts`

**Behaviour**

In `cmdUp`:

- print `Hub: <url>?t=<token>` on **every** path, before any browser is attempted
- attempt the open only when `--no-open` is absent **and** `process.stdout.isTTY`
- when the open is skipped for want of a TTY, say so in one dim line

`cmdDoctor` prints the same URL when a daemon is running. The url comes from
`.crosstalk/daemon.json` (`{version,url,pid,startedAt}`, `server.ts:110`) and the
token from `.crosstalk/tokens/human` — `daemon.json` has never held a token, and
`tokenFilename` strips the `@` (`server.ts:255-258`). Findings keep their current
`--json` shape; the URL is printed only on the human branch of `emit`.

`openBrowser` gains `windowsHide: true` (`open.ts:29`) — the only `execFile` in
`src/` without it, against `init.ts:205,211,235,256`, `doctor.ts:143`,
`git.ts:13-17`. A console flashing up is a poor look in the one path whose whole
symptom is a headless launch behaving oddly.

**Tests**

1. `up --no-open` prints `Hub: http://127.0.0.1:\d+/\?t=[0-9a-f]{64}`. **Passes
   today** via the `else if` at `index.ts:199-201`; kept as a regression guard.
2. `up` **without** `--no-open`, stdout not a TTY, prints the same line. This is
   the one that fails today.
3. `doctor` against a running daemon prints the tokenised URL.

---

## T-4 — Long messages collapse with an expand control (CT-16)

**Files:** `src/ui/cards/MessageCard.tsx`, `src/ui/theme.css`, `tests/ui/message-card.test.tsx` (new)

**Behaviour**

`MessageCard` holds local `expanded` state. Past a threshold on **body character
length** the body renders clamped with a fade plus a button reading `Show more` /
`Show less` — no line count in the label, because with `-webkit-line-clamp` the
visible line count is a layout result, not something the component knows. Below
the threshold nothing changes: no control, no wrapper, DOM identical to today.

Clamping is CSS, so the full text stays in the DOM — selectable, findable by
browser search, readable by a screen reader. The button carries `aria-expanded`.

**Tests**

1. A short body renders in full with **no** expand control.
2. A long body renders the control and the collapsed marker.
3. Clicking expands: marker cleared, `aria-expanded` true.
4. The full text is in the DOM in both states. **Passes today** — labelled as the
   guard that keeps clamping honest rather than truncation.

Then build it, serve it, open it and look, per AGENTS.md. A component test proves
the card draws correctly *given* props, never that the stream hands it any.

---

## T-5 — `ct task create` and `ct task state` (CT-14b)

**Files:** `src/cli/index.ts`, `src/harness/brief.ts`, `tests/cli/task-commands.test.ts` (new)

**Behaviour**

**One** `HANDLERS` key: `task`, which dispatches on its first positional. `main`
looks up `argv[0]` alone (`index.ts:100`), so a key of `'task create'` is
unreachable — `ct task create` would look up `task` and throw "Unknown command".
One key also keeps `CLI_COMMANDS` (`index.ts:440`) agreeing with
`brief-vocabulary.test.ts:43`, whose regex captures only the first word after
`` `crosstalk ``.

```
ct task create --as leader --id T-01 --title '...' --brief '...' \
               --assignee codex --branch track-a/core \
               [--spec-ref R]... [--dep T-00]... [--acceptance '...']...
ct task state <id> --as <id> --state in_progress [--reason '...']
```

`create` → `POST /tasks` with `{id,title,brief,assignee,branch,specRefs,deps,acceptance}`
(`handlers.ts:121-143`). `state` → `POST /tasks/:id/state` with `{state,reason?}`
(`handlers.ts:224-249`) — the field is `state`, not `to`. No validation is
duplicated in the CLI: the daemon owns the rules and its refusals are what agents
must learn to read.

The shell-tier brief block **gains** two lines naming the new commands. The
existing sentence — "The task gates ... are MCP tools only" (`brief.ts:83-84`) —
**stays as it is and stays true**: the gates are `ack_task` and `submit_task`
(`tools.ts:273,300`), which this task does not add. Rewriting it would make the
brief lie to every shell-tier agent, the exact regression
`brief-vocabulary.test.ts` exists to catch.

**Tests**

1. `task create` against a live daemon appends `task_created`; `ct board` lists it.
2. `task state` moves it and appends `task_state`.
3. A **worker** calling `task create` is refused by the daemon and the CLI exits
   non-zero carrying the daemon's own message — the CLI must not invent a check
   and must not swallow one.
4. `ct task` with no subcommand exits with usage, naming both subcommands.

---

## T-6 — `up --host` (CT-14a)

**Files:** `src/daemon/server.ts`, `src/cli/index.ts`, `tests/daemon/host.test.ts` (new)

**Behaviour**

`StartDaemonOptions.host`, defaulting to `127.0.0.1`; `--host` on `up` threads
through. A non-loopback host prints a warning naming the exposure and the fact
that the token is the only guard.

The comment at `server.ts:56` stays true: the *name* remains `127.0.0.1` rather
than `localhost`, because `localhost` resolves to `::1` first on Windows and
strands IPv4 clients. `--host` changes the interface, not that reasoning.

**Tests**

1. Default binds loopback; the reported url still says `127.0.0.1`.
2. `--host 0.0.0.0` → `(server.address() as AddressInfo).address === '0.0.0.0'`.
   Asserted on the bound address, **not** by connecting over a routable IP: that
   needs a non-loopback address and an open host firewall, and AGENTS.md rule 7
   wants this green on three platforms.
3. A non-loopback host emits the warning; loopback does not.

---

## T-7 — Side rooms (CT-18 + the ordering bug)

**Files:** `src/core/rooms.ts`, `src/daemon/server.ts`, `src/cli/index.ts`,
`src/ui/layout/Dock.tsx`, `tests/core/rooms.test.ts`, `tests/cli/dm.test.ts` (new)

**Behaviour**

1. `normaliseRoom(id)` sorts the two parts of a `dm:` id through the same
   comparator `dmId` uses, and returns anything else untouched.
2. It is applied on **both** paths, not just the write. `#readRoom`
   (`server.ts:680-683`) filters `event.room === room` on the raw string, so
   normalising only on append makes `GET /rooms/dm:leader~codex/events` return
   zero events forever — membership passes, the filter does not.
3. `ct dm --as <id> --with <id> --body '...'` builds the id via `dmId`.
4. The dock's participant list gets a control that opens a side room with that
   participant and selects it.

Called **side rooms** in UI and briefs, with the human's presence stated:
`withHuman()` (`rooms.ts:83`) puts `@human` in every room, so these are not
private from the operator.

**Known limit, stated rather than implied:** normalisation fixes new writes and
reads. A log that already holds both spellings keeps two sidebar entries, because
`derive.ts` builds the channel list from `event.room` and the log is append-only.

**Tests**

1. `normaliseRoom('dm:leader~codex') === 'dm:codex~leader'`; `#floor`, `task:`
   and `dispute:` ids pass through unchanged.
2. Posting to both spellings yields **one** room in the projection. Fails today.
3. Reading `/rooms/dm:leader~codex/events` returns events written as
   `dm:codex~leader` — the read-path half.
4. `ct dm` posts into the sorted id.
5. Membership is unchanged by normalisation.

---

## T-8 — `doctor` names what is absent (CT-17, CT-19, and the stale worktree)

**Files:** `src/harness/doctor.ts`, `tests/harness/doctor.test.ts`

**Behaviour**

Three warnings, none blocking, **each one finding total rather than one per
participant**. A default `init` already emits `THIRD_AGENT_UNAVAILABLE` and
`MCP_PROBE_FALLBACK` (pinned by `front-door.test.ts:270-279`) and `up` prints
them all above the banner; per-participant model warnings would make five lines
on a correct first run, in the change whose purpose is practicality.

- `PARTICIPANT_NO_MODEL` — one finding listing every non-human participant with
  no `model`. Remedy names `--participant id:role:harness:model`.
- `MIRROR_UNCONFIGURED` — `config.mirror` absent entirely. Says mirroring is off
  and not yet reachable from `init`, so an unbuilt feature and a deliberately
  disabled one stop looking identical. `enabled: false` is a choice, not a gap,
  and does not warn.
- `WORKTREE_BEHIND_MAIN` — a **registered** worker worktree whose HEAD is behind
  the main branch. T-1 only catches the branch-alive/worktree-gone shape; this is
  the ordinary daily case, and it is what the operator hand-fixed with
  `git merge --ff-only main` in three worktrees.

**Tests**

1. A participant without a model warns; one with a model does not; two without
   produce **one** finding naming both.
2. Absent `mirror` warns; `enabled: false` does not warn with `MIRROR_UNCONFIGURED`.
3. A worktree at the main branch does not warn; one behind it does.
4. None is `reject`, so none blocks `up`.

---

## T-9 — Regression test for the pinned composer (CT-15)

**Files:** `tests/ui/layout.test.tsx`, `tests/ui/theme.test.ts`, `src/ui/theme.css`

Already fixed, and pinned by nothing. The DOM assertion alone is not enough: the
composer's position is a **CSS** fact. The pin is `theme.css:892-896`
(`.hub-stream { display:flex; flex-direction:column; overflow:hidden }`) with
`:941-946` (`.stream-scroll { min-height:0; flex:1; overflow-y:auto }`). Delete
either and the composer scrolls away with the log — CT-15 verbatim — while
remaining a non-descendant of `.stream-scroll`.

So: the DOM assertion, **plus** assertions over the stylesheet that
`.stream-scroll` keeps `flex:1` and `min-height:0` and `.hub-stream` stays a
`column` with `overflow:hidden`.

Also delete the contradictory `.hub-stream { overflow: auto }` at
`theme.css:97-99`. It loses to `:892` only by source order, so reordering the
file silently restores the bug. And give `.composer` `flex: none`, which
`.stream-head` (`:906`) and `.needs-you` (`:1039`) have and it does not.

Verify by inverting: moving the composer inside the scroll container, and
separately removing `flex:1` from `.stream-scroll`, must each turn this red.

---

## Order

T-1, T-2, T-3 first — they make a day possible. Then T-5, T-4. Then T-6, T-7,
T-8, T-9.

## Evidence

`npm test`, `npm run typecheck`, `npm run build`, each with output and the SHA it
ran at. UI work is additionally built, served and looked at. `npm test` is not a
build: vitest transpiles without typechecking, so a green suite can sit on code
`tsc` rejects.

Acceptance is the vitest suites named per task. The reproduction scripts that
confirmed CT-11 and CT-12 live in the session scratchpad and are **not** repo
acceptance criteria — AGENTS.md:15 allows no `.sh`, `.bat` or `.ps1` in the tree.

---

## Critic round — findings and resolution

One round, sixteen findings. Each was checked against the source before being
accepted; none was taken on assertion alone.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | defect | `renderBrief`'s signature change breaks `doctor.ts:320` and `brief-vocabulary.test.ts:55,67` | **accepted** — verified; T-2 threads `repoRoot` from `checkParticipant` and names both callers |
| 2 | defect | "directory the brief is written into" is wrong for cursor's `.cursor/rules/crosstalk.mdc`, reproducing CT-13 for the one harness that wandered | **accepted** — verified; the token is `resolve(repo, participant.workspace)`, and T-2 test 2 now asserts it on a `cursor-app` participant |
| 3 | defect | T-1's refusal fired after config and tokens were written, stranding a repo `init` refuses to re-enter | **accepted** — verified against `init.ts:100-114` and `front-door.test.ts:296-298`; the check moved to the pre-write pass |
| 4 | defect | `mainBranch` reading is vacuous, and `isAncestor` turns a missing branch into a stack trace (git exits 128, `git.ts:88` rethrows) | **accepted** — verified; resolve through `branchSha`, convert to `CliError`, and T-1 test 5 covers a `master` repo |
| 5 | defect | T-9 cannot fail for the defect CT-15 was: the pin is CSS, not DOM | **accepted** — verified; stylesheet assertions added, the contradictory `.hub-stream` rule deleted, `flex:none` given to `.composer` |
| 6 | defect | T-7 normalised writes only; `#readRoom` filters the raw id | **accepted** — verified at `server.ts:683`; both paths normalise, and the stated limit for existing logs is now in the plan |
| 7 | defect | `'task create'` is unreachable as a `HANDLERS` key, and two keys break the vocabulary regex | **accepted** — verified at `index.ts:100,440` and `brief-vocabulary.test.ts:43`; one `task` key with sub-dispatch |
| 8 | defect | T-5's note would have made a true brief sentence false — the gates are `ack_task`/`submit_task`, not the verbs being added | **accepted** — the sentence stays; the block gains two lines |
| 9 | risk | T-1 covers only branch-alive/worktree-gone, not a registered worktree behind main | **accepted, different remedy** — rather than widen T-1, `WORKTREE_BEHIND_MAIN` was added to T-8, which is where a daily check belongs |
| 10 | risk | T-8 would put five warnings on a correct first `init` | **accepted, different remedy** — one finding per code rather than per participant; defaulting a model was rejected, since Crosstalk cannot know which model an agent runs and CT-17 already says a hand-declared one is documentation, not fact |
| 11 | risk | T-6 test 2 was a network test needing a routable IP and an open firewall | **accepted** — assert the bound `AddressInfo.address` |
| 12 | risk | Two "Done when" criteria cite scripts that are not in the repo and could not be, per AGENTS.md:15 | **accepted** — removed; acceptance is the vitest suites |
| 13 | risk | `daemon.json` has never held a token, so T-3's `doctor` line needs `.crosstalk/tokens/human` | **accepted** — verified at `server.ts:110,255-258` |
| 14 | nit | T-1 listed `git.ts` without saying what was missing there | **accepted** — `deleteBranch`; `isAncestor` already exists, do not add a second |
| 15 | nit | "Show more (N lines)" contradicts a character threshold | **accepted** — the label is `Show more` / `Show less` |
| 16 | nit | Two tests pass against unfixed code and were not labelled | **accepted** — T-3 test 1 and T-4 test 4 are labelled regression guards |
| — | scope | `openBrowser` is the only `execFile` in `src/` without `windowsHide` | **accepted** — folded into T-3, which already rewrites that branch |

The critic also independently confirmed the four "already fixed" verdicts and the
five "confirmed" ones, and traced every deletion path and git subprocess
reachable from `up` without finding one that removes tokens — which is the
strongest available support for the spec's CT-11 correction.
