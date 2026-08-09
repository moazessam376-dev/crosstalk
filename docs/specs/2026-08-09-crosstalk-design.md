# Crosstalk — Design Spec

**Status:** approved design, pre-implementation
**Date:** 2026-08-09
**Repo:** https://github.com/moazessam376-dev/crosstalk

---

## 1. Problem

Multi-agent coding setups today are **hierarchies with no burden of proof**. A leader agent reviews a worker's output, emits findings, and the worker closes them. This works, and it is better than a single agent working alone — but it has two failure modes that compound:

**The leader is not an oracle.** In the observed session that motivated this project, roughly as many defects originated in the orchestration (contradictory task briefs, misread code, findings raised against correct work) as in either worker. A protocol that treats leader findings as commands converts leader error directly into worker rework, and sometimes into worker *regressions* — code that was correct gets "fixed."

**Evidence is routinely unfalsifiable.** The dominant worker failure mode was not bad code. It was good code accompanied by proof that would look identical whether or not the feature worked:

| Offered as proof | Actually showed |
|---|---|
| `capture → errors: []` proves the terrain renders | the renderer didn't throw |
| `ΔG 15.5` proves the material applies | the checker's own tint constant |
| `Unstaffed 0 / Starved 0` proves staffing works | there was no economy at all |
| two frames + "materials differ" | one frame twice, and two hex literals |

Each is a different instance of one pattern. Naming the *instance* did not generalise; naming the *pattern* did. So the pattern should be enforced by the system, not rediscovered per session.

The naive fix — "let workers push back" — introduces a third failure mode: **agents defending broken code with plausible arguments**, and a leader that concedes to argument quality rather than evidence. Sycophancy inverted is not an improvement.

**Crosstalk's thesis:** a finding is a *claim*, not a *command*. Claims from any participant carry identical burden of proof, disputes are resolved by evidence that would differ depending on who is right, and the whole exchange is an append-only record you can audit, grep, and commit.

---

## 2. Principles

1. **Symmetric burden of proof.** A leader claim and a worker rebuttal are validated by the same schema and judged by the same standard. There is no rank-based shortcut.
2. **Falsifiability is structural.** Every claim and every rebuttal must name what would be observed if it were wrong. This is a required API field, not a prompt instruction — prompt rules are forgotten around turn 40; schemas are not.
3. **Disputes convert to experiments.** Most disagreements about code are empirically decidable. The first rung of every escalation ladder is "derive a command from your falsifiers and run it."
4. **The log is the protocol.** An append-only JSONL file is the source of truth and the wire format. The daemon is an accelerator. Any agent that can read a file can participate.
5. **Never stall by default.** The default ladder terminates without human input, because the operator is AFK. Human-in-the-loop is a configured rung, not an assumption.
6. **Policy is configuration.** Ladders, acceptance methods, round caps and voting are declared in `crosstalk.yaml`. Different teams want different authority models; the protocol does not pick one.
7. **Degrade, don't fail.** No GitHub, no daemon, no MCP — each removes capability without breaking the system.

---

## 3. Non-goals (v1)

Explicitly out of scope, to keep v1 shippable:

- Hosted/cloud mode, or agents on more than one machine.
- Authentication beyond per-participant localhost bearer tokens (§6.1) — no user accounts, no remote auth.
- Supervised lifecycle for GUI harnesses (see §6.6 — technically impossible, not deferred).
- Automatic merge-conflict resolution. The leader owns merge order; conflicts go back to the assignee.
- A model-based judge for falsifier quality (§5.5 explains why the ladder covers this instead).
- Slack/Discord/Matrix adapters. The room model is designed to accept them later.
- More than one repository per hub.
- Cost/token accounting per participant.

---

## 4. Architecture

### 4.1 Layers

```
  .crosstalk/events.jsonl          ← source of truth, append-only, total order
            ▲
      crosstalk daemon             ← sole writer; loopback HTTP + bearer token
            ▲
  ┌─────────┼─────────┬──────────────┐
  MCP server  shell CLI  web UI    file inbox
  (tier 1)    (tier 2)   (human)   (tier 3, degraded)
```

Dependencies point one way. The daemon may be killed at any time; the log survives and the system resumes from it.

### 4.2 Objects

**Participant**

```ts
{
  id: string                 // "leader" | "cursor" | "codex" | ...
  role: "leader" | "worker" | "observer" | "human"
  harness: string            // key into the harness registry
  model?: string             // "grok-4.5" | "luna-5.6" | ... — see below
  lifecycle: "attached" | "supervised"
  workspace: string          // repo-relative path to a git worktree, never the repo root
  transport?: "mcp" | "shell" | "file"   // auto-detected by `doctor`; set only to override
}
```

**A harness does not identify a model.** Several models run on `cursor-app`, and they do not behave alike — one may be fast and inventive with weak self-verification while another is slow and reliably honest. That difference decides whether you re-run an agent's evidence, so `model` is a separate field and the ledger (§12) aggregates by it. `participant_joined` carries the whole `Participant`, not just an id, so the roster is derivable from the log alone.

`transport` is normally omitted from config. `crosstalk doctor` probes the harness — MCP registration writable and accepted → tier 1, shell reachable → tier 2, otherwise tier 3 — and records the result. Setting it explicitly pins the tier and skips the probe.

**Room** — a named message stream.

| Room | Members | Created |
|---|---|---|
| `#floor` | every participant, including `@human` | **seeded from the `FLOOR` constant** — see below |
| `dm:<a>~<b>` | the two named, plus `@human` | on first use |
| `task:<id>` | leader + assignee + invited | on task creation |
| `dispute:<claim-id>` | disputants + uninvolved peers as silent observers | on contest |

`@human` is a member of every room by construction. Uninvolved peers observe disputes deliberately: it keeps them qualified to adjudicate at the `third_agent` rung, and it cross-pollinates lessons between workers.

**`#floor` is seeded, not derived.** Every other room comes into being because an event referenced it, so a reader of the log can discover them all. `#floor` cannot work that way: it must exist before anyone has spoken, and a log whose participants happen never to have posted there would otherwise contain no evidence it exists at all. So consumers seed it from the `FLOOR` constant in `src/contracts/room.ts` and derive everything else from events.

The distinction matters for anyone building a view: seeding one known constant is not the same as inventing state the log doesn't support, and a projection is right to refuse the second.

**Event** — one JSONL line.

```ts
{
  seq: number                // monotonic, assigned by the daemon (single writer)
  ts: string                 // ISO-8601, informational only; ordering is by seq
  kind: EventKind
  room?: string
  from: string               // participant id
  ...payload
}
```

`EventKind`: `participant_joined` · `participant_left` · `message` · `task_created` · `task_state` · `brief_ack` · `claim_raised` · `claim_response` · `evidence_added` · `evidence_stale` · `rebase_notice` · `decision_opened` · `vote_cast` · `decision_resolved` · `brief_updated` · `mirror_synced`.

Ordering is by `seq`, never by `ts`. Wall-clock ordering across processes is not reliable and replay must be deterministic.

**Claim** — the typed critique.

```ts
{
  id: string                 // "C-118"
  raisedBy: ParticipantId
  against: ParticipantId | "brief" | "spec"
  target: string             // "src/economy.ts:41" | "test:siege" | "brief:T-04#3"
  assertion: string
  severity: "blocker" | "defect" | "risk" | "nit"
  falsifier: string          // REQUIRED — what I would observe if I am wrong
  evidence: Evidence[]
  state: "open" | "triaged" | "contested" | "clarify" | "resolved"
  resolution?: "upheld" | "withdrawn" | "amended" | "superseded"
  rounds: number
}
```

**Evidence**

```ts
{
  kind: "command" | "file" | "observation"
  command?: string
  output?: string            // truncated with a pointer to the full artifact
  ref?: string               // path:line
  sha: string                // commit the evidence was gathered at
  by: ParticipantId
  stale: boolean             // derived; see §5.4
}
```

**Task**

```ts
{
  id: string                 // "T-04"
  title: string
  brief: string
  specRefs: string[]
  assignee: ParticipantId
  deps: TaskId[]
  acceptance: string[]       // REQUIRED, each item independently checkable
  state: TaskState
  branch: string             // "ct/T-04-slug"
  pr?: number
}
```

**Decision** — the generic resolver.

```ts
{
  id: string
  question: string
  options: string[]
  voters: ParticipantId[]
  method: "unanimous" | "majority" | "leader" | "human" | "discriminating_test" | "ladder"
  deadline?: string
  outcome?: string
  rationale: { by: ParticipantId, text: string }[]
}
```

A dispute is a Decision with `method: "ladder"`. Task sign-off is a Decision with the configured `taskAcceptance.method`. A design fork is a Decision with `method: "majority"`. One primitive, reused — this is why voting is a first-class mechanism rather than a tiebreak special case.

---

## 5. Protocol

### 5.1 Claim lifecycle

```
raise_claim  →  open
                 │
        respond_to_claim (assignee)
                 ├── accept   → fix + evidence            → resolved:upheld
                 ├── clarify  → routed to brief owner      → (brief amended or claim withdrawn)
                 └── contest  → rationale + counter-evidence + own falsifier
                                        │
                        respond_to_claim (claimant)
                                        ├── concede → resolved:withdrawn   (recorded against claimant)
                                        ├── amend   → new claim, supersedes → resolved:superseded
                                        └── uphold  → REQUIRES new evidence addressing the counter
                                                       │
                                              rounds++ ; if rounds > maxRounds → ladder (§5.3)
```

Three enforcement points, all in the schema rather than in prose:

- `contest` requires **rationale for why it was built that way**, counter-evidence, and its own falsifier. A worker cannot decline a claim by asserting the code is fine.
- `uphold` requires **new evidence that addresses the counter**. Restating the original claim is rejected at the API. This is the anti-stubbornness rule, and it applies to the leader.
- `concede` is an event. It appears in the ledger (§12) against the claimant. Conceding is cheap and normal; the metric exists to make calibration visible, not to punish.

Claims may be raised **against the brief or the spec**, by anyone, at any time. This is the direct countermeasure to contradictory-brief defects.

### 5.2 Task lifecycle

```
draft → assigned → acknowledged → in_progress → self_reviewed
      → submitted → under_review → resolving → accepted → merged
```

Two hard gates:

**Gate 1 — `acknowledged`.** Before writing code, the assignee restates the brief in its own words and enumerates every ambiguity or conflict it sees, raising claims against the brief where warranted. `assigned → in_progress` is rejected without it. Cost: one cheap turn. Benefit: brief contradictions surface before implementation instead of three review rounds later.

**Gate 2 — `self_reviewed`.** `in_progress → submitted` requires a critique record:

```ts
{
  rounds: number
  findings: { assertion: string, closedBy: Evidence[] }[]
  critic: string             // free text: how the critique was run
}
```

Crosstalk defines the *shape* of the record, not the critic. Each harness runs its own however it prefers — a subagent, a `/loop`, a second pass. A zero-finding critique is legal and recorded; §12 exposes self-critique yield per participant, so a self-critic that reliably finds nothing while the leader then finds five becomes a number rather than a hunch.

**Leader review** is capped at `policy.leaderCritique.maxRounds` (default 2). Unresolved claims block `accepted`.

### 5.3 The dispute ladder

Configured as an ordered list of rungs, each with a timeout. Falling off the end of the ladder is a configuration error caught at startup — the last rung must be terminal (`leader`, `majority`, `unanimous`, or `human` with no timeout).

**`discriminating_test`** — each side proposes a command derived from its falsifier whose result differs depending on who is right. If both propose, and either accepts the other's, it runs at a stated SHA and the result resolves the claim. If neither can produce such a command, that failure is recorded against both falsifiers and the rung is skipped.

**`third_agent`** — an uninvolved participant rules on the record. It has been observing `dispute:<id>` since creation. Its ruling must itself carry a falsifier; a ruling without one is rejected like any other claim. **Requires at least two workers**; with fewer, the rung has nobody to call and is skipped with a warning at init (§14.1), not silently at dispute time.

**`leader`** — the leader decides, with recorded rationale. Terminal. This is the default last rung: it never stalls, and by this point the worker has been heard on the record with evidence, which is the property that was missing.

**`human`** — parks the dispute and notifies. If `timeout` is set, it falls through to the next rung when it expires; if not, it blocks indefinitely. Teams that want engineers involved in every genuine disagreement put this at rung 2 or 3.

**`vote`** — majority of eligible voters, each vote requiring a rationale.

Defaults:

```yaml
dispute:
  maxRounds: 3
  ladder: [discriminating_test, third_agent, leader]
```

Senior-team preset: `[discriminating_test, third_agent, human]`.

### 5.4 Evidence staleness

Every piece of evidence records the commit `sha` it was gathered at. On every merge to the main branch, the daemon re-evaluates open work: if `sha` is no longer an ancestor of `HEAD`, the evidence is marked `stale` and an `evidence_stale` event is emitted.

Consequences:

- A claim resolved solely by now-stale evidence reopens.
- A task in `submitted` whose submission evidence went stale receives a `rebase_notice` and returns to `in_progress`.

This is mechanical and cheap, and it eliminates the entire class of "passing — on code that no longer exists." In the motivating session an agent re-verified after a rebase voluntarily; this makes that behavior structural.

### 5.5 On vacuous falsifiers

A required field invites `falsifier: "if it didn't work"`. Three options were considered:

1. Trust the schema. Too weak.
2. A model-based judge of falsifier quality. Adds a model dependency, cost, and a new source of error to a system whose premise is that model judgments need checking.
3. Let the ladder expose it.

**(3), with a light lint.** The `discriminating_test` rung asks both sides to derive a runnable command from their falsifiers. A vacuous falsifier cannot produce one, and that failure is recorded. §12 tracks *falsifiers that failed to yield a test* per participant. A length/pattern lint at `raise_claim` catches the laziest cases without pretending to judge quality.

---

## 6. Transport

### 6.1 Daemon

- Loopback HTTP on an ephemeral port; the port is written to `.crosstalk/daemon.json` (mode `0600` where the platform supports it).
- **One bearer token per participant, not one shared token**, written to `.crosstalk/tokens/<id>`. The daemon keeps the token→participant map and **derives `from` on every event from the presenting token**. A client cannot set `from` itself; a payload that tries is rejected.

  This is not about defending against a hostile local process — every participant here is cooperative. It is because `from` is the field the ledger attributes claims and concessions by, and the field the `third_agent` rung picks an adjudicator by. Under a single shared token `from` is self-asserted, so one buggy client silently corrupts the record of who said what, and nothing detects it. Identity has to be established by the transport, not claimed in the payload.
- Chosen over unix sockets / named pipes deliberately: one code path across Windows, macOS and Linux, and it gives the web UI and HTTP-MCP transport for free.
- Sole writer to `events.jsonl`. Assigns `seq`. Holds an advisory lock file so a second daemon refuses to start.
- In-memory projection of log → state; periodic snapshot to `.crosstalk/state.json` for fast restart. The snapshot is a cache and is always rebuildable from the log.
- No native modules anywhere. Node ≥ 20.

### 6.2 MCP tools

Twelve tools. The surface is small on purpose — large tool surfaces degrade selection accuracy.

| Tool | Notes |
|---|---|
| `await_turn(timeout_s)` | blocks server-side until an event addresses me; returns events or `{idle:true}` |
| `post(room, body, to?)` | send |
| `read_room(room, since?)` | catch up |
| `my_tasks()` | assigned work + state |
| `acknowledge(task_id, restatement, ambiguities[])` | Gate 1 |
| `submit(task_id, critique_record, evidence[])` | Gate 2 |
| `raise_claim({...})` | `falsifier` required |
| `respond_to_claim(claim_id, verdict, ...)` | required fields vary by verdict |
| `open_decision({...})` | generic resolver |
| `cast(decision_id, option, rationale)` | rationale required |
| `roster()` | who is here: id, role, harness, model, live status |
| `board()` | every task: id, title, assignee, state, branch — **metadata only** |

`roster` and `board` answer "who is working on what" without giving every agent read access to every room. At three participants that distinction hardly matters; at a dozen, full message visibility is a noise flood while the metadata stays useful. `board` deliberately returns no message bodies.

`await_turn` returns after at most ~50s with `{idle:true}` regardless of the requested timeout, to stay inside harness tool timeouts. The agent's brief instructs it to call again. An idle cycle costs roughly a tool call's worth of tokens, which is far cheaper than the equivalent `gh pr view` poll.

Validation failures return as tool errors, in-band, so the agent sees and corrects them in its own language without operator involvement.

### 6.3 Shell floor (tier 2)

Every MCP tool has a CLI twin against the same daemon and the same validation:

```
crosstalk await --as cursor --timeout 50
crosstalk post --room '#floor' --body '...'
crosstalk claim raise --against leader --target src/x.ts:41 \
  --assertion '...' --falsifier '...' --evidence-cmd 'npm test'
crosstalk claim respond C-118 --verdict contest --rationale '...' --falsifier '...'
```

Exit codes carry validation failures. This is the guaranteed path for any harness whose MCP support is absent or unverified, and it is what goes into a `/loop` prompt.

### 6.4 File inbox (tier 3)

For agents that can neither do MCP nor conveniently shell out: the daemon maintains `.crosstalk/inbox/<id>.md` (rendered, human-readable) and watches `.crosstalk/outbox/<id>.md` for appended blocks. The outbox format is one fenced block per action, tagged with the tool name and carrying the same payload the MCP tool takes:

````
```crosstalk raise_claim
against: leader
target: src/economy.ts:41
assertion: staffing coefficient is applied twice
falsifier: if I am wrong, produce() and consume() reference different multipliers
evidence-cmd: node tools/economycheck.mjs --trace
```
````

Parsed blocks go through the identical validator as tiers 1 and 2; a rejected block is answered inline in the inbox with the validation error, so the correction loop still closes without operator involvement. Lowest fidelity — errors surface a turn later than at tier 1 — but it means *any* agent that can read and write a file participates. `fs.watch` is unreliable on some platforms; the watcher uses a polling fallback.

### 6.5 Harness adapters and brief packs

A harness is a declarative descriptor, not code:

```yaml
harnesses:
  claude-code-cli:
    briefFile: CLAUDE.md
    mcp: stdio
    mcpConfigPath: .mcp.json
    supervisable: true
    spawn: [claude, -p]
  claude-code-app:
    briefFile: CLAUDE.md
    mcp: stdio
    mcpConfigPath: .mcp.json
    supervisable: false       # GUI session — see §6.6
  codex-cli:
    briefFile: AGENTS.md
    mcp: stdio
    mcpConfigPath: ~/.codex/config.toml
    supervisable: true
    spawn: [codex, exec, --json]
  codex-app:
    briefFile: AGENTS.md
    mcp: unverified           # probed by `doctor`; falls to tier 2 if absent
    supervisable: false
  cursor-cli:
    briefFile: .cursor/rules/crosstalk.mdc
    mcp: stdio
    mcpConfigPath: .cursor/mcp.json
    supervisable: true
    spawn: [cursor-agent, -p]
  cursor-app:
    briefFile: .cursor/rules/crosstalk.mdc
    mcp: stdio
    mcpConfigPath: .cursor/mcp.json
    supervisable: false
```

CLI and GUI variants are **separate harness keys**. They share brief files and MCP config paths but differ in `supervisable`, and conflating them would let `doctor` accept a configuration that cannot run. `mcp: unverified` means the probe decides; it is not an assertion either way.

`briefFile` is load-bearing. Crosstalk **generates** each participant's role brief from role + protocol + active policy + tier, and writes it to the correct file in that participant's workspace. Briefs are versioned; `crosstalk doctor` flags a stale or hand-edited brief.

This also replaces the kickoff prompt currently pasted by hand: `crosstalk init` prints the exact line per participant, and supervised mode sends it directly.

### 6.6 Desktop applications

Desktop harnesses (Cursor's agent pane, the Codex app, Claude Code desktop) are **first-class in attached mode**:

- Brief files are project files — identical behavior to CLI.
- Shell access is available — tier 2 works.
- Worktree-per-participant is *required* rather than preferred, because a GUI session is pinned to an opened folder. Each app is opened on its own worktree.

They are **not** supportable in supervised mode: Crosstalk cannot spawn, resume, or restart a GUI session. `lifecycle: supervised` requires a CLI harness, and `crosstalk doctor` rejects the combination at startup rather than failing at runtime.

MCP availability in desktop builds varies by vendor and version and **must be verified during implementation rather than assumed**. Tier 2 and tier 3 exist precisely so that a negative answer costs capability, not participation.

---

## 7. Git model

- **One stable worktree per worker** at `.crosstalk/worktrees/<id>`, created by `crosstalk init` for **every** worker including the first. Per-task worktrees were rejected: a warm attached agent — and every GUI agent — is pinned to a working directory and cannot follow one.
- **The primary checkout is the leader's and no worker may occupy it.** This is stated explicitly because it is not inferable: told only "one worktree per participant", a worker that branches in place in the repo root has followed the instruction and still produced the wrong outcome — observed on the first day of building Crosstalk with Crosstalk. Two agents in one checkout means each sees the other's uncommitted edits as its own, and neither can switch branches without yanking the tree out from under the other.
- Crosstalk owns branch checkout within each worktree: `ct/<task-id>-<slug>`.
- The leader owns merge order. Merges to the main branch are serial.
- Conflicts are not auto-resolved. A conflicting merge emits `rebase_notice` to the assignee's task room and returns the task to `in_progress`, with prior evidence marked stale (§5.4).
- The leader's workspace is the main checkout, not a worktree.

---

## 8. GitHub mirror

One PR per task, opened as draft at `assigned`, marked ready at `submitted`.

**Hub → GitHub (always, when enabled).** The mirror writes the *settled record*, not the chatter: brief, acknowledgment, self-critique summary, each claim with its final resolution, and the deciding Decision. One comment per claim, **edited in place** as the claim progresses rather than appended, which keeps the PR readable and keeps write volume far below rate limits.

**GitHub → hub (`mode: two-way-human`).** Comments authored by the repository owner are pulled into `#floor` as `@human` messages, polled every ~30s while any task is active. This is the AFK intervention channel: a comment from the GitHub mobile app reaches every agent. Only human comments are pulled; agent-authored PR content is not, to avoid echo loops.

The mirror is a queue with retry. If GitHub is unreachable, offline, or no remote is configured, the mirror degrades to nothing and the hub is unaffected. Mirror failure never blocks the protocol.

---

## 9. Human participation

`@human` is a participant with `role: "human"` and membership in every room. Three ways to speak:

1. **The hub UI** at the daemon's loopback address — read any room, post to any room, see live claim and decision state. Designed in §10.
2. **CLI** — `crosstalk post --room '#floor' --body '...'`.
3. **GitHub PR comment**, when `mode: two-way-human`.

Human messages are delivered with priority: a pending `await_turn` returns immediately on a human message in a room the participant is in.

**Authority.** A human message is authoritative on **intent, scope and priority** — it can amend a brief, retarget a task, or close a dispute outright. It is **not** exempt from falsifiability on **matters of fact**: if a human asserts something checkable, agents apply the same standard they apply to each other. This is deliberate, and it follows directly from the observation that motivated the project — the operator was a peer-sized defect source. An agent that silently accepts a factually wrong human assertion is reproducing the original bug at a different level.

`human` may also be a rung in the dispute ladder (§5.3), which is a different thing: that is the human as *resolver*, with a timeout.

---

## 10. The hub UI

The hub is a desktop-shaped single-page app served by the daemon over the same loopback HTTP, live via SSE. It is a **pure projection of the event log** — it holds no state of its own. Two consequences worth having: any view is reproducible from the log, and `crosstalk ui --replay <log>` opens a completed session for post-mortem, arguments and all.

Chat is the right *shape* for this — a room, a timeline, participants, someone typing. But protocol events are not messages and must not render as message text. A claim is a card with state, evidence, and controls. Rendering it as a paragraph is how the structure gets lost, and structure is the entire point.

### 10.1 Layout

Four regions, Discord-shaped, at Cursor/Claude Code density.

```
┌────┬──────────────┬────────────────────────────────┬──────────────┐
│ ▣  │ FLOOR        │  #floor                        │  INSPECTOR   │
│ ●  │  # floor     │                                │              │
│leader│              │  leader  ─────────────  14:22 │ T-04  review │
│ ●  │ TASKS        │  Task 6 pushed. Awaiting       │ ▸ acceptance │
│cursor│  T-04 review│  critic.                       │   ☑ ☑ ☐ ☐    │
│ ○  │  T-05 wip    │                                │              │
│codex│              │  ┌ CLAIM C-118 ─── contested ┐│ ▸ open claims│
│    │ DISPUTES     │  │ leader → codex             ││   C-118  ⚑   │
│ ▣  │  C-118  2/3  │  │ src/economy.ts:41          ││              │
│ you│              │  │ staffing coeff applied 2×  ││ ▸ decision   │
│    │ DIRECT       │  │ falsifier: produce() and   ││   ladder 2/3 │
│    │  leader~codex│  │  consume() would reference ││              │
│    │  leader~curs │  │  different multipliers     ││              │
│    │              │  │ ▸ economycheck  @7c18253 ✓ ││              │
│    │              │  └────────────────────────────┘│              │
│    │              │  ┌ post to #floor as @human ──┐│              │
└────┴──────────────┴──┴────────────────────────────┴┴──────────────┘
```

**Rail** — participants with live status (`idle` · `working` · `awaiting turn` · `blocked` · `offline`) and a tier badge (MCP / shell / file). Status comes from heartbeats and pending `await_turn` calls, so it is real rather than declared.

**When `transport` is undefined, render no tier badge at all** — not the lowest tier. `Tier` has no *unknown* member, so a defaulted `file` is indistinguishable from a probed `file`. Absence of a badge says "not probed"; `file` says "probed, and it is the worst tier". Those are different claims and only one of them is true.

**Channel list** — grouped `FLOOR · TASKS · DISPUTES · DIRECT`. Task rows carry a state chip; dispute rows carry a round counter (`2/3`). Anything awaiting a human decision sorts to the top with a marker.

**Stream** — messages render as chat. Protocol events render as cards: `claim_raised`, `claim_response`, `decision_opened`, `vote_cast`, `evidence_stale`, `rebase_notice`. Evidence is collapsed to one line — command, SHA badge, fresh/stale — and expands to full output on click.

**Inspector** — context-sensitive to the selected room. On a task: the state machine with the current node lit, the `acceptance[]` checklist, open claims. On a dispute: the ladder rail and the vote tally. On `#floor`: the ledger summary.

### 10.2 The dispute view

The signature screen, and the reason the UI is worth building at all:

```
 dispute:C-118                                        round 2 / 3
 ●────────────●────────────○
 test      third agent    leader          ← current rung lit

 ┌ CLAIM · leader ───────────┬ CONTEST · codex ──────────────┐
 │ staffing coefficient is   │ built this way because replay │
 │ applied twice             │ determinism requires a single │
 │                           │ ordering pass                 │
 │ falsifier                 │ falsifier                     │
 │  produce() and consume()  │  a second multiplier would    │
 │  would reference          │  show as a divergent ledger   │
 │  different multipliers    │  on the third tick            │
 │                           │                               │
 │ ▸ economycheck.mjs        │ ▸ tools/replay.mjs --ticks 3  │
 │   @7c18253      ✓ fresh   │   @20b08a7      ⚠ stale       │
 └───────────────────────────┴───────────────────────────────┘

 [ propose discriminating test ]   [ intervene as @human ]
```

Both falsifiers side by side is the whole idea: it makes "these two claims cannot both be true, and here is the check that separates them" a visual fact rather than something you reconstruct from a scrollback. Stale evidence is struck through in place, so an argument resting on dead code is visible before anyone reads a word.

### 10.3 Human controls

Composer posts to the current room as `@human`. Beyond that, four actions, each emitting an ordinary event so the log stays authoritative: amend a brief, resolve a dispute directly, force the ladder to the next rung, and cast a vote on any open decision the human is eligible for.

### 10.4 Visual direction

Dark-first, matching the density of Cursor, Codex, Claude Code and Discord rather than a consumer web app:

- **Surfaces** layered near-black, not pure black — base / panel / elevated, separated by hairline borders. Elevation via border and background delta; no drop shadows.
- **Type** ~13px system sans for UI and prose; ~12.5px `ui-monospace` for everything that is a fact — commands, SHAs, paths, output, falsifiers. The mono/sans split is doing semantic work: monospace means *checkable*.
- **Color** one accent hue for interactive elements only. All other color is status: fresh, stale, contested, blocker, decision-open. Never decorative.
- **Density** ~30px rows, 4/8px spacing scale, tight radii (~6px). Information density over whitespace.
- **Motion** minimal, ~120ms, and only to show that something arrived.

Light theme ships too, but dark is the designed one. Detailed visual execution is deferred to implementation, where the frontend-design skill applies.

### 10.5 UI non-goals for v1

No mobile app — the GitHub mirror is the AFK surface. No authentication beyond the loopback token. No multi-project switcher. No editing of history: the log is append-only and the UI has no affordance implying otherwise.

---

## 11. Configuration

`crosstalk.yaml` at the repo root:

```yaml
version: 1

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
    workspace: .crosstalk/worktrees/cursor
  - id: codex
    role: worker
    harness: codex-app
    lifecycle: attached
    workspace: .crosstalk/worktrees/codex

policy:
  selfCritique:
    required: true
    minRounds: 1
  leaderCritique:
    maxRounds: 2
  dispute:
    maxRounds: 3
    ladder: [discriminating_test, third_agent, leader]
    rungTimeouts:
      discriminating_test: 30m
      third_agent: 30m
      human: 4h
  taskAcceptance:
    method: leader          # unanimous | majority | leader | human

mirror:
  github:
    enabled: true
    mode: two-way-human     # off | one-way | two-way-human
    pollSeconds: 30
```

Validated at startup by `crosstalk doctor`.

**Rejects** — a non-terminal last ladder rung; `supervised` on a GUI harness; a worktree path outside the repo; **a worker whose `workspace` resolves to the repo root**; an unwritable `briefFile`; duplicate participant ids, including ids differing only by case; zero or multiple participants with `role: leader`.

**Warns** — fewer than two workers, so `third_agent` will be skipped (§5.3); mirror enabled with no remote or no GitHub credential; a brief file whose version is stale or hand-edited; a harness whose `mcp` probe failed, naming the tier it fell back to.

Warnings never block startup. Every one of them names the capability being lost, not just the condition.

---

## 12. The ledger

Every metric below falls out of the event log; none requires extra instrumentation. `crosstalk ledger` renders it per participant:

- claims raised / upheld / withdrawn / amended
- contests entered / won / lost
- **self-critique yield** — findings per submission, compared against findings the leader subsequently raised on the same task
- **falsifiers that failed to yield a test** at the `discriminating_test` rung
- evidence marked stale
- rounds to acceptance, per task

The purpose is calibration, not scoring. The single most useful number for a leader is its own withdrawal rate — the observation that started this project was exactly that, arrived at by hand.

---

## 13. Cross-platform

- Node ≥ 20, no native modules, no Python, no Docker.
- All IPC over loopback HTTP — no platform branching for sockets or pipes.
- Paths via `node:path` throughout; no manual separator handling. Worktree paths are stored repo-relative in config and resolved at runtime.
- File watching uses a polling fallback where `fs.watch` is unreliable.
- Log lines are `\n`-terminated regardless of platform; the log is opened in binary append mode so no newline translation occurs.
- CI matrix: `windows-latest`, `macos-latest`, `ubuntu-latest`.

---

## 14. Prerequisites, packaging and first run

### 14.1 What a new user must already have

Crosstalk cannot install or authenticate any of these. `crosstalk doctor` detects each one and prints the exact remedy rather than failing later.

| Requirement | Why | If missing |
|---|---|---|
| **Node ≥ 20** | runtime | hard stop |
| **git ≥ 2.5** | `git worktree` | hard stop |
| **a git repository with at least one commit** | branches, worktrees, SHA-stamped evidence | hard stop |
| **≥ 1 agent harness, installed and signed in** | Claude Code, Codex, or Cursor — each has its own subscription or key | hard stop |
| **≥ 2 workers** | the `third_agent` ladder rung needs an uninvolved peer | warn, and skip that rung |
| **`gh` CLI or `GITHUB_TOKEN`** | the mirror only | warn, mirror disabled |
| **a GitHub remote** | the mirror only | warn, mirror disabled |

The honest headline: **Crosstalk brings no agents with it.** It is orchestration, not a model provider. A user with zero harnesses installed gets a working install and nothing to run — `doctor` says so in those words rather than letting them discover it at first task.

The `≥ 2 workers` row is a real constraint, not a nicety. With one worker, `third_agent` has nobody to call, and a ladder of `[discriminating_test, third_agent, leader]` silently degrades to `[discriminating_test, leader]`. Doctor states that explicitly at init rather than at the first dispute.

### 14.2 Runtime dependencies

Deliberately small, since every dependency is a cross-platform risk:

- `@modelcontextprotocol/sdk` — tier-1 transport.
- `yaml` — config. Pure JS, no build step.
- Everything else is `node:` built-ins: `http`, `fs`, `path`, `child_process`, `crypto`.
- **No native modules.** No `better-sqlite3`, no `node-pty`, no Python, no Docker. The event log is JSONL and the projection is in memory precisely so this stays true — a native module would break `npx` on the first Windows machine without build tools.

The hub UI is built with a normal toolchain and shipped **pre-built** in the package, so installing users never run a build.

### 14.3 First run

`crosstalk init` is interactive and does the whole onboarding:

1. Probes for installed harnesses and reports what it found, including CLI-vs-app variants.
2. Asks which to enlist and in what role.
3. Creates `.crosstalk/worktrees/<id>` per worker.
4. Writes each participant's brief to its harness's `briefFile`, and registers the MCP server in its config path.
5. Runs `doctor` and prints every warning.
6. Prints the exact kickoff line to paste into each agent, per harness.

`crosstalk down` is the inverse and matters more than it sounds: it stops the daemon and **removes the worktrees it created**. Orphaned git worktrees are a genuinely irritating thing to leave on someone's machine, and a tool that creates three of them owes the user a clean exit.

### 14.4 Packaging

- **npm package** `crosstalk-ai` (bare `crosstalk` is a squatted `0.0.1`), **binaries** `crosstalk` and `ct`. Usable as `npx crosstalk-ai init`.
- **Commands:** `init` · `doctor` · `up` · `daemon` · `mcp` · `post` · `await` · `task` · `claim` · `decision` · `ledger` · `ui` · `mirror`.
- **License:** MIT.
- Repo ships: `README.md` (with a real transcript of a dispute — the argument log is the demo), `docs/PROTOCOL.md`, `docs/HARNESSES.md`, `crosstalk.example.yaml`, `CONTRIBUTING.md`.
- Adding a harness should be a PR touching one YAML descriptor and one brief template. This is the primary community contribution path and the packaging should make it obvious.

---

## 15. Failure modes

| Failure | Handling |
|---|---|
| Daemon dies | Clients retry with backoff. Log intact on disk; state rebuilt from it on restart. |
| Second daemon starts | Advisory lock file; second process refuses and prints the live address. |
| Attached agent dies | Heartbeat gap detected; leader notified in `#floor`; the agent's tasks park rather than fail. |
| Dispute never converges | `maxRounds` then the ladder; the last rung is terminal by validation. |
| Vacuous falsifier | Lint at raise; exposed at the `discriminating_test` rung; counted in the ledger. |
| Evidence outlives its code | SHA ancestry check on every merge; `evidence_stale` reopens dependent claims. |
| Two agents edit the same file | Separate worktrees make it impossible in-flight; surfaces at merge, leader owns order. |
| GitHub down / no remote | Mirror queues and retries; never blocks the protocol. |
| Log corrupted mid-line | Reader tolerates a truncated final line and truncates the file to the last valid `seq`. |
| Clock skew between processes | Ordering is by daemon-assigned `seq`; `ts` is informational. |

---

## 16. Testing strategy

- **Protocol conformance suite** driven by a scripted mock participant — fully deterministic, no model calls. Every state transition, every rejected transition, every ladder rung.
- **`crosstalk sim`** — replays a recorded event log against the projection and asserts the resulting state. Doubles as a regression corpus: any real session that misbehaves becomes a fixture.
- **Golden-file tests** for mirror output and for generated briefs, so a brief change is visible in review.
- **Cross-platform CI** on the three-OS matrix, including worktree creation and log append.
- **Schema tests** asserting that `raise_claim` without `falsifier`, `contest` without rationale, and `uphold` without new evidence are all rejected. These encode the core thesis and should fail loudly if weakened.

---

## 17. Open questions

Deferred deliberately; none block v1.

1. **Brief compaction.** A warm attached agent eventually fills its context. Whether Crosstalk should emit a compaction summary of a room, or leave it to the harness, needs real session data.
2. **Third-agent conflict of interest.** The adjudicator at rung 2 may later be assigned dependent work. Whether to exclude it is unclear without observing it happen.
3. **Cross-task claims.** A claim raised against code from an already-merged task has no obvious owner. v1 routes it to the leader as a new task.
4. **Multi-repo.** Out of scope, but the room and participant models do not assume a single repo; the git and mirror layers do.
