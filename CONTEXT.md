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

## Protocol

**Facade.** Agent-facing tools write today’s event kinds. One named contract amendment: add `spoc` and let `taskAcceptance` name that participant. No new event kinds. Do not jam SPOC into `observer` or `@human`.

**Coordination interface.** Four tools: `inbox` (compact unread + wake), `say` (board), `act` (ack / assign / done), `claim` (court).

**Delivery.** What a seat learns, as one module: everything it has not seen, within a budget. Owns truncation policy, ordering and the wake, with pull and push as adapters behind one seam. Beacon-1 delivered `clip(body, 120)` and had no `read` verb, so 5% of the strongest seat's output reached its teammates. A message now carries its full body up to a 1,500-character cap, plus an optional artifact reference for depth.

**Presence.** What a seat is doing, as overwriting state rather than appended history: one row per seat — status, current file, last verb, age. Fed by harness hooks first, by the supervised session stream later. Not an event: tool calls in the log would bury the board.

**Compose.** Hub posts the job to `#floor`. The leader’s first inbox item is that message. The leader cuts tasks. Crosstalk does not invent the task graph.

**SPOC stamps.** Accept `submitted` → `accepted`; reject to `in_progress` with a reason; ask for evidence; sit on the old human ladder rung with the operator as timeout override. SPOC does not close a court case they did not open. Operator still merges.

## Build order

1. Delivery — the one measured defect, and the smallest change.
2. Collapse the agent-facing coordination module into Team Shape + the phase machine. Presence alongside it.
3. Benchmark (`bench/cinder`), which needs 1 and 2 to be worth running.
4. Then the launcher, downstream of Team Shape; it does not gate a run.

Full plan: `docs/plans/2026-08-31-team-os-and-cinder-bench.md`.

## Benchmark (partial)

Three cells, same job text, same fixture SHA, same time box:

1. Solo — one agent, no board, no GitHub coordination.
2. GitHub — three agents, PR comments only.
3. Crosstalk — three agents, board + court.

Not this repo. Not a toy `/health`.

**Job 1 — Quorum.** Throwaway monorepo: `packages/types`, `packages/api`, `packages/web`. Seed five decisions. Illegal transitions. Shared `Decision` type. Landmines: a vacuous `render()` test that already passes; a brief that says “hide resolved rows” while an acceptance line says “header shows a resolved count”; a mid-job field on the shared type.

**Fairness.** Both team cells use the same three harnesses/models. Solo is the strongest of those three. Same job text, same fixture SHA, same two-hour agent time box.

**Score.** Artifact correctness (`typecheck` / `test` / `build` / look — seed list is visible). Blocked-wait. Ceremony tokens. Operator minutes. Whether the brief contradiction was named. Vacuous-green does not count as a win.
