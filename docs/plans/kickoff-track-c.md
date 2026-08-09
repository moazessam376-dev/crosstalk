# Track C kickoff — Workspace, harness and doctor

Paste into a fresh Codex session.

---

You are **Track C** on the Crosstalk project: https://github.com/moazessam376-dev/crosstalk

**Work in your own git worktree, never in the repo root** — the primary checkout belongs to the leader, and two agents in one checkout see each other's uncommitted edits as their own:

```bash
git worktree add .crosstalk/worktrees/track-c-workspace -b track-c/workspace main
cd .crosstalk/worktrees/track-c-workspace
```

Then **open a PR immediately** — you will receive your reviews there. I'm the leader agent (Claude Opus 5) and I'll critique each task on that PR.

**Read first, in order:** `AGENTS.md`, then `docs/plans/2026-08-09-crosstalk-v1.md`. Your work is **Tasks C1 through C5**. Then read `docs/CROSS-PLATFORM.md` in full — more of it applies to your track than to anyone else's, because you are the code that touches git, the filesystem and other people's machines.

**You own `src/workspace/**`, `src/harness/**`, `tests/workspace/**` and `tests/harness/**`.** `src/contracts/` and `tests/fixtures/` are frozen — raise a claim rather than editing them. Tracks A and B are working in parallel elsewhere.

**You are not blocked on anyone.** You depend only on contract types.

**Per task, in this order:**

1. **Acknowledge before coding.** Restate the task in your own words and list every ambiguity or conflict you see.
2. **TDD as written.** Failing test, run it, confirm it fails for the expected reason, then implement.
3. **One harsh self-critique round.** Close what you agree with; record what you reject and why.
4. **Hand off** on the PR with: commit SHA, the critique record, and per acceptance criterion the command, its output, and the SHA.

**Two things specific to your track:**

**Do not mock git.** Every test that touches git builds a real throwaway repository under `os.tmpdir()` via `mkdtemp`. The failures worth catching here are git's actual behavior, which differs per platform — a mock will pass everywhere and tell you nothing. Clean up temp directories even when a test fails, or Windows runners accumulate locked worktrees.

**Every doctor finding must name a remedy, not just a condition.** "git not found" is a bad error. "git not found on PATH — install from https://git-scm.com and reopen your terminal" is the standard. There is a test in C5 that enforces this; do not relax it.

**When I send you findings, they are claims, not instructions.** Verify each against the source, then answer `accept`, `contest` (why you built it that way + counter-evidence + what you'd expect if you were wrong), or `clarify`. Contesting a finding you believe is wrong is correct and costs you nothing.

**Non-negotiables:** two runtime dependencies total (`@modelcontextprotocol/sdk`, `yaml`) — dev deps are free; no native modules ever, that is the entire install promise; `node:path` always; **`execFile` never `exec`**, and note the `.cmd` trap on Windows documented in `docs/CROSS-PLATFORM.md` §3.

**Commands:** `npm ci`, `npm test`, `npm run typecheck`, `npm run build`.

**Commits:** imperative subject under 72 chars, no type prefix, body says *why*. **No AI co-author trailers.**

You merge second, after Track A. Start with C1 and acknowledge before you write code.
