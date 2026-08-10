# Protocol repair — implementation plan

**Revision 2**, amended after two independent plan reviews. 18 claims were
raised; 17 were the leader's errors. This document is the contract — where it
and a PR comment disagree, this wins. Rulings and their reasoning:
[PR #10 review round 1](https://github.com/moazessam376-dev/crosstalk/pull/10#issuecomment-5240725484).

**Goal:** make the protocol engine real — the dispute ladder, decisions,
evidence expiry and task authority — and finish the front door so a first run
on somebody else's repository produces the system the design describes.

**Architecture:** no new subsystems except the mirror. Every other gap is filled
by wiring existing primitives to code paths that currently have no caller.
Three new event kinds make the ladder observable.

**Tech stack:** unchanged. Node ≥ 20, TypeScript, React + Vite, vitest.
**Two runtime dependencies, still** — that binds Track D hardest.

---

## Global constraints

From `AGENTS.md`; they bind every task.

1. **Two runtime dependencies, total** — `@modelcontextprotocol/sdk` and `yaml`.
2. **No native modules.**
3. **The log is append-only.** Corrections are new events, never edits.
4. **Order by `seq`, never `ts`.**
5. **`falsifier` is required** on every claim, on `contest`, and on `amend`. `uphold` requires new evidence, not a falsifier.
6. **`node:path` always, `execFile` never `exec`.**
7. **Green on one platform is not done.** CI is Windows, macOS and Linux.
8. **Don't edit `src/contracts/` or `tests/fixtures/`** — frozen. Raise a claim.
   *Scope of rule 8, ruled:* frozen means the existing files are not to be
   **edited**. **Adding** a new fixture is permitted — `tests/fixtures/session-basic.jsonl`
   and `session-dispute.jsonl` stay byte-identical, and nothing may be added that
   an existing test reads. Track C owns `tests/fixtures/session-ladder.jsonl`;
   Track A's fixtures go under `tests/daemon/fixtures/`.
   **A track owns the tests for the source it owns**, even where the path does
   not sit under it: `tests/ui/` is Track C's, `tests/cli/` and `tests/harness/`
   are Track B's, `tests/core/`, `tests/daemon/` and `tests/workspace/` are
   Track A's, `tests/mirror/` is Track D's.
9. **Scratch goes under `.crosstalk/`.**

Plan-specific:

- **Rule 4 is about ordering, not wall-clock.** Rung timeouts are wall-clock by necessity (§5.3 gives them in minutes and hours). Arming a timer from `ts` is correct; *ordering* two events by `ts` is still a violation.
- **Crosstalk never executes an agent-proposed command.** The `discriminating_test` rung is bookkeeping. Agents propose, run it themselves, and post output as evidence.
- **The repository is public.** Nothing lands on `main` without maintainer approval, the leader included. Secret scanning and push protection are on.

---

## Status of Task 0 — contract freeze: **DONE**, on `ct/plan-repair` at `26a1345`

Applied by the leader. Typecheck, build and 278 tests green. Do not re-apply;
do not edit `src/contracts/` further without raising a claim.

What landed, and the claim that caused each:

| Change | From |
|---|---|
| `room` **required** on `decision_opened`, `vote_cast`, `decision_resolved` | A/C-1 |
| `rung_entered { decisionId, rung, index, adjudicator? }` | A/C-3, B/1 |
| `rung_failed { decisionId, rung, reason }` | A/C-6, B/1 |
| `test_proposed { decisionId, claimId, command, predicts, sha }` | A/C-11 |
| `room` **required** on `evidence_stale` (`dispute:<claimId>`) and `rebase_notice` (`task:<taskId>`) | A/C-12 |
| `Decision.skipped?: SkippedRung[]` | A/C-2, B/1 |
| `Claim.lastResponder?: ParticipantId` | A/C-5 |
| `RUNG_NOT_ACTIVE`, `NOT_ADJUDICATOR`, `RULING_WITHOUT_FALSIFIER`, `TEST_WITHOUT_PREDICTION`, `NOT_TASK_AUTHORITY` | various |

**Three rules that fall out of the freeze and bind more than one track:**

1. **Current rung** = the `index` of the last `rung_entered` for that `decisionId`; absent any, `decision.currentRung ?? 0`. One rule that satisfies both the frozen fixture and live data. Track C renders by it; Track A appends by it.
2. **The adjudicator is chosen at rung entry, not at open.** "Uninvolved" decays — a peer picked when the ladder opened may hold its own claim by rung 2. `rung_entered.adjudicator` is stamped at *every* entry. Track C reads it from the last `rung_entered`, never from `decision_opened`.
3. **A ladder decision's `voters` are every participant who could ever be asked at any rung**: the leader, `@human`, and all workers, deduplicated. This is *not* the dispute room's membership — that was claim A/C-1 — and it is what makes rule 2 possible without a contract change, since the adjudicator is already an eligible voter whenever it is named.

The leader also added the minimum for the tree to compile: `decisionRoom()` in
`src/daemon/handlers.ts`, the three new kinds in `EVENT_KIND_ROUTE` and
`PROTOCOL_STATUS`, and three cases in `src/cli/output.ts`. **Wiring the rooms is
not the same as waking the voters** — that is still A2.

---

## Track A — the protocol engine

**Owns** `src/core/`, `src/daemon/`, `src/workspace/`. Branch `ct/track-a-engine`. One PR.

### A1 — a dispute is an argument, not one turn

Modify `src/core/claims.ts`, `src/core/projection.ts`. Test `tests/core/claims.test.ts`.

In `contested`, the eligible responder is whoever did *not* answer last, resolved
through one helper used by **both** the `open` and `contested` branches:

```ts
export function responderFor(claim: Claim, state: HubState): ParticipantId;
// briefOwner(state) when `against` is 'brief' | 'spec'; claim.against otherwise.
```

- `lastResponder === claim.raisedBy` → the responder answers: `accept` | `contest` | `clarify`.
- `lastResponder === responderFor(...)` → the raiser answers: `concede` | `amend` | `uphold`.
- unset → the raiser answers.

`lastResponder` is compared against `responderFor(...)`, **never** against
`claim.against` directly — for a `brief`/`spec` claim that literal matches nobody
and the branch falls through undefined. This is the claim shape the plan reviews
themselves used. The verdict-legality check at `claims.ts:110` relaxes alongside
the authority check; both live in `validateResponseAuthority`.

**Acceptance.** After `contest` → `uphold`, the responder's second `contest` is accepted and `rounds` is 3. After a `contest`, the responder contesting again is `NOT_CLAIM_RESPONDER`. After an `uphold`, the raiser upholding again is `NOT_CLAIM_RESPONDER`. A claim `against: "spec"` alternates correctly between raiser and brief owner. Test both sides of each discrimination.

### A2 — decisions reach the people they name

Modify `src/daemon/handlers.ts`, `src/core/decisions.ts`, `src/daemon/server.ts`.

- `addressesParticipant` returns true when the event is a decision event (`decision_opened`, `vote_cast`, `decision_resolved`, `rung_entered`, `rung_failed`) **and** `who` is in that decision's `voters`. Room membership alone is insufficient: `membersOf('dispute:<id>')` adds a leader only for `brief`/`spec` claims, so on a worker-vs-worker dispute the leader — the default terminal rung — is not a member.
- `tally(decision: Decision, state: HubState): string | null`. The signature change is load-bearing and deliberate: `Decision` carries no roles, so nothing in the old signature could tell a leader from a worker. `authoritativeVote` returning the first voter who voted is a **live bug today**, not only under ladders — a worker's vote already resolves a `method: 'leader'` decision.
- For `method: 'ladder'`, resolve by the **current rung** (rule 1 above): `third_agent` → the adjudicator's vote from the last `rung_entered`; `leader` → the leader's; `human` → `@human`'s; `vote` → majority; `discriminating_test` → always `null`.
- A `vote_cast` at a `third_agent` rung without a falsifier is `RULING_WITHOUT_FALSIFIER`.
- A `vote_cast` at a `third_agent` rung from anyone **other than the named adjudicator** is `NOT_ADJUDICATOR`. This is what that frozen code is for. `voters` deliberately holds everyone who could be asked at *any* rung, so without this refusal the leader could vote at rung 2 and pre-empt the peer whose rung it is — and if the leader wants to decide, the ladder has a rung for that, one further along.
- `GET /config.json` gains `maxRounds: config.policy.dispute.maxRounds`. **This is Track C's dependency — land it in your first commit.**

**Acceptance.** A voter in `await_turn` receives `decision_opened` — including a leader on a worker-vs-worker dispute. A ladder at rung `leader` resolves on the leader's vote and **not** on a worker's. `method: 'leader'` with voters `['codex','leader']` and only `codex` voting resolves to nothing. `/config.json` returns the loaded value, not a constant.

### A3 — the ladder actually climbs

Create `src/core/ladder.ts` (pure) and `src/daemon/ladder.ts` (timers). Modify `src/daemon/handlers.ts`, `src/harness/doctor.ts`.

```ts
export interface LadderPlan { ladder: LadderRung[]; skipped: SkippedRung[]; start: number }
export function planLadder(ladder: LadderRung[], state: HubState): LadderPlan;
export function adjudicatorFor(claimId: string, state: HubState): ParticipantId | undefined;
export function nextRung(decision: Decision, state: HubState): { rung: LadderRung; index: number } | undefined;
```

- **Trigger.** On a `claim_response` leaving the claim `contested` with `rounds > policy.dispute.maxRounds` **and no unresolved ladder decision for that `claimId`**. The guard is not optional: A1 makes responses past the maximum the *expected* case, so without it response 4 opens `D-1`, response 5 opens `D-2`, each with its own timers racing.
- **`rounds > maxRounds` is first true at response 4**, not 5: `rounds` is 0 at raise and increments once per response.
- `decision_opened.decision` carries `skipped` populated and `currentRung = LadderPlan.start`. Track C renders both.
- `planLadder` drops `third_agent` when fewer than two workers exist, recording it in `skipped` with a reason. Skipped, never silent.
- `adjudicatorFor` returns a `role: 'worker'` participant that is neither `claim.raisedBy` nor `responderFor(claim, state)`, **re-evaluated at every `rung_entered`**. None available → `rung_failed` reason `no_uninvolved_peer`, advance.
- **The last rung never arms a timer**, whatever `rungTimeouts` says — §5.3's terminal rung blocks indefinitely by design. A non-final rung with no configured timeout also blocks; state it rather than leaving `setTimeout(NaN)`.
- `doctor` gains a **reject** when the last rung has a configured timeout. `TERMINAL_RUNGS` and §5.3 disagree — the spec says `human` is terminal only *with no timeout*, and the shipped `DEFAULT_POLICY` pairs `human: '4h'` with a senior preset ending in `human`. That config is dead escalation that reads as working escalation.
- Timers re-arm on restart from the last `rung_entered.ts`; an expired deadline advances immediately.

**Acceptance.** The **4th** response on `maxRounds: 3` escalates and the **3rd** does not. Five further responses produce **exactly one** `decision_opened`. One worker → `skipped` names `third_agent` with a reason. `adjudicatorFor` never returns a disputant. A ladder ending `human` with `rungTimeouts.human` set is rejected by `doctor`. A restart mid-rung re-arms; past the deadline it advances at once. **Break it on purpose:** hard-code `adjudicatorFor` to return a disputant and confirm a test goes red.

### A4 — the discriminating test rung

Modify `src/core/ladder.ts`, `src/daemon/handlers.ts`. Add `POST /decisions/:id/test`.

- A disputant proposes `{ command, predicts, sha }`. Empty `predicts` → `TEST_WITHOUT_PREDICTION`. Missing `sha` → `MALFORMED_BODY`, matching `Evidence`'s precedent.
- Proposing at any other rung → `RUNG_NOT_ACTIVE`.
- **`sha` is why this rung works.** Two disputants running one command at two commits get a difference explained by the diff between them, not by who is right — and the rung would then record an inconclusive falsifier against both in the §12 ledger when the real fault was that nobody named a commit.
- **The acceptance handshake of §5.3 is deliberately not modelled.** It adds an event and a state without changing any outcome. Recorded as a knowing narrowing, contested once and settled.
- **On expiry**, uniformly: fewer than two proposals → `rung_failed` naming who was silent; two or more with the claim still unresolved → `rung_failed` reason `test_inconclusive`. Either way, advance. Rung 0 can never stall.
- **The success path is the claim resolving**, which closes the decision (A5's companion rule below).

**Acceptance.** Both propose → two `test_proposed`, no `rung_failed`, rung still current. One proposes, timer expires → `rung_failed` names the silent participant and the ladder advances. Two propose, timer expires, claim unresolved → `test_inconclusive`. Wrong rung → `RUNG_NOT_ACTIVE`. `predicts: ""` → `TEST_WITHOUT_PREDICTION`.

### A5 — evidence expires, work recovers, and a settled dispute stops escalating

Create `src/daemon/staleness.ts`. Modify `src/core/projection.ts`, `src/core/tasks.ts`, `src/workspace/git.ts`, `src/daemon/server.ts`.

- `src/workspace/git.ts` gains an export for the head of `project.mainBranch`. `headSha` is `rev-parse HEAD` and is the wrong commit.
- Re-evaluate on `task_state → merged` and on a 30s poll of the main branch. Crosstalk does not own the user's git and cannot hook their merges.
- **Scope: every claim whose `resolution` is not `withdrawn` or `superseded`.** Not "open claims" — a claim resolved `upheld` is precisely the one that must be re-checked, and the state-literal reading made the reopen rule dead code.
- `TASK_TRANSITIONS.submitted` gains `'in_progress'`.
- `evidence_stale` marks the item; if the claim is `resolved` **and no non-stale evidence remains**, return it to `open` and clear `resolution`. A claim standing on one fresh piece stays resolved.
- `rebase_notice` returns a `submitted` task to `in_progress`.
- **Companion rule (A/C-7):** when a claim reaches `resolved`, any unresolved ladder decision for it is closed with `decision_resolved` outcome `claim_resolved`, and its timer disarmed. Otherwise the ordinary end of a dispute — `concede`, `accept`, `amend` — leaves a timer armed that later fires `rung_entered` on a settled argument, and with `human` on the ladder that pages a person about an argument that ended hours ago. A claim reopened by staleness does **not** revive the old decision; a fresh escalation opens a new one.

**Acceptance.** A resolved claim whose only evidence is orphaned reopens with `resolution` cleared; one with a fresh piece remaining does not. `submitted` + `rebase_notice` → `in_progress`. `concede` on an escalated claim closes the decision and disarms its timer. Tests build a real throwaway repo under `os.tmpdir()` and rebase it — **do not mock git**.

### A6 — who may move a task

Modify `src/daemon/handlers.ts`. An authority table beside `TASK_TRANSITIONS`:

| Target state | Who |
|---|---|
| `assigned`, `under_review`, `resolving`, `merged` | the leader |
| `acknowledged`, `in_progress`, `self_reviewed`, `submitted` | the assignee |
| `accepted` | per `policy.taskAcceptance.method`: `leader` → leader; `human` → `@human`; `majority`/`unanimous` → `NOT_TASK_AUTHORITY` naming the decision route |

Anything else is `NOT_TASK_AUTHORITY` naming who may.

*Correction to revision 1:* both policy fields **are** read — `brief.ts:51` and `:55` print them into a brief. They are not *enforced*. Do not delete them.

**Acceptance.** A non-assignee moving a task to `in_progress` is refused; the assignee is not. A worker moving to `accepted` under `method: leader` is refused; the leader is not. The full march an unrelated worker made from `in_progress` to `merged` fails at the first step.

---

## Track B — the front door

**Owns** `src/cli/`, `src/harness/`, `src/mcp/`. Branch `ct/track-b-frontdoor`. One PR.
Depends on no new contract; **start immediately**.

*`src/mcp/` was unassigned in revision 2 — a gap, not a deliberate exclusion.
It is the transport B3 registers, so it is Track B's.*

### B1 — `init` builds the workspace it promises, `down` removes it

Modify `src/cli/init.ts`, `src/cli/index.ts`. Test `tests/cli/front-door.test.ts`.

- Create `.crosstalk/worktrees/<id>` per worker on `ct/<id>-base`; reuse an existing one rather than recreating it. `init --force` must not destroy uncommitted work.
- Render and write each participant's brief to its harness's `briefFile` inside that participant's workspace, at the probed tier.
- **Write an ignore rule into each created worktree's `.git/info/exclude`.** A linked worktree resolves `.mcp.json` relative to its own root, which the top-level `.gitignore`'s `.crosstalk/` rule does not match — so B3's per-participant token lands untracked and stageable on a branch the worker is expected to push. `.git/info/exclude` rather than `.gitignore` keeps Crosstalk out of a file the user owns.
- **`ensureGitignored` also covers `.mcp.json` at the repo root.** Pre-existing, and now urgent: this repository is public and `init` writes a bearer token there.
- `down --purge` removes the worktrees `init` created, via `removeWorktree` — which **Track A extends** to `removeWorktree(repo, id, options?: { force?: boolean })`, defaulting to today's behaviour. `--purge` passes `force: true`.
  Revision 1 was self-contradictory here: it required `init` to write a brief *into* each worktree, which leaves an untracked file, and `git worktree remove` refuses a worktree with untracked files without `--force`. Every worktree `init` creates was therefore guaranteed unremovable, and `removeWorktree`'s existing fallback does not cover it — that path only fires when the worktree is no longer *registered*. `--purge` is already the explicitly destructive flag; `down` without it still keeps everything.
- **The ignore rule goes in the common git dir, not per worktree.** Git reads `info/exclude` only from `git rev-parse --git-common-dir`; a copy inside a linked worktree is silently ignored. One write there covers the primary checkout and every linked worktree at once.

**Acceptance.** `init` then `doctor` on a fresh repo → **zero** `BRIEF_STALE`. Baseline is **two** on the default roster and **three** on `leader/codex/cursor`; both were measured, and the ambiguity was the plan's for not naming the roster. `git worktree list` shows one per worker. `git check-ignore -v .mcp.json` reports a matching rule at the root **and** inside every worker workspace. `init --force` over an uncommitted file preserves it. `down --purge` leaves none behind. **Five consecutive runs**, report the count.

### B2 — `up` refuses a configuration `doctor` rejects

Modify `src/cli/index.ts`, `src/cli/init.ts`.

- `cmdUp` runs `doctor` before `startDaemon`. Any `reject` prints findings and exits `EXIT.protocol` **without binding a port**. Warnings print and start. `--force` overrides.
- `init` refuses to *write* a config with zero or multiple leaders, with `doctor`'s own message. A generator that emits what the validator rejects is the bug.

**Acceptance.** `up` on a two-leader config exits non-zero, prints `LEADER_COUNT`, and binds nothing — assert nothing is listening. Warnings-only starts. `init` with two leaders is refused.

### B3 — every agent gets its own MCP registration

Modify `src/cli/init.ts`. Test `tests/cli/mcp-merge.test.ts`.

- One registration per participant whose harness declares `mcp: stdio`, in that participant's workspace, at the harness's `mcpConfigPath`, carrying **that participant's** token.
- **`mcp: unverified`, or no `mcpConfigPath`, or a path outside the repo → write nothing, print the exact registration.** Crosstalk does not edit files outside the repository it was pointed at. Without this branch the shipped default roster (`codex-app` has `mcp: unverified` and no `mcpConfigPath`) gets nothing at all, and B3 goes green with its own motivating symptom intact.
- Keep the merge semantics exactly: never clobber, refuse to rewrite unparseable JSON. That fix exists because the first version deleted users' MCP servers.
- **Reference the token, do not embed it.** `init` writes `CROSSTALK_TOKEN_FILE` pointing at `.crosstalk/tokens/<id>`; `loadMcpConfig` (`src/mcp/config.ts`) reads it, preferring `CROSSTALK_TOKEN` when both are set so CLI use is unchanged. A live bearer token sitting in a config file is worth removing on its own merits, and a missing token file fails loudly rather than silently.
  *This is the one addition to the agreed scope.*
- **The ignore rule's reason is machine-specific paths, not the token.** `.mcp.json` as `init` writes it carries an absolute path to the installed package in `args[0]` (`init.ts:91`, deliberately absolute while the package is unpublished) and an absolute path to the clone in `env.CROSSTALK_REPO`. It therefore breaks for the second person who clones, token or no token — so the exclusion is keeping a machine-local artifact out of somebody's history, not withholding a shareable file.
  This distinction is load-bearing for maintenance, which is why it is written down: stated as "defence in depth" against a secret that referencing has already removed, a later reader has every reason to delete the rule. Stated as machine-specific paths, the argument does not weaken over time.
  A genuinely shareable `.mcp.json` needs those absolute paths fixed — a published package name, or a repo-relative launcher. **Not in scope**, named here only so the token change is not mistaken for having achieved it.

**Acceptance.** Two MCP-capable participants → two registrations, two different tokens, each under its own workspace. **On the default roster**, `codex` gets a printed instruction. A pre-existing `mcpServers` entry survives. `git check-ignore` matches for every file written.

---

## Track C — the hub

**Owns** `src/ui/` and nothing else. Branch `ct/track-c-hub`. One PR.
**Not blocked.** Branch from `origin/ct/plan-repair`, which carries the frozen
types, and rebase onto `main` when PR #10 lands. Revision 1 said "blocked until
Task 0 is on `main`"; moving the branch point is what makes that reason false.

Visual reference: `docs/design/2026-08-10-hub.dc.html`. Read the `{{ }}` bindings
as seams where live data enters and the rest as a visual spec — density, surface
layering, the mono/sans split doing semantic work per §10.4. Not a template to
port. Load the `frontend-design` skill before the visual layer.

**Out of scope, agreed:** the ledger and PR-list surfaces (they project
subsystems that do not exist), and the human's accept/contest claim buttons —
`POST /events` refuses on `kind` at `DIRECTLY_APPENDABLE` before responder
authority is ever consulted, so a browser cannot hand-build a `claim_response`
whoever is clicking. The composer posts `kind: "message"` for that reason.

### C1 — the dispute view shows the argument

Modify `src/ui/dispute/DisputeView.tsx`, `src/ui/cards/ClaimCard.tsx`. Create `tests/fixtures/session-ladder.jsonl` (new; the two frozen fixtures stay untouched).

- Left pane: the claim and its falsifier. Right pane: **the most recent response from the other side** — never the claimant's own restatement. Today it pairs `claims[0]` with `responses.at(-1)`, so after an `uphold` the contesting worker's falsifier disappears from the one screen the design exists for.
- Ladder rail from `decision.ladder`, current rung by **rule 1**, `decision.skipped` as `data-state="skipped"` with its reason, and a rung that `rung_failed` as `data-state="failed"` — distinct, or an escalated ladder and a stalled one look identical.
- Adjudicator read from the last `rung_entered`, per **rule 2**.
- `test_proposed` renders command, `predicts` and `sha`; answering evidence whose `sha` differs is marked. That makes "these two ran at different commits" visible on screen rather than only in the ledger.
- Stale evidence stays struck through in place.

*Correction to revision 1:* the rail and tally **do** render today — the frozen fixture carries a `room` and `tests/ui/dispute.test.tsx` passes. What never renders is against a live daemon, which was A2's bug.

**Acceptance.** With claim → contest → uphold, the contest's falsifier is still on screen — assert on the falsifier **text**. Skipped and failed rungs render distinctly. **Live pass, required:** after Track A merges and you rebase, run `crosstalk up` against a repo with a real escalated dispute, open the hub, and look. Page text or screenshot in the handoff. A component test proves the component draws *given* props; it cannot prove anything hands it props — this project shipped that exact failure with 28 green tests.

### C2 — the round counter tells the truth

Modify `src/ui/dispute/DisputeView.tsx`, `src/ui/state/derive.ts`, `src/ui/state/hubConfig.ts`, `src/ui/layout/ChannelList.tsx`, **`src/ui/App.tsx`, `src/ui/layout/Layout.tsx`, `src/ui/layout/Stream.tsx`**.

The last three are not optional: `deriveState(events)` is a pure function of
events with no access to `HubConfig`, its only production caller is `App.tsx:44`,
and `DisputeViewProps` has no config field. Threading the value requires a
signature change and every layer between. Omitting them is audit F-09's shape
exactly — every layer tested with the prop passed in, and `App` never passing it.

- Both the header and the channel row read `maxRounds` from `/config.json`. Neither clamps: a dispute at round 5 of 3 reads `5 / 3`.
- **Delete** the second `DEFAULT_MAX_ROUNDS` in `ChannelList.tsx:17`. Do not default it.
- **Fixture mode has no `HubConfig` at all** — that is the path `vite dev`, a static build, and every UI test take. Render the fixture's own policy value where present, otherwise `round 5` **with no denominator**. Never `3`: a fallback of 3 reinstates precisely the bug this task removes, and hides the regression it exists to expose.
- The channel-list `human` badge (`derive.ts:112`) reads the current rung by **rule 1**. Frozen at `currentRung ?? 0` it fires only when `human` is the *first* rung, so once the ladder escalates to `human` the person with terminal authority is never told.

**Acceptance.** With `maxRounds: 5`, header and channel row both read `/ 5` and agree. Past the maximum both show the true round. Fixture mode renders no `3` anywhere. Escalating to a `human` rung badges the channel.

### C3 — the human can speak, and can rule

Create `src/ui/layout/Composer.tsx`. Modify `src/ui/layout/Stream.tsx`, `src/ui/state/humanAction.ts`, `src/ui/theme.css`.

- A composer under the stream posting to the active room as `@human` via `POST /events`, `kind: "message"`. Reuse `postHumanAction`'s error handling; its 401 message is already right.
- Enter sends, Shift+Enter newlines, empty sends nothing, the field clears **only** on a confirmed 201.
- **Casting a vote on any open decision `@human` is eligible for**, via the existing `POST /decisions/:id/vote`. No new route, and not optional: A3 makes `human` a reachable ladder rung and A2 resolves that rung on `@human`'s vote, so without this the hub cannot terminate a dispute that escalated to the person with terminal authority. A rung nobody can answer from the UI is the same hole as a decision nobody is told about. A vote requires a rationale — the daemon returns `VOTE_WITHOUT_RATIONALE`, so the control must collect one rather than send an empty string.

`README.md` is **not** Track C's, and not Track B's. The leader holds it and
writes it once all four tracks merge: the Status section is the one file that
cannot be truthful until then.

**Acceptance.** Enter issues one `POST /events` with the active room; the field clears. A failed post keeps the text and shows the reason — losing what someone typed is not an acceptable failure mode. Whitespace-only sends nothing. A decision at the `human` rung can be resolved from the hub, and a vote submitted with no rationale is refused client-side rather than round-tripping a 422.

---

## Track D — the GitHub mirror

**Owns** `src/mirror/` — all new files. Branch `ct/track-d-mirror`. One PR.
Independent of A, B and C; **start immediately**.

Design §8. Not previously built, so this is construction, not repair.

### D1 — the outbound mirror

Create `src/mirror/github.ts`, `src/mirror/queue.ts`, `src/mirror/render.ts`. Test `tests/mirror/`.

- One PR per task: opened as draft at `assigned`, marked ready at `submitted`.
- Mirror the **settled record**, not the chatter: brief, acknowledgement, self-critique summary, each claim with its final resolution, and the deciding decision.
- **One comment per claim, edited in place** rather than appended. This keeps the PR readable and write volume far below rate limits — an appending mirror on a five-round dispute is five comments nobody can follow.
- A queue with retry. **Mirror failure never blocks the protocol.** No remote, no credential, or GitHub unreachable degrades to nothing.
- `gh` via `execFile`, or REST over `node:https`. **Not octokit** — two runtime dependencies, total.
- **The mirror reads the log through `GET /stream?since=<seq>`** and has no path back into the append path, so "mirror failure never blocks the protocol" is structural rather than a discipline. Ordering is `seq` straight from the log; restart catch-up is `since`.
- **It has a caller.** Track D exports from `src/mirror/index.ts`:
  ```ts
  export function startMirror(opts: { repo: string; url: string; token: string; config: MirrorConfig }):
    Promise<{ stop(): Promise<void> }>;
  ```
  **Track B** calls it in `cmdUp` after the daemon is listening, when `mirror.github.enabled`, and `stop()`s it on shutdown — one call site in `src/cli/index.ts`, which Track B owns. Starting it from `up` rather than from inside the daemon is what keeps the mirror separately killable. A subsystem with no caller outside its own tests is the defect this whole plan was opened on; the first draft of D1 reproduced it.

**Acceptance.** A task reaching `assigned` opens a draft PR; `submitted` marks it ready. A claim progressing through contest → uphold → concede leaves **one** comment, edited three times — assert the comment count, not just its content. With the remote unreachable, every protocol operation still succeeds and the queue retries. Tests must not need network: fake the transport at your own boundary, not with a mocked `execFile` that would pass against a typo'd subcommand.

### D2 — the inbound human channel

Create `src/mirror/poll.ts`. **No daemon change — the first draft of this task was wrong to ask for one.**

The mirror posts a pulled comment into `#floor` as `@human` through the existing
`POST /events`, holding `@human`'s token from `.crosstalk/tokens/human`. The
daemon resolves `from` from the presenting token, so attribution is already
correct without a hook. Verified by mutation: changing `from: ctx.who` to a
hard-coded `'@human'` in `#appendMessage` turns
`tests/mirror/daemon-seam.test.ts`'s leader-token case red.

A hook would also be *worse*, which is the part that turned this from
unnecessary into forbidden: any hook letting the mirror inject a message as a
participant is a second path to `from` that does not go through a token —
`FROM_NOT_ALLOWED` reopened for one caller, in the subsystem most exposed to
input from outside this codebase. The mirror holds `@human`'s token and has
exactly the authority that token carries, which is also what makes it safe to
run out of process and kill at any moment.

- `mode: two-way-human` polls every `pollSeconds` while any task is active, pulling comments **authored by the repository owner** into `#floor` as `@human`.
- Only human comments. Agent-authored PR content is never pulled back, or the mirror echoes itself.
- This is the AFK channel: a comment from the GitHub mobile app reaches every agent.

**Acceptance.** An owner comment appears in `#floor` as `@human` exactly once across repeated polls — assert on the second poll, not just the first. A comment the mirror itself wrote is not pulled. `mode: one-way` polls nothing.

---

## Working agreement

- **Two review rounds per task, then the leader decides.**
- **Nits never block a merge.** Not in the acceptance criteria → does not gate.
- **A contract change is a claim to the leader**, answered within one turn.
- **Evidence:** command, output, and the SHA it ran at, for every acceptance criterion. `npm run typecheck` and `npm run build` in every handoff — vitest transpiles without typechecking.
- **Anything binding a port, spawning a process or touching the filesystem: five consecutive runs, report the count.**
- **When a five-run comes back short, check the wall-clock before filing anything.** A run that took 121s against ~33s for its siblings did not find a flake; it found contention. `vitest.config.ts:33` sets `fileParallelism: false`, so test *files* within one run cannot contend — but two `vitest` processes started from two shells contend freely, and the result is indistinguishable from a real flake at the pass-count level. The five-run rule catches genuine flakes; only the durations catch a measurement you generated yourself. Re-measure with nothing else running before naming somebody else's test.
- **Push before you cite.**
- **Post handoffs with `gh pr comment N --body-file`**, then verify:
  ```bash
  gh api repos/moazessam376-dev/crosstalk/issues/N/comments --jq '.[-1].body | length'
  ```

## Merge order

1. **PR #10** — CI fix, this plan, the licence, Task 0. Maintainer approval required; the repository is public.
2. **A** and **B** and **D** in parallel — disjoint files.
3. **C**, rebased onto A, with the live hub pass done *after* the rebase.

## Out of scope

Supervised lifecycle / `spawn`; `policy.planning` as executable code; the tier-3
file inbox; the ledger and PR-list UI surfaces.

**Three of §10.3's five human affordances are deferred, not dropped:** amend a
brief, resolve a dispute directly, and force the ladder to the next rung. Each
needs a daemon route that does not exist, which would be Track A's to add, and
none of them is required for a dispute to terminate. The composer and the vote
**are** in scope (C3) — the vote because A3 makes `human` a reachable rung and
without it the hub cannot answer one.

Raise a claim if you disagree with any of this.
