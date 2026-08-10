# Track G — the CLI and the hub's front door

You are building the thing that makes Crosstalk runnable. Everything behind it is built and merged; there is currently **no command to type**. `package.json` advertises `bin.crosstalk → ./dist/cli/index.js` and that file has never existed.

**Time box: ~90 minutes.** If you will miss it, push what runs and say what is missing. A CLI that starts a daemon and nothing else is worth more than a complete one that never got pushed.

## The target

The maintainer, on Windows, in one of their own repositories:

```bash
npx crosstalk init
npx crosstalk up
```

— and a browser opens on a live hub, with a Claude Code agent and a Codex agent able to join and talk. That is the acceptance test. Not a test file: that sequence, on a real repo, observed.

## Where things stand

- Base: `main`, which now carries your Track D daemon merged.
- **CI is dark** — the repository is out of GitHub Actions minutes, so pushes will not report. Verify locally and put the output in your handoff. This makes your evidence the only evidence.
- Your daemon HTTP contract (`docs/specs/2026-08-10-daemon-http-contract.md`) is the interface. It is good work and it is authoritative; where this brief and that document disagree, the document wins and tell me.

## Files you own, exclusively

```
src/cli/**            tests/cli/**
src/daemon/**         tests/daemon/**
package.json          (the bin/files/scripts keys only)
```

Nobody else touches these. Two other tracks are running in parallel — Track H owns `src/mcp/**`, Track I owns `src/ui/**`. Do not edit theirs even if you spot something; raise a claim or say it in your handoff.

## The work

**1. `crosstalk init`** — non-interactive, flags only. An agent has to be able to run it.

- Writes `crosstalk.yaml` at the repo root from `DEFAULT_POLICY`, with a `participants` list.
- Creates `.crosstalk/` and mints **one token per participant** into `.crosstalk/tokens/<id>` — `@`-stripped, and `human` stays reserved, per contract §2.3.
- Writes `.mcp.json` for Claude Code pointing at Track H's server, carrying `CROSSTALK_URL` and that participant's `CROSSTALK_TOKEN`. Coordinate the exact shape with Track H through me — a guess here costs both of you a rebuild.
- Adds `.crosstalk/` to `.gitignore` if absent. Tokens must never be committable.
- Prints, for each participant, the one line that participant pastes to join.

**2. `crosstalk up`** — the command the whole demo hangs on.

- Loads config via your existing `loadConfig`, starts the daemon, prints the URL, opens the browser unless `--no-open`.
- **The daemon must serve the built hub at `/`** from `dist/ui`. This is not decoration: your contract §3 argues for cookie auth on `/stream` *because the hub is same-origin*, and nothing serves it today. If the hub is on a different origin that argument collapses and `EventSource` cannot authenticate at all.
- Serve a runtime descriptor the hub can read for its own identity and stream URL — `GET /config.json` or an injection into `index.html`, your call. **Tell Track I which, early, in a PR comment I will relay.** They are blocked on this exact decision.
- If `dist/ui` is absent, say so and name the command that builds it. Do not fail with a bare 404.

**3. `crosstalk down`** — `POST /shutdown`, then remove the runtime files. Per `AGENTS.md` rule 9, anything anyone created under `.crosstalk/` must be findable and removable here.

**4. `crosstalk doctor`** — wire the existing `doctor()` from `src/harness/doctor.ts`. Don't rewrite it.

**5. The tier-2 transport** — this is how the Codex agent participates, so it is demo-critical, not a nice-to-have:

```
ct say      --room '#floor' --body '...'
ct claim    --room ... --body ... --falsifier ...
ct respond  <claim-id> --verdict accept|contest|uphold|amend ...
ct events   --since N
ct await    --timeout 60
ct roster | ct board | ct mine
```

Token from `CROSSTALK_TOKEN`, else `.crosstalk/tokens/<id>` with `--as <id>`. Human-readable output by default, `--json` for machines. **`ct await` is what replaces polling** — it blocks until something addresses you. Get it right and no agent in this project ever needs a watcher again.

## Rules that bite here

- **`node:path` always, `execFile` never `exec`.** Opening a browser cross-platform is exactly where this goes wrong — see `docs/CROSS-PLATFORM.md`.
- **Five consecutive runs** for anything binding a port or spawning a process, with per-run pass counts. That is your whole suite now.
- `npm test` is not a build. `npm run typecheck` and `npm run build` go in the evidence.
- Two runtime dependencies, total. No arg-parsing library — `node:util`'s `parseArgs` is in core.

## Known defect you inherit

`daemon lock > reclaims a lock whose holder has exited` and two neighbours fail roughly two runs in five, mostly as 5–6s timeouts against a 5000ms default. **The rule that produced it is mine** — I mandated `/health`-probe reclamation, which opens a window where a live holder has not yet bound its listener. My "startup window" diagnosis does not explain the 1.4s failure in the fast path, so treat it as unexplained rather than as a theory to confirm.

It does not block the demo. **Quarantine it if it costs you more than fifteen minutes** — skip with a comment naming this paragraph, and say so plainly in the handoff. I would rather have a running CLI and one honest `it.skip` than neither.

## Handing off — read this part

**Do not set up a watcher, a poll, or a scheduled task.** Not a cron, not a background loop, not a "check every 2 minutes". My last brief told you to and it was wrong: the wake predicate was a filter I got wrong three separate times, and **a poll with a broken predicate looks exactly like a poll with nothing to do.** It burned a night.

When you finish or run out of time: push, comment on your PR with the handoff, **and stop.** The maintainer relays. You will be resumed with a paste.

Handoff carries the branch, the SHA, your one-round self-critique, and per acceptance criterion the command, its output, and the SHA you ran it at. Push before you cite. Post with `--body-file` and confirm the body landed:

```bash
gh api repos/moazessam376-dev/crosstalk/issues/N/comments --jq '.[-1].body | length'
```

Findings I send you are **claims, not orders.** Contest any you think is wrong — it costs you nothing and it is the entire point of this project. About seven in ten of the findings I have raised on this repo turned out to be my error.
