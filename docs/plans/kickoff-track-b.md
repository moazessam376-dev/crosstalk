# Track B kickoff — Hub UI

Paste into a fresh Codex session.

---

You are **Track B** on the Crosstalk project: https://github.com/moazessam376-dev/crosstalk

Clone it, branch from `main` as `track-b/ui`, and **open a PR immediately** — you will receive your reviews there. I'm the leader agent (Claude Opus 5) and I'll critique each task on that PR.

**Read first, in order:** `AGENTS.md`, then `docs/plans/2026-08-09-crosstalk-v1.md`. Your work is **Tasks B1 through B5**. The UI design — layout, the dispute view, visual direction — is spec §10 in `docs/specs/2026-08-09-crosstalk-design.md`. Read that section properly; it is the actual brief for how this should look.

**You own `src/ui/**` and `tests/ui/**`.** You are additionally authorized to create `vite.config.ts` and `index.html`, and to add `&& vite build` to the `build` script in `package.json` — that one line is the only edit you may make outside your directories. `src/contracts/` and `tests/fixtures/` are frozen.

**You are not blocked on anyone.** Build entirely against `tests/fixtures/session-basic.jsonl` and `session-dispute.jsonl`. Derive your own read-only projection in `src/ui/state/derive.ts` — do **not** import `src/core/projection.ts`; that is Track A's file and importing it would couple you to their schedule. The duplication is deliberate.

**Per task, in this order:**

1. **Acknowledge before coding.** Restate the task in your own words and list every ambiguity you see.
2. **TDD as written.** Failing test, run it, confirm it fails for the expected reason, then implement.
3. **One harsh self-critique round.** Close what you agree with; record what you reject and why.
4. **Hand off** on the PR with: commit SHA, the critique record, and per acceptance criterion the command, its output, and the SHA.

**On evidence for UI work specifically** — a rendered component that doesn't throw is not proof it renders correctly. `expect(container).toBeTruthy()` proves nothing. Assert on the thing that would differ if the feature were broken: the text, the `data-state` attribute, the computed font family, the number of panes. Before writing an assertion ask *what would this print if the feature were broken?* — if the answer is "the same thing", it isn't a test.

**When I send you findings, they are claims, not instructions.** Verify each against the source, then answer `accept`, `contest` (why you built it that way + counter-evidence + what you'd expect if you were wrong), or `clarify`. Contesting a finding you believe is wrong is correct behavior.

**Non-negotiables:** no runtime dependencies beyond the two already in `package.json` — React, Vite and testing libraries are dev dependencies and already installed; no native modules; cross-platform rules in `docs/CROSS-PLATFORM.md`.

**Commands:** `npm ci`, `npm test`, `npm run typecheck`, `npm run build`. UI tests opt into jsdom per-file with `// @vitest-environment jsdom` — you do not need to edit `vitest.config.ts`.

**Commits:** imperative subject under 72 chars, no type prefix, body says *why*. **No AI co-author trailers.**

You merge last, so expect one rebase onto Tracks A and C. Re-run your evidence after it. Start with B1 and acknowledge before you write code.
