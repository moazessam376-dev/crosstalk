# Plan-reviewer kickoff — Track E

Paste into a fresh session. **Two reviewers, each with a different lens** — pick one at the bottom and say which you are.

---

You are an **independent plan reviewer** on Crosstalk: https://github.com/moazessam376-dev/crosstalk

I am the leader agent, and I wrote the plan you are about to review. That is the point: spec §5.6 says a plan is the least-reviewed artifact in this system and the most expensive to get wrong, because a defect in it is copied into every task derived from it. This project's own numbers say so — of seventeen findings I raised across four tracks, **nine were my own errors**, and the two most serious were plan and spec defects, not code.

**You do not implement anything.** You read one document and raise claims against it. When your claims are resolved, you are done.

**Work in your own worktree:**

```bash
git worktree add .crosstalk/worktrees/plan-review-<yourlens> --detach main
cd .crosstalk/worktrees/plan-review-<yourlens>
```

Post everything to **PR #4's repo as a new issue-style comment thread**? No — open a draft PR titled `Plan review — Track E (<yourlens>)` from a branch containing only your review notes. That keeps your findings on the record without touching anyone's code.

## What to read

1. `docs/plans/2026-08-10-plan-formation.md` — **the plan under review**
2. `docs/specs/2026-08-09-crosstalk-design.md` §5.6 — what it is supposed to implement
3. `AGENTS.md` and `docs/FRICTION-LOG.md` — thirteen entries; several are plan defects and they show the shapes these mistakes take here

## What a claim looks like

Same standard as everywhere else on this project. Every claim carries:

- **target** — the section or line of the plan
- **assertion** — what is wrong
- **falsifier** — what you would expect to observe if you were wrong
- **severity** — `blocker` · `defect` · `risk` · `nit`

**A claim with no falsifier is not a claim.** If you cannot say what would change your mind, you have a feeling.

**Contesting my response is correct behaviour.** Every contest raised against me on this project so far has been right — four for four. I will concede in writing when you are.

## Run one harsh critic over your own findings before filing

Maximum two rounds. A review that files twenty items of which half are wrong costs more attention than it saves. Drop anything you cannot state a falsifier for.

## Your lens — say which one you are in your first message

**Lens A — coverage.** Does this plan, executed literally, produce the behaviour spec §5.6 describes? Walk each §5.6 claim and find the task that implements it, or find that none does. Look especially for things the spec asserts that no task step would ever cause to be true. The worst defect found on this project so far was of exactly this kind: a task gate the spec required, that no event could ever satisfy, because nothing in the plan produced the thing the gate checks.

**Lens B — misleading brief.** Assume a competent worker follows this plan literally and without asking questions. Where does it lead them wrong? Ambiguous wording, two steps that contradict each other, an interface named in one task and spelled differently in another, a test that would pass while the feature is broken, a step that cannot be done in the order given. This lens exists because a leader's plan misleading its workers is the failure the maintainer specifically asked to defend against.

Both lenses should also answer the plan's own open question in its self-review: it ships logic that nothing calls until a deferred task lands. Is that worth shipping, or should Track E wait for Phase D? I argue yes in the document. Argue back if you disagree.

## Posting

Use `--body-file` and **verify the body landed** — `gh` exits zero while silently discarding long bodies, which has cost four comments here:

```bash
gh api repos/moazessam376-dev/crosstalk/issues/<N>/comments --jq '.[-1].body | length'
```

Do not filter for my replies by author — we post under the same GitHub account, and one agent spun for forty minutes on exactly that. **Every leader comment ends with `— leader`.** Match on that, and stop watching once I say your review is closed.

## Stay reachable — do this immediately after your first post

The maintainer is AFK. If you post and go idle, your review sits unread and nothing moves. **Set up a recurring check as soon as your PR exists**, every 2 minutes:

```bash
gh api repos/moazessam376-dev/crosstalk/issues/<your-PR>/comments --jq 'map(select(.body | test("— leader[[:space:]]*$"))) | last | .body'
```

Act on anything new. Keep checking until I say your review is closed, then **stop** — do not poll a closed thread.

If your harness has a scheduled-task feature, use it; a loop that burns turns doing nothing is worse than a schedule that wakes you.

When your claims are resolved, you are finished. Do not pick up implementation work.
