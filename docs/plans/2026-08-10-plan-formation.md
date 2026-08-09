# Plan Formation Implementation Plan (Track E)

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Status: DRAFT — not frozen.** Under `review` mode per spec §5.6: independent readers raise claims against this plan before it is frozen. Do not implement it yet.

**Goal:** Make spec §5.6 enforceable rather than aspirational — a plan cannot be treated as frozen while claims against it are unresolved, and `doctor` catches an incoherent planning policy before a run starts.

**Architecture:** Pure logic in `src/core/plan.ts` over the existing projection, plus `doctor` validation and a brief template for the reviewer role. No new machinery: a claim can already target `'brief' | 'spec'`, so a plan reviewer uses `raise_claim` exactly as a code critic does.

**Tech stack:** unchanged. No new dependencies.

## Global constraints

All of `AGENTS.md` applies. Additionally:

- `src/contracts/**` and `tests/fixtures/**` are frozen — raise a claim rather than editing.
- `src/daemon/**`, `src/mcp/**`, `src/cli/**` belong to Track D, which is in flight. **Do not touch them.** E4 is deliberately deferred for this reason.
- Two runtime dependencies stay two.

## File ownership

| Path | Purpose |
|---|---|
| `src/core/plan.ts` | freeze gate — new file, no collision |
| `tests/core/plan.test.ts` | its tests |
| `src/harness/doctor.ts` | planning-policy checks — Track C's file, merged, free |
| `src/harness/templates/plan-reviewer.md` | the reviewer role brief |
| `src/harness/brief.ts` | render the new role |

---

## Task E1: The freeze gate

**Files:** Create `src/core/plan.ts` · Test `tests/core/plan.test.ts`

**Interfaces:**
- Consumes: `HubState` from `src/core/projection.js`, `Claim`, `ProtocolError`
- Produces: `function openPlanClaims(state: HubState): Claim[]`, `function isPlanFrozen(state: HubState): boolean`, `function validatePlanFrozen(state: HubState): void`

- [ ] **Step 1: Write the failing test**

```ts
it('is not frozen while a claim against the brief is unresolved', () => {
  const state = stateWithClaim({ against: 'brief', state: 'contested' });
  expect(isPlanFrozen(state)).toBe(false);
  expect(() => validatePlanFrozen(state))
    .toThrowError(expect.objectContaining({ code: 'PLAN_NOT_FROZEN' }));
});

it('is frozen once every plan claim is resolved', () => {
  const state = stateWithClaim({ against: 'spec', state: 'resolved' });
  expect(isPlanFrozen(state)).toBe(true);
  expect(() => validatePlanFrozen(state)).not.toThrow();
});

it('ignores claims against participants', () => {
  const state = stateWithClaim({ against: 'codex', state: 'contested' });
  expect(isPlanFrozen(state)).toBe(true);
});

it('reports every open plan claim, not just the first', () => {
  const state = stateWithClaims([
    { id: 'C-1', against: 'brief', state: 'open' },
    { id: 'C-2', against: 'spec', state: 'contested' },
  ]);
  expect(openPlanClaims(state).map((c) => c.id)).toEqual(['C-1', 'C-2']);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/core/plan.test.ts`, FAIL, module not found
- [ ] **Step 3: Implement.** A plan claim is one whose `against` is `'brief'` or `'spec'`. Open means `state !== 'resolved'`. `validatePlanFrozen` throws `ProtocolError('PLAN_NOT_FROZEN', …)` naming every open claim id, not just a count — a message that says "3 open claims" sends the reader looking.
- [ ] **Step 4: Run to verify it passes** — PASS, 4 tests
- [ ] **Step 5:** `git commit -m "Refuse to treat a plan as frozen while claims against it are open"`

**Note for the reviewer:** `PLAN_NOT_FROZEN` is not in the frozen `ErrorCode` union. Raise a claim asking the leader to add it — do not add it yourself.

---

## Task E2: Doctor checks the planning policy

**Files:** Modify `src/harness/doctor.ts` · Test `tests/harness/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('warns when review mode has no reviewers', async () => {
  const f = await doctor(cfg({ planning: { mode: 'review', agents: 0, selection: 'leader' } }), repo);
  expect(f).toContainEqual(expect.objectContaining({ level: 'warn', code: 'PLANNING_NO_REVIEWERS' }));
});

it('rejects panel mode with fewer than two drafters', async () => {
  const f = await doctor(cfg({ planning: { mode: 'panel', agents: 1, selection: 'majority' } }), repo);
  expect(f).toContainEqual(expect.objectContaining({ level: 'reject', code: 'PLANNING_PANEL_TOO_SMALL' }));
});

it('warns when reviewers outnumber available non-leader participants', async () => {
  const f = await doctor(cfg({ workers: 1, planning: { mode: 'review', agents: 3, selection: 'leader' } }), repo);
  expect(f).toContainEqual(expect.objectContaining({ level: 'warn', code: 'PLANNING_REVIEWERS_UNAVAILABLE' }));
});

it('says nothing about planning when the policy is absent', async () => {
  const f = await doctor(cfg({}), repo);
  expect(f.filter((x) => x.code.startsWith('PLANNING_'))).toHaveLength(0);
});
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement.** `planning` is optional; absent means the default and produces no finding. Every finding carries a remedy naming the capability lost — the existing "every finding carries a remedy" test covers these automatically, and must keep passing.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** `git commit -m "Check the planning policy is coherent before a run starts"`

---

## Task E3: The plan-reviewer role brief

**Files:** Create `src/harness/templates/plan-reviewer.md` · Modify `src/harness/brief.ts` · Test `tests/harness/brief.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('renders a plan-reviewer brief distinct from a worker brief', () => {
  const a = renderBrief(reviewer(), descriptor(), policy(), 'mcp');
  expect(a).toContain('raise a claim against the plan');
  expect(a).not.toContain('open a draft PR');
});

it('tells the reviewer it may not implement', () => {
  expect(renderBrief(reviewer(), descriptor(), policy(), 'mcp'))
    .toContain('You do not implement');
});

it('changes version when the planning policy changes', () => {
  const a = renderBrief(reviewer(), descriptor(), policy({ planning: { mode: 'review', agents: 1, selection: 'leader' } }), 'mcp');
  const b = renderBrief(reviewer(), descriptor(), policy({ planning: { mode: 'panel', agents: 3, selection: 'majority' } }), 'mcp');
  expect(briefVersion(a)).not.toBe(briefVersion(b));
});
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement.** The template states: the reviewer reads the plan and raises claims against it; it does not implement; independence from the author is the point, so it must not "improve" a section it would then be unable to question.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** `git commit -m "Add the plan-reviewer role brief"`

---

## Task E4 — deferred

Wiring `validatePlanFrozen` into the daemon's `POST /tasks`, so a task cannot be created while the plan is disputed. **Blocked on Phase D**, which owns `src/daemon/**` and is in flight. Named here so it is not forgotten and not attempted.

---

## Self-review

**Spec coverage.** §5.6's three modes → E2 validates their coherence. "The freeze is a gate, not a moment" → E1. "Reviewers must be independent of the author" → E3's template. The enforcement point that would actually block work → E4, deferred with a reason.

**Known gap, stated rather than hidden:** E1–E3 make the gate *available*; nothing calls it until E4. A reviewer should ask whether that is worth shipping, or whether Track E should wait for Phase D entirely. I think it is worth shipping — the logic and its tests are the part most likely to be wrong, and having them settled before the daemon needs them is the same argument Phase 0 made. But it is a real question and I would rather be argued out of it than have it go unnoticed.
