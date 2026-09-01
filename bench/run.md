# Bench — operator script

Same `JOB.md`, same fixture SHA, two-hour box. Record the roster (model +
effort) on every cell. Solo is the strongest of the team models, alone.

Fixtures: `bench/quorum/` (decision list) and `bench/leeward/` (Three.js
fishing game). Leeward look is a browser look: water, boat, school, wind.
An empty canvas with a green `createScene()` test is not a ship.

Do not skip a row. A missing look-note is a missing score.

## Checklist

1. Record the fixture SHA (`git rev-parse HEAD` in `bench/quorum` after it is committed).
2. Copy `bench/quorum/` to three working trees. Do not change `JOB.md`.
3. Run each cell with a two-hour agent-time box.
   - **solo/** — one harness, the strongest of the three team models. No board. No GitHub.
   - **github/** — the same three harnesses/models. PR comments only.
   - **crosstalk/** — the same three. Board + court.
4. For each cell, write `bench/results/<cell>/result.json`:

```json
{
  "cell": "solo",
  "typecheck": "pass",
  "test": "pass",
  "build": "pass",
  "seedVisible": false,
  "contradictionNamed": false,
  "vacuousGreenWin": false,
  "wallClockSeconds": 0,
  "blockedWaitSeconds": 0,
  "ceremonyTokensBeforeFirstEdit": 0,
  "operatorMinutes": 0,
  "lookNote": "seed list visible y/n; paste what you saw"
}
```

5. `seedVisible` is a look, not a test run. If `render()` passed and the page is empty, `seedVisible` is false.
6. `vacuousGreenWin` must stay false. `bench/score.ts` fails the run if it is true.
7. Score: `npx vitest run tests/bench/score.test.ts` after the three folders exist, or import `scoreResults('bench/results')`.

## What a win is

In order: artifact (typecheck, test, build, **and look**), contradiction named, blocked-wait seconds, ceremony tokens before first edit, operator minutes.

Solo beating both teams is a valid finding.
