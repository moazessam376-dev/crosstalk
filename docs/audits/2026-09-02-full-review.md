# Full review, 2 September 2026

Reviewed at `main` = `8b05a36` by Claude Fable 5.1, with four parallel read-only
passes (daemon; CLI and harness; core, mirror, MCP and contracts; hub and
docs), each finding verified against source. Baseline before any change: 1282
tests green, typecheck clean.

Findings are grouped by what they cost the operator. **Fixed in this pass**
is marked; everything else is open and named precisely enough to fix without
re-finding it.

## What the review was asked

Dead code, obvious bugs and broken functionality; whether the agent-facing
workflows and briefs are any good; whether Crosstalk takes actions against the
repository it should not; and the state of the GitHub mirror.

## Broken functionality

1. **Shell-tier builders could not finish a task.** `crosstalk act --kind
   done` posted `/submit` with no critique record and the daemon refused it
   every time (`GATE_NOT_SELF_REVIEWED`), so a task worked from the shell sat
   in `in_progress` forever. The brief for the shell tier did not name `done`
   at all. *Fixed: the CLI now sends a critique, `--finding` repeatable.*
2. **A Codex seat ran unbriefed.** Its brief was written to
   `AGENTS.local.md`; the Codex binary reads `AGENTS.md` and
   `AGENTS.override.md` and nothing else. *Fixed: `briefSuffix` in the
   registry.*
3. **A Codex seat with an effort died at spawn.** `--effort` is not a
   `codex exec` flag. *Fixed: `-c model_reasoning_effort=…`.*
4. **A Codex seat could not be woken.** No `turnFormat`, so a board event
   after the first turn had nowhere to go, and `execFile` without
   `maxBuffer` killed it at 1 MB of output. *Fixed: `turnFormat: resume`,
   one process per turn on one thread.*
5. **A Codex seat had no MCP unless the operator edited
   `~/.codex/config.toml`,** and was then briefed to run a `crosstalk` binary
   that is on nobody's PATH. *Fixed: the registration is passed as `-c
   mcp_servers.crosstalk.*` on spawn.*
6. **Choosing a model in the hub against a seated roster did nothing.**
   `rosterDiffers` compared id, role and harness only; the seat spawned on
   the model in `crosstalk.yaml`. A test pinned the bug. *Fixed.*
7. **The trio-contract brief told peers a `say` the daemon refuses**
   (`say({room, body, ref})` with no tag or head, under a shape that enforces
   tags). *Fixed.*
8. **Two daemon messages bypassed the projection and the live stream:**
   "launch failed" and "still running after 5s" went to the log directly, so
   the hub never showed them until reload, and both were attributed to
   `@human`. *Fixed: through `#append`, from `@crosstalk`.*
9. **Task acceptance methods `ladder` and `discriminating_test` are
   accepted by `doctor` and can never accept a task.** `majority` and
   `unanimous` are refused with a remedy that does not exist: nothing maps a
   resolved decision onto a task state. Open.
10. **`mirror.github.mode: off` does not turn the mirror off.** Only
    `enabled` is read for the outbound half; `off` disables inbound polling
    only. `crosstalk github <url> --mode off` therefore pushes branches with
    `--force-with-lease` and opens draft PRs on every `up`. Open.
11. **Inbound GitHub polling covers only PRs of tasks that have a claim.**
    The PR number cache is filled inside the claims loop. A two-way mirror
    with three tasks and no court activity polls zero PRs. Open.
12. **Configuring the mirror from the hub does not start it** until `up` is
    restarted, and nothing says so. When `gh` is not on PATH the mirror
    reports `configured: true, enabled: false` with no reason. Open.
13. **Stopping `up` does not stop spawned seats.** A piped seat keeps
    running in its worktree after Ctrl-C. Open.
14. **`act done` is two writes with no compensation.** If the state change
    fails after `/submit` succeeded, a retry appends a second self-review
    record. Open.
15. **Aborted uploads leak temp files** under `.crosstalk/blobs/tmp/` and a
    write error on the sink is an uncaught exception. Open.
16. **A corrupt line mid-log truncates every valid line after it** and then
    reissues those seqs. Only the trailing-line case is tested. Open.
17. **All-quorum gates count every non-human seat,** so a trio project with
    a `spoc` or `observer` configured can never leave build. Open.

## Actions against the repository and the machine

Enumerated in full by the CLI pass. The ones worth knowing:

- **`crosstalk github <url>` and the hub's mirror field run `git remote
  set-url origin`** whenever `origin` exists, with no check of the existing
  URL. A fork remote is overwritten without a word. Open.
- **`.claude/settings.json` is shallow-merged, including at the repository
  root** (the leader's workspace), on every `init`, `up` without a roster,
  and hub launch. The operator's own `hooks` and `env` keys are replaced
  wholesale, and the root file is commonly tracked. Open.
- **`~/.claude.json` is rewritten on every launch of an interactive seat**
  (folder trust), with no flag to decline. Merges key by key; a corrupt file
  is replaced from `{}`. Open.
- **`up` on an unstaffed repository appends to the tracked `.gitignore`.**
  On a CRLF file the detection regex never matches and the block is appended
  again on every run. Open.
- **`down --purge` runs `git worktree remove --force` and `git branch -D`**
  on every seat base branch, discarding uncommitted and unpushed work, and
  prints only "Purged tokens." Task branches from shared-root submits are
  left behind. Open.
- `compose` rewrites `crosstalk.yaml` through parse/stringify, dropping
  comments and flipping every supervisable seat to `lifecycle: supervised`.
  Open.
- Ending a run kills processes and nothing else. Confirmed by test. No
  `checkout`, `reset`, `clean` or `stash` anywhere in `src/`.

## The briefs and shapes, as prompts

- The leader template says "cut tasks immediately"; the planner-integrator
  fragment says "plan with the operator before you plan anything else". A
  fresh model reads both. Open.
- The worker template says finishing is `act({kind:"done"})`; the
  planner-integrator fragment says post `gate:slice-done` and stop, and never
  mentions `done`, so its tasks never leave `in_progress`. Open.
- The peer template's examples (`need: who owns HUD?` on the floor) are
  refused under enforcement, since `ask` must go to one seat. Open.
- The SPOC template never names the `act accept`/`reject` verb it exists to
  use. Open.
- The `file` tier brief describes a transport that does not exist. Open.
- `blocked` requires `to`, so a seat blocked on nobody in particular has no
  legal way to say so. Open.
- The generated board skill and the tag table are consistent with the
  daemon's refusals.

## Dead code

Confirmed unused in `src/` and `tests/`: `mirror/index.ts` `isNumber`,
`claimIdOf`; `runner.ts` `spawnArgv`, `linesOf`; `trust.ts` `untrusted`
(tests only); `hub.ts` `HUB_DIST`; `projection.ts` `stateForVerdict`;
`Terminal.tsx` `ansi16`, `TerminalHistory`; `path.ts` `findExecutable`
duplicates `install.ts` `findOnPath`; `MirrorStatus.lastDrain` never
populated (the hub branch that renders it is unreachable); `POST /compose`
has no live caller in the hub; `POST /decisions/:id/test` has no client;
`Phase.actors` is read by nothing; `policy.selfCritique`/`leaderCritique`
and `policy.planning` are read nowhere; `Task.pr`, `Claim.supersedes`,
`Decision.rationale` are never written; `Tier` `file` is unreachable by
probe; six CSS classes in `theme.css` have no reference.

## Documentation

README, RUNNING and CROSS-PLATFORM described a product several releases
old: supervised lifecycle "not implemented", the ledger "not built", a
thirteen-tool MCP list that is now four tools, a refused-hub screen that no
longer exists, a "two runtime dependencies, no native modules" rule that
`node-pty` contradicts. *README, AGENTS and CONTEXT corrected in this pass;
RUNNING.md's command and tool tables are still the old ones.* CLAUDE.md
names `superpowers:*` skills that exist nowhere in the tree. CI is
macOS-only on push to `main`, not three platforms per PR as AGENTS.md says.

## What the pass added

The `lead-crew` shape, seat hiring and release, the quiet-seat watchdog and
a Codex seat that can be woken — `docs/specs/2026-09-02-lead-crew.md`.
Tests: 1343 green, typecheck clean, hub built and opened.
