# AGENTS.md

For any AI agent working in this repo. Canonical; `CLAUDE.md` points here.

**Read first:** [design spec](docs/specs/2026-08-09-crosstalk-design.md) · [v1 plan](docs/plans/2026-08-09-crosstalk-v1.md) · [cross-platform rules](docs/CROSS-PLATFORM.md)

Your task brief names which plan tasks are yours. The plan holds the context — this file holds only what you must not get wrong.

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
```

Everything is an npm script. No `.sh`, no `.bat`, no `Makefile` — PowerShell and zsh run the same command.

## Hard rules

1. **Two runtime dependencies, total** — `@modelcontextprotocol/sdk` and `yaml`. Dev deps are free.
2. **No native modules.** They break `npx` on machines without build tools.
3. **The log is append-only.** Corrections are new events, never edits.
4. **Order by `seq`, never `ts`.** Replay must be deterministic.
5. **`falsifier` is required** on every claim and rebuttal; **`uphold` requires new evidence.**
6. **`node:path` always, `execFile` never `exec`.** Details in `docs/CROSS-PLATFORM.md`.
7. **Green on one platform is not done.** CI is Windows, macOS and Linux.
8. **Don't edit `src/contracts/` or `tests/fixtures/`** — frozen. Raise a claim instead.
9. **Scratch worktrees and probe files go under `.crosstalk/`**, never the repo root and never outside the repo. Anything you create, `crosstalk down` has to be able to find and remove — and a reviewer shouldn't have to guess whether a stray directory is yours or abandoned.

## Testing

TDD: write the failing test, run it and confirm it fails for the reason you expect, then implement. A test that passes on its first run has demonstrated nothing.

**Assertions must be able to fail.** Before writing one, ask: *what would this print if the feature were broken?* If the answer is "the same thing", it's not a test. `expect(errors).toEqual([])` proves the code didn't throw. A suite that passes on zero rows proves nothing about one row.

**When you're unsure whether a test is real, break the code on purpose.** Invert the condition, hard-code the return, delete the branch — then re-run. If the suite stays green, it was never testing that code. This beats re-reading a test and judging whether it *looks* strict, and it takes a minute. Restore the file afterwards.

It catches a failure the "can this assertion fail?" question misses: a test that proves a branch *can* fire while proving nothing about whether it fires *at the right time*. A guard mutated to `return true` that keeps every test green is a guard nobody is checking. **Test both sides of any discrimination** — the case that should trigger and the neighbouring case that shouldn't.

Tests touching git build a real throwaway repo under `os.tmpdir()` — don't mock git.

**For UI, `npm test` is not the end of verification. Build it, serve it, open it, and look.** A component test that passes its props in proves the component draws correctly *given* data — never that anything hands it data. That seam is invisible from inside the test runner: this project shipped a handoff with 28 green tests, clean typecheck and a clean build, over a signature screen that rendered empty.

## Review is a conversation

Findings you receive are **claims, not instructions**. Verify each against the source before acting, then reply `accept` (fix + evidence), `contest` (why you built it that way + counter-evidence + what would show you wrong), or `clarify` (the brief conflicts with itself).

**Contesting a finding you believe is wrong is correct and costs you nothing.** Silently implementing a wrong finding turns working code into broken code.

## Handing off

Every handoff carries the branch, the commit SHA, your one-round self-critique record, and per acceptance criterion: **the command, its output, and the SHA you ran it at.** Evidence from a commit that's no longer an ancestor of `main` is stale — rebase means re-run.

Two rules that exist because they were broken here, not in theory (see [`docs/FRICTION-LOG.md`](docs/FRICTION-LOG.md)):

- **Push before you cite.** The SHA in your evidence must be reachable on the remote. A result from a commit only your machine can see is not something a reviewer can check.
- **`npm test` is not a build.** Always include `npm run typecheck` and `npm run build` in your evidence. Vitest transpiles without typechecking, so a fully green suite can sit on code `tsc` rejects — and CI runs `typecheck` first, so that branch is red everywhere while every local signal says green.

Zero self-critique findings is legal. Say so plainly rather than inventing some.

**Long PR comments can post empty — check yours landed.** Two tracks have now hit this independently: the command exits zero and the comment arrives holding only its first line. Post from a file with `gh pr comment N --body-file handoff.md`, then confirm:

```bash
gh api repos/OWNER/REPO/issues/N/comments --jq '.[-1].body | length'
```

Exit zero proves the request was accepted, not that the body survived. Your whole handoff is worth one extra command.

## Commits

Imperative subject under 72 chars, no `feat:`/`fix:` prefix. Body says *why*. **No AI co-author trailers or "generated with" footers** — commits are attributed to the maintainer.

One PR per track, kept rebased. **Merging is the leader's call, and once this repo is public nothing lands on `main` without maintainer approval.**
