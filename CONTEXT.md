# Crosstalk domain language

Settled in the 2026-08-30 efficiency rebuild grill. Do not rename these in passing.

## Product

**Team OS.** Crosstalk’s job is to let agents from different harnesses coordinate as a team and finish the user’s work. It is not primarily a review-protocol product.

**Court.** The claim protocol (falsifier, contest, uphold, ladder). Opens only when two statements cannot both be true. Not the default verb.

**Board.** The cheap coordination channel: assign, say, done, share a pointer. Default verb.

**Canary.** Claude Code is the worst-case harness we measure against. One interface for every harness; no Claude-only dialect.

## Efficiency

A change is wrong if it does not improve at least one of:

1. **Blocked-wait** — wall-clock seconds a participant is idle waiting for a peer.
2. **Ceremony tokens** — tokens of protocol overhead before the first code edit.
3. **Benchmark** — same job, same fixture, **two cells** (solo / Crosstalk team); Crosstalk must win on the rubric, not on vibes. Solo is allowed to beat the team. That result would be a real finding — and on beacon-1 it was the finding. The GitHub arm is paused as of 2026-08-31, having done its job: it showed that an artefact-anchored channel is denser than a chat board.

## Audience

**Operator-first.** Design for one person, 2–4 agents, one repo. The repo will be public; do not grow the interface for a 12-agent fleet.

## Constraints that survive

Two runtime dependencies. No native modules. Append-only log. Order by `seq`. Windows, macOS, Linux.

## Coordination

**Board-first.** Default verbs: say, assign, done. Court tools are not on the front of the list.

**Happy-path ceremony.** One-line ack before code. Falsifier only in court. Self-critique is a short record, not an essay. The 5× flake ritual lives in docs, not in the brief.

**Team Shape.** A team's way of working, as data: the seats, and per seat its verbs, what counts as its job, what its done requires, and its brief fragment. The inbox projection, the brief composer and the Launcher all read the same record. A new shape is a new record, not a code change across seven files.

**Phase machine.** What *together* means, made checkable: Plan → Build → Verify → Repair. Each phase names who may write and what must exist to leave it. Gates are mechanical on the transitions only; inside a phase the seats are free. A prose rule agents can ignore is a no-op — beacon-1's peer brief told seats not to narrate and one posted 54 narrations.

**Contract freeze.** The shared interface is authored in Plan and read-only in Build. Moving contracts put both beacon-1 team cells' bugs in the seams: one fix landed in the renderer because the sim's owner had gone quiet-done, and `laneBearing` ended up defined twice. A seat that needs the contract changed stops and raises it.

## Seats

**Builder.** Writes code. (Today’s worker.)

**Leader.** One. Plans, assigns, owns merge order. Does not hold final acceptance if a SPOC exists.

**SPOC.** Optional. The operator’s delegate for acceptance only: accept, reject, ask for evidence. Own participant id and token. Does not write code, does not create tasks, does not merge to `main`. Must not be the same participant as the leader. Absent SPOC, the operator does that job.

**Operator.** `@human`. Can always override SPOC.

## Launcher

**Compose and spawn.** Hub picks installed CLI harnesses, assigns seats, takes the job prompt, starts processes. Not a T3 clone (no terminals, file editor, mobile remote).

**Two join modes.** Supervised = Crosstalk spawns `claude` / `codex` / `cursor-agent`. Attached = operator opens a desktop app and joins. Spawn cannot drive Claude.app or Cursor the IDE. T3 works the same way: its desktop app is a control surface over CLIs, not a puppeteer of other GUIs.

**Harness facts live in the registry.** What a harness is called is a naming convention; what it *does* is a contract, and the contract is `harnesses.yaml`. Three readers had been pattern-matching the key — `startsWith('claude-code')` to write settings, `endsWith('-live')` to decide a seat was watchable, a second hand-written binary list — so a harness named outside the convention got nothing, silently. Ask the registry: `settings`, `turnFormat`, `spawn`.

**Models are asked for, not written down.** A hand-written list goes stale in the one direction that matters: it offered `gpt-5.3-codex` to an operator whose Codex runs luna, terra and sol at 5.6, and none of it could be picked. `codex app-server` answers `model/list` with the catalogue and each model's efforts; Claude Code names its aliases in `--help`. What cannot be probed falls back to the registry, marked as such, and **every model and effort field is free text** — the contract says so, and a closed list is how a correct answer becomes unreachable.

## The mirrored terminal

**A terminal is duplex.** What it sends depends on what the application asked for, in the same escape sequences it uses to draw: application cursor keys, bracketed paste, focus events, mouse reporting. `Screen` keeps them and the key encoder reads them. Sending `ESC [ A` to an application that asked for `ESC O A` is a key that does nothing.

**An agent CLI owns its own history.** Both run on the alternate screen, so there is nothing above the top row to scroll to — in the hub or in a real terminal. The wheel is how their transcripts scroll, and it is forwarded. Scrollback is the *other* answer, for output that really did leave the screen; alt-screen frames never enter it, exactly as a real terminal drops them.

**Pushed, not polled.** The panel asked for a frame every 800ms and the browser gave it 1000 — a hidden tab has its timers clamped, and the hub tab is hidden whenever it is not frontmost. Measured: keystroke to pixel 1009ms, on a path whose POST was 2.8ms and pty echo 3.2ms. The reconstruction streams at ~3 KB/sec for the one open seat; the old objection was pricing raw pty bytes, which is a different thing.

**One ordered channel per seat.** Each keystroke used to be its own request and browsers run six at once, so fast typing arrived transposed. This is a correctness rule, not a performance one.

**A measurement must not feed what it measures.** Cell width was taken from a rendered row, so a wider terminal made wider rows made a wider cell made a wider terminal — it resized the pty continuously and killed the daemon at a 2 GB heap. Measure against a fixed gauge, and bound the result.

## Protocol

**Facade.** Agent-facing tools write today’s event kinds. **No new event kinds.** Three named contract amendments:

1. Add `spoc` and let `taskAcceptance` name that participant. Do not jam SPOC into `observer` or `@human`.
2. A `message` may carry `tag`, `head` and `task`. All optional — the log is append-only and every message written before the amendment has none, so readers fall back to clipping `body`. `head` is the message and `body` is what the head cannot carry; a message sent with only a head stores `body: head`, because every reader that predates this treats `body` as the message.
3. A `message` may carry `attachments` — `{sha, name, type, bytes}` each. Not `ref`: `ref` is single-valued, is *required* by `result`/`gate`/`plan`, and `assertedGates` scans it for `gate:<id>`, so an attachment there would displace a gate assertion or be read as one. **The record carries the hash, never the path** — a machine-local path in a log the mirror pushes to GitHub is useless to the next reader and leaks the author's directory layout; the absolute path is derived at delivery. Bytes live content-addressed at `.crosstalk/blobs/<sha[0:2]>/<sha><ext>`, with the extension from a whitelist keyed on the declared type, never from the client's filename.

**Runs.** A run is a range of the log, and its boundary is a `message` from `@crosstalk` carrying `ref: run:<id>` — the `<scheme>:<id>` convention `gate:<id>` already uses, so no new kind and no fourth amendment. The boundary **resets the projection**, it does not merely clamp reads: `#state` spans the whole log, so a read window alone would leave `/board` listing the last run's tasks and — the correctness bug rather than the display one — `assertedGates` scanning every `#floor` message for `gate:<id>` with no notion of when, marking this run's gates met from yesterday's assertions.

**A run boundary abandons open work, and this is intended.** Tasks, claims, decisions and phase progress do not cross it: a new run is a new team, and inheriting a dispute nobody present remembers raising is worse than starting clean. The events stay in the log, readable by opening the old run. Archiving moves a finished run's lines whole, in order, to `.crosstalk/runs/<id>.jsonl`; not a byte is edited or reordered, and `lastSeq` means "highest ever assigned", never "highest still in the file".

**One run at a time.** Starting a run over live seats is refused, naming them, until the operator says `end`. Ending a run **kills the seats' processes and nothing else** — no `checkout`, no `clean`, no worktree removal. Uncommitted work in a seat's tree is the operator's; `down --purge` is where discarding it is spelled out.

**Message tags.** `status` · `result` · `ask` · `answer` · `blocked` · `gate` · `plan` · `note`. Authored once in `src/core/says.ts`; the brief, the tool schema and every refusal render from that record. A shape's `SeatSpec.tags` decides which a seat has, and whether the daemon enforces the schema at all — a project with no shape writes what it always wrote.

**Sizes are never stated to the writer.** The cap read `1500` in three brief templates and twice in the `say` schema, and the median message over 1187 events was 1429 characters. Refusals name the overage — "312 characters too long" — never the budget.

**Coordination interface.** Four tools: `inbox` (compact unread + wake), `say` (board), `act` (ack / assign / done), `claim` (court).

**Delivery.** What a seat learns, as one module: everything it has not seen, within a budget. Owns truncation policy, ordering and the wake, with pull and push as adapters behind one seam. Beacon-1 delivered `clip(body, 120)` and had no `read` verb, so 5% of the strongest seat's output reached its teammates. A message now carries its full body up to a 1,500-character cap, plus an optional artifact reference for depth.

**Presence.** What a seat is doing, as overwriting state rather than appended history: one row per seat — status, current file, last verb, age. Fed by harness hooks first, by the supervised session stream later. Not an event: tool calls in the log would bury the board.

**Compose.** Hub posts the job to `#floor`. The leader’s first inbox item is that message. The leader cuts tasks. Crosstalk does not invent the task graph.

**SPOC stamps.** Accept `submitted` → `accepted`; reject to `in_progress` with a reason; ask for evidence; sit on the old human ladder rung with the operator as timeout override. SPOC does not close a court case they did not open. Operator still merges.

## Measurement

**The ledger is a projection, not a counter.** `crosstalk ledger` derives what a run cost from the log it already wrote — machine noise, median head and body, tag histogram, floor-versus-DM split, quiet tail. A counter kept during a run can be wrong, can be lost on restart, and cannot be applied to a run that already happened. Validated by independently reproducing every figure the vault run was measured by with `jq`.

**Model tokens are absent and said to be absent.** Only the harness knows them and only some say; a seat on a pty never does. A cost report that quietly omits cost is worse than one that admits what it cannot see.

## Build order

1. Delivery — the one measured defect, and the smallest change.
2. Collapse the agent-facing coordination module into Team Shape + the phase machine. Presence alongside it.
3. Benchmark (`bench/vault`), which needs 1 and 2 to be worth running.
4. Then the launcher, downstream of Team Shape; it does not gate a run.

Full plan: `docs/plans/2026-08-31-team-os-and-vault-bench.md`.

## Benchmark (partial)

Three cells, same job text, same fixture SHA, same time box:

1. Solo — one agent, no board, no GitHub coordination.
2. GitHub — three agents, PR comments only.
3. Crosstalk — three agents, board + court.

Not this repo. Not a toy `/health`.

**Job 1 — Quorum.** Throwaway monorepo: `packages/types`, `packages/api`, `packages/web`. Seed five decisions. Illegal transitions. Shared `Decision` type. Landmines: a vacuous `render()` test that already passes; a brief that says “hide resolved rows” while an acceptance line says “header shows a resolved count”; a mid-job field on the shared type.

**Fairness.** Both team cells use the same three harnesses/models. Solo is the strongest of those three. Same job text, same fixture SHA, same two-hour agent time box.

**Score.** Artifact correctness (`typecheck` / `test` / `build` / look — seed list is visible). Blocked-wait. Ceremony tokens. Operator minutes. Whether the brief contradiction was named. Vacuous-green does not count as a win.
