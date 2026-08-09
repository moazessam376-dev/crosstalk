# Plan review — Track E (misleading brief)

Base: `main` at `b0407ca`  
Lens: **B — misleading brief**

I reviewed `docs/plans/2026-08-10-plan-formation.md` against spec §5.6, the
repository rules, and the existing interfaces. I did not implement product
code. Each finding below is a claim with a falsifier.

## Claims

### E-01 — E1 cannot compile without violating the frozen contract

- **target:** `docs/plans/2026-08-10-plan-formation.md:33-76`, E1 Step 3 and its reviewer note; `src/contracts/errors.ts:1-37`
- **assertion:** E1 requires `validatePlanFrozen` to throw `ProtocolError('PLAN_NOT_FROZEN', ...)`, but `PLAN_NOT_FROZEN` is not in the `ErrorCode` union. The task's file list contains only `src/core/plan.ts` and its test, while the global constraints forbid editing `src/contracts/**`. Because `ProtocolError` accepts `ErrorCode`, a literal implementation either fails typecheck/build or edits a frozen contract. The note tells the reviewer to ask for that contract change, but does not give the worker an implementable task boundary or dependency.
- **falsifier:** This claim is wrong if the reviewed base already contains `PLAN_NOT_FROZEN` in `ErrorCode`, or if `ProtocolError` accepts arbitrary strings without a contract change. On `b0407ca`, neither is true.
- **severity:** `blocker`
- **resolution direction:** Add the error-code change as an explicitly owned prerequisite/task (with the frozen-contract exception agreed), or change E1 to use an existing error code and state why.

### E-02 — E3 names a reviewer template but gives no selector for it

- **target:** `docs/plans/2026-08-10-plan-formation.md:115-139`, E3; `src/harness/brief.ts:12,102`; `src/contracts/participant.ts:4`
- **assertion:** E3 adds `src/harness/templates/plan-reviewer.md` and calls `renderBrief(reviewer(), ...)`, but never defines what `reviewer()` is or how `renderBrief` distinguishes it from an ordinary worker. The existing renderer knows only `leader` versus “anything else,” and the frozen role union has `leader | worker | observer | human` but no `reviewer`. A worker following the task literally must guess whether `observer` means reviewer, add an undocumented policy heuristic, or route every non-leader through the new template. That ambiguity can silently change ordinary worker briefs or leave the new template unused.
- **falsifier:** This claim is wrong if the plan or an existing contract already specifies a reviewer-specific participant shape and requires `renderBrief` to select `plan-reviewer` from it. Neither the plan nor the current participant contract does so.
- **severity:** `defect`
- **resolution direction:** Name the selector explicitly (for example, an existing role and its semantics, or a separate renderer input) and add it to the E3 interface/test contract without editing frozen contracts by accident.

### E-03 — The E3 “distinct from a worker brief” test can pass while workers receive reviewer instructions

- **target:** `docs/plans/2026-08-10-plan-formation.md:122-129`
- **assertion:** The test described as proving a plan-reviewer brief is distinct from a worker brief renders only `reviewer()`. It checks that the output contains one reviewer phrase and does not contain `open a draft PR`; it never renders a normal worker and asserts that the reviewer-only phrase is absent there. A literal implementation can put `raise a claim against the plan` into the shared worker template, pass every assertion shown, and give ordinary workers reviewer-only instructions. The test also does not prove that the new `plan-reviewer.md` file was selected at all.
- **falsifier:** This claim is wrong if the E3 test also renders a normal worker and asserts the reviewer-only instructions are absent, or otherwise asserts the selected template identity. The proposed test does neither.
- **severity:** `defect`
- **resolution direction:** Render both a reviewer and an ordinary worker with otherwise equivalent inputs; assert the reviewer-only text appears only in the reviewer output and that both role headings/templates are correct.

### E-04 — E2’s remedy requirement is stronger than its acceptance test

- **target:** `docs/plans/2026-08-10-plan-formation.md:80-113`, E2 Step 3; `tests/harness/doctor.test.ts:136-139`
- **assertion:** E2 says every planning finding's remedy must name the capability lost, then claims the existing remedy test covers that automatically. The existing test checks only `finding.remedy.length > 0`; the four new examples check only finding level and code. A worker can return the same generic non-empty remedy for every planning error, pass the stated tests, and still omit the capability the remedy is supposed to recover.
- **falsifier:** This claim is wrong if the updated tests assert planning-specific remedy content (or a structured capability field) and fail for a generic non-empty remedy. The current test and the proposed E2 tests do not.
- **severity:** `risk`
- **resolution direction:** Add an assertion for each planning finding, or weaken the prose requirement to “non-empty remedy” so the acceptance criteria match.

## Open question: ship before Phase D?

I would ship E1–E3 before Phase D only as explicitly preparatory work: the pure
freeze logic, doctor checks, and reviewer brief can be tested independently and
will reduce risk when the daemon consumes them. I would not call Track E’s goal
“enforceable” complete, or treat the plan as protecting task creation, until E4
lands: the plan itself says nothing calls `validatePlanFrozen` before then.
The plan should therefore state that E1–E3 are a prerequisite for E4 and add an
integration acceptance criterion at the daemon boundary. If Track E is expected
to deliver end-to-end §5.6 enforcement, it should wait for or be coordinated
with Phase D instead of merging an inert gate as a finished feature.

## Harsh self-critique — one round

I challenged each candidate against the current interfaces and kept only claims
with a concrete contrary observation. E-01 is anchored by the closed
`ErrorCode` union and the plan’s own frozen-contract rule. E-02 is anchored by
the renderer’s two-way selector and the absence of a reviewer representation.
E-03 and E-04 are independent acceptance gaps: one permits the wrong template
to reach ordinary workers, and the other permits semantically empty remedies.

I considered claims that E1 needs a planning-mode parameter and that E2 must
normalize `DEFAULT_POLICY` itself. I dropped both: a future E4 caller could
choose when to invoke the state-only gate, and the current default is coherent,
so neither objection had a sufficiently discriminating falsifier against this
plan alone.

