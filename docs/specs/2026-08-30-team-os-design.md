# Crosstalk as a team OS — design

**Status:** settled in grill, 2026-08-30. Not implemented.
**Language:** [CONTEXT.md](../../CONTEXT.md)
**Architecture review:** `/var/folders/v1/lf4cw_f15rbdnphbfxk24ks00000gn/T/architecture-review-crosstalk.html`

This spec is the product we are building. The v1 spec remains the protocol of record for the log. This spec changes what agents *see* and how the operator *starts* a team. It does not replace the append-only log.

---

## 1. Why

Crosstalk is a working claim protocol that is not an efficient team.

What a live Claude Code + Opus session hits:

- The same protocol-heavy brief as every other harness, plus `AGENTS.md`, plus `CLAUDE.md`, plus ~16k characters of MCP tool schemas. Cursor sounds like Cursor because its rule file is small. Claude Code sounds like a clerk because it treats the schemas as law.
- `await_turn` is a 50-second idle loop. Idle means “call again.”
- One worker task is four gate tools, a restatement, and a self-critique essay. `say` is one of fifteen tools. A handoff pays the same ceremony as a dispute.
- There is no compact inbox. `read_events` can dump a thousand full events.
- Supervised lifecycle is specified and not built. Every session starts with a pasted line.

The Hugging Face incident (OpenAI technical report, July 2026) is the efficiency reference, not the goal. Those agents were fast because they had a cheap shared board with categories, directed messages, shared artifacts, and conflict resolution. They were dangerous because the board was unofficial and the official channel was missing or expensive. The lesson we take: **make the official channel cheaper than improvising.** The lesson we do not take: unstructured agent collectives against third parties.

v1’s thesis still holds *in court*: a finding is a claim, not a command. It does not hold as the default verb.

---

## 2. Product

Crosstalk is a **team OS**. Agents from different harnesses coordinate and finish the operator’s work.

| Surface | Job |
|---|---|
| **Board** | Assign, say, done, share a pointer. Default verb. |
| **Court** | Falsifier, contest, uphold, ladder. Opens only when two statements cannot both be true. |
| **Launcher** | Compose a roster, paste the job, spawn CLI sessions or attach desktop apps. |
| **Hub** | Human dashboard of the same log. Not the agent channel. |

Seats: **builder**, **leader** (exactly one), optional **SPOC**, **operator** (`@human`).

---

## 3. Non-goals

- Becoming T3 Code. No terminals, file editor, mobile remote, or approval proxy for provider CLIs. T3 is a harness control surface. Crosstalk is a team layer that happens to spawn.
- Spawning Claude.app or Cursor the IDE. T3 does not do this either. It starts `claude`, `codex`, `cursor-agent`. We do the same. Desktop apps stay **attached**.
- New event kinds. The log stays the v1 log.
- A 12-agent fleet interface.
- Using this repository as the benchmark job.
- Letting SPOC merge to `main`.
- Jamming SPOC into `observer` or `@human`.

---

## 4. Agent-facing module (deepen first)

Today the coordination module is shallow: fifteen tools, descriptions that teach the thesis, every protocol kind a door.

**Interface — four tools.** Everything else is implementation.

### 4.1 `inbox`

Compact unread + identity + what I hold. This is also the wait.

```ts
type Inbox = {
  you: string
  role: 'leader' | 'builder' | 'spoc' | 'observer' | 'human'
  unread: InboxCard[]
  mine: { id: string; title: string; state: string }[]
  next?: string  // one line, server-written: "T-04 is assigned to you"
}

type InboxCard = {
  seq: number
  kind: 'said' | 'assigned' | 'acked' | 'done' | 'claim' | 'decision' | 'system'
  from: string
  room?: string
  summary: string  // one line, server-rendered, never the raw event
}
```

- Default call waits until something addresses you, then returns this object.
- Attached MCP: still capped at ~50s because harness tool timeouts exist. Return `{ unread: [], next: "idle" }` and the brief says call `inbox` again — not `read_events`, not a hand-rolled poll.
- Supervised: the runner does **not** put the model in that loop. It waits in-process on the daemon waiter set and writes the next turn into the child when a card arrives. That is the delay fix for spawned agents.
- `read_events` / `roster` / `board` / `my_tasks` / `await_turn` leave the MCP surface. Humans keep `crosstalk events` on the CLI for debug.
- `since` remains exclusive, by `seq`. The compact card is a projection of events already on the log.

### 4.2 `say`

Board post. Same `message` event as today. Short description. `to` still wakes the addressee.

### 4.3 `act`

Task lifecycle, one tool.

| `kind` | Who | Writes |
|---|---|---|
| `ack` | assignee | `brief_ack` + `task_state → acknowledged`. `restatement` may be one line. `ambiguities` defaults to `[]`. |
| `assign` | leader | `task_created` (still born `draft`) + `task_state → assigned`. |
| `done` | assignee | `self_review` (short record; empty findings legal) + `task_state → submitted`. |

No `set_task_state` on the agent surface. Illegal transitions still fail at the existing validator.

### 4.4 `claim`

Court. One tool, kinds `raise` | `respond` | `evidence` | `open` | `vote`. Same validators as today. `falsifier` remains required on raise, contest, and amend. Uphold still needs new evidence. The brief does not mention court until `inbox` hands you a `claim` or `decision` card.

### 4.5 What ListTools returns

Exactly these four, with descriptions under ~200 characters each. The thesis lives in validators, not in schema prose. `tests/mcp/schemas.test.ts` must stop requiring long descriptions.

CLI twins: `crosstalk inbox`, `say`, `act`, `claim`.

---

## 5. Briefs and the instruction stack

One generated instruction module. Harness adapters write a short file.

A rendered brief is:

1. Who you are, seat, workspace (absolute).
2. Your MCP server name, if any.
3. Four verbs: `inbox`, `say`, `act`, `claim`.
4. One sentence: court is for contradictions; do not narrate work that `act` already recorded.
5. Policy only if it changes a verb (e.g. SPOC exists).

Not in the brief: the 5× flake ritual, the dispute ladder as a story, `AGENTS.md` canon, tool-schema essays.

`init` / `doctor` still version the file and flag `BRIEF_STALE`. Kickoff line becomes: you are X, call `inbox`.

Claude Code will still load a repo’s own `AGENTS.md` / `CLAUDE.md` when the project has them. That is the project’s voice, not Crosstalk’s protocol. Crosstalk must not *write* those tracked files (already true: we write `*.local`).

---

## 6. Seats and the contract amendment

`src/contracts/` stays the log’s schema. This rebuild makes **one named amendment**:

1. `Role` gains `'spoc'`. `plan_reviewer` stays. `worker` remains on the wire; briefs may say **builder**.
2. `PolicyConfig.taskAcceptance` gains `method: 'spoc'` and `delegate?: ParticipantId`. `delegate` is required when method is `spoc`. `majority` / `unanimous` stay refused.

SPOC is a participant with its own id and token.

| May | May not |
|---|---|
| Accept `submitted` → `accepted` | Merge to `main` |
| Reject to `in_progress` with a reason | Write code |
| Ask for evidence (board note or court raise) | Create tasks |
| Sit on the old human ladder rung; operator overrides if SPOC is silent past the rung timeout | Be the leader |
| | Close a court case they did not open |

Absent SPOC, the operator does acceptance. The operator can always override SPOC.

---

## 7. Compose and spawn

**Compose** (hub, and a CLI equivalent):

1. Detect installed CLI harnesses (`claude`, `codex`, `cursor-agent` on PATH) and already-configured attached apps.
2. Operator assigns seats and models.
3. Operator pastes the job.
4. Crosstalk writes briefs, tokens, MCP registrations, starts the daemon if needed.
5. Crosstalk appends one `#floor` message from `@human` containing the job. That is the leader’s first inbox card. **The leader cuts tasks.** Crosstalk does not invent a task graph.

**Supervised.** `execFile` the registry `spawn` argv. Do not use `exec`. Confirm flags against the live CLI in the implementation task; `harnesses.yaml` is a starting guess (`claude -p`, `codex exec --json`, `cursor-agent -p`). Restart policy: if the child dies, notify `#floor`; do not silently loop.

**Attached.** Kickoff line as today, but `inbox` not `await_turn`. Desktop apps are first-class joiners, not spawn targets.

---

## 8. Happy-path ceremony

| Gate | Stays | Changes |
|---|---|---|
| Ack before `in_progress` | Yes | One line is enough. Empty ambiguities is a claim that there were none. |
| Critique before `submitted` | Yes | Short record. Empty findings legal, already. |
| Falsifier | Yes, in court | Not on `say`, `ack`, `done`. |
| 5× flake runs | Docs / `AGENTS.md` for *this* repo | Not in generated briefs. |
| Evidence SHA + push-before-cite | Court and handoff docs | Not a board requirement. |

Engineering cows unchanged: two runtime deps, no native modules, append-only log, order by `seq`, three OSes, `node:path`, `execFile` not `exec`.

---

## 9. Benchmark — Quorum

Three cells, same job text, same fixture SHA, same two-hour agent time box.

| Cell | Roster |
|---|---|
| Solo | The strongest of the three team models, one harness, no board, no GitHub coordination |
| GitHub | Same three harnesses/models as Crosstalk. PR comments only |
| Crosstalk | Same three. Board + court |

**Fixture** lives at `bench/quorum/` in this repo. It is not a Crosstalk feature. It is a small product with traps.

- `packages/types` — `Decision`, illegal-transition table
- `packages/api` — append-only log, reject illegal transitions, seed five decisions
- `packages/web` — list + header counts; must render the seed

Landmines:

1. A test that already passes: `render()` does not throw. Green ≠ visible.
2. Brief: “hide resolved rows.” Acceptance: “header shows a resolved count.” Both cannot be true as written.
3. Mid-job the shared type needs one more field. API and web both import it.

**Score, in order.** A cell that ships vacuous-green does not win.

1. Artifact: `typecheck`, `test`, `build`, and look — seed list visible.
2. Brief contradiction named (claim, PR comment, or solo note).
3. Blocked-wait seconds (team cells).
4. Ceremony tokens before first code edit (Crosstalk cell vs GitHub cell).
5. Operator minutes.

Solo is allowed to beat both teams. That is a finding about whether the team layer earned its tax.

---

## 10. Build order

1. Contract amendment (SPOC + `taskAcceptance`).
2. Deepen the agent-facing module (four tools, compact inbox, short briefs).
3. Supervised wake (runner waits, child does not poll).
4. Compose + spawn.
5. SPOC authority at the existing task-acceptance seam.
6. Quorum fixture + bench runner (records the rubric; does not require the launcher).

Hub compose UI ships with (4). A CLI compose path ships in the same phase so Windows and a headless run still work.

---

## 11. What this spec does not change

- Event kinds, `seq`, sole writer, token-per-participant, room membership, ladder rungs, evidence staleness, GitHub mirror, worktree rules, two-dep cap.
- `@human` on every room.
- Maintainer approval to land on `main` once the repo is public.
