# Track H — the MCP server

You are building how a Claude Code agent actually joins a Crosstalk conversation. This is tier 1 of the three transports, and it is the one the maintainer will test with first.

**Time box: ~90 minutes.** If you will miss it, push what works and say what is missing.

## What you are really building

Not an API wrapper. **The tool descriptions are the product.**

Crosstalk's thesis is that a code-review finding is a claim, not a command, and that falsifiability has to be structural rather than a prompt rule — because prompt rules are forgotten around turn 40 and schemas are not. Your tool schemas are where that stops being a design document and starts being enforced on a real agent mid-task.

So: `falsifier` is a **required** parameter on `raise_claim`, and its description says what a falsifier is and what a bad one looks like. `respond` explains, in the schema, that `uphold` requires *new evidence* and that restating your claim is rejected at the API. An agent that reads only your tool list should come away understanding the protocol.

## Where things stand

- Base: `main`, which now carries the daemon (routes, auth, SSE, long-poll) merged from Track D.
- The interface you code against is `docs/specs/2026-08-10-daemon-http-contract.md`. Read §3 (auth), §4.1 (route table), §5.1 (`since` is exclusive), §5.2 (room ids are percent-encoded — `#floor` becomes `%23floor`, and this fails silently rather than loudly), and §5.3 (`GET /await`).
- **CI is dark** — the repository is out of GitHub Actions minutes. Pushes will not report. Your local evidence is the only evidence.

## Files you own, exclusively

```
src/mcp/**      tests/mcp/**
```

That is all. Track G owns `src/cli/**` and `src/daemon/**`; Track I owns `src/ui/**`. If you need something changed in either, say so in your handoff and I will relay it — do not edit across the line, and do not work around it silently.

## The work

**1. A stdio MCP server** on `@modelcontextprotocol/sdk` — already a dependency, and one of only two we are allowed. Config comes from the environment: `CROSSTALK_URL` and `CROSSTALK_TOKEN`. Track G's `crosstalk init` writes both into `.mcp.json`; **agree the exact file shape with them through me before you rely on it.** A guess costs you both a rebuild.

The daemon derives `from` from the presenting token and rejects any payload that sets it. Do not send one. That rule is why the ledger can be trusted.

**2. The tools.** Mapping to §4.1, minimum:

| Tool | Route |
|---|---|
| `say` | `POST /events` (`kind: "message"` — the only kind it accepts) |
| `raise_claim` | `POST /claims` — `falsifier` required |
| `respond_to_claim` | `POST /claims/:id/response` |
| `add_evidence` | `POST /claims/:id/evidence` |
| `read_events` | `GET /events?since=` |
| `await_turn` | `GET /await?timeout_s=` |
| `roster` / `board` / `my_tasks` | the read routes |
| `ack_task` / `set_task_state` | `POST /tasks/:id/ack`, `/state` |
| `vote` | `POST /decisions/:id/vote` |

Write routes return a **list** of appended events (§4.2) — a vote can append `vote_cast` *and* `decision_resolved`. Surface all of them; an agent that sees only the first will not know the decision closed.

**3. `await_turn` is the anti-stall primitive.** It long-polls until an event addresses the caller, so an agent waits without burning turns and without a scheduled task. Make its description say that plainly, so an agent reaches for it instead of inventing a poll. This project lost a night to invented polls.

**4. Errors have to teach.** The daemon returns codes like `EVENT_KIND_NOT_APPENDABLE` with messages naming the right route (`"claim_raised is not directly appendable — use POST /claims"`). Pass that through intact. The failure mode worth defending against is not a hostile agent but a capable one that found the wrong door and got an unhelpful answer.

## Testing

Test against a **real daemon** on an ephemeral port, not a mock. A mocked HTTP layer would have caught none of the four defects this project actually shipped.

**Five consecutive runs, per-run pass counts** — you bind a port, so this is you. `npm run typecheck` and `npm run build` in the evidence; a green vitest run on code `tsc` rejects has happened here twice.

**Prove your tests can fail.** Break a tool on purpose — drop the `falsifier` from the schema, hard-code a success return — and confirm the suite goes red. If it stays green it was never testing that. Restore afterwards.

## Handing off — read this part

**Do not set up a watcher, a poll, or a scheduled task.** Not a cron, not a background loop, not "check every 2 minutes". My last brief told a track to do exactly that and it was wrong: the wake predicate was a jq filter I got wrong three separate times, and **a poll with a broken predicate is indistinguishable from a poll with nothing to do.**

When you finish or run out of time: push, comment on your PR, **and stop.** The maintainer relays; you will be resumed with a paste.

Handoff carries the branch, the SHA, your one-round self-critique, and per acceptance criterion the command, its output, and the SHA you ran it at. Push before you cite. Post with `--body-file`, then confirm the body survived:

```bash
gh api repos/moazessam376-dev/crosstalk/issues/N/comments --jq '.[-1].body | length'
```

Exit zero proves the request was accepted, not that the body arrived. Two tracks have hit this independently.

Findings I send you are **claims, not orders.** Contest any you believe is wrong — roughly seven in ten of mine on this repo have been my own error, and the rate went *up* on the documents I wrote myself.
