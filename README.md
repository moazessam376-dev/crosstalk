<div align="center">

# Crosstalk

**Multi-agent development where a code-review finding is a claim, not a command.**

Agents from different vendors — Claude Code, Codex, Cursor — build the same project together, argue about it on the record, and settle disagreements with evidence instead of rank.

</div>

---

## The problem

Give a leader agent authority over worker agents and you get a hierarchy with no burden of proof. Two things go wrong, and they compound.

**The leader isn't an oracle.** In the session that motivated this project, roughly as many defects came from the orchestrating agent — misread code, briefs that contradicted each other — as from either worker. When findings are treated as orders, leader error becomes worker rework, and sometimes turns correct code into broken code.

**Evidence is routinely unfalsifiable.** The dominant worker failure wasn't bad code. It was good code with proof that would look identical whether or not the feature worked:

| Offered as proof | What it actually showed |
| --- | --- |
| `errors: []` | the renderer didn't throw |
| a colour delta of 15.5 | the checker's own constant |
| `unstaffed: 0, starved: 0` | there was no economy at all |

Naming each instance didn't generalise. Naming the *pattern* did — so it should be enforced by the system, not rediscovered every session.

The obvious fix — "let workers push back" — creates a third failure: agents defending broken code with plausible arguments, and a leader that folds to whoever argues better. Sycophancy inverted is not an improvement.

## The approach

A finding is a **claim** with a lifecycle, not an instruction.

- **Symmetric burden of proof.** A leader's claim and a worker's rebuttal are validated by the same schema. No rank-based shortcut.
- **Falsifiability is structural.** Every claim names what would be observed if it were wrong — a *required API field*, not a prompt rule. Prompt rules are forgotten around turn 40; schemas aren't.
- **`uphold` requires new evidence.** Restating your original claim is rejected at the API. That's the anti-stubbornness rule, and it applies to the leader.
- **Disputes become experiments.** Most disagreements about code are empirically decidable, so the first rung of every escalation ladder is "derive a command from your falsifiers and run it."
- **Evidence expires.** Every result carries the commit it was gathered at. When the base moves, it goes stale and the claim reopens — no more "passing", on code that no longer exists.
- **The log is the protocol.** Append-only JSONL is the source of truth; the daemon is an accelerator. Every argument your agents ever have is a plain-text file you can grep, diff and commit.

A local hub renders it: rooms for the group and 1:1, disputes shown with both sides' falsifiers next to each other, and a human who can step in at any point.

## Status

**Working, and not yet used in anger.** The protocol, the daemon, the CLI, the
hub and the GitHub mirror are implemented and tested on Windows, macOS and Linux.
It has been run end to end on throwaway repositories and used to build itself —
it has not been through a long real project with somebody else's agents.

What runs today:

| | |
|---|---|
| **The claim protocol** | `falsifier` required and lint-checked; `contest` needs rationale, counter-evidence and its own falsifier; `uphold` needs new evidence. Enforced at the API, not in a prompt. |
| **Disputes that alternate** | Each side answers in turn until somebody concedes, amends or the round cap is reached. |
| **The escalation ladder** | Past `maxRounds` the daemon opens it with no agent asking: `discriminating_test`, then an uninvolved peer, then the leader. The non-terminal rungs each expire on a timeout; the last one waits for a decision rather than expiring, because a ladder that ran off its own end would resolve nothing. Every skipped rung is named with its reason. |
| **Evidence that expires** | Every result carries the commit it ran at. When a merge orphans that commit the claim reopens, and a submitted task goes back to `in_progress`. |
| **Two task gates** | Nothing reaches `in_progress` without the assignee restating the brief; nothing reaches `submitted` without a self-critique record. |
| **The hub** | Loopback web UI, live over SSE, both sides' falsifiers side by side, the ladder's climb with skipped and failed rungs distinct. The human can post and vote. |
| **The GitHub mirror** | One PR per task, one comment per claim edited in place, the ladder published rather than flattened, and repository-owner comments pulled back in as `@human`. |
| **`doctor`** | Checks Node, git, the repo, harnesses, worktrees, briefs and the ladder's shape, and names the remedy for each. |

Known gaps, so you find them here rather than at the wrong moment:

- **`taskAcceptance.method` only works as `leader` or `human`.** `majority` and `unanimous` are now refused with `NOT_TASK_AUTHORITY` rather than stranding silently, but the remedy that refusal names — open a decision and let its outcome carry — does not exist yet: nothing maps a resolved decision onto a task state. `doctor` still does not refuse the config. Use `leader`.
- **Supervised lifecycle is not implemented.** Every agent is `attached`: you start it and paste the line `init` prints. The harness descriptors mark three CLI harnesses `supervisable` and `doctor` rejects pairing that with a GUI app, but nothing spawns, resumes or restarts anything.
- **The tier-3 file inbox is not built.** Agents participate over MCP or the CLI.
- **The ledger (§12) is not built.** The data is all in the log; nothing renders it yet.
- **The brief names entry points that do not exist, on both transports.** MCP agents are told to call `acknowledge(...)` and `submit(...)`; the tools are `ack_task` and `submit_task`. CLI agents are told to run `crosstalk acknowledge` and `crosstalk submit`, which do not exist, and `crosstalk claim raise`/`claim respond`, which are `claim` and `respond` with different arguments. Both times it is the two task gates that are wrong, so an agent following its brief fails at exactly the points the protocol will not let it skip. [docs/RUNNING.md](docs/RUNNING.md) lists the real tools and commands.
- **A refused hub looks like a working, idle one.** It renders the full interface — channel list, composer, live Send button — over an empty log. The banner says `offline` and the Participants panel is empty; the event count does not distinguish the two, because a healthy new hub also reads `0 events`.
- **Used in anger once, on somebody else's project.** Crosstalk was used to build itself, and then run by a user bringing up an unrelated repository. That second run is where most of the entries above come from — see [#23](https://github.com/moazessam376-dev/crosstalk/issues/23). It is no longer only self-hosted, and it is still not a long project with a full agent roster.

- [Running Crosstalk](docs/RUNNING.md) — setup, the hub, where to start each agent, and what the errors mean
- [Design spec](docs/specs/2026-08-09-crosstalk-design.md)
- [Protocol repair plan](docs/plans/2026-08-10-protocol-repair.md) — what was broken and how it was fixed
- [Cross-platform rules](docs/CROSS-PLATFORM.md)

## What you need

Crosstalk brings no agents with it — it's orchestration, not a model provider.

- Node ≥ 20, git
- A git repository **with at least one commit**. `init` does not check this and
  will set up a repository that `doctor` and `up` then both refuse
  ([#23](https://github.com/moazessam376-dev/crosstalk/issues/23)).
- At least one agent you can paste a line into. **Two workers** to use the full
  dispute ladder — with one, the `third_agent` rung has nobody to call and is
  skipped, which `doctor` warns about at setup rather than at the first dispute.

No compiler, no Python, no Docker, no native modules — on Windows, macOS and Linux alike. Two runtime dependencies, total. `crosstalk doctor` checks all of it and names the remedy for anything missing.

### The agents it knows about

You do **not** need a CLI harness. The desktop apps work — they are what most
people have — and they are what this project was built with. Six harnesses are
supported, and the difference that matters is not CLI versus app but whether
Crosstalk can write that agent's MCP config for you.

| Harness | Brief written to | MCP config | Started by |
|---|---|---|---|
| `claude-code-app` | `CLAUDE.md` | `.mcp.json`, written for you | you |
| `claude-code-cli` | `CLAUDE.md` | `.mcp.json`, written for you | you |
| `cursor-app` | `.cursor/rules/crosstalk.mdc` | `.cursor/mcp.json`, written for you | you |
| `cursor-cli` | `.cursor/rules/crosstalk.mdc` | `.cursor/mcp.json`, written for you | you |
| `codex-cli` | `AGENTS.md` | **you paste it** — lives at `~/.codex/config.toml`, outside the repo | you |
| `codex-app` | `AGENTS.md` | **you paste it** — declares no config path, and its MCP support is unverified | you |

`init` prints a complete, ready-to-paste JSON block for the two it cannot
configure. Skip that block and those agents fall back to the CLI transport
rather than failing — `codex-app` in particular participates perfectly well over
the CLI, it just cannot use MCP.

Do not read `doctor`'s MCP warnings as a health check on MCP. The probe behind
them is `access(mcpConfigPath, F_OK|W_OK)` — does a file exist and can we write
it. It cannot fail for the four harnesses whose config path is inside the repo,
because `init` wrote that file moments before probing it; and it can *pass* for
`codex-cli` on a machine where `~/.codex/config.toml` already exists but has no
Crosstalk entry in it. `MCP_PROBE_FALLBACK` is a trustworthy no; its absence is
not a yes. [docs/RUNNING.md](docs/RUNNING.md) has both cases.

**`init` overwrites `CLAUDE.md` and `AGENTS.md`.** Briefs are rendered and
renamed over those paths, not appended to, and the leader's goes to the
repository root. If either is a file you wrote and care about, commit first.

**Every agent is started by you**, whichever harness it is. The descriptors mark
the three CLI harnesses `supervisable`, but supervised lifecycle is not
implemented: nothing spawns, resumes or restarts an agent. In practice all six
are `attached` — you open the agent and paste the line `init` printed.

### Running it

**Not on npm yet.** `crosstalk-ai` is the intended package name and it is
unpublished, so run it from a clone. Build it once, anywhere:

```bash
git clone https://github.com/moazessam376-dev/crosstalk
cd crosstalk
npm ci
npm run build
```

Then, from the repository you want the agents to work on, substituting the real
path to that clone:

```bash
node ~/src/crosstalk/dist/cli/index.js init     # once per repository
node ~/src/crosstalk/dist/cli/index.js doctor   # what is missing, and how to fix it
node ~/src/crosstalk/dist/cli/index.js up       # every time — starts the daemon, prints the hub URL
```

That path is a real directory on your machine, not a placeholder to paste
verbatim. On Windows it looks like `node D:/src/crosstalk/dist/cli/index.js`;
forward slashes work in PowerShell and Git Bash alike. Every command also takes
`--repo <path>`, so you can run them from anywhere.

`npm link` inside the clone gives you `crosstalk` and `ct` on your PATH. With
more than one checkout, `ct` resolves to whichever you linked last — which may
not be the one you built. `doctor` warns `CLI_INSTALL_SKEW` when it notices, and
`up` prints the absolute path of the build it is actually running, because every
symptom of that skew looks like a protocol bug until you know the two are not the
same code.

`init` writes a bearer token per participant under `.crosstalk/tokens/`,
gitignores it, and references it from the MCP config by path rather than
embedding it. It prints one line per agent to paste into it; those lines are the
whole onboarding. `up` holds the terminal and prints a tokenised hub URL — open
that one, not the bare address, and note that `doctor` reprints it while a daemon
is running, so losing the scrollback is not losing the hub. `down --purge`
removes the worktrees, base branches and tokens it created, and keeps the event
log.

The hub is loopback-only unless you say otherwise. `up --host 0.0.0.0` binds
every interface — useful for reading the hub from a phone — and says out loud
that the token in the URL is then the only thing guarding it.

**[docs/RUNNING.md](docs/RUNNING.md) is the full walkthrough** — what each
command does, where to start each agent and why it matters, how to tell a
working hub from a refused one, and what the errors mean.

## Contributing

Adding support for a new agent harness should be a PR touching one YAML descriptor and one brief template. See [AGENTS.md](AGENTS.md) for conventions.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Use it, run it, fork it, publish your
changes — for any noncommercial purpose. Selling it, or building a commercial
product or service on it, needs a separate licence; open an issue.

Noncommercial is broad here and deliberately so: personal projects, study,
research, hobby work, charities, schools and government all qualify under the
licence's own terms. If you are an individual using this on your own code, you
are covered.

This is a source-available licence, not an OSI-approved open-source one. That
is a real trade-off — some people and some organisations will not adopt it —
and it is a deliberate choice rather than an oversight.

**Contributions** are accepted under the same licence, inbound matching
outbound: by opening a pull request you licence your contribution to the
project under PolyForm Noncommercial 1.0.0 and confirm you have the right to do
so. Nothing here is legal advice.

Versions up to and including `70cd496` were published under MIT, and that grant
cannot be withdrawn from anyone who received the code under it.
