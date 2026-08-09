# Full project audit — 2026-08-10

## Scope and review basis

This is an independent audit of `main` at `5602842f5e9df2e9e5501268b2670a4ab4249b9a`, run from the detached-main audit worktree before creating this branch. No product source, contract, or fixture files were changed. The only committed artifact from this work is this review.

The review covered the frozen contracts, core projection and validators, workspace and harness code, fixture-driven UI, the CI/build surface, and the Phase D boundary. The daemon/MCP/CLI implementation is not present on `main`; `origin/track-d/runtime` contains a proposed HTTP contract, not code merged into this audit base. I therefore did not invent findings about routes that do not yet exist.

## Executive summary

There are two release blockers, four defects, and three risks:

| Severity | Finding | Consequence |
| --- | --- | --- |
| blocker | F-01 stale evidence does not reopen dependent state | obsolete proof can remain resolved, and a submitted task cannot recover to `in_progress` |
| blocker | F-02 advertised CLI entrypoint is absent | the package metadata promises `crosstalk`/`ct`, but the built artifact has no CLI module |
| defect | F-03 `uphold` accepts a rebuttal without a falsifier | the hard falsifier invariant is bypassed by one response path |
| defect | F-04 undefined transport is rendered as `file` | an unprobed participant is reported as if doctor had probed the lowest tier |
| defect | F-05 `#floor` is not seeded | a log with no floor message has no floor channel |
| defect | F-06 accepted claims display as `triaged` | the UI contradicts the projection and presents a resolved claim as unresolved |
| risk | F-07 skipped ladder rungs disappear | the UI hides why a dispute was degraded |
| risk | F-08 unknown protocol events silently degrade to generic cards | malformed or newer events can look like ordinary protocol text |
| risk | F-09 visible human controls have no handler in the shipped `App` | buttons render but do nothing on the actual signature screen |

No nit findings survived the self-critique. Phase D absence from `main` is recorded as a coverage boundary, not as a false claim that an unmerged implementation is broken.

## Findings

### F-01 — blocker: stale evidence does not reopen dependent state

**Claim.** The replay and task state machine do not implement the design’s stale-evidence recovery rule. `evidence_stale` marks an evidence item but leaves a resolved claim resolved, while `rebase_notice` is a no-op and `submitted` has no legal transition back to `in_progress`.

**Expected behavior.** Design §5.4 says a claim resolved solely by stale evidence reopens and a submitted task whose submission evidence went stale receives `rebase_notice` and returns to `in_progress`.

**Evidence.** Base SHA for every command in this finding: `5602842f5e9df2e9e5501268b2670a4ab4249b9a`.

- `rg -n "submitted:|rebase_notice|evidence_stale|Illegal task transition" src/core/tasks.ts src/core/projection.ts` shows `submitted: ['under_review']`, `case 'rebase_notice': return state`, and stale evidence being copied without changing claim state.
- A built replay probe with a resolved/upheld claim followed by `evidence_stale` printed:

  ```text
  {"state":"resolved","resolution":"upheld","evidenceStale":true}
  ```

- A built task probe with a submitted task followed by `rebase_notice` printed:

  ```text
  {"transition":"ILLEGAL_TRANSITION: Illegal task transition: submitted -> in_progress","projectedStateAfterRebase":"submitted","lastSeq":2}
  ```

- The deliberate mutation `submitted: ['under_review', 'in_progress']` was applied only in this audit worktree. `npm test -- --run tests/core/tasks.test.ts` still reported `1 passed` file and `6 passed` tests. The mutation was restored and the worktree rechecked clean. This is a test-gap signal: the green task suite does not discriminate the missing recovery edge.

**Impact.** Once a merge makes submitted evidence stale, the protocol can continue to treat the old proof as an upheld resolution, and the affected task cannot be sent back through work and self-review. That defeats the safety property that evidence is tied to the code it was run against.

**Falsifier.** This finding would be wrong if replaying a resolved claim with `evidence_stale` produced a non-resolved claim and validating `submitted → in_progress` succeeded, or if another shipped event handler performed those transitions. Neither happened at the audited SHA.

### F-02 — blocker: the advertised CLI entrypoint is absent from the build

**Claim.** `package.json` exposes `./dist/cli/index.js` as both `crosstalk` and `ct`, but the source tree has no `src/cli`, and the successful build produces no `dist/cli`.

**Evidence.** Base SHA: `5602842f5e9df2e9e5501268b2670a4ab4249b9a`.

- `Get-Content -Raw package.json` shows both bin entries pointing to `./dist/cli/index.js`.
- `Get-ChildItem src -Directory` returns only `contracts`, `core`, `harness`, `ui`, and `workspace`; no daemon, MCP, or CLI directory is present on `main`.
- `npm run build` passed, but the direct built-artifact probe printed:

  ```text
  cli=missing:ENOENT
  ```

Phase D is explicitly in flight, so this is not a finding against the unmerged daemon design. It is still a release blocker if the package metadata is treated as a runnable public entrypoint before Phase D lands.

**Falsifier.** This finding would be wrong if the audited build contained `dist/cli/index.js` or if invoking the advertised bin resolved to a real module. The artifact probe found neither.

### F-03 — defect: `uphold` bypasses the required falsifier

**Claim.** `validateResponse` validates a falsifier for `contest` and `amend`, but the `uphold` branch checks only for new evidence. A contested claim can therefore receive an uphold rebuttal with no falsifier.

**Evidence.** Base SHA: `5602842f5e9df2e9e5501268b2670a4ab4249b9a`.

- `src/core/claims.ts:57-80` shows `uphold` returning after the new-evidence check, with no `validateFalsifier` call. This conflicts with the AGENTS hard rule that `falsifier` is required on every claim and rebuttal.
- The built validator probe supplied a valid contested claim, a new evidence item, and omitted `falsifier`. It printed:

  ```text
  {"missingFalsifierResponse":"accepted"}
  ```

**Impact.** The response can enter the append-only record without the discriminating observation needed to settle it at a later dispute rung. The invariant is enforced selectively rather than at the validator boundary.

**Falsifier.** This finding would be wrong if the same input were rejected with `MISSING_FALSIFIER` or `VACUOUS_FALSIFIER` before it could be accepted. It was accepted at the audited SHA.

### F-04 — defect: an undefined transport is displayed as `file`

**Claim.** `projectParticipants` defaults `participant.transport` to `'file'`, and the rail always renders the resulting badge. This turns “not probed” into the claim “doctor probed and the participant fell back to tier 3.”

**Expected behavior.** Design §10.1 explicitly requires no tier badge when `transport` is undefined; `file` is reserved for a probed lowest tier.

**Evidence.** Base SHA: `5602842f5e9df2e9e5501268b2670a4ab4249b9a`.

- `src/ui/state/derive.ts:64-71` contains `tier: participant.transport ?? 'file'`.
- `src/ui/layout/Rail.tsx:24-35` renders `participant.tier` unconditionally.
- The focused `vite-node` UI-state probe passed a joined participant with no `transport` and printed:

  ```text
  {"participants":[{"id":"worker","role":"worker","status":"awaiting_turn","tier":"file"}],"rooms":[]}
  ```

**Falsifier.** This finding would be wrong if an unprobed participant produced an absent/undefined tier and the rail omitted the badge. The probe produced `file`.

### F-05 — defect: `#floor` is not seeded

**Claim.** The UI room projection starts with an empty map and creates rooms only from event `room` fields. A log with participants but no floor message therefore has no `#floor` channel.

**Expected behavior.** Design §2.2 says `#floor` is seeded from the `FLOOR` constant because it must exist before anyone speaks there.

**Evidence.** Base SHA: `5602842f5e9df2e9e5501268b2670a4ab4249b9a`.

- `src/ui/state/derive.ts:75-83` initializes `new Map()` and only inserts `event.room`.
- The same focused UI-state probe used for F-04 returned `"rooms":[]` for a log containing a participant join and no floor message.

**Impact.** The landing surface can omit the universal coordination channel and can choose no active room at all for an otherwise valid session.

**Falsifier.** This finding would be wrong if the minimal participant-only log derived a room with `{ "id": "#floor", "kind": "floor" }`. It derived no rooms.

### F-06 — defect: an accepted claim is displayed as `triaged`

**Claim.** The dispute view maps an `accept` response to `triaged`, while the core projection maps the same response to `resolved` with resolution `upheld`, and the design’s lifecycle says accept → resolved.

**Evidence.** Base SHA: `5602842f5e9df2e9e5501268b2670a4ab4249b9a`.

- `src/ui/dispute/DisputeView.tsx:88-103` returns `triaged` for `case 'accept'`.
- `src/core/projection.ts:65-75` returns `resolved` and `upheld` for `accept`.
- `rg -n "accept|resolved:upheld|triaged" docs/specs/2026-08-09-crosstalk-design.md src/core/projection.ts src/ui/dispute/DisputeView.tsx` shows the UI/core/spec mismatch.

**Impact.** The signature screen can show a claim as still triaged immediately after the protocol has recorded a terminal acceptance, misleading the operator and any UI logic keyed on claim state.

**Falsifier.** This finding would be wrong if the accepted response reached the UI with `state: 'resolved'`, or if the UI branch returned `resolved` rather than `triaged`. The audited branch contains the opposite mapping.

### F-07 — risk: skipped dispute rungs disappear

**Claim.** The plan requires a skipped rung to remain visible with `data-state="skipped"`, but the decision contract has no skipped metadata and `DisputeView` renders only the current `decision.ladder` entries with `data-current`.

**Evidence.** Base SHA: `5602842f5e9df2e9e5501268b2670a4ab4249b9a`.

- `docs/plans/2026-08-09-crosstalk-v1.md:990-1003` specifies a visible skipped rung and a `skipped` prop.
- `src/contracts/decision.ts` defines `ladder?: LadderRung[]` and `currentRung?: number`, with no skipped-rung field.
- `src/ui/dispute/DisputeView.tsx:151-168` maps only `(decision.decision.ladder ?? [])` and emits no `data-state="skipped"`.
- `src/core/decisions.ts:11-16` removes `third_agent` from the resolvable ladder when there are fewer than two workers, with no record of the omitted rung for the UI.

**Impact.** A degraded dispute can look like an intentional shorter ladder. Operators lose the reason a third-agent check was unavailable, exactly where the protocol says degradation should be visible.

**Falsifier.** This finding would be wrong if a shipped decision event carried skipped-rung information and the rendered ladder emitted a visible skipped node. The contract and renderer carry neither.

### F-08 — risk: unknown protocol events silently degrade to generic cards

**Claim.** The plan requires an unknown event kind to throw so a new protocol event cannot silently become message-like text. `ProtocolCard` instead has a default generic card, and `useLog` casts JSON directly to `CrosstalkEvent` without runtime validation.

**Evidence.** Base SHA: `5602842f5e9df2e9e5501268b2670a4ab4249b9a`.

- `docs/plans/2026-08-09-crosstalk-v1.md:953-957` says the card switch must throw on an unknown kind.
- `src/ui/cards/ProtocolCard.tsx:55-61` renders `protocol event` plus `event.kind` in its default branch.
- `src/ui/state/useLog.ts:17-22` and `:59-66` parse arbitrary JSON and cast it, rather than validating the event kind before rendering.

**Impact.** A malformed fixture or a server event newer than this UI can appear as a legitimate, low-information card instead of surfacing a protocol incompatibility. That makes the stream less trustworthy during upgrades.

**Falsifier.** This finding would be wrong if an unknown JSON event caused the UI ingestion/card path to throw or otherwise surfaced an explicit unsupported-event error. The source path intentionally falls through to a generic card.

### F-09 — risk: the shipped `App` leaves human controls unwired

**Claim.** `DisputeView`, `Stream`, and `Layout` accept and forward `onHumanAction`, but `App` renders `Layout` without that prop. The actual fixture-driven signature screen therefore renders buttons whose optional callbacks are undefined.

**Evidence.** Base SHA: `5602842f5e9df2e9e5501268b2670a4ab4249b9a`.

- `src/ui/App.tsx:20-24` passes only `state`, `activeRoom`, and `onSelectRoom` to `Layout`.
- `src/ui/layout/Layout.tsx:14-19,41-44` accepts `onHumanAction` and forwards it to `Stream`.
- `src/ui/layout/Stream.tsx:15-19,85-87` forwards it to `DisputeView`.
- `src/ui/dispute/DisputeView.tsx:203-215` invokes the callback with optional chaining, so no handler means no event or visible error.

This is marked risk rather than a Phase D protocol defect: the daemon/HTTP implementation is not on `main`, but the current UI presents the controls already.

**Falsifier.** This finding would be wrong if clicking either visible button in the actual `App` caused a posted `propose_test` or `intervene_human` event. The application wiring supplies no callback for either click.

## Verification record

All baseline evidence below was run at `5602842f5e9df2e9e5501268b2670a4ab4249b9a` in the isolated audit worktree:

- `npm test` — PASS: 22 test files, 105 tests.
- `npm run typecheck` — PASS.
- `npm run build` — PASS: TypeScript plus Vite production build; 34 modules transformed.
- Vite preview smoke — HTTP 200 for the built `index.html` and HTTP 200 for the fixture asset.
- The in-app browser bootstrap was attempted twice against the preview URL. Both attempts failed before a tab opened with `windows sandbox failed: helper_unknown_error: apply deny-read ACLs`. I do not claim a visual browser pass; this host limitation is recorded rather than hidden.
- Windows-only verification was possible here. macOS and Linux were not independently exercised; the repository CI workflow remains the cross-platform check.

## Checked and dismissed

- The proposed Phase D HTTP routes, MCP tools, CLI, and daemon lifecycle were not filed as implementation bugs because those modules are absent from `main`; `origin/track-d/runtime` contains a draft contract only.
- The inclusive `EventLog.readFrom(seq)` behavior is deliberate in the current core API; the proposed daemon contract calls it with `since + 1` for exclusive HTTP `since` semantics.
- The self-review event and fixture gate are reachable in the audited A–C tree; the fixture guard covers the gate event shape. No finding was filed there.
- The project currently has exactly the two allowed runtime dependencies, uses `node:path`, and the workspace git code uses `execFile`. No dependency or shell-rule finding was filed.
- `writeBrief` was exercised through its existing two-write test on Windows and passed; the possible overwrite concern was not strong enough to file.

## Self-critique record

### Round 1

- **F-01:** challenged as possibly “Phase D only.” Counter-evidence: `evidence_stale` and `rebase_notice` are already frozen event kinds handled by shipped projection/core state, and the direct probes show the required recovery is impossible. Retained as blocker.
- **F-03:** challenged as possibly applying only to `contest`. Counter-evidence: `uphold` is a `ContestVerdict` rebuttal and AGENTS requires falsifiers on every rebuttal; the validator accepts the missing field. Retained as defect.
- **F-04/F-05:** challenged as fixture-only UI details. Counter-evidence: both are pure `deriveState` behavior on a minimal valid log, and the design explicitly defines the pre-message floor and unprobed transport distinction. Retained as defects.
- **F-06–F-09:** challenged as component-level rather than integration findings. Counter-evidence: the source path from `App` to the rendered components is what determines the shipped behavior; the review brief specifically warns that prop-level component tests do not prove the handoff. Retained at defect/risk severity as marked.

### Round 2

- The stale-evidence claim and task recovery consequences were checked separately so one probe could not hide the other. Both fail independently; they remain one blocker because they are the same lifecycle invariant and should be fixed together.
- The absent CLI was downgraded from a claim about Phase D completeness to a precise package-release claim: the bin is advertised now, and the built file is absent now. It remains a blocker for publishing the current package, not a claim that the unmerged daemon track has failed.
- The unknown-event and unwired-control findings were kept as risks, not blockers, because the current UI is fixture-driven while Phase D transport is still in flight.

