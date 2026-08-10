# Track I — put the hub on a live daemon

The hub is built, styled and tested. It reads a **fixture file**. Your job is to point it at the running daemon and make the human a participant rather than a spectator.

This is the smallest of the three tracks and the most visible: it is the only one the maintainer looks at directly.

**Time box: ~60 minutes.**

## Where things stand

`useLog` (`src/ui/state/useLog.ts`) already has a working SSE branch — `{ kind: 'sse', url }` — with `EventSource`, `onmessage`, sorting by `seq`, and a `connected` flag. **You are not writing a transport.** `App` simply never selects it.

- Base: `main`, which now carries the daemon merged from Track D.
- **CI is dark** — the repository is out of GitHub Actions minutes. Verify locally; your evidence is the only evidence.

## Files you own, exclusively

```
src/ui/**       tests/ui/**
```

Track G owns `src/cli/**` and `src/daemon/**`; Track H owns `src/mcp/**`. Do not edit theirs.

## Your one dependency, and how to not be blocked by it

The daemon serves the hub same-origin and exposes `GET /config.json` → `{ version, self, streamUrl, room }`. **Settled in [`docs/specs/2026-08-10-front-door-interfaces.md`](../specs/2026-08-10-front-door-interfaces.md) §2 — you are not blocked on Track G.**

Build against it now. Fall back to the fixture when it 404s, so you stay runnable before their half lands, and never hard-code a port.

## The work

**1. Select the live source.** `App` chooses `sse` when a descriptor is present, `fixture` otherwise — keeping the fixture path alive matters, because every existing UI test uses it and I do not want them rewritten.

**2. Connection state has to be legible.** `connected` already exists and nothing renders it. Connected, disconnected, reconnecting — distinct and visible.

This is the highest-risk item on the track and it is not cosmetic. `stream.onmessage` fires **only for frames with no `event:` name** (contract §6). A daemon that names its frames leaves the hub connected, silent, and reporting healthy. This project has already shipped a handoff with 28 green tests, a clean typecheck and a clean build over a screen that rendered nothing. **A hub showing "connected" over an empty stream is the same failure wearing the same clothes.** If you can distinguish "connected and idle" from "connected and receiving nothing it understands", do.

**3. Wire the human's controls.** `onHumanAction` in `App` is unhandled — audit finding F-09, and it was mine to fix. It is yours now. The composer posts `POST /events` with `kind: "message"` as `@human`, and the human's messages must be visible in the room they were sent to, to everyone. Human intervention being visible to all participants is a product requirement, not a UI detail.

**4. An empty log is a first-run state, not a bug.** `crosstalk up` on a fresh repo shows a hub with nothing in it. Say what to do next. Do not ship a blank screen.

## Verification — the part `npm test` cannot do

**Build it, serve it, open it, and look.** A component test that passes props in proves the component draws correctly *given* data. It never proves anything hands it data. That seam is invisible from inside the test runner, and it is precisely the seam you are working on.

Your evidence must include the hub rendering live events from a real daemon — not a fixture, not a mock. A screenshot or a described observation with the command that produced it. **Everything else is secondary to that one observation.**

Then `npm test`, `npm run typecheck`, `npm run build`. Vitest transpiles without typechecking; a fully green suite can sit on code `tsc` rejects, and that has happened here twice.

Keep the existing UI tests passing. `tests/ui/verdict-parity.test.ts` and `tests/ui/unsupported-event.test.tsx` encode findings that cost real time — if one goes red, that is a finding about your change.

## Handing off — read this part

**Do not set up a watcher, a poll, or a scheduled task.** When you finish, push, comment on your PR, **and stop.** The maintainer relays. My previous brief told a track to register a scheduled watcher and it cost this project a night: the wake predicate was a filter I got wrong three separate times, and **a poll with a broken predicate looks exactly like a poll with nothing to do.**

Handoff carries the branch, the SHA, your one-round self-critique, and per criterion the command, its output, and the SHA. Push before you cite. Post with `--body-file` and confirm the body landed:

```bash
gh api repos/moazessam376-dev/crosstalk/issues/N/comments --jq '.[-1].body | length'
```

Findings I send are **claims, not orders.** Contest what you think is wrong — about seven in ten of mine on this repo have been my own error.
