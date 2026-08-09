# Plan Formation Implementation Plan (Track E)

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Status: DRAFT — not frozen.** Under `review` mode per spec §5.6: independent readers raise claims against this plan before it is frozen. Do not implement it yet.

**Goal:** Build the pieces spec §5.6 enforcement needs — the freeze predicate, the policy checks, and the reviewer role — and prove each in isolation.

**E1–E3 are explicitly preparatory, not the feature.** Nothing calls `validatePlanFrozen` until E4 wires it into the daemon's `POST /tasks`, so **§5.6 is not enforced when E1–E3 merge** and this track must not be described as delivering it. E4 is the acceptance boundary; E1–E3 are its prerequisites. Corrected after review claim E-05 — the original wording claimed enforcement that the tasks do not deliver, which is the misleading-brief failure this plan exists to reduce.

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

**`PLAN_NOT_FROZEN` is already in `ErrorCode` on `main`** — the leader added it. Use it directly; do not edit `src/contracts/`.

*(Was a blocker: the task required throwing a code that did not exist while forbidding the worker from adding it, so a literal implementation had to either fail typecheck or violate the freeze. Raised as E-01.)*

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

// The existing "every finding carries a remedy" test only asserts length > 0,
// so one generic string satisfies it for all three. Each remedy must name the
// thing to change, and they must differ from each other.
it('gives each planning finding its own actionable remedy', async () => {
  const remedy = async (planning: object, code: string) =>
    (await doctor(cfg({ planning }), repo)).find((f) => f.code === code)!.remedy;

  const noReviewers = await remedy({ mode: 'review', agents: 0, selection: 'leader' }, 'PLANNING_NO_REVIEWERS');
  const smallPanel = await remedy({ mode: 'panel', agents: 1, selection: 'majority' }, 'PLANNING_PANEL_TOO_SMALL');

  expect(noReviewers).toMatch(/agents/i);
  expect(smallPanel).toMatch(/agents|participant/i);
  expect(noReviewers).not.toBe(smallPanel);
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

**The selector is `role: 'plan_reviewer'`**, added to the frozen `Role` union on `main` by the leader. `renderBrief` currently branches leader-vs-everything-else; it gains a third arm. Do not invent a heuristic and do not reuse `observer` — an observer watches a dispute it is not party to, while a reviewer's entire purpose is to speak.

```ts
// Both participants differ ONLY in role, so any difference in output is
// attributable to the selector and nothing else.
const reviewer = () => ({ ...base, id: 'planrev', role: 'plan_reviewer' as const });
const worker   = () => ({ ...base, id: 'planrev', role: 'worker' as const });

it('gives the reviewer instructions the worker does not get', () => {
  const r = renderBrief(reviewer(), descriptor(), policy(), 'mcp');
  const w = renderBrief(worker(), descriptor(), policy(), 'mcp');

  expect(r).toContain('raise a claim against the plan');
  expect(w).not.toContain('raise a claim against the plan');   // ← the half that matters

  expect(r).toContain('You do not implement');
  expect(w).not.toContain('You do not implement');
});

it('still gives the worker its own instructions', () => {
  const w = renderBrief(worker(), descriptor(), policy(), 'mcp');
  expect(w).toContain('open a draft PR');
  expect(renderBrief(reviewer(), descriptor(), policy(), 'mcp')).not.toContain('open a draft PR');
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

## Task E4 — deferred, and the acceptance boundary

Wiring `validatePlanFrozen` into the daemon's `POST /tasks`, so a task cannot be created while the plan is disputed. **Blocked on Phase D**, which owns `src/daemon/**` and is in flight. Named here so it is not forgotten and not attempted.

**E1–E3 are a prerequisite for E4, not a substitute.** Until this task lands, `validatePlanFrozen` has no caller and §5.6 is not enforced anywhere. Track E is complete when E4 passes an integration test at the daemon boundary: a `POST /tasks` while an unresolved claim targets `'brief'` or `'spec'` is refused with `PLAN_NOT_FROZEN`, and the same request succeeds once that claim resolves. Anything short of that is preparatory work, and describing it otherwise is the failure this plan is meant to reduce.

---

## Self-review

**Spec coverage.** §5.6's three modes → E2 validates their coherence. "The freeze is a gate, not a moment" → E1. "Reviewers must be independent of the author" → E3's template. The enforcement point that would actually block work → E4, deferred with a reason.

**Known gap, stated rather than hidden:** E1–E3 make the gate *available*; nothing calls it until E4. Ship them as preparatory work — the logic and its tests are the part most likely to be wrong, and settling them before the daemon needs them is the same argument Phase 0 made. But **the goal statement and E4 now say plainly that this is not §5.6 enforcement**, because the original wording claimed it was.

## Review record

Reviewed under spec §5.6 `review` mode by an independent reader (lens: misleading brief), PR #5. **Five claims raised, five upheld, none contested.** All are fixed above:

| | |
|---|---|
| E-01 `blocker` | E1 required throwing a code that did not exist while forbidding the worker from adding it — unimplementable either way |
| E-02 `defect` | E3 called `renderBrief(reviewer(), …)` with no definition of what makes a participant a reviewer |
| E-03 `defect` | E3's test rendered only the reviewer, so putting reviewer text in the *shared* worker template would pass while giving every worker reviewer instructions |
| E-04 `risk` | E2 required remedies that "name the capability lost" while its test only checked non-empty |
| E-05 | the goal claimed §5.6 enforcement that E1–E3 do not deliver |

E-03 is worth singling out: it is a one-sided discrimination test, the exact defect this project's own `AGENTS.md` warns about, in a plan written by the person who wrote that warning.
