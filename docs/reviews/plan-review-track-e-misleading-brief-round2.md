# Plan review — Track E follow-up (misleading brief)

This follow-up responds to the leader’s `— leader` comment on PR #5. It is the
second and final harsh-critic round; no product code was implemented.

## Additional claims

### E-05 — E2/E3 fail-first steps are not executable as written

- **target:** `docs/plans/2026-08-10-plan-formation.md:108-110,140-142`; `AGENTS.md:36-42`
- **assertion:** E2 and E3 say only `Step 2: Run — FAIL` and `Step 4: Run — PASS`. They give no command, no targeted test path, and no expected failure reason. E1 is explicit (`npx vitest run tests/core/plan.test.ts`, module not found), so the omission is not a deliberate plan-wide convention. A worker following E2 or E3 literally cannot perform the repository’s required “confirm it fails for the reason you expect” check, and can report a green full-suite run that never exercised the new test file.
- **falsifier:** This claim is wrong if the plan supplies the exact E2/E3 commands and expected failure in another referenced section, or if the repository’s standard command explicitly guarantees those targeted failure checks. Neither is present in the reviewed plan or `AGENTS.md`.
- **severity:** `risk`
- **resolution direction:** Name the targeted commands and the expected pre-implementation failure for E2 and E3, then repeat the commands for the passing step.

### E-06 — E2 claims three-mode coverage but never protects `solo`

- **target:** `docs/plans/2026-08-10-plan-formation.md:87-106,155`; `docs/specs/2026-08-09-crosstalk-design.md:304-310`; `src/contracts/config.ts:22-25`
- **assertion:** The self-review says “§5.6’s three modes → E2 validates their coherence,” but the proposed tests cover only `review`, `panel`, and an absent policy. There is no explicit `solo` case establishing that `agents` and `selection` are ignored there. An implementation can apply the `review`/`panel` reviewer-count checks unconditionally—warning for `solo` with `agents: 0`, or rejecting it with fewer than two agents—and all four proposed tests still pass, while violating the spec and the contract comment that those fields are ignored for `solo`.
- **falsifier:** This claim is wrong if E2 adds an explicit `solo` configuration test whose expected result would fail under unconditional reviewer/panel checks. The reviewed plan has no such test or implementation rule.
- **severity:** `defect`
- **resolution direction:** Add the explicit `solo` case and state the mode-specific validation table; for example, `solo` must not produce planning findings from `agents` or `selection`.

## Second harsh self-critique

Both claims survive the second pass because each has a concrete mutation that
the proposed suite would miss: omit the targeted fail-first command, or apply
the review/panel checks to `solo`. I did not add a separate claim about
`DEFAULT_POLICY` normalization or a planning-mode argument to E1; those remain
caller/design questions rather than defects this plan alone proves.

