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

**Pre-implementation.** The design and plan are complete and public; the code is not written yet.

- [Design spec](docs/specs/2026-08-09-crosstalk-design.md)
- [v1 implementation plan](docs/plans/2026-08-09-crosstalk-v1.md)
- [Cross-platform rules](docs/CROSS-PLATFORM.md)

## What it will need

Crosstalk brings no agents with it — it's orchestration, not a model provider.

- Node ≥ 20, git ≥ 2.5
- A git repository
- At least one agent harness installed and signed in (Claude Code, Codex, or Cursor). Two workers to use the full dispute ladder.

No compiler, no Python, no Docker, no native modules — on Windows, macOS and Linux alike. `crosstalk doctor` checks all of it and names the remedy for anything missing.

## Contributing

Adding support for a new agent harness should be a PR touching one YAML descriptor and one brief template. See [AGENTS.md](AGENTS.md) for conventions.

## License

MIT
