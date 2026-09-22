# Crosstalk as a message board — design

Status: proposed
Date: 2026-09-22
Replaces: the claim protocol (tagged `v0-protocol` before this lands)

## Why

The owner's goal: agents in ordinary harnesses (Claude Code CLI and desktop,
Codex, Cursor) get a way to coordinate and communicate, and nothing else.
Efficiency is the requirement. The claim protocol, dispute ladder and task gates
are removed because they cost context without paying for it.

Two complaints about the current version drive the design:

1. **Old messages flood new sessions.** Opening Crosstalk in a folder replays
   history into every new agent.
2. **Talk without output.** Agents talked a lot, often with no visible benefit.

What the old version got right is kept as a data point: three agents built a
better game about 3x faster than one agent, for 16% more tokens. Parallel work
with a shared channel works. The ceremony around it was the cost.

An audit on 2026-09-22 found the delivery path unfit for long runs: an
interrupted `await_turn` loses a message, a daemon restart dumps each agent's
whole history into its context, every `#floor` message lands in every context,
and MCP servers never re-find a restarted daemon. This design removes the
causes instead of patching them.

## Success

- Claude Code (CLI and desktop) can run a task with and without Crosstalk, and
  `ct stats` reports how many tokens the board added to each agent's context.
- A subagent can be redirected mid-task by a message from the orchestrator or the
  human.
- A new session sees nothing from before it joined, except direct messages
  already waiting for its name.
- Codex and Cursor can take part through the same MCP server or the CLI, with no
  Claude-specific code on their path.

## Out of scope

- Cloud agents (Devin, Cursor background agents). They cannot reach local files.
  A later `ct serve` could expose the same files over HTTP.
- Hook adapters for harnesses other than Claude Code. They use `inbox` between
  steps until they get one.
- Tasks, claims, reviews, votes, GitHub mirroring, worktrees. Removed, not
  deferred.

## What the probe established

A throwaway probe on Claude Code 2.1.280 (headless, Sonnet 5, one subagent)
settled what the docs leave open:

| Question | Result |
|---|---|
| Do hooks fire for a subagent's tool calls? | Yes. Input carries `agent_id` and `agent_type`; the main session has neither. `session_id` is shared. |
| Can a `PostToolUse` hook put text in the model's context? | Yes, via `hookSpecificOutput.additionalContext`. |
| Will the agent act on message *content* injected that way? | **No.** Both the main session and the subagent treated it as possible prompt injection and refused. |
| Will it act on a short notice that points at its own inbox tool? | **Yes**, when its prompt says it is on a board. A running subagent read the message and changed plan mid-task. |
| Can `SubagentStop` block finishing and give a reason? | Yes, `{"decision":"block","reason":…}`. It re-fires after the block; `stop_hook_active` is the guard. |
| Does a background command that exits wake an idle session? | Yes in the desktop app. No in headless `claude -p`, which exits at end of turn. Interactive CLI not tested. |

The design follows from row 3 and row 4: hooks **notify**, they never carry the
message.

## Architecture

No daemon. Every entry point — the MCP server, the CLI, the hooks, the hub —
reads and writes the same files under `.crosstalk/` in the project root. There is
no process to start, no port to discover and no token to hand out.

```
.crosstalk/
  current                     # the active run id, one line
  runs/<run-id>/
    msgs/<name>.jsonl         # messages <name> sent; only <name> appends here
    agents/<name>.json        # join record + read cursor for <name>
    hooks/<agent-key>         # hook identity map: session or agent id -> name
```

`<run-id>` is `YYYYMMDD-HHMMSS` plus an optional label (`20260922-2130-geekfarm`).

### Runs

- `ct new [label]` starts a run and points `current` at it. Old runs stay on disk
  and are never read by agents.
- The first `join` in a folder with no `current` starts a run.
- A run is the unit of "old messages": a new run is an empty board.

### Storage

- **One file per sender.** An agent appends only to `msgs/<own name>.jsonl`, one
  complete line per message in one `appendFile` call. With one writer per file
  there is no lock and no interleaving.
- **Names are claimed exclusively.** `join` creates `agents/<name>.json` with the
  `wx` flag, which fails if it exists. That is atomic on all three platforms.
- **Message line:** `{"id":"<name>-<n>","ts":"<ISO>","from":"<name>","to":["builder-2"],"text":"…"}`.
  `to` is a list of names or `["all"]`.
- **Order:** readers merge the files by `ts`, then `from`, then `n`. All writers
  share one machine clock, which is enough for a message board.
- **Partial lines:** a reader consumes only up to the last `\n` and leaves its
  offset on a line boundary, so it never reads half of a line being written.

### Cursors

`agents/<name>.json` holds `{joinedAt, offsets: {<sender>: <byte offset>}, notified: {<sender>: <byte offset>}, stats}`.
Only `<name>` writes its own cursor file, so it has one writer too. It is
rewritten atomically (write temp, rename).

Delivery rules for `<name>`:

- A message with `<name>` in `to` is delivered, whenever it was sent. That is how
  the orchestrator briefs `builder-2` before `builder-2` exists.
- A message to `all` is delivered only if sent after `joinedAt`.
- Nothing else is delivered. The human reads everything in the hub; agents never
  get the whole history.

### Names

- Pattern `^[a-z][a-z0-9-]{0,23}$`. `all` and `human` are reserved.
- `join(name)` fails if the name is taken. `join(name, {rejoin: true})` takes the
  existing cursor over: that is how a session continues after `/clear` or a
  restart.

## Interface

### MCP tools (four)

Every tool except `join` takes `as`, the caller's name. Subagents share their
parent's MCP connection, so the connection cannot identify the caller.

| Tool | Arguments | Returns |
|---|---|---|
| `join` | `name`, `rejoin?` | Confirmation plus the etiquette block below. |
| `send` | `as`, `to` (name, list of names, or `"all"`), `text` | `sent <id>`. |
| `inbox` | `as`, `wait_s?` (max 50) | New messages for `as`, one per line: `21:04 orchestrator: text`. Returns at once if anything is unread. Otherwise, with `wait_s`, blocks on `fs.watch` of `msgs/` until something arrives or time runs out. |
| `who` | none | Names in the run, when each last sent, and unread counts. |

Output is plain text lines, never JSON. `inbox` returns at most 20 messages
(or 4,000 characters) and ends with `N more — call inbox again` when it stops
early. Nothing is dropped.

Tool descriptions are one or two sentences each.

The server's MCP `instructions` field tells a main session the board exists and
that it should tell each subagent it spawns to `join` with a unique name.

**Etiquette,** returned by `join` so that every agent, including subagents, gets
it exactly once:

> You are `<name>` on a Crosstalk board. Pass `as: "<name>"` on every call.
> Send a message only when: you are about to edit a file another agent may be
> editing; you are blocked on something another agent owns; or you changed
> something others depend on. Never send progress reports — your result reaches
> whoever started you. When told you have unread messages, call `inbox` and act
> on them within your task.

### CLI

`ct` and `crosstalk` point at the same entry. Every command takes `--repo`.

| Command | Does |
|---|---|
| `ct join <name> [--rejoin]` | Same as the tool. |
| `ct send --as <name> --to <a,b\|all> <text>` | Same as the tool. |
| `ct inbox --as <name> [--wait <s>]` | Same as the tool. Exit code 0 with messages, 3 when none. |
| `ct who` | Same as the tool. |
| `ct new [label]` | Start a run. |
| `ct hub [--port <n>]` | Serve the hub. |
| `ct stats [run]` | Per agent: messages sent, messages and characters delivered, estimated tokens (characters / 4), `inbox` calls. |
| `ct setup claude` | Install the Claude Code adapter (below). |
| `ct mcp` | Run the MCP server on stdio. What harness configs point at. |

### Claude Code adapter

`ct setup claude` merges, never overwrites:

- a `crosstalk` entry into `.mcp.json` running `ct mcp`;
- three hooks into `.claude/settings.local.json`, each running `ct hook <event>`;
- `.crosstalk/` into `.git/info/exclude`, not the tracked `.gitignore`.

Commands are written as absolute `node <crosstalk>/dist/cli/index.js …` paths, so nothing depends on `ct` being on PATH or on which checkout `npm link` last pointed at. It prints what it changed.

The hooks, all quiet (no output) when there is nothing to say:

| Event | Does |
|---|---|
| `PostToolUse` on the MCP `join` tool | Records `hooks/<agent_id or session_id>` → name, so later hooks know who this is. |
| `PostToolUse` on any other tool | If the agent has messages it has not been **notified** of, emits `additionalContext`: `crosstalk: 2 unread messages for builder-1. Call inbox.` Never the content. Advances `notified`, so each message is announced once. |
| `Stop` and `SubagentStop` | If the agent has unread direct messages and `stop_hook_active` is false, blocks with `crosstalk: 1 unread message for builder-1. Call inbox before finishing.` |

A subagent is looked up by its `agent_id` only and never inherits its parent's mapping, so a subagent that never joined is unknown to the hooks, which then do nothing. The
hook is a single Node script that reads a few small files; it must exit in under
100 ms on Windows.

An idle desktop session can wait for mail at no cost by starting
`ct inbox --as <name> --wait 50` as a background command in a loop. This is
documented, not automated.

### Hub

`ct hub` serves one static page on `127.0.0.1` with a random token in the URL.
It shows the current run live (Server-Sent Events driven by `fs.watch`), lets
the human pick a run, and has a box to send as `human` to any name or `all`.
Plain HTML and JavaScript, no framework and no build step.

## What is removed

- `src/`: all of it. Claims, disputes, the ladder, decisions, tasks and gates, the
  daemon and its HTTP contract, tokens, presence, the GitHub mirror, worktrees,
  submit, staleness, the harness registry, brief templates, `doctor`, and the
  React hub.
- `tests/`: all of it, replaced by tests for the new code.
- `docs/`: specs, plans, audits, reviews, handoffs and kickoffs for the removed
  protocol. `CROSS-PLATFORM.md` and `FRICTION-LOG.md` stay.
- Dependencies: `yaml` (no config file remains), and the dev dependencies for
  React, Vite, jsdom and Testing Library. `@modelcontextprotocol/sdk` stays as the
  only runtime dependency.
- `README.md`, `AGENTS.md`, `docs/RUNNING.md`: rewritten. The hard rules about
  falsifiers, `seq` and frozen contracts go; the rules about no native modules,
  `execFile`, `node:path` and three-platform CI stay.

Target: about 1,200 lines of source, from about 13,000.

## Error handling

- A corrupt line in a sender's file (a crash mid-write) is skipped and counted in
  `who`; it never blocks reading the rest.
- A cursor file that fails to parse is rebuilt from `joinedAt` with offsets at
  zero, and the next `inbox` says so.
- `send` to a name that has not joined is allowed (it waits for them) but the
  result says `builder-3 has not joined yet`.
- Every failure message names the fix: `name "builder-1" is taken — pick another, or pass rejoin: true if you are builder-1 continuing`.

## Testing

TDD, real files under `os.tmpdir()`, no mocked filesystem.

- **Concurrency:** four child processes append 500 messages each to their own
  files while a fifth reads in a loop. Every message is delivered exactly once,
  in order, and no partial line is ever returned. Run five times.
- **Delivery rules:** direct messages sent before a join are delivered; `all`
  messages sent before it are not; each is delivered once across restarts.
- **Name claims:** two processes joining one name at once — exactly one wins.
- **Caps:** 50 unread messages come back as 20 plus `30 more`, then the rest.
- **MCP:** the four tools over the SDK's in-memory transport.
- **Hooks:** piped hook input JSON in, expected JSON or silence out, including
  `stop_hook_active` and an agent that never joined. One timing test holds the
  100 ms budget.
- **Hub:** a message written to a file reaches an SSE client; a message posted
  from the hub lands in `msgs/human.jsonl`.
- CI stays on Windows, macOS and Linux.

## Measuring with and without

`ct stats` gives the board's own cost. The rest comes from the Claude Code
transcripts, as before: total input, cache read, cache write and output tokens,
tool calls, wall time. A task is a fair test only if at least one of these can
happen in it: a running subagent needs redirecting, two parallel agents touch
one file, one agent learns something mid-task that another needs, or an agent
is blocked on another. Otherwise the board has nothing to do and the comparison
measures only its fixed cost.
