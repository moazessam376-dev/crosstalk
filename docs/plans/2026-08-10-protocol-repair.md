# Protocol repair — implementation plan

> **For agentic workers:** this plan is a claim, not a command. Read it, then
> raise claims against it before you write code. `against: "spec"`, one claim per
> defect, each with a falsifier. See "Plan review" below.

**Goal:** make the protocol engine real — the dispute ladder, decisions,
evidence expiry and task authority — and finish the front door so a first run
on somebody else's repository produces the system the design describes.

**Architecture:** no new subsystems. Every gap below is filled by wiring
existing primitives (claims, decisions, rooms, the append-only log) to code
paths that currently have no caller. Three new event kinds make the ladder
observable; everything else is behaviour behind existing contracts.

**Tech stack:** unchanged. Node ≥ 20, TypeScript, React + Vite for the hub,
vitest. Two runtime dependencies, still.

**Review basis:** the runtime review of `70cd496`, verified by running the
built CLI end to end against a throwaway repository. Findings are restated in
each task under "Why".

---

## Global constraints

Copied from `AGENTS.md`; they bind every task in this plan.

1. **Two runtime dependencies, total** — `@modelcontextprotocol/sdk` and `yaml`. Dev deps are free.
2. **No native modules.**
3. **The log is append-only.** Corrections are new events, never edits.
4. **Order by `seq`, never `ts`.** Replay must be deterministic.
5. **`falsifier` is required** on every claim, on `contest`, and on `amend`. `uphold` requires new evidence, not a falsifier.
6. **`node:path` always, `execFile` never `exec`.**
7. **Green on one platform is not done.** CI is Windows, macOS and Linux.
8. **Don't edit `src/contracts/` or `tests/fixtures/`** — frozen. Raise a claim instead. (Task 0 below is the one exception, and it is the leader's; it lands before you branch.)
9. **Scratch worktrees and probe files go under `.crosstalk/`.**

Two constraints specific to this plan:

- **Rule 4 is about ordering, not about wall-clock.** Rung timeouts are wall-clock by necessity (§5.3 gives them in minutes and hours). Ordering stays `seq`. Arming a timer from `ts` is correct and is not a rule-4 violation; ordering two events by `ts` still is.
- **Crosstalk never executes an agent-proposed command.** The `discriminating_test` rung is bookkeeping: agents propose, accept, run it in their own workspace, and post the output as evidence. A daemon that shells out to whatever two arguing agents agreed on is a remote-code-execution hole, not a feature.

---

## Already done — do not redo

**CI ordering.** `.github/workflows/ci.yml` ran `npm test` before
`npm run build`, so `tests/cli/front-door.test.ts:104` got a 503 from
`sendHubMissing` and every run on every platform was red for reasons unrelated
to the commit. Fixed in this PR by swapping the two steps. Verified at the
branch head: clean `dist/`, `npm run build`, then `npm test` → 37 files, 278
tests, all passing; and `tests/daemon tests/cli tests/workspace` run five
consecutive times, 110 passed each time.

If your suite is red on arrival, it is something you did, not the baseline.

---

## Task 0 — contract freeze (leader, lands before either track branches)

This is the interface between the two tracks. It is proposed here for the plan
review and applied by the leader once claims against it are resolved. **Do not
apply it yourself**, and do not start a task that depends on it until it is on
`main`.

### `src/contracts/events.ts`

Add `LadderRung` to the imports, add three kinds to `EventKind`, and replace the
three decision members:

```ts
import type { Decision, LadderRung } from './decision.js';
```

```ts
  | 'decision_opened'
  | 'vote_cast'
  | 'decision_resolved'
  | 'rung_entered'
  | 'test_proposed'
  | 'rung_failed'
  | 'brief_updated';
```

```ts
  // `room` is required on every decision event, not inherited as optional from
  // EventBase. `addressesParticipant` wakes a participant only for an event
  // with a room they are in, so a roomless decision reached nobody: a voter
  // parked in await_turn was never told the vote it was named in existed.
  // Making it required means the compiler finds every append site instead of a
  // reviewer finding one of them.
  | (EventBase & { kind: 'decision_opened'; room: RoomId; decision: Decision })
  | (EventBase & {
      kind: 'vote_cast';
      room: RoomId;
      decisionId: string;
      option: string;
      rationale: string;
      /** Required when the current rung is `third_agent`: a ruling is a claim
       *  and carries the same burden as any other (§5.3). */
      falsifier?: string;
    })
  | (EventBase & { kind: 'decision_resolved'; room: RoomId; decisionId: string; outcome: string })
  // The ladder, made observable. Without these, a dispute that escalated
  // through three rungs and one that never left the first are the same log.
  | (EventBase & {
      kind: 'rung_entered';
      room: RoomId;
      decisionId: string;
      rung: LadderRung;
      index: number;
      /** Set when the rung names one — the uninvolved peer at `third_agent`. */
      adjudicator?: ParticipantId;
    })
  | (EventBase & {
      kind: 'test_proposed';
      room: RoomId;
      decisionId: string;
      claimId: string;
      command: string;
      /** What the proposer says this prints if they are right. A command
       *  without a prediction cannot discriminate anything. */
      predicts: string;
    })
  | (EventBase & {
      kind: 'rung_failed';
      room: RoomId;
      decisionId: string;
      rung: LadderRung;
      reason: string;
    })
```

### `src/contracts/decision.ts`

```ts
export interface SkippedRung {
  rung: LadderRung;
  /** Named, never silent. A degraded ladder must not look like a short one. */
  reason: string;
}
```

Add to `Decision`:

```ts
  /** Rungs that will not be attempted, with why. Audit F-07. */
  skipped?: SkippedRung[];
```

### `src/contracts/claim.ts`

Add to `Claim`:

```ts
  /**
   * Who answered last. The dispute alternates: the target answers the raiser,
   * the raiser answers the target. Without this the validator could only ask
   * "is this the raiser?", which let an `uphold` return the claim to
   * `contested` in a state only the raiser could leave — so the participant
   * being upheld against got exactly one turn in the argument.
   * Derived by the projection, never authored.
   */
  lastResponder?: ParticipantId;
```

### `src/contracts/errors.ts`

```ts
  // The ladder.
  | 'RUNG_NOT_ACTIVE'
  | 'NOT_ADJUDICATOR'
  | 'RULING_WITHOUT_FALSIFIER'
  | 'TEST_WITHOUT_PREDICTION'
  // Task authority.
  | 'NOT_TASK_AUTHORITY'
```

**Acceptance:** `npm run typecheck` names every append site that now needs a
`room`; `npm run build` and `npm test` are green after the leader adds it.

---

## Track A — the protocol engine

**You own** `src/core/`, `src/daemon/`. **Do not touch** `src/cli/`,
`src/harness/`, `src/ui/` — Track B owns those and a conflict there costs a
rebase for both of us. Branch: `ct/track-a-engine`. One PR.

### A1 — a dispute is an argument, not one turn

**Why.** Verified on `70cd496`: leader raises → codex contests → leader upholds
→ codex's `contest` is refused with `ILLEGAL_CLAIM_RESPONSE`. `uphold` maps to
`contested` (`src/core/projection.ts:136`), and `contested` admits only
`claim.raisedBy` (`src/core/claims.ts:109`). The leader can uphold forever and
the worker cannot answer. That is the hierarchy the project exists to remove.

**Files:** modify `src/core/claims.ts` (`validateResponseAuthority`),
`src/core/projection.ts` (set `lastResponder`). Test:
`tests/core/claims.test.ts`.

**Behaviour.** In state `contested`, the eligible responder is whoever did *not*
answer last:
- `lastResponder === claim.raisedBy` → the target answers, with `accept`, `contest` or `clarify`.
- `lastResponder === target` → the raiser answers, with `concede`, `amend` or `uphold`.
- `lastResponder` unset → the raiser answers (the current behaviour).

`rounds` still increments on every response. Nothing else changes.

**Acceptance:**
- After `contest` then `uphold`, the target's second `contest` is accepted and `rounds` is 3.
- After a `contest`, the target contesting again is `NOT_CLAIM_RESPONDER`.
- After an `uphold`, the raiser upholding again is `NOT_CLAIM_RESPONDER`.
- Test both sides of the discrimination, per `AGENTS.md`: the case that should be refused and the neighbouring one that should not.

### A2 — decisions reach the people they name

**Why.** Verified: `cursor` sat in `await_turn` while a decision naming it as a
voter was opened, and got `idle`. `openDecision` appends with no `room`
(`src/daemon/handlers.ts:215`), and `addressesParticipant` requires one
(`src/daemon/handlers.ts:326`). The hub is blind for the same reason —
`DisputeView` filters by room, so the ladder rail and tally never render.
Separately, `tally()` returns `null` for `method: 'ladder'`
(`src/core/decisions.ts:19`), so a ladder decision can never close: I voted 2 of
3 in favour and no `decision_resolved` was emitted.

**Files:** modify `src/daemon/handlers.ts` (`openDecision`, `castVote`),
`src/core/decisions.ts` (`tally`). Test: `tests/core/decisions.test.ts`,
`tests/daemon/routes.test.ts`.

**Behaviour.**
- Every decision event carries a room: `dispute:<claimId>` when `claimId` is set, otherwise `#floor`.
- `GET /config.json` (`src/daemon/server.ts:340`) gains `maxRounds: config.policy.dispute.maxRounds`. **This one field is Track B's B5 dependency** — it is in your files, so it is your task. Land it early in the PR so B is not blocked on your last commit.
- `tally` for `method: 'ladder'` resolves by the **current rung**: `third_agent` → the adjudicator's vote decides; `leader` → the leader's vote decides; `human` → `@human`'s vote decides; `vote` → majority; `discriminating_test` → never resolved by votes, returns `null`.
- A `vote_cast` at a `third_agent` rung without a falsifier is `RULING_WITHOUT_FALSIFIER`.

**Acceptance:**
- A participant in `await_turn` receives `decision_opened` naming it a voter.
- A ladder decision at rung `leader` resolves on the leader's vote and emits `decision_resolved`.
- The same decision does **not** resolve on a worker's vote.
- `GET /config.json` returns `maxRounds` matching the loaded config, not a constant.

### A3 — the ladder actually climbs

**Why.** `resolvableRungs` and `advance` (`src/core/decisions.ts:11`, `:33`)
have no caller outside tests. `maxRounds` is only ever printed into a brief
(`src/harness/brief.ts:52`). Verified: four `uphold`s against `maxRounds: 3`,
all accepted, nothing escalated.

**Files:** create `src/core/ladder.ts` (pure: which rung, who adjudicates, what
is skipped), `src/daemon/ladder.ts` (timers and the append side). Modify
`src/daemon/handlers.ts`, `src/daemon/server.ts`. Test:
`tests/core/ladder.test.ts`, `tests/daemon/ladder.test.ts`.

**Interfaces produced** — Track B renders these, so the names are load-bearing:

```ts
export interface LadderPlan {
  /** The configured ladder, unfiltered. */
  ladder: LadderRung[];
  /** Rungs that will not be attempted, each with a reason. */
  skipped: SkippedRung[];
  /** Index into `ladder` of the first attemptable rung. */
  start: number;
}

export function planLadder(ladder: LadderRung[], state: HubState): LadderPlan;
export function adjudicatorFor(claimId: string, state: HubState): ParticipantId | undefined;
export function nextRung(decision: Decision): { rung: LadderRung; index: number } | undefined;
```

**Behaviour.**
- On a `claim_response` that leaves the claim `contested` with `rounds > policy.dispute.maxRounds`, the daemon opens a ladder `Decision` in `dispute:<claimId>` and emits `rung_entered` for the first attemptable rung. This is automatic — no agent has to know the ladder exists.
- `planLadder` drops `third_agent` when fewer than two workers are configured and records it in `skipped` with the reason. **Skipped, never silent** — audit F-07.
- `adjudicatorFor` returns an uninvolved worker: a participant with `role: 'worker'` who is neither `claim.raisedBy` nor `claim.against`. It is already a member of the dispute room (`src/core/rooms.ts:64`), so it has been reading the argument. Undefined when there is none, which is what makes the rung skippable.
- Entering `third_agent` emits `rung_entered` with `adjudicator` set and addresses that participant, so their `await_turn` returns.
- Each rung arms a timer from `policy.dispute.rungTimeouts[rung]`. On expiry: `rung_failed` with reason `timeout`, then `rung_entered` for the next attemptable rung. Re-armed on daemon restart from the last `rung_entered.ts`; a rung whose deadline already passed advances immediately on startup.
- The last rung is terminal by validation (`validateLadder`), so the ladder cannot run out. Falling off the end is a bug, not a state.

**Acceptance:**
- A fifth response on a `maxRounds: 3` dispute produces `decision_opened` + `rung_entered` without any client asking for it.
- With one worker, `skipped` contains `third_agent` with a reason and the rail still shows the rung.
- With two workers, `adjudicatorFor` returns the uninvolved one, and never a disputant.
- A rung whose timeout expires emits `rung_failed` then `rung_entered` for the next.
- A daemon restarted mid-rung re-arms; one restarted after the deadline advances at once.
- **Break it on purpose** (`AGENTS.md`): hard-code `adjudicatorFor` to return a disputant and confirm a test goes red. If none does, the test does not test it.

### A4 — the discriminating test rung

**Why.** §5.3 makes this the first rung because most disagreements about code
are empirically decidable. Today it is a string in a config array and a label in
the UI.

**Files:** modify `src/core/ladder.ts`, `src/daemon/handlers.ts`, add route
`POST /decisions/:id/test`. Test: `tests/daemon/ladder.test.ts`.

**Behaviour.**
- A disputant proposes with `{ command, predicts }`; the daemon appends `test_proposed`. Empty `predicts` is `TEST_WITHOUT_PREDICTION` — a command nobody has said anything about cannot discriminate.
- Proposing when the current rung is not `discriminating_test` is `RUNG_NOT_ACTIVE`.
- When **both** disputants have proposed, the rung stands and the dispute continues normally: whoever runs a command posts the output as evidence and answers with a verdict. Crosstalk records the exchange; it does not execute anything.
- When the rung times out with **fewer than two** proposals, emit `rung_failed` with a reason naming who did not propose, then advance. §5.5: this is how a vacuous falsifier is exposed, and the ledger counts it.

**Acceptance:**
- Both sides propose → `test_proposed` × 2, no `rung_failed`, rung still current.
- Only one proposes and the rung times out → `rung_failed` names the silent participant, ladder advances.
- Proposing at the wrong rung → `RUNG_NOT_ACTIVE`.
- `predicts: ""` → `TEST_WITHOUT_PREDICTION`.

### A5 — evidence expires, and the work recovers

**Why.** `evaluateStaleness` (`src/workspace/staleness.ts:4`) has no production
caller. Nothing emits `evidence_stale` or `rebase_notice`. `projection.ts:95`
returns state unchanged for `rebase_notice`, and a stale flag leaves a resolved
claim resolved. `submitted` has no transition back to `in_progress`. This is
audit F-01, upheld by the leader and still open. "Evidence expires" is a
headline claim in the README that is currently false.

**Files:** create `src/daemon/staleness.ts`. Modify `src/core/projection.ts`,
`src/core/tasks.ts`, `src/daemon/server.ts`. Test:
`tests/core/projection.test.ts`, `tests/core/tasks.test.ts`,
`tests/daemon/staleness.test.ts`.

**Behaviour.**
- The daemon re-evaluates on a `task_state` → `merged` event, and on a poll of `project.mainBranch`'s head every 30s. Polling because Crosstalk does not own the user's git and cannot hook their merges.
- For each open claim, `evaluateStaleness` compares evidence SHAs to the head; a SHA that is no longer an ancestor emits `evidence_stale`.
- `TASK_TRANSITIONS.submitted` gains `'in_progress'`.
- `projection` for `evidence_stale`: mark the item, and if the claim is `resolved` **and every** non-stale piece of evidence is gone, return it to `open` and clear `resolution`. A claim still standing on fresh evidence stays resolved.
- `projection` for `rebase_notice`: a task in `submitted` returns to `in_progress`.
- The daemon emits `rebase_notice` to `task:<id>` for any `submitted` task whose submission evidence went stale.

**Acceptance:**
- A resolved claim whose only evidence is orphaned by a rebase returns to `open` with `resolution` cleared.
- A resolved claim with one stale and one fresh piece stays `resolved`. (Both sides of the discrimination.)
- A `submitted` task receiving `rebase_notice` is `in_progress`, and `validateTransition('submitted' → 'in_progress')` passes.
- Tests build a real throwaway repo under `os.tmpdir()` and rebase it. Do not mock git — `AGENTS.md`.

### A6 — who may move a task

**Why.** Verified: `cursor`, an unrelated worker, drove `codex`'s task from
`in_progress` to `merged`, including `accepted`. `setTaskState`
(`src/daemon/handlers.ts:174`) checks legality and nothing else.
`policy.taskAcceptance.method` and `policy.leaderCritique.maxRounds` are never
read by any code path.

**Files:** modify `src/daemon/handlers.ts`. Test: `tests/daemon/routes.test.ts`.

**Behaviour.** An authority table beside `TASK_TRANSITIONS`:

| Target state | Who |
|---|---|
| `assigned`, `under_review`, `resolving`, `merged` | leader |
| `acknowledged`, `in_progress`, `self_reviewed`, `submitted` | the assignee |
| `accepted` | per `policy.taskAcceptance.method`: `leader` → the leader; `human` → `@human`; `majority`/`unanimous` → refuse with `NOT_TASK_AUTHORITY` naming the decision route |

Anything else is `NOT_TASK_AUTHORITY` with a message naming who may.

**Acceptance:**
- A non-assignee worker moving a task to `in_progress` is refused; the assignee is not.
- A worker moving a task to `accepted` under `method: leader` is refused; the leader is not.
- The full march I ran during review — an unrelated worker from `in_progress` to `merged` — fails at the first step.

---

## Track B — the front door and the hub

**You own** `src/cli/`, `src/harness/`, `src/ui/`. **Do not touch**
`src/core/`, `src/daemon/` — Track A owns those. Branch: `ct/track-b-frontdoor`.
One PR.

**Your dependency, stated plainly.** B4 and B5 render events Track A emits. The
contracts are frozen at Task 0, so you can build and test against a fixture you
write. That is exactly the seam this project has already shipped broken once —
28 green tests over a signature screen that rendered empty. So B4's acceptance
is not "the component test passes"; it is "I opened the hub against a live
daemon with a real escalated dispute and looked at it". Track A merges first;
you rebase and do that pass before your PR is ready.

### B1 — `init` builds the workspace it promises, `down` removes it

**Why.** Verified on a fresh repo: `init` writes
`workspace: .crosstalk/worktrees/codex` into the config and never creates the
directory (`src/cli/init.ts:191`); `createWorktree` and `removeWorktree` have no
caller outside tests. It also never calls `writeBrief`, so `doctor` warns
`BRIEF_STALE` for every participant on a repository `init` created seconds
earlier — the product's first two commands disagreeing about a file one of them
just wrote. Two agents in one checkout is the failure §7 of the design spec
exists to prevent.

**Files:** modify `src/cli/init.ts`, `src/cli/index.ts` (`cmdDown`). Test:
`tests/cli/front-door.test.ts`.

**Behaviour.**
- `init` creates `.crosstalk/worktrees/<id>` for every worker, on branch `ct/<id>-base` off the current head.
- `init` renders and writes each participant's brief to its harness's `briefFile`, inside that participant's workspace, at the probed tier.
- `down --purge` removes the worktrees `init` created. Reuse `removeWorktree`, which already handles the Windows retry.
- Existing worktrees are reused, not recreated. `init --force` must not destroy a worker's uncommitted work.

**Acceptance:**
- `init` then `doctor` on a fresh repo produces **zero** `BRIEF_STALE` findings. This is the whole point; it is currently three.
- `.crosstalk/worktrees/<id>` exists per worker and `git worktree list` shows it.
- `down --purge` leaves none behind.
- Re-running `init --force` over a worktree with an uncommitted file preserves that file.
- Windows: the suite touches git and binds nothing, but it does spawn processes — run it **five times consecutively** and report the count.

### B2 — `up` refuses a configuration `doctor` rejects

**Why.** Verified: `init` accepted two leaders without complaint, `doctor`
rejected it with `LEADER_COUNT` and exit 1, and `up` started it anyway. Design
§11 says the config is "validated at startup by `crosstalk doctor`". It is not.

**Files:** modify `src/cli/index.ts` (`cmdUp`), `src/cli/init.ts`. Test:
`tests/cli/front-door.test.ts`.

**Behaviour.**
- `cmdUp` runs `doctor` before `startDaemon`. Any `reject` prints the findings and exits `EXIT.protocol` without binding a port. Warnings print and start.
- `--force` starts anyway, for someone who knows better than the checker.
- `init` refuses to *write* a config with zero or multiple leaders, with the same message `doctor` gives. A generator that emits what the validator rejects is the bug, not the validator.

**Acceptance:**
- `up` on a two-leader config exits non-zero, prints `LEADER_COUNT`, and binds no port (assert nothing is listening).
- `up` on a config with only warnings starts.
- `init --participant a:leader:... --participant b:leader:...` is refused.

### B3 — every agent gets its own MCP registration

**Why.** `writeMcpConfig` (`src/cli/init.ts:82`) picks one participant and
writes a single `crosstalk` server carrying that participant's token. Every
other agent must fall back to the CLI, and worker worktrees — where the GUI
harnesses are actually opened — get no `.mcp.json` at all. One shared
registration also means two agents opened on the same folder present the same
token, and `from` is the field the ledger attributes by.

**Files:** modify `src/cli/init.ts`. Test: `tests/cli/mcp-merge.test.ts`.

**Behaviour.**
- Write one MCP registration per participant whose harness declares `mcp: stdio`, into that participant's own workspace, at the harness's `mcpConfigPath`, carrying that participant's token.
- Keep the existing merge semantics exactly: never clobber, and refuse to rewrite JSON that failed to parse. That fix (`70cd496`) is load-bearing — it exists because the first version deleted users' MCP servers.
- A harness whose `mcpConfigPath` is outside the repo (`~/.codex/config.toml`) is **not** written. Print the exact registration for the user to add by hand. Crosstalk does not edit files outside the repository it was pointed at.

**Acceptance:**
- Two MCP-capable participants produce two registrations with two different tokens, each under its own workspace.
- A pre-existing `mcpServers` entry survives.
- An out-of-repo `mcpConfigPath` writes nothing and prints instructions.

### B4 — the dispute view shows the argument

**Why.** Verified in a browser against a live daemon: the signature screen
rendered "CLAIM · leader" beside "UPHOLD · leader". `DisputeView` pairs
`claims[0]` with `responses.at(-1)` (`src/ui/dispute/DisputeView.tsx:141`), so
after an uphold the contesting worker's rationale and falsifier are gone from
the one screen the design calls the reason the UI is worth building. The ladder
rail and vote tally never rendered at all, because A2's missing room excluded
the decision from `scopedEvents`.

**Files:** modify `src/ui/dispute/DisputeView.tsx`, `src/ui/cards/ClaimCard.tsx`.
Create `tests/fixtures/session-ladder.jsonl` (a new fixture; the two frozen ones
stay untouched). Test: `tests/ui/dispute.test.tsx`.

**Behaviour.**
- Left pane: the claim and its falsifier. Right pane: **the most recent response from the other side** — the opposing falsifier, never the claimant's own restatement. An `uphold` updates the left pane's evidence; it does not replace the right pane.
- Render the ladder rail from `decision.ladder`, marking the current rung, and rendering `decision.skipped` entries with `data-state="skipped"` and their reason as a title. A degraded ladder must not look like a short one.
- Render the vote tally, including a `third_agent` ruling's falsifier.
- Stale evidence stays struck through in place.

**Acceptance:**
- With claim → contest → uphold, the contest's falsifier is still on screen. Assert on the falsifier **text**, not on the presence of a node.
- A decision with a skipped rung renders it with `data-state="skipped"` and its reason.
- **Live pass, required:** `crosstalk up` against a repo with a real escalated dispute, open the hub, and confirm both falsifiers and the rail. Screenshot or page text in the handoff. A component test proves the component draws given props; it cannot prove anything hands it props.

### B5 — the round counter tells the truth

**Why.** `roundFor` clamps with `Math.min(3, …)` and the header hard-codes
`/ 3` (`src/ui/dispute/DisputeView.tsx:85`, `:157`); `ChannelList` uses its own
`DEFAULT_MAX_ROUNDS = 3` (`src/ui/state/derive.ts:29`). Verified: the same
dispute read "round 3 / 3" in the header and "4/3" in the channel row. Neither
reads `policy.dispute.maxRounds`.

**Files:** modify `src/ui/dispute/DisputeView.tsx`, `src/ui/state/derive.ts`,
`src/ui/state/hubConfig.ts`, `src/ui/layout/ChannelList.tsx`. Test:
`tests/ui/dispute.test.tsx`, `tests/ui/derive.test.ts`.

**Behaviour.**
- Serve `policy.dispute.maxRounds` from the daemon's `/config.json` — **this is the one field Track A must add for you.** Coordinate it in the plan review, not mid-build.
- Both the header and the channel row read that value, and neither clamps. A dispute at round 5 of 3 reads `5 / 3`, because that is what happened.

**Acceptance:**
- With `maxRounds: 5`, header and channel row both read `/ 5`.
- A dispute past the maximum shows the true round in both places, and they agree.

### B6 — the human can speak, and the README is true

**Why.** Design §10.3 gives the human a composer on every room. There is no
`<input>` or `<textarea>` anywhere in `src/ui/` — only two canned buttons in the
dispute view. And `README.md` still says "Pre-implementation… the code is not
written yet" over roughly 7,000 lines of source, which is the first thing a new
contributor reads.

**Files:** create `src/ui/layout/Composer.tsx`. Modify
`src/ui/layout/Stream.tsx`, `src/ui/state/humanAction.ts`, `README.md`,
`src/ui/theme.css`. Test: `tests/ui/layout.test.tsx`.

**Behaviour.**
- A composer under the stream, posting to the active room as `@human` via `POST /events`. Reuse `postHumanAction`'s error handling — the 401 message it already has is the right one.
- Enter sends, Shift+Enter newlines, empty does nothing, and the field clears only on a confirmed 201.
- Frontend work follows the density and colour rules in design §10.4. Read the `frontend-design` skill before touching the visual layer.
- `README.md` Status section: what actually runs, and what does not. Do not claim the ladder works until Track A merges.

**Acceptance:**
- Typing and pressing Enter issues one `POST /events` with the active room; the field clears.
- A failed post keeps the text and shows the reason. Losing what someone typed is not an acceptable failure mode.
- Empty or whitespace-only sends nothing.

---

## Explicitly out of scope

Named so nobody builds them and nobody raises a claim that they are missing:

- **The GitHub mirror.** Not started, a whole subsystem, and the one part that fails for reasons outside this codebase. `doctor`'s mirror warnings stay.
- **Supervised lifecycle / `spawn`.** Attached-only remains correct for v1 per design §6.6.
- **`policy.planning` as executable code.** The field stays parsed and unread. Plan review happens the way this plan is being reviewed: by hand, with claims against `spec`.
- **The file inbox (tier 3).** Not built, not in this repair.

---

## Working agreement

This exists because the last session spent 24 hours on small details.

- **Two review rounds per task, then the leader decides.** Repo policy; it will be held to.
- **Nits never block a merge.** They become follow-ups. If it is not in the acceptance criteria, it does not gate.
- **A contract change is a claim to the leader**, answered within one turn. Do not work around a frozen contract, and do not wait on one silently.
- **Evidence:** every acceptance criterion gets the command, its output, and the SHA it ran at. `npm run typecheck` and `npm run build` in every handoff — vitest transpiles without typechecking, so a green suite can sit on code `tsc` rejects.
- **Anything that binds a port, spawns a process or touches the filesystem: five consecutive runs, report the count.** A 40% flake reports green on a single run more often than not, and one has already passed a handoff here.
- **Push before you cite.** A SHA only your machine can see is not checkable.
- **Post handoffs with `gh pr comment N --body-file handoff.md`**, then verify the body landed:
  ```bash
  gh api repos/moazessam376-dev/crosstalk/issues/N/comments --jq '.[-1].body | length'
  ```

## Merge order

1. Task 0, contract freeze — leader, before either branch.
2. Track A. It owns the event shapes Track B renders.
3. Track B, rebased onto A, with the live hub pass done after the rebase.

## Plan review

Before any code: read this plan against `docs/specs/2026-08-09-crosstalk-design.md`
and the code it names, and raise claims against it.

- `against: "spec"`, `target: "plan:<task-id>"`, one claim per defect, each with a falsifier.
- Verify what the plan asserts. Several "Why" paragraphs cite line numbers and observed behaviour; if one is wrong, that is the most valuable claim you can raise, and contesting the leader costs you nothing.
- Zero findings is legal. Say so plainly rather than inventing one.
- Read the whole plan, including the other track's tasks. The two most serious defects in this project's history were found by someone reading a plan section that was not theirs.
- One round, then the leader freezes.
