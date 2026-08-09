# Leader rulings — full project audit, 2026-08-10

Companion to [`2026-08-10-full-review.md`](2026-08-10-full-review.md). That document is the auditor's record and is left exactly as filed. This one records what was decided, including the one place the auditor and I disagreed, so the repository carries both sides rather than one side as settled fact.

**Nine findings, nine upheld.** One had its severity amended and one had its fix direction contested.

| | Finding | Disposition |
|---|---|---|
| F-01 | stale evidence does not reopen dependent state | **upheld** · became Track F |
| F-02 | advertised CLI entrypoint absent | **upheld**, severity amended `blocker` → `risk` |
| F-03 | `uphold` accepts a rebuttal without a falsifier | **observation upheld, fix direction contested** |
| F-04 | undefined transport rendered as `file` | **upheld** · fixed `2d9541b` |
| F-05 | `#floor` not seeded | **upheld** · fixed `2d9541b` |
| F-06 | accepted claim displayed as `triaged` | **upheld** · fixed, plus a parity test `294ebd6` |
| F-07 | skipped ladder rungs disappear | **upheld** · owned by leader, triggered on Phase D |
| F-08 | unknown events degrade to generic cards | **upheld** · fixed `7ee0e4a` |
| F-09 | human controls unwired in `App` | **upheld** · owned by leader, triggered on Phase D |

## F-02 — severity amended, not the fact

`bin` promises `./dist/cli/index.js`; there is no `src/cli` and no `dist/cli`. Verified.

It blocks **publication**, and the repository is private and unpublished precisely because Phase D has not landed. It becomes a blocker the moment anyone runs `npm publish`, and is on the pre-publication checklist for that reason. The metadata does make a promise the artifact does not keep — that part stands.

## F-03 — the disagreement

The auditor found a real inconsistency and attributed it to the validator. I attributed it to the documentation.

The spec specifies `uphold` in three places and says **new evidence** every time, never a falsifier — including §16's list of the three schema tests that "encode the core thesis". The code matches the spec. `AGENTS.md` said *"falsifier is required on every claim and rebuttal"*, which over-generalises: an `uphold` restates a claim whose falsifier is already on the record and makes no new assertion, while **`amend` is the verdict for a changed argument and does require one** — `validateFalsifier` is called on that branch.

**Falsifier offered and not met:** if any spec section required a falsifier on `uphold`, I would be wrong. Three mentions, none do.

Fixed in `AGENTS.md`. The auditor did not contest the ruling.

## F-07 and F-09 — owned, with triggers

Both need Phase D. F-07 needs an optional field on `Decision` recording which rungs `resolvableRungs` dropped; adding a contract field while Track D builds against the frozen contract would force a rebase nobody asked for. F-09's handler cannot post anything until a daemon exists.

**Owner: leader. Trigger: Phase D merges.** Named here because an obligation with an owner and no trigger is how F-04 and F-05 survived a concession and shipped anyway — the leader conceded, took the follow-up, wrote the spec, and stopped.

## What the audit found that was larger than any finding

Two of the nine were spec sections the leader had personally certified as clean, and two more were cases where the plan specified one thing, the implementation did another, and the leader passed it in review.

The pattern: **the leader's reviews checked whether code was internally sound and whether its tests could fail. They did not check whether the code matched its own plan.** The audit's method — documents against code — caught what that method structurally could not.

That changed how the tracks running at the time were read. Track F raised fourteen findings against a leader-written plan within the hour, four of them of exactly this shape.
