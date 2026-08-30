# Team OS and the Cinder bench

Settled in the 2026-08-31 grilling session, on evidence from the beacon-1
post-mortem and two primary-source research notes in `docs/research/`.

## Why

Beacon-1 shipped three playable games. Solo won on cost (332k tokens) and tied
on quality; both teams shipped a seam bug that solo did not have. The
post-mortem found the cause was not the protocol but the transport: `inbox`
delivers `clip(body, 120)` and has no `read` verb, so **5% of what the strongest
seat wrote reached its teammates**. Everything expensive that followed — the
polling loop, a 21-minute duplicated build, a done-close on a branch nobody had
rendered — is downstream of seats not knowing what was said to them.

Two findings from the research bound what a fix can achieve:

- *Capable language models can outgrow the benefits of collaboration* (Nature
  Machine Intelligence, 2026-07-24) measured coordination going **net-negative
  above a ~45% single-agent baseline**. Beacon's fixture sat near 100% for solo,
  so a team could not have won it. The fixture has to get harder before a team
  result is interpretable.
- Cognition's April 2026 reversal: multi-agent works when writes stay
  single-threaded and additional agents contribute intelligence. Amended here by
  operator decision to **three writers behind a frozen contract**, which is the
  same rule applied at file granularity rather than seat granularity.

## Settled decisions

| # | Decision |
|---|---|
| Goal | Higher ceiling — tasks a solo run cannot finish well. Not cheaper-tie. |
| Success | Core acceptance met bug-free, then judged on quality, graphics, gameplay. |
| Writers | Three, each owning one system, behind a contract frozen before build. |
| Benchmark | Own fixture (`bench/cinder`), two cells. No external benchmark. No GitHub *communication* arm — but the team cell uses a GitHub repo as merge plumbing. |
| Delivery | Full body up to a 1,500-char cap, plus an optional artifact reference. |
| Presence | Harness hooks first; supervised stream later behind the same seam. |
| Gates | Mechanical on phase transitions only. Free inside each phase. |
| Budget | Uncapped tokens. Wall-clock ceiling as a safety, not a target. |
| Judging | Blind first, then unblinded. Operator judges. n=1 is directional. |

## Workstreams

### W1 — Delivery

The measured defect. Smallest change, largest payoff.

- `src/core/inbox.ts` — `InboxCard` gains `body`. `SUMMARY_LIMIT` becomes a
  delivery budget rather than a private constant.
- `src/mcp/tools.ts`, `src/cli/index.ts` — `say` enforces a 1,500-char cap and
  **rejects** over-cap with guidance rather than truncating, so the author
  chooses what to cut.
- `say` gains optional `ref` — a path, SHA, or file the seat wrote. Depth lives
  in the artifact; the board carries the finding.
- Delete *"Read it before every work step, not only when idle"* from the brief
  templates once W2 lands. It is the line that causes the poll loop.

**Acceptance:** a behavioural test — seat B's inbox contains what seat A claimed,
in full. Not an assertion that `clip()` returns 120 characters.

### W2 — Push transport

`driveSupervised` in `src/harness/runner.ts` is written and tested and **nothing
calls it**; the spawn line is `[claude, -p]`, a one-shot with no session to write
into. Verified working: a persistent `claude -p --input-format stream-json`
process accepts a second message 1.2s into the first turn and answers both in
order.

- `src/harness/harnesses.yaml` — claude spawn becomes
  `claude -p --input-format stream-json --output-format stream-json --verbose`.
- Wire `driveSupervised` into `src/cli/compose.ts`.
- Declare a per-harness `push` capability. `codex exec` reads stdin as one block
  and **cannot** be pushed mid-session; Delivery falls back to pull for it.

**Acceptance:** a seat receives a board message mid-turn without calling `inbox`.

### W3 — Team Shape and the phase machine

Today "how a team works" is spread across seven places: the `Role` union,
`InboxRole`, `nextLine()`, `jobFor()`, `readTemplate()`'s literal union, a
ternary in `brief.ts`, and four prose templates. Adding a seat kind is a
five-file change; composing a shape at runtime is impossible.

- One `TeamShape` record: seats, and per seat — verbs, job source, done
  requirement, brief fragment.
- `nextLine()` and `jobFor()` read the shape instead of switching on role.
- `readTemplate()`'s union collapses into shape-supplied fragments.
- Phase machine with **mechanical transition gates only**:

| Phase | Who writes | Exit gate |
|---|---|---|
| Plan | nobody writes `src/` | `src/contract.ts` exists; split posted with zero shared files; all seats agree |
| Build | each seat, own files only; contract read-only | own tests green; PR open; **no two PRs touch the same file** |
| Verify | the integrator seat, test files only | every Build PR merged to `main` by this seat; bug list posted to the board |
| Repair | the same seat, anything | full run clean, regression green, merged to `main` |

- Ship two shapes: `solo` and `trio-contract`.
- **PRs are plumbing, not process.** Each Build seat opens a PR from its own
  branch. Nobody reviews in the PR, nobody blocks on approval, and no discussion
  happens there — the board stays the only channel. The integrator merges. This
  is what makes the Build gate mechanical: `git diff --name-only` across the
  three branches must not intersect, or the split was wrong and the phase does
  not advance. Beacon-1's GitHub cell was slow precisely because a PR was a
  review gate; here it is only a merge path.
- Teach `dm:` rooms in the brief — they exist in the protocol and went unused in
  all 82 beacon messages because nothing mentioned them.

**Acceptance:** adding a fourth seat kind is a data change, no code edit.

### W4 — Presence

Twenty board messages on beacon-1 asked what a seat was doing, and the answers
were wrong. One presence row would have prevented the duplicated build.

- Hook script POSTs `PreToolUse` / `PostToolUse` / `Stop` to the daemon.
- `Presence` projection as **overwriting state, not appended events** — one row
  per seat: status, current file, last verb, age. Putting tool calls in the
  append-only log would bury 87 real events under thousands.
- `/presence` route; sidebar rendering.
- Brief rule: do not ping a seat holding active working-state.

### W5 — Cinder fixture

`bench/cinder/JOB.md` is written. Still needed, byte-identical for both cells:
`package.json`, `vite.config.ts`, `tsconfig.json`, `vitest.config.ts`,
`index.html`, a `src/main.ts` stub, and a seed test. Freeze the fixture SHA and
record it.

### W6 — Run protocol

- **Cell A — solo:** one Opus 5 high seat, self-verification, ships.
- **Cell B — trio-contract:** three Opus 5 high seats through the phase machine.
- Identical fixture SHA and `JOB.md`. Uncapped tokens; wall-clock ceiling as
  safety. Per-seat token and wall-clock accounting.
- Both builds served on unbranded ports for blind judging.
- A fresh GitHub repo per run, created at run time. Team cell only; the solo
  cell commits locally.

**Isolation.** Beacon-1's cells ran at `.crosstalk/bench/beacon-1/` *inside*
this repo, so `CLAUDE.md`, `AGENTS.md` and `CONTEXT.md` were in scope, and
auto-memory now carries a beacon-1 results file that a fresh session in this
project loads on its own. That is the contamination vector, not the game design.

1. Run both cells outside the Crosstalk tree — `~/bench/cinder-1/{solo,team}`.
2. No `CLAUDE.md` or `AGENTS.md` in the fixture beyond the seat brief.
3. Launch seats with `--bare` (or an explicit `--settings`) to skip auto-memory
   and `CLAUDE.md` auto-discovery.
4. Never name Beacon in the fixture, briefs, or job prompt.
5. Run the cross-cell overlap audit afterward, as on beacon-1.
- Bug list from Verify is the defect record for both cells — the solo cell
  produces one too.

### W7 — Domain update

`CONTEXT.md` now diverges from reality. Update: the benchmark is two cells on an
own fixture, not three with a GitHub arm. Add `Team Shape`, `Delivery`,
`Phase machine`, `Contract freeze`, `Presence`.

### W8 — Hub Launcher

Downstream of W3; does not gate the run. `/compose`, `/harnesses`, `/roster`
exist, and the roster already carries `model` and `effort`. Needs a `/shapes`
route, a shape picker, and per-seat rows in `ComposeForm.tsx` (currently 76
lines).

## Order

```
W1 ──► W2 ──┐
W3 ─────────┼──► W6 (run)
W4 ─────────┤
W5 ─────────┘
W3 ──► W8   (after the run, or alongside it)
W7 alongside W3
```

W1 first: it is the only workstream with a measured defect behind it rather than
an inferred one.

## Applied from `docs/research/2026-08-30-aihero-skills-engineering.md`

- **No-op test on every brief line.** Delete it, re-run, see if behaviour
  changes. The current peer brief tells seats to post short asks and not
  narrate; one seat posted 54 narrations. That line is a no-op and should be
  replaced by the W1 cap, which is mechanical.
- **Phase skills small and composable**, marked `disable-model-invocation` so
  their descriptions do not burn context in every session.
- **Validate skill frontmatter in CI** — six of his skills silently vanished
  from the installer on an unquoted YAML colon.
- **Worktrees are mandatory**, not optional: parallel sessions sharing one
  checkout corrupted git for him (an amend landing on another session's commit,
  a stash vanishing). `crosstalk init` not creating worktrees for peer seats cost
  20 operator minutes on beacon-1.

## Measurement honesty

The research measured up to **30× run-to-run token variance** on identical tasks,
and a noise-floor study found inert configurations producing apparent gaps of −3
to +18 points. n=1 per cell is directional evidence, not a result. The beacon-1
delivery figures (5% / 19% / 60%) are direct measurements and stand; the causal
cost attributions built on them do not, until they reproduce.

The gap worth filling: no published work measures cost-per-solved-task for a
matched single- versus multi-agent pair at frontier scale.
