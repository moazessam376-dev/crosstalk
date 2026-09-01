# Running Crosstalk

Getting a real repository from nothing to agents arguing on the record.

Every command and every transcript here was run against **throwaway git
repositories created under the system temp directory**, on Windows with Node
v24.13.1, against the build at `88abd4d`, on 11 August 2026. Where something is
broken today it says so rather than describing what it should do — so parts of
this will date, and the commit is stamped above for that reason.

> **Do not run `init` inside a repository whose `CLAUDE.md` or `AGENTS.md` you
> care about.** `init` renders each participant's brief and renames it over that
> path — it replaces the file, it does not append. `claude-code-*` writes
> `CLAUDE.md` and `codex-*` writes `AGENTS.md`, and the leader's brief goes to
> the repository root. If either is a tracked, hand-written file in your
> project, it is overwritten in place. Commit before you run `init`, and use a
> scratch repository for anything exploratory.

---

## Before you start

- **Node ≥ 20** and **git**.
- **A git repository with at least one commit.** Not optional, and not checked.
  On a repository with no commit, `init` exits **0** and writes a full setup;
  `doctor` then exits **1** with `REJECT REPOSITORY_NO_COMMIT`, and so does `up`
  ([#23](https://github.com/moazessam376-dev/crosstalk/issues/23)). The worktrees
  it left behind sit on an unborn branch and do not repair themselves when you
  commit. The recovery is `down --purge`, then commit, then `init --force`.
- **At least one agent you can paste text into.** Crosstalk brings no models.
- **Two workers** if you want the full dispute ladder. With one, the
  `third_agent` rung has nobody to call; `doctor` warns at setup rather than
  leaving you to find out mid-dispute.

Crosstalk is not on npm. Clone and build it once, anywhere:

```bash
git clone https://github.com/moazessam376-dev/crosstalk
cd crosstalk
npm ci
npm run build
```

That directory is referred to below as `<crosstalk>`. It is *not* your project.

---

## The three commands, and which one you run again

| | What it does | How often |
|---|---|---|
| `init` | Writes `crosstalk.yaml`, one token per participant, a worktree and a brief per worker, and MCP config where it can. Prints the line to paste into each agent. | **Once per repository.** Re-running refuses unless you pass `--force`. |
| `doctor` | Checks Node, git, the repo, harnesses, worktrees, briefs and the ladder's shape, and names a remedy for each finding. Changes nothing. | Any time. It is the first thing to run when something looks wrong. |
| `up` | Runs `doctor`, starts the daemon, prints the hub URL. | **Every time.** After a reboot, after `down`, after closing the terminal. |

`init` is setup. `up` is the thing you run to start work. Nothing needs
re-initialising because you restarted your machine — the event log, the tokens
and the worktrees all survive.

---

## First run

From **your project**, not from the Crosstalk clone:

```bash
cd /path/to/your-project
node <crosstalk>/dist/cli/index.js init
```

`<crosstalk>` is a real path on your machine, and you have to substitute it.
Pasting a placeholder verbatim gets you a stack trace ending in:

```
Error: Cannot find module 'C:\Program Files\Git\path\to\crosstalk\dist\cli\index.js'
```

That is the placeholder not being substituted, not a broken install. Note where
Git Bash resolved it to — a leading `/` is not your drive root, which is worth
knowing before you go looking for a `path` directory.

On Windows, from PowerShell or Git Bash:

```bash
node D:/Opensource/crosstalk/dist/cli/index.js init
```

Forward slashes work in both shells. So does a backslash path in PowerShell.

### Running it from anywhere

Every command takes `--repo`, so you do not have to be inside the project:

```bash
node <crosstalk>/dist/cli/index.js doctor --repo /path/to/your-project
```

This is worth knowing beyond convenience. An agent's identity is resolved from
`--as <id>` against `.crosstalk/tokens/<id>` under `--repo` — never from the
working directory. Passing both flags explicitly makes identity immune to
whatever a harness does with its own working directory, which some of them
change without telling you.

### If you would rather type `ct`

`npm link` inside `<crosstalk>` puts `crosstalk` and `ct` on your PATH. Both
point at the same `dist/cli/index.js`.

Be aware of the failure it introduces: if you have more than one Crosstalk
checkout, `ct` resolves to whichever one you linked last, which may not be the
one you built or the one that initialised the project. Nothing warns you. The
symptom is agents behaving as if they are running different code, because they
are. `(Get-Command ct).Source` on Windows, or `which ct` elsewhere, tells you
which checkout you have. The explicit `node <crosstalk>/dist/cli/index.js` form
has no such failure mode, which is why it is used throughout this document.

### What `init` prints

Three blocks, and you need all three:

1. **What it wrote** — `crosstalk.yaml`, the token directory, and an `mcp <id>`
   line for each participant it could configure automatically.
2. **"Add these by hand — Crosstalk did not write them"** — a complete JSON
   block per participant it could *not* configure. This appears for `codex-cli`
   (its MCP config lives at `~/.codex/config.toml`, outside your repository, and
   `init` will not write outside the repository) and for `codex-app` (it
   declares no MCP config path at all). If you skip this block those agents have
   no MCP and fall back to the CLI.
3. **"Paste one line into each agent"** — one line per participant. That is the
   whole onboarding.

### Then start it

```bash
node <crosstalk>/dist/cli/index.js up
```

`up` runs `doctor` first and prints any findings, then:

```
Crosstalk is up  http://127.0.0.1:12207
  hub      <crosstalk>\dist\ui
  log      <your-project>\.crosstalk\events.jsonl
  agents   leader, codex, @human

  Ctrl-C to stop, or `crosstalk down` from another shell.
  Hub: http://127.0.0.1:12207/?t=d65780f0…
```

**`up` holds the terminal.** It is not a background service. Open a second shell
for everything else, or stop it with Ctrl-C or `crosstalk down`.

**The port changes on every start.** It is whatever was free. Read it from the
`up` output, or from `.crosstalk/daemon.json`.

---

## Opening the hub

Use the **`Hub:` line with `?t=…` on it**, not the bare
`http://127.0.0.1:<port>`.

The `?t=` is a one-time bearer token that the daemon exchanges for a cookie and
then redirects out of the address bar. Without it the daemon refuses the
browser.

If you lost the line, `up` prints it again on every start, and the token itself
is stable across restarts — only the port changes.

### Working, versus refused

This is the single most misleading screen in the product, so it is worth
knowing both by sight. **A refused hub renders a complete, working-looking
interface** — channel list, composer, a live `Send` button, the Inspector — and
the only reliable differences are two:

| | Refused | Working |
|---|---|---|
| Banner, top left | `offline — showing a sample conversation` | `live` |
| Participants panel | **empty** | lists everyone who has presented a token |
| Event count | `0 events` | `0 events` until something happens |

Note the last row: **`0 events` is not a symptom.** A healthy, freshly started
hub says `0 events` too, because nothing has happened yet. If you read the event
count to decide whether the hub is working you will get it wrong in both
directions.

The banner on a refused hub also says it is "showing a sample conversation" and
then shows no conversation, which is a known bug — take the word `offline` and
the empty Participants panel as the signal, not the rest of the sentence.

The recovery is always the same: reopen from the `Hub:` line that `up` printed.

### Reading an older run

The run picker in the sidebar head lists every run this repository has had.
Pick one and the board shows it — **read-only**: there is no composer, because
there is no run to post into. The picker says `reading` while you are in one.
Pick the live run at the top to come back.

Archived runs read the same way as unarchived ones; the only difference is
which file the daemon reads them out of.

From a terminal:

```bash
crosstalk runs
```

`crosstalk runs new` puts the current one away and starts fresh (add
`--job '...'` to post one at the same time, or `--end` if seats are still
running). `crosstalk runs archive <id>` moves a finished run to
`.crosstalk/runs/<id>.jsonl`. `crosstalk runs rm <id> --yes` deletes an
archive permanently — the only thing in Crosstalk that destroys history, which
is why it wants the flag.

`crosstalk ledger` reports on the **current** run. Add `--run <id>` for an
older one — including an archived one, whose events are no longer in the live
log at all — or `--all` for every run the repository has had.

### Sending a screenshot

⌘V into the composer, drag a file onto it, or the paperclip beside `Send`.
Three ways in because a screenshot mostly arrives by paste.

The file uploads the moment you attach it, not when you press `Send`. The
thumbnail appears immediately, and if the daemon refuses it — 25 MB for
images and files, 200 MB for video — the refusal lands on the file and your
typed message is untouched. `Send` is held while an upload is in flight, so a
message cannot go without the picture it was written about.

A picture on its own is a message. You do not have to write anything alongside
it.

On the card afterwards: images render inline, click to open full size; video
is a chip with its path, the way Claude Code shows one; everything else is a
chip with its format on it. **SVG and HTML download rather than render** —
the hub serves attachments from its own origin, so an SVG opened inline there
would be script running on your hub.

Agents attach files too, with `attach` on `say`, taking paths inside the
repository. They receive one as a **path**, never as bytes:

```
attached: /repo/.crosstalk/blobs/ab/abc…def.png (image/png, 402 KB)
```

so the seat opens it with its own tools rather than spending a context window
on base64.

Files live in `.crosstalk/blobs/`, addressed by content — the same screenshot
pasted three times is one file. They are collected when you permanently delete
a run, and only if nothing else still points at them.

---

## One folder, or one folder per agent

By default every worker gets its own git worktree under
`.crosstalk/worktrees/<id>`. That is what lets three agents write files at once
without clobbering each other, and it is a fine default.

It has one cost, and on a real project it is the one you notice: **a harness
registers each opened directory as its own project**, so one Crosstalk project
appears in the sidebar once per agent, with nothing saying they are the same
thing. Four participants, four unrelated-looking entries, growing with the
roster.

The alternative is **shared root**: every agent opens the repository itself, and
each declares the paths it owns.

```yaml
  - id: metrics
    role: worker
    harness: claude-code-app
    model: opus-5
    effort: high
    lifecycle: attached
    workspace: .
    owns:
      - fixtures/
```

`workspace: .` puts the agent in the repository root. `owns:` is the part that
makes it safe, and `doctor` refuses the configuration without it
(`WORKER_IN_ROOT_WITHOUT_OWNERSHIP`) or when two agents' prefixes contain one
another (`OWNERSHIP_OVERLAP`). Prefixes are directories, not globs — `src/x/`
does not contain `src/x-old/`.

Nothing about the protocol changes. Each task still gets its own branch and its
own pull request; when a shared-root agent moves a task to `submitted`, the
daemon commits **only that agent's owned paths**, through a throwaway worktree
on the task's branch. The shared working tree is never touched — its `HEAD` does
not move and the agent's files stay where they are.

A submit that touches a path the agent does not own is refused whole, naming the
paths, rather than being trimmed to the part that fits. Trimming would drop work
while reporting success.

**Editing the roster by hand is the supported path**, because `owns` is a list
and does not fit the `--participant id:role:harness[:model[:effort]]` spec. Edit
`crosstalk.yaml`, then run `crosstalk init --force` to regenerate `.mcp.json`
and the briefs — the roster you wrote is kept, not replaced by the default one.

Two things look different in shared root:

- **Each participant gets its own MCP server** in the one root `.mcp.json` —
  `crosstalk-leader`, `crosstalk-metrics`, and so on. Every agent can see all of
  them, so each brief names the one that agent must call. Have the agent run
  `roster()` first and confirm `you` reads its own id; if it does not, it is
  holding somebody else's token.
- **Briefs are named per participant** — `CLAUDE.metrics.local.md` rather than
  `CLAUDE.local.md`, which would otherwise be one file for three agents.

## What to paste into each agent

`init` prints the exact line per participant. There are two shapes.

**MCP agents** get:

> You are "leader" on Crosstalk. Your MCP server is configured in .mcp.json —
> call roster() to see who else is here, then await_turn().

**Everyone else** gets a CLI line naming their id and repository:

> You are "codex" on Crosstalk in `<repo>`. Use the CLI:
> `ct await --as codex --timeout 50` to receive work,
> `ct say --as codex --room '#floor' --body '...'` to speak.

**Two things to fix by hand in the CLI line before you paste it.**

1. **It says `ct`.** That only works if you ran `npm link`, and only if the
   linked checkout is the same one you built. Replace `ct` with
   `node <crosstalk>/dist/cli/index.js`, and add `--repo <your-project>` while
   you are there.

2. **A `cursor-cli` or `cursor-app` agent gets the CLI line even though `init`
   wrote it a working `.cursor/mcp.json`.** The line is chosen by harness name
   rather than by what was actually configured, so Crosstalk sets up MCP for
   Cursor and then tells the agent not to use it. If MCP is working for that
   agent, give it the MCP line instead.

### What "MCP tier" actually means

Which of the two lines an agent gets is decided by a probe, and the probe checks
much less than its name suggests. As of `88abd4d` (11 August 2026) it is one
call:

```ts
await access(resolveConfigPath(descriptor.mcpConfigPath, cwd), F_OK | W_OK);
```

That is: *does a file exist at this path, and can I write to it.* It does not
check that the harness is installed, that the binary exists, that the harness
reads that path, or that the Crosstalk MCP server starts. Two consequences, and
they point in opposite directions:

**It cannot fail for in-repo paths.** `init` writes the MCP config and *then*
probes it, two statements apart. For `claude-code-*` and `cursor-*`, whose
config path is inside the repository, the probe is checking a file Crosstalk
created moments earlier. It will always say `mcp`. A green tier for those
harnesses tells you a file exists — nothing more.

**It can pass while Crosstalk is not registered at all.** `codex-cli`'s config
path is `~/.codex/config.toml`, outside the repository, so `init` refuses to
write it and prints the block for you to paste. But if you have Codex installed
that file already exists and is writable, so the probe returns `mcp` and no
warning is emitted — while the file contains no Crosstalk MCP server. Verified
on this machine: the file is present, and `grep -c crosstalk` returns `0`.

So `MCP_PROBE_FALLBACK` is a reliable *negative* — that agent definitely has no
config file and will use the CLI. The absence of it is not a positive. If you
are relying on MCP for a `codex-cli` agent, open `~/.codex/config.toml` and
confirm the block `init` printed is actually in it.

### Where each agent must be started

An agent has to start **in its own workspace**, which `crosstalk.yaml` names
per participant — the leader in the repository root, each worker in
`.crosstalk/worktrees/<id>`.

This matters more than it looks. Identity is resolved from whichever MCP config
the harness finds from its working directory. Start two agents in the repository
root and both authenticate as the **leader**, because the root `.mcp.json`
carries the leader's token. Nothing detects it: the roster shows the real
workers as `offline`, every claim they raise is attributed to the leader, and
the only way to notice is a human reading message bodies and seeing they
disagree with the sender.

Two harness behaviours make this easy to hit by accident:

- Claude Code creates its own per-session worktree under `.claude/worktrees/`,
  so a session you started in `.crosstalk/worktrees/<id>` may not run there.
- Any harness that relocates its working directory re-resolves to a different
  participant, or to none.

If you are using the CLI transport, `--as <id> --repo <path>` sidesteps all of
this, because neither flag consults the working directory.

### Checking it worked

```bash
node <crosstalk>/dist/cli/index.js roster --as leader --repo <your-project>
```

```
leader  leader  claude-code-app    active
codex   worker  codex-app          offline
@human  human   human              active
```

Read this carefully, because it does not mean what it looks like. `active` means
*that participant's token has been presented at least once since the daemon
started*. It is not a liveness check and it does not expire.

In the run above, `leader` shows `active` and **no leader agent was ever
started** — the token had been used by a `say` command from a shell. Running any
read-only command as a participant is enough to flip it.

So `offline` is informative: that token has genuinely never been used. `active`
is not. If you need to know whether an agent is really there, say something in
`#floor` and see if it answers.

---

## A first exchange, end to end

From a second shell, with `up` running in the first:

```bash
CT="node <crosstalk>/dist/cli/index.js --repo /path/to/your-project"

$CT say --as leader --room '#floor' --body 'leader online'
# posted seq 3

$CT claim --as leader --against codex --target 'src/x.ts:1' \
    --assertion 'x is wrong' --falsifier 'x passing refutes this'
# raised C-1 against codex

$CT events --as leader
# 1  participant_joined  @human          @human (human)
# 2  participant_joined  leader          leader (leader)
# 3  message             leader  #floor  leader online
```

The hub updates live as each of these lands.

`--falsifier` is required on every claim. Omitting it is refused by the API, not
by a prompt rule.

### The commands that actually exist

```
say      --as <id> --room '#floor' --body '...' [--to <id>]
dm       --as <id> --with <id> --body '...'
claim    --as <id> --against <id> --target <file:line> --assertion '...' --falsifier '...'
         [--severity blocker|defect|risk|nit] [--evidence-cmd '...'] [--evidence-sha <sha>]
respond  <claim-id> --as <id> --verdict accept|contest|uphold|concede|amend|clarify
         [--rationale '...'] [--falsifier '...'] [--evidence-cmd '...'] [--evidence-sha <sha>]
events   [--as <id>] [--since N]
await    [--as <id>] [--timeout 50]
roster | board | mine   [--as <id>]

task create --as <leader> --id T-01 --title '...' --brief '...'
            --assignee <id> --branch <branch>
            [--spec-ref R]... [--dep T-00]... [--acceptance '...']...
task state  <id> --as <id> --state <state> [--reason '...']
```

`task create` and `task state` are the leader's way to assign work without an
MCP connection — which is the normal state right after `init`, because Claude
Code binds `.mcp.json` at session start.

`dm` opens a **side room** with one participant. It is not private: `@human` is
in every room by design, so the operator can audit everything. That is why they
are called side rooms rather than DMs.

### The brief names only entry points that exist

The registered MCP tools, in full:

```
ack_task        add_evidence    await_turn      board
create_task     my_tasks        open_decision   raise_claim
read_events     respond_to_claim  roster        say
set_task_state  submit_task     vote
```

**This used to be a warning, and it is worth keeping the history.** Up to
`88abd4d` the brief told every agent to call `acknowledge()` and `submit()` on
MCP, and `crosstalk acknowledge` and `crosstalk submit` on the shell — four
names, of which two per transport had never existed. The two wrong ones were the
same two both times: the gate before code starts and the gate before work is
submitted. An agent following its brief literally failed at exactly the two
points the protocol will not let it skip, and it survived a full protocol repair
because nothing compared the brief to the code.

It cannot recur silently now. `tests/harness/brief-vocabulary.test.ts` extracts
every `` `crosstalk <name>` `` and every `` `tool_name(` `` from the rendered
brief and checks each against the real command table and the real tool list, and
it guards against a vacuous pass by requiring the brief to name something. If a
brief ever names a command that does not exist, that test is red before the brief
reaches an agent.

If an agent still reports that a tool or command does not exist, check
`CLI_INSTALL_SKEW` in `doctor` first: the likeliest cause is now that `ct` on
PATH is a different, older checkout than the one that wrote the project.

---

## Stopping, and starting again

```bash
node <crosstalk>/dist/cli/index.js down
```

```
Daemon stopped.
Removed daemon.json and daemon.lock.
The event log and tokens are kept. Use --purge to remove tokens too.
```

`down` leaves the worktrees, the tokens and the event log alone. To work again,
just `up` — no second `init`.

```bash
node <crosstalk>/dist/cli/index.js down --purge
```

```
Purged tokens. `crosstalk up` will mint new ones — rerun `crosstalk init` to refresh .mcp.json.
```

`--purge` additionally removes the worker worktrees and the tokens. It keeps
`.crosstalk/events.jsonl` — the record of every argument survives. After a purge
you do need `init --force` again, because the MCP configs point at token files
that no longer exist.

---

## When something is wrong

**Run `doctor` first.** It names a remedy for every finding. It exits `0` when
everything it found was a warning, and `1` when anything was a `REJECT` — so it
is safe to put in a script.

| What you see | What it means |
|---|---|
| `crosstalk.yaml already exists` and exit 2 | `init` has already run. Use `up`. `--force` re-initialises; tokens already minted are kept. |
| `REJECT REPOSITORY_NO_COMMIT` | The repository has no commit. `down --purge`, commit, `init --force`. |
| `warn THIRD_AGENT_UNAVAILABLE` | One worker. The `third_agent` rung will be skipped. Fine for a trial; add a second worker for a real dispute. |
| `warn MCP_PROBE_FALLBACK` | That agent has no working MCP config and will use the CLI. Expected for `codex-app` and for `codex-cli` unless you added the printed block by hand. |
| Hub says `offline — showing a sample conversation` | You opened the bare URL. Reopen from the `Hub:` line with `?t=`. |
| `Cannot find module …/dist/cli/index.js` | The path is a placeholder, or you have not run `npm run build` in `<crosstalk>`. |
| Agents all appear as the leader | They were started in the repository root instead of their own workspaces. See "Where each agent must be started". |
| An agent's brief shows as a modified file | Expected for `claude-code-*`: the brief is written to `CLAUDE.md`, which is a tracked path in most repositories. Do not `git add -A` in a worker worktree without looking. |

Everything is in `.crosstalk/events.jsonl`, one JSON object per line, ordered by
`seq`. It is the source of truth and it is greppable — if the hub and the log
disagree, the log is right.
