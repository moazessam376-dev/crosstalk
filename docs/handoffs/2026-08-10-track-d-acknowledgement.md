# Track D acknowledgement — Phase D (D1–D4)

Branch `track-d/runtime` · worktree `.crosstalk/worktrees/track-d-runtime` · base `68e5b70`

Posted before any contract or code is written, per the brief and plan §Agent Operating Protocol step 1.

---

## Restatement

I own Phase D: the runtime that makes the three merged libraries into something a person can run. Four tasks in `docs/plans/2026-08-09-crosstalk-v1.md`:

- **D1** — a loopback HTTP daemon that is the *sole writer* to `events.jsonl`, holds an advisory lock so a second daemon refuses to start, assigns `seq` through one `EventLog` instance, and authenticates every request against a per-participant bearer token.
- **D2** — SSE at `GET /stream` with `id:` set to `seq`, heartbeat comments, and gapless resume from `Last-Event-ID`; the hub's default `LogSource` moves from `fixture` to `sse` while the fixture path keeps working.
- **D3** — the twelve MCP tools of spec §6.2 over stdio, each delegating to Track A's validators, with validation failures surfacing as MCP tool *errors* rather than successful results containing an error string.
- **D4** — the tier-2 CLI twin of every tool, `init`/`down`, and a scripted end-to-end session test that runs the whole protocol and asserts no worktrees survive `down`.

**The first deliverable is not code.** It is the daemon HTTP contract — routes, request and response types, error codes, and golden request/response fixtures — posted for leader review before anything is implemented. Phase 0 froze types so three tracks could run without merge conflicts; this freezes the wire so four consumers (server, SSE client, MCP server, CLI) assert against the same examples, the way Tracks A and B both asserted against the same event logs.

The load-bearing constraint I am building around: **the daemon derives `from` from the presenting token and rejects a payload that sets it** (spec §6.1, friction-log entry 9). Under one shared token `from` is self-asserted, and everything downstream that attributes anything — the ledger, `third_agent` adjudicator selection, who owes a rebuttal — is reading fiction.

I will work in `.crosstalk/worktrees/track-d-runtime`, open a draft PR before building, treat every finding as a claim rather than an instruction, and carry `npm test`, `npm run typecheck` *and* `npm run build` in every handoff, each with the SHA it ran at, pushed before I cite it.

---

## Conflicts — two documents disagree and I want your ruling

### 1. Phase D parallelism: the brief contradicts the plan

The plan says these tasks **must not** run in parallel:

> Assigned one task at a time to whichever agent is free; these tasks touch shared ground and must not run in parallel.
> — `docs/plans/2026-08-09-crosstalk-v1.md:1275`

The brief says the opposite:

> If you decide the four tasks can run as parallel sub-agents against that frozen contract, do it — that's the shape I'd choose, and D1/D2 share a directory but never a file.
> — `docs/plans/kickoff-track-d.md:36`

**My reading:** the brief is later and states the condition under which it holds (a frozen contract), so it supersedes — but not to four-way parallelism. D2's `sse.ts` needs the daemon's route table, auth and a broadcast hook; D3's MCP server is an HTTP client of the daemon; D4's e2e test needs all three. The shape that actually parallelises is **D1 first, then D2 ∥ D3, then D4**. Four-way would have three agents writing against a server that does not exist yet, and the contract cannot substitute for a running process at test time.

**Not blocking the contract.** Blocking before I dispatch subagents — confirm or overrule.

### 2. `startDaemon` returns one token; §6.1 requires one per participant

```
Produces function startDaemon(opts: { repo: string; port?: number }):
  Promise<{ url: string; token: string; close(): Promise<void> }>
                            ^^^^^^^^^^^^^^
— plan:1281
```

> **One bearer token per participant, not one shared token**, written to `.crosstalk/tokens/<id>`.
> — spec §6.1, line 300

A single returned `token` is exactly the shape entry 9 of the friction log says makes `from` self-asserted. I do not think the plan means to undo §6.1 — it reads like the signature was written before §6.1 was amended.

**Proposed:** `Promise<{ url: string; tokens: ReadonlyMap<ParticipantId, string>; close(): Promise<void> }>`. D1's acceptance criterion "a request without the bearer token gets 401" is unaffected. This edits a published interface in your plan, so it is your call, not mine.

### 3. No error code exists for any transport-level failure

`src/contracts/errors.ts` is frozen and holds sixteen codes, all of them protocol vocabulary. None of these exist:

- `DAEMON_ALREADY_RUNNING` — required by D1's step 1 (`plan:1283`)
- an unauthorized code — required by D1's 401 criterion
- a code for "the payload tried to set `from`" — required by spec §6.1

Two ways out:

- **(a)** raise a claim against the frozen contract and add them to `ErrorCode`.
- **(b)** a separate `DaemonErrorCode` union in `src/daemon/errors.ts`, which Phase D owns, carried in the same wire envelope as `ErrorCode`.

**I recommend (b).** `ProtocolError` is the protocol's own vocabulary — the ladder, the ledger and the agent-facing error text all read it. A 401 is not a protocol event and should not become one; a participant that cannot authenticate has not made a claim about anything. But this is a contract-shape decision and you own the contracts.

### 4. `ClaimResponseError` carries no code at all

`src/core/claims.ts:147` throws a plain `Error` subclass — not `ProtocolError` — when the wrong participant responds to a claim (`validateResponseAuthority`, lines 87–136). Every other validator failure in Track A carries an `ErrorCode`. The daemon has to map this to *something* on the wire, and right now the only distinguishing feature is `error.name === 'ClaimResponseError'`, which is a string match on a class name.

This looks like a Track A gap rather than a Phase D one, so I am raising it rather than papering over it. Interim, I will map it to HTTP 409 with a daemon-namespace code and note it in the contract as provisional.

### 5. A generic `POST /events` is a validator bypass

D1 step 1 asks for `POST /events` that "appends and returns the stamped event" (`plan:1283`). But `claim_raised` carries a whole `Claim` — `id`, `state`, `rounds`, `falsifier` — and `task_state` carries a target state. A client that can post those kinds directly builds its own claim and never touches `validateRaise`, and moves a task to `submitted` without ever passing `validateTransition`. Every falsifier and gate rule in Track A becomes optional in practice, enforced only by clients choosing to be polite.

That inverts the project's own thesis: spec §4.1 puts validators *at the API boundary* rather than in prompts precisely so they cannot be forgotten.

**Proposed for the contract:** `POST /events` is not a general append.

- Protocol-bearing kinds get typed routes — `POST /claims`, `POST /claims/:id/response`, `POST /tasks/:id/state`, `POST /tasks/:id/ack`, `POST /decisions`, `POST /decisions/:id/vote` — taking the validators' own input types (`RaiseClaimInput` minus `raisedBy`, etc.) and letting the daemon construct the event. `id` assignment stays server-side, where `nextClaimId` already lives.
- `POST /events` accepts only kinds with no invariants to violate — `message` — and rejects every other `kind` with a named error.

This is the single largest decision in the contract and the one I most want you to look at.

---

## Underspecified — I will decide these in the contract unless you say otherwise

### 6. `since` is inclusive in the code and undefined in the plan

`EventLog.readFrom(seq)` returns events with `seq >= seq` (`src/core/log.ts:89`). `GET /events?since=N` (`plan:1283`) does not say which it is. SSE resume *is* defined, and it is exclusive: "replay from `Last-Event-ID + 1`" (`plan:1295`).

**I will define `since` as exclusive** — `seq > since` — so the word means one thing on both paths, and pin it with a golden fixture that would fail on an off-by-one. The daemon calls `readFrom(since + 1)`.

### 7. The hub cannot send a bearer token, so `/stream` auth cannot be a header

`useLog` opens the stream with `new EventSource(source.url)` (`src/ui/state/useLog.ts:55`). `EventSource` accepts no headers in any browser — its only option is `withCredentials`. So per-participant auth on `/stream` is a query parameter or a same-origin cookie, and nothing else.

**Proposed:** the daemon sets an `HttpOnly; SameSite=Strict; Path=/` cookie bound to `@human` when it serves the UI shell, and accepts `Authorization: Bearer` on every route for non-browser clients. A token in a query string lands in access logs, shell history and `Referer` headers; a cookie does not, and same-origin `EventSource` sends it without any UI change.

Second, smaller constraint from the same file: `useLog` handles only default-typed frames (`stream.onmessage`, line 59). `CrosstalkEvent` frames must therefore carry **no `event:` name**, and heartbeats must be `:` comment lines. That happens to match `plan:1295`; I will pin it in the contract as a requirement rather than leave it as a coincidence that a later refactor can break.

### 8. `@human` cannot be a token filename under the id rules

Spec §6.1 puts tokens at `.crosstalk/tokens/<id>`. `HUMAN_ID` is `'@human'` (`src/contracts/room.ts`), and `PARTICIPANT_ID_PATTERN` — `/^[a-z0-9][a-z0-9-]{0,23}$/` — rejects it (`src/contracts/participant.ts`).

**Proposed:** token files are named by the id with a leading `@` stripped, and `doctor` reserves the plain id `human` — otherwise a participant literally named `human` silently shares the human's token file, which is friction-log entry 9 again in a new costume. The alternative, one `tokens.json` map, contradicts the spec's wording, so I am not proposing it.

### 9. Where the golden wire fixtures live

The brief asks me for golden request/response fixtures. `tests/fixtures/**` is frozen and yours (`plan:36`, AGENTS.md rule 8).

**Proposed:** `tests/daemon/fixtures/*.json`, a path Phase D owns, with every consumer — server, SSE client, MCP server, CLI — asserting against those same files. Say the word and I will hand them to you to own under `tests/fixtures/` instead.

### 10. "An event addresses me" is not defined anywhere

`await_turn` "blocks server-side until an event addresses me" (spec §6.2, line 314). Nothing defines the predicate.

**I will define it as:** any event in a room the caller is a member of per `isMember`, excluding events the caller authored, plus any event whose `to` is the caller. A `@human` message in such a room resolves a pending wait immediately (spec §9, line 454). The wait caps at 50s regardless of the requested timeout (spec §6.2, line 329) and returns `{idle: true}`.

The "excluding events the caller authored" clause is deliberate and is friction-log entry 9's *other* lesson: a wait that returns on your own writes is a busy loop that looks like progress.

---

## Scope — three things assigned to Phase D that no Phase D task step mentions

### 11. `evidence_stale` emission

`plan:1102` and the plan's own self-review (`plan:1336`) both say Phase D turns C2's staleness descriptors into `evidence_stale` events, and the self-review names D1 specifically. D1's five steps do not mention it, and nothing states what triggers an evaluation.

**Proposed:** evaluate on daemon start and on `rebase_notice`, not on a timer. Spec §15 says "SHA ancestry check on every merge", which is the same trigger. A periodic sweep would spend `git merge-base` calls to discover nothing on a quiet repo.

### 12. The `.crosstalk/state.json` snapshot

Spec §6.1 line 305 calls for a periodic snapshot for fast restart. No D task mentions it.

**Proposed: out of scope for v1** unless you disagree. It is a pure cache that the log rebuilds, and a cache that can disagree with its source is the sort of thing that eventually lies to somebody. The log is small enough that restart cost is not yet a problem worth a second source of truth.

### 13. `crosstalk down` must not remove worktrees it did not create

D4 says `down` "removes only worktrees it created, verified against `listWorktrees`" (`plan:1315`). I want to state the failure explicitly because the hazard is live *right now in this repository*: `.crosstalk/worktrees/` currently holds `track-a-core`, `track-c-workspace` and `track-d-runtime`, none of which Crosstalk created, at least one of which has unpushed work at any given moment.

**I will implement `down` to remove only worktrees whose directory name matches a participant id in `crosstalk.yaml`**, never "everything under `.crosstalk/worktrees/`", and the e2e test will assert that a foreign worktree in that directory survives `down`. That test is the whole point — it is the one that can fail if I get it wrong.

---

## Assumptions I am proceeding under

- Two runtime dependencies stay two. The daemon is `node:http`; CLI argument parsing is `node:util.parseArgs`; no third dependency, no native module.
- The daemon binds `127.0.0.1` explicitly rather than `localhost`, which resolves to `::1` first on Windows and would leave an IPv4 client unable to connect to a server that started fine.
- `chmod 0o600` on `daemon.json` and the token files is a no-op on Windows (`docs/CROSS-PLATFORM.md` §5). The daemon does not pretend otherwise; `doctor` says so.
- `execFile`, never `exec`; `node:path` for every join; log lines stay LF on every platform.
- Anything I bind or spawn during development gets killed. No orphaned server in a shared checkout (friction-log entry 1's cousin, and the cause of an `EPERM` on someone else's `npm ci`).

## Worktree note

The harness opened this session in `.claude/worktrees/crosstalk-kickoff-track-d-032a7c`. That is not the path the brief gives and not the path AGENTS.md rule 9 requires, and `crosstalk down` would never find it. I created `.crosstalk/worktrees/track-d-runtime` on `track-d/runtime` from `main` at `68e5b70` and all Track D work is there. The harness worktree is untouched and holds no Track D work.

## Blocking status

**Nothing above blocks the contract.** Items 1–5 are your rulings to make and I want them before I implement, but I can write the contract now with my proposals in it and amend on your answer — which is cheaper than waiting, and puts something concrete in front of you to disagree with.

Next: the daemon HTTP contract, posted for review.
