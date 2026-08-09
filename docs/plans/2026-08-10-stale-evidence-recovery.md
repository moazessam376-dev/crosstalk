# Stale Evidence Recovery Implementation Plan (Track F)

**Status: DRAFT — under review per spec §5.6.** Do not implement until frozen.

**Goal:** Implement spec §5.4, which is currently specified and has no code behind it. A claim resolved solely by stale evidence must reopen, and a `submitted` task whose submission evidence went stale must return to `in_progress` on `rebase_notice`.

**Why this exists:** an independent audit (F-01, PR #6) found §5.4 entirely unimplemented — `submitted: ['under_review']` with no path back, and `case 'rebase_notice': return state`. The leader had reviewed that track and declared it clean without checking the spec section against the transition table.

**Tech stack:** unchanged. No new dependencies.

## Global constraints

All of `AGENTS.md`. Additionally:

- `src/daemon/**`, `src/mcp/**`, `src/cli/**` belong to Track D, in flight. **Do not touch them.**
- `tests/fixtures/**` is frozen and leader-owned. If a fixture needs a new event, raise a claim.
- `src/contracts/**` is frozen. `rebase_notice` and `evidence_stale` already exist; you should not need a contract change. Raise a claim if you disagree.

## File ownership

| Path | Purpose |
|---|---|
| `src/core/tasks.ts` | the transition table and its gate |
| `src/core/projection.ts` | `rebase_notice` and `evidence_stale` handling |
| `tests/core/tasks.test.ts`, `tests/core/projection.test.ts` | their tests |

---

## Task F1: A submitted task can return to in_progress

**Files:** Modify `src/core/tasks.ts` · Test `tests/core/tasks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('allows submitted -> in_progress, because a rebase can invalidate submitted evidence', () => {
  const state = stateWithTask('T-1', 'submitted', { critique: aCritique() });
  expect(() => validateTransition('T-1', 'in_progress', state)).not.toThrow();
});

// The neighbouring case that must NOT become legal. Without this, widening the
// table to `submitted: [...everything]` would pass the test above.
it('still refuses submitted -> accepted', () => {
  const state = stateWithTask('T-1', 'submitted', { critique: aCritique() });
  expect(() => validateTransition('T-1', 'accepted', state))
    .toThrowError(expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/tasks.test.ts -t submitted`
Expected: FAIL on the first test with `ILLEGAL_TRANSITION`. **Confirm that is the reason** — a missing-helper error means the test is wrong, not the code.

- [ ] **Step 3: Implement** — `submitted: ['under_review', 'in_progress']`. Nothing else in the table changes.
- [ ] **Step 4: Run to verify it passes** — PASS, both tests
- [ ] **Step 5:** `git commit -m "Allow a submitted task back to in_progress after a rebase"`

---

## Task F2: rebase_notice returns the task to in_progress

**Files:** Modify `src/core/projection.ts` · Test `tests/core/projection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('returns a submitted task to in_progress on rebase_notice', () => {
  const state = project([taskCreated('T-1'), taskState('T-1', 'submitted'), rebaseNotice('T-1', 'abc123')]);
  expect(state.tasks.get('T-1')?.state).toBe('in_progress');
});

// Discrimination: a task that is not submitted must be left alone, or the
// handler is just "set every task to in_progress on any rebase".
it('leaves an accepted task alone on rebase_notice', () => {
  const state = project([taskCreated('T-1'), taskState('T-1', 'accepted'), rebaseNotice('T-1', 'abc123')]);
  expect(state.tasks.get('T-1')?.state).toBe('accepted');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/projection.test.ts -t rebase`
Expected: FAIL — the first test reports `submitted`, because the handler is a no-op.

- [ ] **Step 3: Implement** — `rebase_notice` moves a task to `in_progress` **only when its current state is `submitted`**. Every other state is untouched.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** `git commit -m "Return a submitted task to in_progress on rebase notice"`

---

## Task F3: A claim reopens when the evidence holding it up goes stale

**Files:** Modify `src/core/projection.ts` · Test `tests/core/projection.test.ts`

Spec §5.4: *"A claim resolved solely by now-stale evidence reopens."* The word **solely** is load-bearing — a claim with one stale item and one fresh item does not reopen.

- [ ] **Step 1: Write the failing test**

```ts
it('reopens a resolved claim when its only supporting evidence goes stale', () => {
  const state = project([claimRaised('C-1', [ev('sha-old')]), claimResolved('C-1', 'upheld'), evidenceStale('C-1', 'sha-old')]);
  const claim = state.claims.get('C-1')!;
  expect(claim.state).not.toBe('resolved');
  expect(claim.resolution).toBeUndefined();
});

it('leaves a resolved claim alone when other evidence is still fresh', () => {
  const state = project([claimRaised('C-1', [ev('sha-old'), ev('sha-new')]), claimResolved('C-1', 'upheld'), evidenceStale('C-1', 'sha-old')]);
  expect(state.claims.get('C-1')?.state).toBe('resolved');
});

it('does not resurrect a withdrawn claim', () => {
  const state = project([claimRaised('C-1', [ev('sha-old')]), claimResolved('C-1', 'withdrawn'), evidenceStale('C-1', 'sha-old')]);
  expect(state.claims.get('C-1')?.state).toBe('resolved');
});
```

The third case is the one to think about: a **withdrawn** claim was conceded by its raiser, not proven by evidence. Stale evidence says nothing about it, and reopening it would resurrect an argument both parties had settled.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/projection.test.ts -t stale`
Expected: FAIL — the first test reports `resolved`, because `evidence_stale` only marks the item.

- [ ] **Step 3: Implement** — on `evidence_stale`, mark the item; then if the claim is `resolved` with resolution `upheld` **and** every evidence item is now stale, clear `resolution` and return the claim to `contested`.
- [ ] **Step 4: Run — PASS, 3 tests**
- [ ] **Step 5:** `git commit -m "Reopen a claim whose supporting evidence has all gone stale"`

---

## Task F4: Prove the suite would have caught this

**Files:** none — this is a verification step, reported not committed.

The audit found F-01 by mutation, and the suite that missed it was green. Before handing off, run the same mutation against your own work:

- [ ] Widen `submitted` to include a state it should not reach, re-run — a test must fail.
- [ ] Make `rebase_notice` set every task to `in_progress` regardless of state, re-run — a test must fail.
- [ ] Make `evidence_stale` reopen every resolved claim, re-run — a test must fail.

Restore each mutation and confirm the tree is clean. **Report all three results in your handoff.** If any mutation survives, that test is not testing what you think and the task is not done.

---

## Self-review

**Spec coverage.** §5.4 sentence 1 (claims reopen) → F3. Sentence 2 (`rebase_notice` → `in_progress`) → F1 and F2. The `solely` qualifier → F3's second test. The transition table gap → F1.

**Deliberate omission:** nothing emits `rebase_notice` yet. Producing it is the daemon's job on merge, and that is Track D's file. This track makes the event *do* something; wiring the trigger is Phase D. Stated here rather than discovered later.

**Known risk:** F3's rule is "resolved + upheld + all evidence stale". A reviewer should ask whether `amended` and `superseded` resolutions deserve the same treatment. I think not — both were replaced by a newer claim that carries its own evidence — but I have not proven it and would rather be argued out of it.
