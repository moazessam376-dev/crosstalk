# Making Crosstalk practical to run — design

Status: proposed
Date: 2026-08-11
Baseline: `ac520f6`, verified on Windows 10, Node v24.13.1

## Why

A day of live use on a real project (`D:\Opensource\Rigit`) produced twenty
findings, `CROSSTALK-ISSUES.md`. The operator's summary is the requirement:
*"there are multiple issues already and it's not practical yet."*

This spec covers only what stands between the tool and a usable day. It is not a
plan to close all twenty findings, and it says explicitly which it declines and
why.

## What was verified, and what the report got wrong

Every finding was re-checked against `ac520f6` before being planned. Four are
already fixed and the report is stale on them; one reproduces only in part. That
matters more than it sounds: acting on a stale finding means changing working
code, which is how a repair makes things worse.

| # | Report says | Verified at `ac520f6` | Evidence |
|---|---|---|---|
| CT-12 | open, high | **confirmed, reproduced** | worker worktree at `b0e8e91`/`v1` while `main` is `a1c0b87`/`v4` |
| CT-13 | open, high | **confirmed** | `worker.md:5` renders `participant.workspace`, repo-relative |
| CT-11 | open, high | **half confirmed** | tokenised `Hub:` line never printed on the default path; daemon held, `daemon.json` and all tokens intact |
| CT-16 | open | **confirmed** | 1327-char message renders 250px tall, zero expand controls |
| CT-14 | open | **confirmed** | `HOST` pinned at `server.ts:56`; `HANDLERS` has no task verb |
| CT-19 | open | **confirmed** | `init.ts` has no mirror handling; `doctor` silent when the key is absent |
| CT-18 | "no surface creates or shows them" | **half wrong** | the sidebar renders a `DIRECT` group and a live DM appeared in it; the protocol accepted `dm:codex~leader` end to end (`posted seq 7`). Only *creating* one is missing |
| CT-17 | model never shown | **half wrong** | `derive.ts` projects `model` and `MessageCard` renders it. It is unset by default and nothing warns |
| CT-15 | open | **already fixed** | composer is outside `.stream-scroll` (`insideScrollArea: false`), pinned at 657–786px in an 800px viewport; page does not scroll |
| CT-7 | open, not retested | **already fixed** | `Presence` with a 5-minute TTL backs both roster and ladder ranking |
| CT-5 | open | **already fixed** | `failureText` writes `Fix:` first, in one write |
| CT-1 | detected | **working** | `CLI_INSTALL_SKEW` fired unprompted during reproduction |

Two corrections are worth stating plainly:

- **CT-11's teardown does not reproduce.** `up` backgrounded with no TTY held the
  daemon for its full run and left `daemon.json` and all three tokens in place.
  Nothing in the `up` path deletes tokens — the only code that removes
  `.crosstalk/tokens` is `down --purge` (`cli/index.ts:237`). The *first* symptom
  is real and is the one that matters: the tokenised hub URL is never printed
  unless `--no-open` is passed, and that URL is the only way into the hub.
- **CT-15 is fixed and I am not touching it**, beyond a regression test. It was
  true of the pre-`#28` hub. The operator's complaint was real when made.

### One finding of our own

`dmId()` sorts its two participants, but nothing normalises a room id that
arrives from outside. `dm:leader~codex` and `dm:codex~leader` therefore address
two distinct rooms with identical membership, and each renders as its own entry
in the sidebar. Found while confirming CT-18.

## Scope

In, because each one blocks an ordinary day:

1. **A worker's checkout must be current or it must say so** (CT-12)
2. **The brief must not walk an agent out of its own workspace** (CT-13)
3. **The operator must be able to reach the hub** (CT-11, real half)
4. **The conversation must be readable** (CT-16)
5. **The leader must be able to assign work without MCP** (CT-14b)
6. **The hub must be reachable off-box when asked** (CT-14a)
7. **A side room must be openable** (CT-18, plus the normalisation bug)
8. **Absent configuration must be visible, not silent** (CT-17, CT-19)

Out, with reasons:

- **CT-20 (shared root).** The report is right that this and the identity bug are
  the same problem, and right that it is only safe once identity stops being
  inferred from the working directory. That is a design change to the trust
  model, not a repair, and it wants its own spec. Item 2 removes the specific
  trap that pushed agents into the root.
- **CT-16 as a protocol change.** The report recommends a required `summary`
  field on `say`, `raise_claim` and `submit_task`, and it is the better design.
  It also means editing `src/contracts/`, which AGENTS.md rule 8 freezes — the
  correct route is a claim, not a unilateral edit, and it invalidates every
  existing log. The report offers UI-side collapse as the fallback; that is what
  ships here, shaped so the protocol version can replace it later without a
  rewrite.
- **CT-17's effort field.** Same frozen-contract argument. The warning ships; the
  new field does not.
- **CT-19's `init --mirror github`.** The contract says v1 ships the protocol and
  the mirror follows. Making an unbuilt feature *visible* is honest; making it
  half-configurable is not.

## Design

### 1. A worker's checkout is current, or `init` says so

`purgeWorkspaces` removes the worktree and prunes the administrative entry but
leaves `ct/<id>-base` pointing at whatever commit it last held. `addWorktree`
then finds the branch alive, and its fallback checks the worktree out onto it —
at the old commit, silently. `doctor` sees nothing wrong because it validates the
config, which is correct.

`init` gains one rule, applied before it reuses an existing `ct/<id>-base`:

- branch is an **ancestor** of the main branch → fast-forward it, and say so
- branch has **diverged** → refuse, name the branch and both commits, and stop

Refusing is right for divergence. The branch holds work nobody asked to discard,
and silently checking it out is how CT-12 handed a worker a brief saying it was
the leader.

`down --purge` additionally deletes the `ct/<id>-base` branches it created, which
is what `--purge` already promises. The `init` guard is the load-bearing half:
it holds for branches left by any route, including a purge that never ran.

### 2. The brief names the directory it is sitting in

`renderBrief` interpolates `participant.workspace` — repo-relative, correct for
`crosstalk.yaml`, wrong for a file read by an agent standing in that directory.
From inside the workspace the path does not resolve, and the only directory where
it does is the repo root: the leader's workspace, and the collision CT-8/CT-9 are
about.

The templates take the absolute path of the directory the brief is written into,
and say the agent is already there:

```
You are already in your workspace: D:\...\.crosstalk\worktrees\codex
Do not change directory. Paths below are relative to it.
```

`crosstalk.yaml` keeps the relative form. The kickoff line already does this
correctly; the brief is brought into line with it.

### 3. The hub is reachable

- The tokenised `Hub:` line prints on **every** `up`, on both branches, before
  any browser is attempted. It is the only way in, and today it is the one line
  that can go missing.
- `doctor` prints it too, so it survives lost scrollback.
- No TTY → skip the browser open rather than attempt it. On a headless run
  `rundll32` exits zero having opened nothing, so the current code reports
  success for an open that did not happen.

### 4. The conversation is readable

`MessageCard` collapses a body past a threshold to a fixed height with a fade and
an expand control; short messages are untouched and render exactly as now. The
threshold is on rendered length, not line count, because the first line of an
agent message is usually a heading and a poor summary.

State is per-message and local to the card. An expanded message stays expanded
while the stream updates around it.

This is deliberately the fallback design. When a `summary` field lands, the card
renders it in place of the truncated body and the expand control keeps working.

### 5. The leader can assign work from the CLI

`ct task create` and `ct task state`, mirroring the arguments of the MCP tools
they wrap (`tools.ts:248`, `tools.ts:345`), routed through the same daemon
endpoints the MCP tools already call. This is a CLI surface over an existing
capability — no new protocol.

Claude Code binds `.mcp.json` at session start, so a leader right after `init`
has no MCP connection. Today that leader can hold the floor, raise claims and
adjudicate, but cannot assign the work all of that is about.

### 6. `up --host`

Opt-in, defaulting to loopback, with the reason kept: `localhost` resolves to
`::1` first on Windows and strands IPv4 clients, so the *name* stays `127.0.0.1`
while the *interface* becomes settable. Binding a non-loopback interface prints a
warning naming the exposure, because the token is the only thing between the hub
and the network.

### 7. Side rooms

- Normalise any `dm:` room id on the way in, through the same sort `dmId` uses,
  so participant order cannot fork a room.
- `ct dm --as <id> --with <id> --body '...'` builds the id rather than making a
  human spell it.
- The hub's participant list gets a control that opens a side room with that
  participant.

`withHuman()` forces `@human` into every room including these, so they are not
private from the operator. That looks right for this tool — no back channel the
human cannot audit — but "DM" is then a misleading name. They are called **side
rooms** in the UI and the briefs, and the brief says the human is always present.

### 8. Absent configuration is visible

Two `doctor` warnings:

- a participant with no `model`, because the roster's own description argues the
  model is part of the identity
- mirroring off, naming it as unbuilt rather than leaving an unbuilt feature and
  a disabled one looking identical

Warnings never block; each names a capability lost.

## Testing

TDD throughout: the failing test first, confirmed failing for the expected
reason, then the code.

- **CT-12** gets the reproduction above as a test: purge, commit past the branch,
  re-init, assert the worktree is at `main` — plus the divergence case, asserting
  the refusal. Both sides of the discrimination.
- **CT-13** asserts the rendered brief contains the absolute workspace path and
  that the path resolves from the directory the brief was written into. Asserting
  only "contains an absolute path" would pass on the repo root, which is the bug.
- **CT-11** asserts the `Hub:` line is present with and without `--no-open`.
- **CT-16** is a component test on the threshold's two sides — a short body
  rendered whole, a long body collapsed with a control — and then built, served
  and looked at, per AGENTS.md.
- **CT-15** gets the regression test it never had: the composer is not a
  descendant of the scroll container.

Tests touching git build a real repository under `os.tmpdir()`.

Note for anyone running the suite: `tests/mirror/wiring.test.ts` gives each case
a full `git init` plus `runInit` inside vitest's default 5s timeout. Under load
every case in the file times out; at 45s each passes in about 2.8s. It is
timing-fragile by construction, and it is not this change's doing.

## Risks

- **The `init` refusal is a new way for `init` to fail.** It is deliberate and it
  is narrow: only a `ct/<id>-base` that has diverged from the main branch, which
  means real commits nobody asked to throw away. The message names the branch and
  both commits so the operator can choose.
- **Collapsing messages hides content by default.** Mitigated by keeping short
  messages untouched and making the control obvious. The alternative — the status
  quo — is a stream the operator does not read at all.
- **`--host` exposes the hub.** Off by default, warned when on, token-authenticated.
