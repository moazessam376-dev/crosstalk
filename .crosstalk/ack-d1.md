# D1 acknowledgement — daemon, sole writer, lock, token auth

Branch `track-d/runtime` at `a3f08b3`, rebased onto `main` at `7f627a7` and pushed. Contract frozen; all thirteen acknowledgement items and CT-D-1 verified present before starting.

**Watch registered.** A harness scheduled task, `crosstalk-track-d-pr4-watch`, re-reads PR #4 every three minutes and resumes Track D in a fresh session if a new `— leader` comment appears. Not an in-session loop — the previous session died holding for a review that had already landed, which is the failure the brief now names. It is seeded with `5234185398` so it starts quiet.

---

## Restatement

Build the daemon: `node:http` bound to `127.0.0.1` on an ephemeral port, the sole writer to `events.jsonl`, funnelling every write through one `EventLog` instance. An advisory lock at `.crosstalk/daemon.lock` makes a second daemon refuse to start and report the live address. One bearer token per participant under `.crosstalk/tokens/`, with the daemon deriving `from` from the presenting token and rejecting any payload that sets it.

Every route in the frozen contract **except `GET /stream`**, which is D2. That scope follows by construction rather than by choice: D2 ∥ D3 start together once D1 lands, and D3's MCP server is an HTTP *client* of `/claims`, `/tasks`, `/decisions`, `/await`, `/roster` and `/board`. If D1 shipped only the four routes its step 1 names, D3 would start blocked.

Acceptance, from the plan: a second `startDaemon` rejects with `DAEMON_ALREADY_RUNNING` and reports the live URL; no bearer token gets 401; a payload that sets `from` is rejected; `GET /events?since=N` returns the tail exclusive of `since`.

---

## Conflicts and gaps

### 1. Nothing in the repository can load `crosstalk.yaml` — and no track owns it

`startDaemon(opts: { repo, port? })` takes only a repo path, but it needs the participant roster to mint one token per participant and to stamp `participant_joined` with a whole `Participant`. That roster lives in `crosstalk.yaml`.

Checked at `a3f08b3`: `src/contracts/config.ts` declares `CrosstalkConfig`, `doctor(config, cwd)` *consumes* one, and **nothing anywhere produces one from disk**. There is no `crosstalk.yaml` in the repo either. The plan's file-ownership table has no row for config loading.

**Proposed:** `src/daemon/config.ts`, exporting `loadConfig(repo: string): Promise<CrosstalkConfig>` using `yaml`, which is already one of the two permitted runtime dependencies. `src/daemon/**` is Phase D's, and `src/cli/**` is too, so wherever it ends up it is mine — I want it named rather than assumed, because `doctor` will want the same loader in D4 and two loaders that disagree about defaults is a bug with a long fuse.

Missing or unparseable config is a startup failure, not a protocol error: `MALFORMED_CONFIG` in the daemon namespace, thrown by `startDaemon`, never reached over HTTP.

### 2. Plan step 3 still describes the single-token file

> Write `{url, token}` to `.crosstalk/daemon.json`

That is residue from the shape corrected at `40b5360` — the interface two lines above it now returns `tokens: ReadonlyMap<…>`. Spec §6.1 and contract §2 both put tokens in `.crosstalk/tokens/<id>` and keep `daemon.json` token-free, so that a process discovering the daemon does not thereby acquire everyone's identity.

**Following the contract**, writing `{version, url, pid, startedAt}`. Flagging rather than silently diverging from a checklist step.

### 3. The lock needs liveness, not just a pid

Plan step 3: "a stale lock whose pid is gone is reclaimed." A pid that is *present* is not proof the daemon is alive — pids are recycled, and on Windows a reused pid is entirely ordinary.

**Proposed:** the lock file holds `{pid, startedAt, url}`. Reclaim when the pid is gone (`process.kill(pid, 0)` throws `ESRCH`), **or** when the pid exists but `GET /health` at the recorded url does not answer within 500 ms. Both tested. Without the second check a recycled pid makes the daemon permanently unstartable, and the remedy — deleting a lock file by hand — is exactly the kind of thing a user should never be asked to do.

`process.kill(pid, 0)` throwing `EPERM` means the process exists and belongs to someone else: treat as alive, do not reclaim.

### 4. One code the contract does not have

`opts.port` given and already bound is `EADDRINUSE`, which is not `DAEMON_ALREADY_RUNNING` — the lock is free, the port is not. Adding `PORT_IN_USE` to `DaemonErrorCode`, which is Phase D's own namespace. Noting it because the contract enumerates that namespace and I would rather the list stay true than stay unchanged.

### 5. The `contains` filter can match my own comments

`e6f214b` fixed `endswith("— leader")`, which matched nothing. The replacement, `contains("— leader")`, matches the marker **anywhere in the body** — including a worker comment that quotes a leader ruling. I quote your rulings routinely; this acknowledgement does it twice.

The failure is not cosmetic: `map(select(...)) | last` would return *my* comment, and a fresh watch session would read my own text as your ruling and act on it. That is friction-log entry 9 once more — a predicate that cannot tell participants apart.

`test("— leader[[:space:]]*$")` anchors to the end, has no backslashes to mangle through a shell or a markdown fence, and I verified it at `a3f08b3`: four matches, all yours, none of my three. My scheduled task already uses it. Your call whether the briefs change — raising it because the next reader inherits whichever one is written down.

---

## Assumptions

- `.crosstalk/` gets created if absent. `daemon.json`, `tokens/` and `worktrees/` are already gitignored, so nothing a daemon writes can be committed by accident.
- `0o600` is attempted and its failure ignored on Windows, where it is a no-op (CROSS-PLATFORM §5). `doctor` reports it; the daemon does not claim a permission it does not have.
- Tests build a real throwaway repo under `os.tmpdir()` with a real `crosstalk.yaml`, and every one closes its daemon in `finally` — an orphaned listener here would hold `node_modules` and surface hours later as somebody else's `EPERM`.
- Shutdown handles `SIGINT`, `SIGTERM` and `POST /shutdown`, and relies on none of them arriving.

Starting now, TDD, in the plan's step order. Nothing above blocks it.
