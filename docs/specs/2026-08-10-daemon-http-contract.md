# Daemon HTTP contract — v1

Phase D's Phase 0. Freezing types before three tracks started produced zero interface churn across ~50 commits; this does the same one level up, so the four Phase D consumers — the server, the SSE client in the hub, the MCP server and the CLI — assert against the same wire examples rather than against each other's implementations.

**Status:** proposed, not frozen. Awaiting leader review.
**Consumes (frozen):** `src/contracts/**`, `src/core/**`, `src/workspace/**`.
**Produces:** this document, `src/daemon/contract.ts` (types + status map), `tests/daemon/fixtures/**` (golden wire examples).

Spec references: §6.1 daemon, §6.2 MCP tools, §6.3 shell floor, §9 human participation, §10 hub UI, §15 failure modes.

---

## 1. The rule the rest of the contract is built around

> The daemon keeps the token→participant map and **derives `from` on every event from the presenting token**. A client cannot set `from` itself; a payload that tries is rejected.
> — spec §6.1

Two consequences run through every route below:

1. **No request body ever contains `from`, `raisedBy`, `by`, or any other author field.** The daemon injects it. A body carrying one is rejected with `403 FROM_NOT_ALLOWED` — rejected, not ignored, because silently dropping it would let a client believe it had spoken as someone else.
2. **The daemon constructs every event.** Clients send the *inputs* a validator takes, never an assembled `CrosstalkEvent`. See §4.

---

## 2. Process, files and lifecycle

| Concern | Contract |
|---|---|
| Bind address | `127.0.0.1` explicitly — never `localhost`, which resolves to `::1` first on Windows and leaves an IPv4 client unable to reach a server that started fine |
| Port | `0` (ephemeral) unless `opts.port` is given |
| Discovery | `.crosstalk/daemon.json`, mode `0o600` where supported |
| Lock | `.crosstalk/daemon.lock` via `fs.open(path, 'wx')`, contents = pid; a lock whose pid is gone is reclaimed |
| Tokens | one file per participant under `.crosstalk/tokens/`, mode `0o600` where supported |
| Shutdown | `SIGINT`, `SIGTERM`, **and** `POST /shutdown` — CROSS-PLATFORM §3: `SIGTERM` is not delivered on Windows the way it is elsewhere, so the daemon must not rely on a signal arriving at all |

`.crosstalk/daemon.json`:

```json
{ "version": 1, "url": "http://127.0.0.1:53411", "pid": 24188, "startedAt": "2026-08-10T09:14:02.113Z" }
```

It carries no token. Tokens are per participant and live in their own files.

`chmod 0o600` is a no-op on Windows (CROSS-PLATFORM §5). The daemon does not pretend otherwise and `doctor` says so; claiming a permission we do not have is worse than not having it.

### 2.1 `startDaemon`

```ts
export interface DaemonHandle {
  url: string;
  /** One per participant — spec §6.1. Never a single shared token. */
  tokens: ReadonlyMap<ParticipantId, string>;
  close(): Promise<void>;
}

export function startDaemon(opts: { repo: string; port?: number }): Promise<DaemonHandle>;
```

**Deviation from `plan:1281`, flagged for ruling.** The plan's signature returns `token: string`. A single token is the shape friction-log entry 9 identifies as making `from` self-asserted, so I read the plan's signature as predating the §6.1 amendment rather than overruling it. D1's acceptance criterion — a request without the bearer token gets 401 — holds either way.

A second `startDaemon` against the same repo rejects with a `DaemonError` carrying `code: 'DAEMON_ALREADY_RUNNING'` and `url` set to the live daemon's address, read from `daemon.json` (spec §15: "second process refuses and prints the live address").

### 2.2 Joining

The daemon appends `participant_joined` the first time a participant authenticates within a daemon lifetime, taking the whole `Participant` from `crosstalk.yaml`. On clean shutdown it appends `participant_left` for each participant that joined.

Clients never post either kind. Membership is configuration the daemon reads, not a claim a client makes — the same reasoning as `from`.

---

## 3. Authentication

| Client | Credential |
|---|---|
| MCP server, CLI, any non-browser client | `Authorization: Bearer <token>` |
| The hub UI | `ct_token` cookie — `HttpOnly; SameSite=Strict; Path=/`, set by the daemon when it serves the UI shell |

**Why a cookie, and why this is not a preference.** The hub opens its stream with `new EventSource(source.url)` (`src/ui/state/useLog.ts:55`). `EventSource` takes no headers in any browser — its only option is `withCredentials`. So per-participant auth on `/stream` is a cookie or a query parameter, and nothing else. A token in a query string lands in access logs, shell history and `Referer`; a same-origin cookie does not, and it needs no change to `useLog`.

The cookie authenticates `@human` only. A bearer token in the `Authorization` header always wins over a cookie, so a CLI run from a browser-adjacent context cannot be silently re-identified.

Every route requires authentication except `GET /health` and the static UI shell. Unknown or missing credential → `401 UNAUTHENTICATED`. The response carries no hint about which tokens exist.

---

## 4. Write routes

**`POST /events` is not a general append.** This is the largest decision in the contract and the one most worth disagreeing with.

`plan:1283` asks for `POST /events` that "appends and returns the stamped event". Taken literally that is a hole straight through Track A: `claim_raised` carries a whole `Claim` — `id`, `state`, `rounds`, `falsifier` — so a client posting that kind builds its own claim and never reaches `validateRaise`; `task_state` posted directly never reaches `validateTransition`. Every falsifier rule and both task gates would be enforced only by clients choosing to be polite, which inverts spec §4.1's reason for putting validators at the API boundary instead of in prompts.

So:

- **`POST /events` accepts `kind: "message"` and nothing else.** `message` carries no invariant a validator defends. Any other `kind` → `422 EVENT_KIND_NOT_APPENDABLE` naming the route that owns it.
- **Every protocol-bearing kind gets a typed route** taking the validator's own input type, minus author fields. The daemon assembles the event. Id assignment stays server-side where `nextClaimId` already lives.

### 4.1 Route table

Every write route returns `{ "events": CrosstalkEvent[] }` — see §4.2.

| Route | Body | Validator | Events appended |
|---|---|---|---|
| `POST /events` | `{ kind: "message", room, body, to? }` | membership | `message` |
| `POST /claims` | `RaiseClaimInput` − `raisedBy` | `validateRaise` | `claim_raised` |
| `POST /claims/:id/response` | `ClaimResponseInput` − `claimId`,`from` | `validateResponse` | `claim_response` |
| `POST /claims/:id/evidence` | `Evidence` − `by` | claim exists | `evidence_added` |
| `POST /tasks` | `Task` − `state` (leader only) | id unused | `task_created` |
| `POST /tasks/:id/ack` | `Acknowledgement` | assignee only | `brief_ack` [+ `task_state`] |
| `POST /tasks/:id/submit` | `{ critique, evidence[] }` | `validateTransition` | **blocked — see §7** |
| `POST /tasks/:id/state` | `{ state, reason? }` | `validateTransition` | `task_state` |
| `POST /decisions` | `Decision` − `id`,`votes`,`outcome` | `validateLadder` | `decision_opened` |
| `POST /decisions/:id/vote` | `{ option, rationale }` | eligibility + rationale | `vote_cast` [+ `decision_resolved`] |
| `POST /shutdown` | — (leader or `@human`) | — | `participant_left` × n |

`Evidence.by` and `Claim.raisedBy` are author fields and are injected, not accepted — same rule as `from`.

### 4.2 Why every write returns a list

Three routes legitimately produce more than one event in one request, and each is a single tool call at tier 1:

- `POST /tasks/:id/ack` appends `brief_ack`, then — if `canTransition(current, 'acknowledged')` — a `task_state` to `acknowledged`. Gate 1 exists to make acknowledgement precede work; making the caller issue two requests to satisfy it invites the second to be skipped.
- `POST /decisions/:id/vote` appends `vote_cast`, then `decision_resolved` when `tally()` returns non-null.
- `POST /shutdown` appends one `participant_left` per joined participant.

A uniform `{ events: [...] }` is simpler than a shape that is sometimes an object and sometimes a list. **This generalises `plan:1283`'s "returns the stamped event"** — flagged rather than assumed.

### 4.3 Status codes on success

`201 Created` for routes that append; `200 OK` for reads; `204` for `POST /shutdown` after the log is flushed.

---

## 5. Read routes

| Route | Returns |
|---|---|
| `GET /health` | `{ ok: true, version: 1, pid }` — the only unauthenticated route; carries no log data |
| `GET /events?since=&limit=` | `{ events, lastSeq }` |
| `GET /stream` | SSE, §6 |
| `GET /rooms/:roomId/events?since=` | `{ events, lastSeq }`, filtered to the room; `403 NOT_A_ROOM_MEMBER` if `isMember` is false |
| `GET /roster` | `{ participants: [{ id, role, harness, model?, transport?, status }] }` |
| `GET /board` | `{ tasks: [{ id, title, assignee, state, branch, pr? }] }` |
| `GET /tasks/mine` | `{ tasks: Task[] }` for the authenticated participant |
| `GET /await?timeout_s=` | long poll, §5.3 |

### 5.1 `since` is exclusive

`EventLog.readFrom(seq)` is inclusive — it returns `seq >= seq` (`src/core/log.ts:89`). `GET /events?since=N` does not say which it is, and SSE resume *is* defined and is exclusive: "replay from `Last-Event-ID + 1`" (`plan:1295`).

**`since` is exclusive everywhere: the response contains events with `seq > since`.** `since=0` (the default) returns the whole log. The daemon calls `readFrom(since + 1)`. One word, one meaning, on both paths — and a golden fixture pins it, so an implementation that gets it backwards fails rather than double-delivering one event on every reconnect.

`limit` defaults to 1000 and is capped at 1000. When a response is truncated, `lastSeq` is the seq of the last event *in the response*, not the log's tail, so a client paging forward with `since=lastSeq` cannot skip a gap.

### 5.2 Room ids must be percent-encoded

Room ids contain `#`, `:` and `~`. `#floor` in a URL path is an empty path plus a fragment — the `#` never reaches the server. **Clients percent-encode the room id**: `GET /rooms/%23floor/events`, `GET /rooms/dispute%3AC-118/events`. A golden fixture covers `%23floor`, because this fails silently rather than loudly.

### 5.3 `GET /await` — what "an event addresses me" means

Spec §6.2 says `await_turn` "blocks server-side until an event addresses me" and never defines the predicate. This contract defines it:

An event addresses participant `P` when **either**:
- `event.room` is a room `P` is a member of per `isMember(P, room, state)`, **and** `event.from !== P`; or
- `event.to === P`.

Rules:
- A `message` from `@human` in such a room resolves a pending wait **immediately**, ahead of any other pending work (spec §9, line 454).
- The wait returns after at most **50 s** regardless of the requested `timeout_s` (spec §6.2, line 329), with `{ "idle": true }`.
- Otherwise it returns `{ "events": [...] }` — every addressing event since the caller's last delivered seq, not just the one that woke it.
- `Cache-Control: no-store`.

The `event.from !== P` clause is deliberate: a wait that returns on the caller's own writes is a busy loop that looks like progress. That is friction-log entry 9's other lesson — a predicate that cannot distinguish participants produces an agent that polls forever and learns nothing.

### 5.4 `board` returns metadata only

Spec §6.2: `board` "deliberately returns no message bodies". The fixture for `/board` asserts that no `body` key appears anywhere in the response, so a future change that widens the projection fails a test rather than quietly turning `board` into a firehose at a dozen participants.

`status` on `/roster` is derived, never declared: `awaiting_turn` when the participant has a pending `GET /await`, otherwise from its most recent event. There is no heartbeat route in v1 — see §7.

---

## 6. SSE

```
GET /stream
Accept: text/event-stream
```

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-store`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

Frame format — one event per frame, **default event type, no `event:` line**:

```
id: 42
data: {"seq":42,"ts":"2026-08-10T09:14:07.402Z","kind":"message","from":"leader","room":"#floor","body":"pushed"}

```

Heartbeat every 15 s, as a comment line that `EventSource` ignores:

```
:hb

```

**The no-`event:`-line rule is load-bearing, not stylistic.** `useLog` subscribes with `stream.onmessage` (`src/ui/state/useLog.ts:59`), which fires only for frames with no `event:` name. A named frame would leave the hub connected, silent, and showing `connected` — friction-log entry 7's failure shape exactly: green everywhere, blank screen.

**Resume.** On reconnect the browser sends `Last-Event-ID`. Precedence: `Last-Event-ID` header, then `?since=`, then 0. Both are exclusive, so a client that saw seq 42 receives 43 next and no gap and no duplicate. A golden fixture pins the first frame after a resume at `Last-Event-ID: 3`.

**Auth**: cookie (hub) or bearer (everything else), as §3.

---

## 7. Deferred, with reasons

| Item | Decision |
|---|---|
| `.crosstalk/state.json` snapshot (spec §6.1) | **Out of v1.** A pure cache the log rebuilds. A cache that can disagree with its source eventually lies to somebody, and restart cost is not yet a problem worth a second source of truth. |
| Heartbeat route (implied by spec §10.1's "status comes from heartbeats") | **Out of v1.** `status` derives from a pending `GET /await` plus last-event time. Where that is not enough the badge says nothing rather than guessing — spec §10.1 line 495 already makes that argument for the tier badge. |
| `evidence_stale` emission (`plan:1102`, `plan:1336`) | **In D1**, triggered on daemon start and on `rebase_notice`, not on a timer. Spec §15 says "SHA ancestry check on every merge"; a periodic sweep spends `git merge-base` calls to discover nothing on a quiet repo. |
| `POST /tasks/:id/submit` | **Blocked** on claim CT-D-1 — the log has no event that can carry a `CritiqueRecord`, so gate 2 is unsatisfiable through the daemon. Full statement and evidence on the PR. The route is specified above and cannot be implemented until the contract gains a kind that sets `Task.critique`. |

---

## 8. Errors

One envelope, two namespaces. This avoids editing frozen `src/contracts/errors.ts` while keeping every failure machine-readable:

```json
{ "error": { "domain": "protocol", "code": "MISSING_FALSIFIER", "message": "claim requires a falsifier" } }
```

`domain: "protocol"` → `code` is an `ErrorCode` from the frozen contract. `domain: "daemon"` → `code` is a `DaemonErrorCode`, defined in `src/daemon/contract.ts`, which Phase D owns.

`ProtocolError` is the protocol's own vocabulary — the ladder, the ledger and the agent-facing error text all read it. A 401 is not a protocol event: a participant that cannot authenticate has not made a claim about anything. Alternative (a) from the acknowledgement — adding transport codes to the frozen `ErrorCode` — remains open if you prefer it.

### 8.1 Protocol codes → HTTP status

The rule: **422 means the payload is not acceptable; 409 means the payload is fine and the world is not in a state that permits it.**

| `ErrorCode` | Status |
|---|---|
| `MISSING_FALSIFIER`, `VACUOUS_FALSIFIER` | 422 |
| `CONTEST_WITHOUT_RATIONALE`, `CONTEST_WITHOUT_COUNTER_EVIDENCE` | 422 |
| `UPHOLD_WITHOUT_NEW_EVIDENCE` | 422 |
| `NON_TERMINAL_LADDER`, `VOTE_WITHOUT_RATIONALE` | 422 |
| `GATE_NOT_ACKNOWLEDGED`, `GATE_NOT_SELF_REVIEWED` | 409 |
| `ILLEGAL_TRANSITION`, `UNRESOLVED_CLAIMS` | 409 |
| `NOT_ELIGIBLE_VOTER` | 403 |
| `UNKNOWN_CLAIM`, `UNKNOWN_TASK`, `UNKNOWN_DECISION`, `UNKNOWN_PARTICIPANT` | 404 |

The map is one exported `Record<ErrorCode, number>`, and **a test asserts it is total over `ErrorCode`**. A code added to the frozen contract without a status then fails typecheck rather than falling through to 500 in production.

### 8.2 Daemon codes

| `DaemonErrorCode` | Status | Raised when |
|---|---|---|
| `MALFORMED_BODY` | 400 | unparseable JSON or a missing required field |
| `UNAUTHENTICATED` | 401 | absent or unknown credential |
| `FROM_NOT_ALLOWED` | 403 | body carried `from`, `raisedBy` or `by` |
| `NOT_A_ROOM_MEMBER` | 403 | read or post to a room `isMember` denies |
| `ROLE_NOT_PERMITTED` | 403 | non-leader on a leader-only route |
| `UNKNOWN_ROUTE` | 404 | no route matched |
| `CLAIM_RESPONSE_NOT_AUTHORIZED` | 409 | `ClaimResponseError` — **provisional**, §8.3 |
| `DAEMON_ALREADY_RUNNING` | 409 | lock held by a live pid; carries `url` |
| `PAYLOAD_TOO_LARGE` | 413 | body over 1 MiB |
| `EVENT_KIND_NOT_APPENDABLE` | 422 | `POST /events` with a kind other than `message` |

### 8.3 One provisional mapping

`src/core/claims.ts:147` throws `ClaimResponseError`, a plain `Error` subclass with no `ErrorCode`, when the wrong participant responds to a claim (`validateResponseAuthority`, lines 87–136). Every other Track A refusal carries a code. The daemon's only way to recognise it is `error.name === 'ClaimResponseError'` — a string match on a class name, which survives no refactor.

Mapped to `409 CLAIM_RESPONSE_NOT_AUTHORIZED` in the daemon namespace, flagged as provisional. It looks like a Track A gap rather than a Phase D one.

### 8.4 Consumers

**MCP (D3).** Any non-2xx becomes an MCP tool **error** — never a successful result containing an error string — with message `"<CODE>: <message>"`. D3's criterion, that an empty `falsifier` returns an error naming `MISSING_FALSIFIER`, falls out of the mapping rather than being special-cased.

**CLI (D4).** Exit codes carry the failure (spec §6.3):

| Exit | Meaning |
|---|---|
| 0 | success |
| 1 | protocol refusal (422, 409) |
| 2 | usage error (400, 404) |
| 3 | authentication or authorisation (401, 403) |
| 4 | daemon unreachable, or already running |

---

## 9. The twelve MCP tools map onto this surface

Completeness check: every tool in spec §6.2 has a route, and no route exists only to serve a tool that does not exist.

| Tool | Route |
|---|---|
| `await_turn(timeout_s)` | `GET /await?timeout_s=` |
| `post(room, body, to?)` | `POST /events` |
| `read_room(room, since?)` | `GET /rooms/:roomId/events?since=` |
| `my_tasks()` | `GET /tasks/mine` |
| `acknowledge(task_id, …)` | `POST /tasks/:id/ack` |
| `submit(task_id, …)` | `POST /tasks/:id/submit` — blocked, §7 |
| `raise_claim({…})` | `POST /claims` |
| `respond_to_claim(claim_id, …)` | `POST /claims/:id/response` |
| `open_decision({…})` | `POST /decisions` |
| `cast(decision_id, …)` | `POST /decisions/:id/vote` |
| `roster()` | `GET /roster` |
| `board()` | `GET /board` |

The remaining routes — `/health`, `/events`, `/stream`, `/claims/:id/evidence`, `/tasks/:id/state`, `/shutdown` — serve the hub and the CLI, which have surface the twelve tools deliberately do not.

---

## 10. Golden fixtures

`tests/daemon/fixtures/`, one JSON file per case:

```json
{
  "name": "since is exclusive",
  "request": { "method": "GET", "path": "/events?since=2", "headers": { "authorization": "Bearer <leader>" } },
  "response": { "status": 200, "body": { "events": ["<seq 3>", "<seq 4>"], "lastSeq": 4 } }
}
```

`tests/fixtures/**` is frozen and leader-owned (`plan:36`, AGENTS.md rule 8), so these live under a path Phase D owns. Move them if you would rather own them.

The server, the MCP server, the CLI and the hub's SSE client all assert against these same files — the same discipline that had Tracks A and B asserting against one pair of event logs.

Every fixture below was chosen because it can fail. Listed with what a broken implementation would produce:

| Fixture | Fails if |
|---|---|
| `append-message` | happy path breaks |
| `reject-from-in-payload` | a client can set `from` — returns 201 instead of 403 |
| `reject-non-message-kind` | `POST /events` accepts `claim_raised`, i.e. `validateRaise` is bypassable |
| `unauthenticated` | a request with no credential is served |
| `events-since-exclusive` | `since` is inclusive — seq 2 appears in a `since=2` response |
| `raise-claim-missing-falsifier` | an empty falsifier is accepted, or is refused with the wrong code |
| `raise-claim-assigns-id-and-author` | the client's `id` or `raisedBy` survives into the event |
| `room-events-encoded` | `%23floor` is not decoded, or a non-member is served |
| `board-metadata-only` | any `body` key appears in `/board` output |
| `await-idle` | the long poll returns something other than `{idle:true}` at the cap |
| `stream-frames` (raw bytes) | a frame gains an `event:` line, or `id:` is not `seq` |
| `stream-resume` | a resume from `Last-Event-ID: 3` starts at 3 or at 5 |

---

## 11. Open for ruling

1. `startDaemon` returning `tokens` rather than one `token` (§2.1) — edits a published interface in the plan.
2. Daemon error namespace vs. adding transport codes to frozen `ErrorCode` (§8).
3. `POST /events` restricted to `message` (§4) — the validator-bypass fix.
4. Uniform `{ events: [...] }` on writes (§4.2) — generalises `plan:1283`.
5. Golden fixtures under `tests/daemon/fixtures/` rather than frozen `tests/fixtures/` (§10).
6. Phase D parallelism: the plan forbids it, the brief invites it. Proposed shape: **D1, then D2 ∥ D3, then D4** — D2 and D3 both need a running daemon at test time, which a contract cannot substitute for.
7. Claim CT-D-1 (§7) — no event kind can carry a `CritiqueRecord`, so gate 2 is unsatisfiable through the daemon and `submit` cannot be built.
