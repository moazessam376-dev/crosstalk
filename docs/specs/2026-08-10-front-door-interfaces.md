# Front-door interfaces — G ↔ H ↔ I

**Status:** decided by the leader, contestable. Tracks G, H and I build against this from minute one rather than waiting on each other.

Two decisions, and only two, sit between the three tracks. Left to be negotiated in PR comments they serialize the work: H and I would both idle until G answered. So they are settled here. **Both are claims — contest either one with a falsifier and I will rule before you have lost time.**

## 1. How an agent's MCP server finds the daemon

`crosstalk init` writes `.mcp.json` into the target repository:

```json
{
  "mcpServers": {
    "crosstalk": {
      "command": "node",
      "args": ["<absolute path to>/dist/mcp/index.js"],
      "env": {
        "CROSSTALK_REPO": "<absolute repo root>",
        "CROSSTALK_TOKEN": "<that participant's token>"
      }
    }
  }
}
```

**The URL is discovered, not configured.** The MCP server reads `$CROSSTALK_REPO/.crosstalk/daemon.json`, which `startDaemon` already writes as `{ version, url, pid, startedAt }`. `CROSSTALK_URL` overrides it if set.

*Why:* the daemon binds an ephemeral port (`listen(0)`), and `.mcp.json` is static and written before any daemon exists. Pinning a default port in `init` would make the two files disagree the first time anyone passes `--port`, or the first time 7717 is taken. Discovery uses a file Track D already writes, and it is correct across restarts.

Missing `daemon.json` is not an error to swallow: fail with a message naming `crosstalk up`. An agent whose tools silently return nothing is the failure this project keeps rediscovering.

- **G** writes this file and keeps `daemon.json` accurate.
- **H** reads `CROSSTALK_REPO` + `CROSSTALK_TOKEN`, resolves the URL, and does not require `CROSSTALK_URL`.
- Absolute path to `dist/mcp/index.js` because the package is unpublished; `npx crosstalk-ai mcp` replaces it at publication and is not a v1 concern.

## 2. How the hub learns its own identity and stream

The daemon serves the built hub from `dist/ui` at `/`, same-origin — which is what makes contract §3's cookie argument hold, since `EventSource` accepts no headers in any browser.

**`GET /config.json`** → `{ version: 1, self: ParticipantId, streamUrl: "/stream", room: RoomId }`, authenticated by cookie like every other route.

**Bootstrap.** `crosstalk up` opens `http://127.0.0.1:<port>/?t=<human token>`. The daemon sets an `HttpOnly`, `SameSite=Strict` cookie and **302s to `/`**, so the token is gone from the address bar before the hub loads.

*The tradeoff, named rather than hidden:* contract §3 argues against tokens in query strings — access logs, shell history, `Referer`. That argument is weaker but not void here: loopback only, one shot, minted per run, redirected away immediately. It is also the only mechanism that gets a credential into a browser you just launched. **G owns this and may contest it** — if there is a way to seed a cookie without the query parameter, take it, and I will withdraw this.

- **G** implements `/`, `/config.json` and the bootstrap redirect.
- **I** fetches `/config.json`, falls back to the fixture when it 404s, and never hard-codes a port.

## What this does not settle

Anything inside a track's own files. `ct`'s output format, the MCP tool names, the hub's connection-state design — those are each one track's call, and I would rather read them in a handoff than specify them here.
