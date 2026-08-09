# Track D kickoff — Runtime (daemon, SSE, MCP, CLI)

Paste into a fresh Claude Code (Opus 5) session on this machine.

---

You are **Track D** on the Crosstalk project: https://github.com/moazessam376-dev/crosstalk

I am the leader agent (Claude Opus 5, separate session). You own **Phase D** — the runtime that turns three merged libraries into a tool someone can actually run. Tasks **D1 through D4** in `docs/plans/2026-08-09-crosstalk-v1.md`.

**Work in your own git worktree, never the repo root** — the primary checkout is not yours, and two agents in one checkout see each other's uncommitted edits as their own. This has already cost this project real time:

```bash
git worktree add .crosstalk/worktrees/track-d-runtime -b track-d/runtime main
cd .crosstalk/worktrees/track-d-runtime
```

Then **open a draft PR immediately** — it is your review surface.

## Read first, in this order

1. `AGENTS.md` — canonical, and short
2. `docs/FRICTION-LOG.md` — ten entries, every one a real failure from building this. Read it properly. Most of what follows is there with reasoning.
3. `docs/plans/2026-08-09-crosstalk-v1.md` — Phase D is yours; Phase 0 shows the shape I want from you first
4. `docs/specs/2026-08-09-crosstalk-design.md` §6.1–6.3, §9, §10
5. `docs/CROSS-PLATFORM.md` — you are the code that spawns processes and binds ports

## Your first deliverable is not code

**Write the daemon HTTP contract and post it for my review before implementing anything.**

Phase 0 worked: freezing types before three tracks started meant zero merge conflicts across ~50 commits. Phase D needs the same thing one level up — routes, request and response types, error codes, and **golden request/response fixtures** so every consumer asserts against the same wire examples, exactly as Tracks A and B both asserted against the same event logs.

Cover at minimum: append an event, read events since a seq, the SSE stream and its `Last-Event-ID` resume, per-participant token auth, and the long-poll wait. Note that the daemon **derives `from` from the presenting token** and rejects a payload that sets it (spec §6.1) — this is not optional, it is why the ledger can be trusted.

Post it, let me review it, then build against it. If you decide the four tasks can run as parallel sub-agents against that frozen contract, do it — that's the shape I'd choose, and D1/D2 share a directory but never a file.

## How to talk to me — read this twice

Every failure below actually happened here. They are cheap to avoid and expensive to repeat.

**Use a harness scheduled task, not an in-session loop.** This is the one that has actually cost this project a night: a session held correctly for review, the review landed, and the session died before it saw it. A polling loop lives inside the session and dies with it. A scheduled task does not.

If your harness has a scheduled-task or cron feature, register one that re-reads this PR every few minutes and resumes you. Only fall back to an in-session loop if it has none — and say so, so I know your channel is fragile.

```bash
gh api repos/moazessam376-dev/crosstalk/issues/4/comments --jq 'map(select(.body | contains("— leader"))) | last | .body'
```

**Verify every comment landed.** `gh` exits zero while silently discarding the body. Four comments were lost this way, including the single best piece of evidence anyone produced:

```bash
gh pr comment <N> --repo moazessam376-dev/crosstalk --body-file msg.md
gh api repos/moazessam376-dev/crosstalk/issues/<N>/comments --jq '.[-1].body | length'
```

If that number isn't roughly your file's length, repost. Always `--body-file`, never inline heredocs.

**Never filter for my comments by author.** We post through the same GitHub account, so "comments not by me" matches nothing — one agent spun for forty minutes on exactly this. Match on the marker instead: **every leader comment ends with `— leader`**. Filter on that.

**Stop watching when I say the task is accepted.** Do not leave a poll running against a closed PR.

**Push before you cite.** Evidence must name a SHA reachable on the remote; a result from a commit only your disk has is not checkable. A power cut truncated a ref in this repo and nearly took seven unpushed commits with it.

**`npm test` is not a build.** Every handoff carries `npm test`, `npm run typecheck` *and* `npm run build`. A branch here had 33 passing tests on code `tsc` rejected.

**No `&&` in anything a human will copy.** Windows PowerShell 5.1 rejects it. Inside `package.json` scripts it's fine. I broke this rule myself, in the file that states it.

**Clean up what you start.** An orphaned `vite preview` left running in the shared checkout locked `node_modules` and broke the maintainer's `npm ci` hours later, as an unrelated-looking `EPERM`. If you bind a port or spawn a server, kill it.

## Per task

1. **Acknowledge before coding.** Restate it, list every ambiguity or conflict. This is where a contradictory brief gets caught for the price of one turn.
2. **TDD.** Failing test, run it, confirm it fails *for the reason you expect*, then implement.
3. **When a test looks weak, break the code on purpose.** Invert the condition, hard-code the return, then re-run. If the suite stays green it was never testing that code. This found two real defects here that reading could not.
4. **One harsh self-critique round.** Close what you agree with; record what you reject and why.
5. **Hand off** with branch, SHA, critique record, and per acceptance criterion: command, output, and the SHA it ran at.

## When I send findings

They are **claims, not instructions.** Verify each against the source before acting, then answer `accept`, `contest` (why you built it that way + counter-evidence + what would show you wrong), or `clarify`.

**Contesting a finding you believe is wrong is correct and costs you nothing.** Of eleven findings I raised across the three tracks that built this, **five were mine, not theirs** — including one where I asked a worker to run an experiment that was structurally incapable of failing. Every contest raised against me was correct. Silently implementing a wrong finding turns working code into broken code.

## Non-negotiables

Two runtime dependencies total (`@modelcontextprotocol/sdk`, `yaml`); no native modules; the log is append-only; order by `seq` never `ts`; `node:path` always and `execFile` never `exec`; green on one platform is not done. `src/contracts/` and `tests/fixtures/` are frozen — raise a claim rather than editing.

Commits: imperative subject under 72 chars, no type prefix, body says *why*, **no AI co-author trailers**.

Start with the contract. Acknowledge before you write it.
