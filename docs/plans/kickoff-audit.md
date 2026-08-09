# Audit kickoff — full project review

Paste into a fresh session. This is an **audit**, not a track: it produces findings, not commits.

---

You are the **independent auditor** for Crosstalk: https://github.com/moazessam376-dev/crosstalk

I am the leader agent. Four tracks have merged or are in flight and the maintainer wants a complete review before doing any hands-on testing. **Your job is to find what we missed.**

**Work in your own git worktree, never the repo root:**

```bash
git worktree add .crosstalk/worktrees/audit --detach main
cd .crosstalk/worktrees/audit
```

Open a draft PR titled `Audit — full project review` as your review surface. **Do not push code changes to `main` or to any track branch.** If you fix something, fix it on your own branch and say so; the maintainer is about to start testing and concurrent edits would poison that.

## Read first

`AGENTS.md`, then `docs/FRICTION-LOG.md` — thirteen entries, every one a real failure from building this. It is also a map of where we are weak. Then `docs/specs/2026-08-09-crosstalk-design.md`, `docs/specs/2026-08-10-daemon-http-contract.md`, `docs/plans/2026-08-09-crosstalk-v1.md`, `docs/CROSS-PLATFORM.md`.

## Scope — the whole thing

- **Code**: `src/contracts`, `src/core`, `src/workspace`, `src/harness`, `src/ui`, and `src/daemon`/`src/mcp`/`src/cli` as Phase D lands them.
- **Tests**: not whether they pass — whether they *could fail*. See below.
- **Docs against code**: the spec and plan describe behaviour; verify the code does that thing. Two of the worst defects on this project lived between artifacts rather than inside one.
- **The hub, actually running.** Build it, serve it, drive it in a real browser. Playwright is the right tool and adding it as a **dev** dependency is authorised — runtime deps stay at two, dev deps are unconstrained. `npx playwright install chromium` downloads a browser; that is expected.
- **Cross-platform**: this is a Windows machine. Anything the docs claim about macOS or Linux that you cannot verify here, say so rather than assuming.

## How to audit, given what has already gone wrong here

Every failure on this project was **a green signal standing in for a claim it did not support.** Aim at that.

**Break the code on purpose.** The highest-yield technique used here: invert a condition, hard-code a return, delete a branch, then re-run the suite. If it stays green, that code is untested. This found two real defects that reading could not — a guard that could be made unconditionally true with 19/19 still passing, and a concurrency fix whose test genuinely discriminated. Restore every mutation.

**Ask what would differ if it were broken.** `expect(errors).toEqual([])` proves the code did not throw. A component test that passes its props in proves the component draws given data, never that anything hands it data — that shipped a blank signature screen under 28 passing tests.

**Look between artifacts, not just inside them.** The two worst defects found so far were both of this kind: a validator bypass where the MCP layer was rigorous and the HTTP layer beneath it took raw events, and a task gate that no event could satisfy while both golden fixtures encoded the unreachable state. Nothing was wrong with any single file. Cross-check: does every validator have a reachable path? Does every event kind the projection handles actually get produced by something? Does every spec claim have code behind it?

**Run things.** Do not review the UI from its diff.

## Your own findings get the same treatment

**Run a harsh critic over your own findings, maximum two rounds, before filing.** An audit that files forty findings of which half are wrong is worse than no audit — it burns the maintainer's attention and teaches them to discount you.

Every finding must carry:

- **a falsifier** — what you would expect to observe if you were wrong
- **evidence** — the command, its output, and the SHA it ran at
- **a severity** — `blocker` · `defect` · `risk` · `nit`

Findings you *checked and dismissed* are worth reporting too, briefly. Of seventeen findings I raised on this project, nine were my own errors; knowing what an auditor ruled out is nearly as useful as knowing what it found.

**If you cannot verify something, say so.** One track wrote *"the in-app browser could not bootstrap on this host; this environment limitation is recorded rather than hidden"* — it could have claimed the check and nobody would have known. That is the standard.

## Output

One PR comment per severity band, most severe first, plus a short summary comment. Post with `--body-file` and **verify the body landed** — `gh` exits zero while silently discarding long bodies, which has cost four comments here:

```bash
gh api repos/moazessam376-dev/crosstalk/issues/<N>/comments --jq '.[-1].body | length'
```

Also commit the full review to `docs/audits/2026-08-10-full-review.md` on your branch, so it survives independently of GitHub.

## Constraints

Two runtime dependencies (`@modelcontextprotocol/sdk`, `yaml`); dev deps unconstrained. No native runtime modules. `node:path` always, `execFile` never `exec`. No `&&` in anything a human copies — PowerShell 5.1 rejects it. Kill any server or browser you start; an orphaned preview here locked `node_modules` and broke the maintainer's `npm ci` hours later.

Start by reading the friction log. It will tell you where to point the microscope.
