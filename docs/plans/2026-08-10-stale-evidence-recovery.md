# Stale Evidence Recovery Implementation Plan (Track F)

**Status: FROZEN** at this revision. Reviewed under spec §5.6 by the implementing track before any code was written — fourteen findings, fourteen upheld. The revision below is the result; see the Review record at the end.

**Goal:** Implement the *consequences* of spec §5.4. Detection already exists and is tested (`evaluateStaleness` in `src/workspace/staleness.ts`); nothing acts on it.

**Corrected framing:** the original draft said §5.4 was "entirely unimplemented". That was wrong and the error mattered — it hid the fact that the detector is claim-scoped and produces no task-scoped output at all, so nothing in this repository can determine that a *submitted task's* evidence went stale. F3 exists because of that correction.

**Tech stack:** unchanged. No new dependencies. No contract changes.

## Global constraints

All of `AGENTS.md`. Additionally:

- `src/contracts/**` and `tests/fixtures/**` are frozen. Raise a claim rather than editing.
- `src/daemon|mcp|cli/**` belong to Track D, in flight. **Do not touch.**
- `src/ui/**` belongs to the leader for this work — see F5, which is **not yours**.

## File ownership

| Path | Purpose |
|---|---|
| `src/core/projection.ts` | `rebase_notice` and `evidence_stale` consequences |
| `src/workspace/staleness.ts` | task-scoped staleness output — **now owned by Track F**, was unowned |
| `tests/core/projection.test.ts`, `tests/workspace/staleness.test.ts` | their tests |

**`src/core/tasks.ts` is deliberately absent.** See F-P5.

### Test helpers do not exist — author them

Eight of the nine helpers the draft used were pseudocode: `aCritique`, `claimRaised`, `claimResolved`, `evidenceStale`, `taskCreated`, `taskState`, `rebaseNotice`, `ev`. Only `stateWithTask` is real. **Write the helpers you need**; a missing-helper error means the helper is missing, not that your test is wrong.

**There is no event that sets a resolution.** Resolution is derived from a `claim_response` verdict by `resolutionForVerdict`: `accept → upheld`, `concede → withdrawn`, `amend → superseded`. Build every resolved-claim fixture from `claim_response`.

And because `validateResponse` requires evidence on `accept`, **every `resolved`/`upheld` claim reachable through the API carries the accepter's fix evidence.** A test over a claim without it is a test of an unreachable state.

---

## Task F1: `rebase_notice` returns a submitted task to in_progress

**Files:** Modify `src/core/projection.ts` · Test `tests/core/projection.test.ts`

**The transition table is not widened, and this is the whole transition fix.** The draft also widened `submitted` in `src/core/tasks.ts`; that was wrong. `validateTransition` governs what the daemon accepts *from clients*, so widening it would make `submitted → in_progress` legal for any participant-authored `task_state` — letting a worker pull its own task out of the review queue at will, with nothing recording that a rebase happened. The projection folds without validating, so `rebase_notice` can move the task while the table keeps clients out.

**Consequence for Phase D, recorded here:** the daemon emits `rebase_notice` and **must not** also emit `task_state: in_progress`. That event would be illegal (`in_progress` is not in its own transition list) and would fail the fixture guard, which is correct to reject it.

- [ ] **Step 1: Write the failing test**

```ts
it('returns a submitted task to in_progress on rebase_notice', () => {
  const state = project([taskCreated('T-1'), taskState('T-1', 'submitted'), rebaseNotice('T-1', 'abc123')]);
  expect(state.tasks.get('T-1')?.state).toBe('in_progress');
});

// Discrimination: any other state must be untouched, or the handler is
// just "set every task to in_progress on any rebase".
it.each(['accepted', 'merged', 'under_review'] as const)('leaves a %s task alone on rebase_notice', (s) => {
  const state = project([taskCreated('T-1'), taskState('T-1', s), rebaseNotice('T-1', 'abc123')]);
  expect(state.tasks.get('T-1')?.state).toBe(s);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/projection.test.ts -t "rebase_notice"`
Expected: FAIL — the first test reports `submitted`, because the handler is `return state`. Confirm that is the reason. Counts in these steps are advisory; `-t` is a substring match and may select neighbours.

- [ ] **Step 3: Implement** — move to `in_progress` **only** from `submitted`.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** `git commit -m "Return a submitted task to in_progress on rebase notice"`

---

## Task F2: A resolved claim reopens when its evidence goes stale

**Files:** Modify `src/core/projection.ts` · Test `tests/core/projection.test.ts`

**Three rulings are baked in here. Do not re-derive them:**

1. **Reopen when *any* evidence item is stale**, not when all are. `Claim.evidence` is one flat array mixing the raiser's support, counter-evidence and the accepter's fix evidence, and `Evidence` has no field distinguishing them. "All stale" keeps a claim resolved when the accepter's fix evidence went stale but the raiser's old evidence did not — the exact case §5.4 exists for. This errs toward re-checking: a false reopen costs one cheap re-run, a false stay-resolved hides a regression behind a green record.
2. **Reopen to `open`, not `contested`.** `upheld` comes only from `accept`, so the target agreed and nobody contested. It is also a routing bug: `validateResponseAuthority` expects `claim.against` on `open` and requires `claim.raisedBy` on `contested`, so reopening to `contested` demands a response from the raiser when the accepter owes the re-run.
3. **`rounds` is not reset.** A reopened claim is `open`, so it takes a triage verdict; the round cap governs the ladder, which is a dispute mechanism. If it is contested again past the cap, the ladder engages immediately — correct, since this argument already had its rounds.

- [ ] **Step 1: Write the failing test**

```ts
it('reopens a resolved claim when any of its evidence goes stale', () => {
  const state = project([...acceptedClaim('C-1', ev('sha-raiser'), ev('sha-fix')), evidenceStale('C-1', 'sha-fix')]);
  const claim = state.claims.get('C-1')!;
  expect(claim.state).toBe('open');              // exact state, not `not.toBe('resolved')`
  expect('resolution' in claim).toBe(false);      // key omitted, not set to undefined
  expect(claim.rounds).toBe(1);                   // unchanged by the reopen
});

// F-P8: [].every(...) is true, so an evidence-free claim would reopen on a
// sha it never carried. The existing suite already builds such a claim.
it('does not reopen a resolved claim that carries no evidence at all', () => {
  const state = project([...acceptedClaimNoEvidence('C-2'), evidenceStale('C-2', 'never-on-this-claim')]);
  expect(state.claims.get('C-2')?.state).toBe('resolved');
});

it('does not resurrect a withdrawn claim', () => {
  const state = project([...concededClaim('C-3', ev('sha-old')), evidenceStale('C-3', 'sha-old')]);
  expect(state.claims.get('C-3')?.state).toBe('resolved');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/projection.test.ts -t "stale"`
Expected: FAIL — the first test reports `resolved`, because `evidence_stale` only marks the item.

- [ ] **Step 3: Implement** — mark the item; then if the claim is `resolved` with resolution `upheld`, **carries at least one evidence item**, and any item is now stale: set `state: 'open'` and **omit** the `resolution` key rather than setting it to `undefined` (an own `undefined` key survives serialisation and the determinism test compares serialised state).
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** `git commit -m "Reopen a resolved claim when its evidence goes stale"`

---

## Task F3: Task-scoped staleness, so F1's event can be emitted for the right reason

**Files:** Modify `src/workspace/staleness.ts` · Test `tests/workspace/staleness.test.ts`

`evaluateStaleness` returns `{ claimId, sha }[]` — claim-scoped only. Nothing can determine that a *submitted task's* evidence went stale, which is F1's precondition. Without this, F1 makes an event mean something that nothing can correctly decide to emit.

**"Submission evidence" means `Task.critique.findings[].closedBy`** — the only `Evidence` reachable from a `Task`. Stated because the draft left it undefined.

- [ ] **Step 1: Write the failing test** — build a real throwaway repo (do not mock git), a task in `submitted` whose `critique.findings[].closedBy` cites a SHA on an orphan branch, and assert `evaluateTaskStaleness` reports that task. A second task whose evidence SHA is an ancestor of HEAD must **not** be reported.
- [ ] **Step 2: Run — FAIL**, module member not found
- [ ] **Step 3: Implement** `evaluateTaskStaleness(tasks, head, cwd): Promise<{ taskId, sha }[]>`, reusing the existing ancestry check and deduplicating SHA lookups.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** `git commit -m "Report which submitted tasks have stale submission evidence"`

---

## Task F4: Prove the suite catches what it is for

**Files:** none. A verification step, reported in the handoff, not committed.

Run each mutation, confirm a test fails, restore it, and report all four results. **If any survives, that test is not testing what you think and the task is not done.**

1. `rebase_notice` sets **every** task to `in_progress` regardless of current state.
2. `rebase_notice` moves `under_review` to `in_progress` as well as `submitted`.
3. The reopen fires for **any** resolution, not only `upheld` — so a `withdrawn` claim resurrects.
4. Delete the empty-evidence guard, so `[].every(...)` reopens an evidence-free claim.

Mutation 4 came from the review: it survives the other three, which is exactly why it is named.

---

## Not this track — F5, owned by the leader

`displayState` in `src/ui/dispute/DisputeView.tsx` returns `resolved` for a claim F2 has reopened: the last verdict is still `accept`, and clearing `claim.resolution` only skips an early return. So the core says reopened and the signature screen says resolved.

`tests/ui/verdict-parity.test.ts` exists on `main` at `294ebd6` — the review's claim that it was missing was true at that branch point and is now stale. But it maps **verdicts** to states, and this reopen is **evidence-driven**, so it does not cover this case.

**This is the leader's to fix, and it is being done now rather than filed** — an unowned obligation is how F-04 and F-05 survived a concession and shipped anyway.

---

## Review record

Reviewed under spec §5.6 by the implementing track before writing code, PR #7. **Fourteen claims, fourteen upheld, none contested.**

Two changed what gets built: **F-P5** deleted the transition-table widening after showing it would let a worker pull its own task out of review, and **F-P6** showed that reopening to `contested` routes the response to the wrong participant. **F-P8** supplied the surviving mutation the leader had asked for on a different PR. **F-P9** corrected the plan's own framing of what was missing, which changed the scope.

The rest — helpers that did not exist, an event that does not exist, an assertion that could not distinguish right from wrong, `-t` filters that select more than the counts claim, and an `undefined` key that survives serialisation — were all real, and all in a plan written after two other plans had already been improved by review.
