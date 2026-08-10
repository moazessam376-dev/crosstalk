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
| **The escalation ladder** | Past `maxRounds` the daemon opens it with no agent asking: `discriminating_test`, then an uninvolved peer, then the leader — each with a timeout, each skipped rung named with its reason. |
| **Evidence that expires** | Every result carries the commit it ran at. When a merge orphans that commit the claim reopens, and a submitted task goes back to `in_progress`. |
| **Two task gates** | Nothing reaches `in_progress` without the assignee restating the brief; nothing reaches `submitted` without a self-critique record. |
| **The hub** | Loopback web UI, live over SSE, both sides' falsifiers side by side, the ladder's climb with skipped and failed rungs distinct. The human can post and vote. |
| **The GitHub mirror** | One PR per task, one comment per claim edited in place, the ladder published rather than flattened, and repository-owner comments pulled back in as `@human`. |
| **`doctor`** | Checks Node, git, the repo, harnesses, worktrees, briefs and the ladder's shape, and names the remedy for each. |

Known gaps, so you find them here rather than at the wrong moment:

- **`taskAcceptance.method` only works as `leader` or `human`.** `majority` and `unanimous` are accepted by config and strand the task — nothing maps a resolved decision onto a task state yet, and `doctor` does not refuse them. Use `leader`.
- **Supervised lifecycle is not implemented.** Every agent is `attached`: you start it and paste the line `init` prints. Crosstalk does not spawn or restart agents.
- **The tier-3 file inbox is not built.** Agents participate over MCP or the CLI.
- **The ledger (§12) is not built.** The data is all in the log; nothing renders it yet.
- **One real session, and it was this project.** Crosstalk was used to build the repair that made it work. That is a genuine test and a narrow one.

- [Design spec](docs/specs/2026-08-09-crosstalk-design.md)
- [Protocol repair plan](docs/plans/2026-08-10-protocol-repair.md) — what was broken and how it was fixed
- [Cross-platform rules](docs/CROSS-PLATFORM.md)

## What you need

Crosstalk brings no agents with it — it's orchestration, not a model provider.

- Node ≥ 20, git ≥ 2.5
- A git repository with at least one commit
- At least one agent harness installed and signed in (Claude Code, Codex, or Cursor). **Two workers** to use the full dispute ladder — with one, the `third_agent` rung has nobody to call and is skipped, which `doctor` warns about at init rather than at the first dispute.

No compiler, no Python, no Docker, no native modules — on Windows, macOS and Linux alike. Two runtime dependencies, total. `crosstalk doctor` checks all of it and names the remedy for anything missing.

**Not on npm yet.** `crosstalk-ai` is the intended package name and it is
unpublished, so run it from a clone:

```bash
git clone https://github.com/moazessam376-dev/crosstalk && cd crosstalk
npm ci
npm run build
```

Then, from the repository you want the agents to work on:

```bash
node /path/to/crosstalk/dist/cli/index.js init     # crosstalk.yaml, a worktree and a brief per worker
node /path/to/crosstalk/dist/cli/index.js doctor   # what is missing, and how to fix each thing
node /path/to/crosstalk/dist/cli/index.js up       # starts the daemon, opens the hub
```

`init` writes a bearer token per participant under `.crosstalk/tokens/`,
gitignores it, and references it from the MCP config by path rather than
embedding it. `down --purge` removes the worktrees it created.

`init` prints one line per agent to paste into it. Those lines are the whole
onboarding.

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
