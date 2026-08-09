# Task A6 implementer report

Task: A6 — Room ids and membership

Branch: `track-a/core`

Commit SHA: `02d6c1259318a0a684134f6486d419e8a2a8d642`

Files changed:
- `src/core/rooms.ts`
- `tests/core/rooms.test.ts`
- `.superpowers/sdd/2026-08-09-crosstalk-v1/task-A6-report.md`

RED

Command:

`npx vitest run tests/core/rooms.test.ts`

Output:

```text
FAIL tests/core/rooms.test.ts
Error: Failed to load url ../../src/core/rooms.js ... Does the file exist?
```

Reason:

The test failed for the expected RED reason: `src/core/rooms.ts` did not exist yet, so Vitest could not load `../../src/core/rooms.js`.

GREEN

Command:

`npx vitest run tests/core/rooms.test.ts`

Output:

```text
✓ tests/core/rooms.test.ts (4 tests)
Test Files  1 passed (1)
Tests       4 passed (4)
```

Additional verification

Command:

`npm run typecheck`

Output:

```text
FAIL outside Task A6 scope:
- src/core/log.ts
- src/core/tasks.ts
- tests/core/log.test.ts
```

Interpretation:

After fixing the only new A6 type-safety issue I introduced, the remaining typecheck failures were pre-existing in other Track A files outside the allowed write scope.

Exactly one harsh self-critique round

Accepted findings:

1. Accepted — I had unsafe destructuring in `membersOf()` (`const [taskId]` / `const [claimId]`) that produced strict TypeScript errors because the array element can be `undefined`.
   - Reason accepted: the typecheck evidence was real and directly attributable to my new file.
   - Fix: changed both lookups to `room.parts[0] ?? ''`.

Rejected findings:

1. Rejected — “Task room membership is incomplete because it does not include invited participants.”
   - Reason rejected: the frozen `Task` contract in this branch exposes `assignee` but no invited-participant field, and the A6 brief explicitly constrained the implementation to the current interfaces. Expanding that model would require a claim against the frozen contracts or plan, not an A6-local change.

Concerns

1. Branch-wide `npm run typecheck` is still failing in pre-existing non-A6 files:
   - `src/core/log.ts`
   - `src/core/tasks.ts`
   - `tests/core/log.test.ts`
2. The A6 brief’s required verification command passed cleanly, but I did not alter out-of-scope files to make the whole branch typecheck green.

Fix round 1 � review defect follow-up

Review finding verified:
- membersOf('dispute:C-1', state) incorrectly returned only @human when claim.against was 'brief' or 'spec'.
- Required behavior: keep the claimant as a dispute party, include every uninvolved ole: 'worker' participant as an observer, and omit only the non-participant target.

RED

Command:


px vitest run tests/core/rooms.test.ts

Output:

`	ext
FAIL rooms > keeps the claimant and uninvolved workers in a brief dispute room
expected [ '@human' ] to deeply equal [ 'leader', 'cursor', 'codex', '@human' ]
`

Reason:

The new regression test failed for the expected behavior gap in membersOf() for claims against 'brief' / 'spec'.

GREEN

Command:


px vitest run tests/core/rooms.test.ts

Output:

`	ext
? tests/core/rooms.test.ts (6 tests)
Test Files  1 passed (1)
Tests       6 passed (6)
`

Scope of fix:
- Updated dispute-room membership so the claimant always remains a party.
- Non-participant targets ('brief', 'spec') are omitted from the party list, not treated as an empty room.
- Added the requested coverage test that a task room includes all leaders plus the task assignee.

## Fix round 1 evidence correction

This correction supersedes the malformed command/output formatting in the preceding section.

Reviewed fix commit: 283a420e7b87ff243503fa620d02a71273493ee7

RED

Command: npx.cmd vitest run tests/core/rooms.test.ts

SHA: 02d6c1259318a0a684134f6486d419e8a2a8d642 plus the uncommitted regression test.

Output:

    FAIL rooms > keeps the claimant and uninvolved workers in a brief dispute room
    expected [ '@human' ] to deeply equal [ 'leader', 'cursor', 'codex', '@human' ]

Reason: the new regression test failed because the parent implementation returned only @human for a claim against brief or spec.

GREEN

Command: npx.cmd vitest run tests/core/rooms.test.ts

SHA: 283a420e7b87ff243503fa620d02a71273493ee7

Output:

    tests/core/rooms.test.ts (6 tests)
    Test Files 1 passed (1)
    Tests 6 passed (6)

The committed fix retains the claimant, omits only non-participant targets (brief and spec), includes uninvolved workers as observers, and covers task-room leaders plus the assignee.

## Post-rebase verification

The earlier A6 evidence used pre-rebase commit 283a420e7b87ff243503fa620d02a71273493ee7. After rebasing onto origin/main at bfdeb764b2de9d5fec402e284396f3a0e05d158c, the A6 implementation is present in f84dac70c556b75bf2b56c7741f92acaed8f0755. The contract-aware typecheck fix is committed at cd66aef.

Focused A6 command: npx.cmd vitest run tests/core/rooms.test.ts
SHA: cd66aef
Output:
  tests/core/rooms.test.ts (6 tests)
  Test Files 1 passed (1)
  Tests 6 passed (6)

Typecheck command: npm.cmd run typecheck
SHA: cd66aef
Output:
  crosstalk-ai@0.1.0 typecheck
  tsc -p tsconfig.test.json

Build command: npm.cmd run build
SHA: cd66aef
Output:
  crosstalk-ai@0.1.0 build
  tsc -p tsconfig.json

Full test command: npm.cmd test
SHA: cd66aef
Output:
  Test Files 7 passed (7)
  Tests 47 passed (47)