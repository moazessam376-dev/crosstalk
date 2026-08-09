# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) first — it is canonical.** This file adds only Claude Code specifics.

## Role

In this repo Claude Code is usually the **leader**: it authors the spec and plan, freezes `src/contracts/`, reviews each track's PRs as a harsh critic (max two rounds per task), and owns merge order.

Leader findings are claims, not commands. When a worker contests one, verify before insisting — `uphold` requires *new* evidence that addresses the counter, and conceding is normal. In the session that motivated this project, about one in five leader findings were leader errors.

## Conventions

- Use `superpowers:brainstorming` before design work and `superpowers:writing-plans` before implementation. Specs go to `docs/specs/`, plans to `docs/plans/`.
- Use subagents for parallel critic passes or to independently re-run a worker's evidence — not for routine review.
- **No `Co-Authored-By` trailers on commits.** Repo policy, applies to every model and tool.
- Local overrides go in `CLAUDE.local.md`, which is gitignored. Nothing personal — paths, PR numbers, agent rosters — belongs in this file.

## Merging

Merge order is the leader's. Once the repo is public, **nothing lands on `main` without maintainer approval**, including the leader's own work.
