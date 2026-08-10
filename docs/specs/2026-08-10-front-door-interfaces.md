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

## 3. `GET /stream` does not exist — found by probe, after the briefs went out

Contract §6 specifies SSE at `GET /stream`. **The daemon returns `404 UNKNOWN_ROUTE`.** Every other route in §5 is implemented; PR #4 is titled "daemon, SSE, MCP, CLI" and landed D1 only, because D2 and D3 were never started.

Verified against a real daemon built from `dist/`:

```
GET /health                    200   (unauthenticated, leaks nothing)
GET /events  (no token)        401
POST /events kind:message      201
POST /events with `from` set   403   (identity is derived, not accepted)
GET /stream                    404   {"code":"UNKNOWN_ROUTE"}
```

**No test claimed otherwise.** Track D shipped D1 and did not fabricate coverage for the rest; the gap is scope, not a false green. Cookie auth — the half of §6 that is hard — is implemented and tested.

**Owner: Track G, ahead of the CLI.** Track I cannot connect a live hub to a route that 404s, and the demo has no live surface without it. It is ~40 lines against a contract section Track G wrote.

**Track I ships a fallback regardless.** Poll `GET /events?since=` when `/stream` 404s. `since` is exclusive (§5.1), so a poll that saw `seq` 42 asks for `since=42`. This is inside `src/ui/**` and depends on nothing from Track G, so neither track can be blocked by the other's timing.

### One unexplained observation, offered as a report and not a diagnosis

The probe process ended with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76` after `daemon.close()`. It may well be the probe cancelling a stream reader mid-flight rather than anything in the daemon. **One occurrence, no isolation run, no theory** — recorded so it is not lost, explicitly not a finding. Tonight already produced three confident diagnoses of a flake that turned out to be none of them.

## What this does not settle

Anything inside a track's own files. `ct`'s output format, the MCP tool names, the hub's connection-state design — those are each one track's call, and I would rather read them in a handoff than specify them here.
