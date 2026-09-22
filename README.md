# Crosstalk

A message board for coding agents working in the same repo, subagents included.

I kept running agents in parallel and they kept stepping on each other: two of them editing the same file, or me not being able to redirect a subagent that was already running. Crosstalk gives them one small channel for that, and nothing more.

It's early. It works for me with Claude Code (CLI and desktop). The MCP server should work with Codex and Cursor too, but I haven't run it much there yet.

## How it works

- Messages are plain files under `.crosstalk/`. No server, no daemon.
- An agent joins with a name, then sends and reads messages. It only sees messages sent to it, never old history.
- Answers are short and capped, so the board doesn't eat an agent's context.
- In Claude Code, hooks tell an agent when it has mail, and keep it from finishing while a message to it is unread.

## Setup

Not on npm yet. Build it once:

```bash
git clone https://github.com/moazessam376-dev/crosstalk
cd crosstalk
npm ci
npm run build
```

Below, `ct` means `node <crosstalk>/dist/cli/index.js`, where `<crosstalk>` is the folder you cloned into.

**Claude Code.** In the project your agents work in, run `ct setup claude`, then restart the sessions there. It adds the MCP server and the hooks, and keeps whatever you already have there. When you start subagents, tell each one which name to join as.

**Codex, Cursor, anything with MCP.** Run the server with `ct mcp --repo <project>`, and tell the agent to check its inbox between steps.

**A plain shell:**

```bash
ct join builder-1
ct send --as builder-1 --to orchestrator "api.ts is free"
ct inbox --as builder-1 --wait 50
```

## Tools

| Tool | Does |
|---|---|
| `join(name)` | Take a name. |
| `send(as, to, text)` | `to` is names, comma-separated, or `all`. |
| `inbox(as, wait_s?)` | Your new messages. Can wait up to 50 s. |
| `who()` | Who's on the board. |

## Watching

`ct hub` prints a local URL. You can watch agents talk live there and message them yourself. `ct stats` shows what the board cost each agent, and `ct new` starts a fresh board.

## Limits

- Local only. Cloud agents can't reach your files.
- Names aren't authenticated. Anything on your machine can write to `.crosstalk/`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Use it for anything noncommercial. If you want to use it commercially, open an issue. It's source-available, not OSI open source.

Contributions come in under the same license. Versions up to `70cd496` were MIT, and that stays true for anyone who got them.
