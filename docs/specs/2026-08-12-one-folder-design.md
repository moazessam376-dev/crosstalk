# One project folder, and a hub that shows what is running — design

Status: proposed
Date: 2026-08-12
Baseline: `90d945b`, verified against the live project at `D:\Opensource\Rigit`

## Why

The operator's goal, verbatim:

> *"my goal is to not to bloat my projects folders, just all the sessions in one
> folder, and they can control there own folders within the project etc. also the
> effort level and model and harness should be showing, and the github mirror"*

Today one Crosstalk project renders as three unrelated top-level entries in the
harness's project list:

```
metrics    > Crosstalk metrics agent setup
Rigit      > Crosstalk project setup
skeleton   > Skeleton agent setup on Crosstalk
```

That is CT-20. It was declined once, on the grounds that shared root "is a change
to the trust model." That reason does not survive contact with the code, and the
correction is recorded in §2 below rather than quietly dropped.

The second half of the sentence — effort, model, harness, mirror — looks like a
separate ask and is mostly a *configuration* problem rather than a UI one. §5 and
§6 say which is which. The two halves ship independently; they are in one spec
because they are one sentence from the operator and one question: **what does the
operator see, and where do the agents work.**

## 1. What was verified first

| Claim | Verified at `90d945b` | Evidence |
|---|---|---|
| Worktrees isolate identity | **false** | `.crosstalk/tokens/` is at the repo root; every worktree can read every participant's token |
| Identity comes from cwd | **true** | `claude-code-app` names `mcpConfigPath: .mcp.json` (`harnesses.yaml:11`), discovered from the opened folder |
| `.mcp.json` holds one server | **true** | `mergeRegistration` writes the fixed key `servers['crosstalk']` (`init.ts:574`) |
| A worker in root is rejected | **true** | `WORKER_IN_REPO_ROOT`, severity `reject` (`doctor.ts:324`) |
| The hub shows harness and model | **true** | `member-meta` renders `harness · model · tier` (`Dock.tsx:178`) |
| The hub shows effort | **false, and known** | `Dock.tsx:176` — *"The design also shows an effort level; no contract field carries one, so there is nothing to read."* |
| Rigit sets a model | **false** | no `model:` key on any of the five participants in `crosstalk.yaml` |
| Rigit configures the mirror | **false** | no `mirror:` block at all; `mirror?` is optional (`config.ts:78`) |
| The mirror can write to the log | **false, by design** | `index.ts:157` — *"the mirror cannot record the number on the task: that would mean appending an event, and the mirror has no write path into the log"* |

Two of the operator's three display asks are therefore not UI defects. `harness`
already renders. `model` renders when set and is unset. Only `effort` is missing
from the code, and the mirror is missing from the *configuration* before it is
missing from the screen.

## 2. The correction to the CT-20 decline

The decline said shared root changes the trust model. It does not, because there
is no trust model to change: tokens sit in one directory at the repo root and are
readable from every worktree, so any agent can already post as any participant.
Worktrees give **write isolation**, not **identity isolation**, and only the
first was ever real.

What the decline also failed to weigh is the cost of *not* doing it. It compared
"typing a path once" against "a spec's worth of work." The actual cost is a
permanent project entry per participant, growing with the roster, with nothing
indicating the entries are one project. Of the three options in
`CROSSTALK-ISSUES.md`, only shared root touches that; a launcher command and
relocated worktrees both leave three entries.

The real objection, which should have been the stated one:

**Three agents in one working tree share one `.git/index` and one `HEAD`.**
`metrics` currently sits on `ct/T-01-analytic-fixtures` while `skeleton` sits on
its own branch. That is only possible because they are separate worktrees. One
`HEAD` means one branch, and `Task.branch` is required (`task.ts:50`), the mirror
finds pull requests by it (`findPullRequestByBranch`), and merge order is
expressed in it. Shared root as naively implemented deletes branch-per-worker and
takes the review protocol with it.

## 3. The shape the operator described

*"they can control there own folders within the project"* is not "everyone writes
everywhere." It is one opened folder with a subtree per agent, and that is a
materially easier problem than general concurrent access: file collisions become
structurally rare rather than merely rare, and the remaining hazard is confined
to git's own state.

So the design has two independent parts:

- **Ownership** — who may write which paths. Solves file collisions, and
  doubles as a submit gate.
- **Commit isolation** — how a commit happens without three processes racing on
  one index and one `HEAD`.

### Approaches

**A. Daemon-serialized git.** Agents never run git. They call MCP tools and the
daemon does the git work under the lock it already owns (`daemon/lock.ts`).
Correct, and it fits the architecture. Cost: every brief changes, agents lose
direct git, and the daemon grows a large new surface.

**B. One shared branch, leader commits.** Agents edit their own subtrees; the
leader commits and pushes. Cheapest to build. Cost: per-task branches and pull
requests disappear, which takes the mirror's outbound half and the review unit
with them.

**C. Shared root for editing, ephemeral worktree for committing** —
*recommended*. Agents edit in the repo root, in the paths they own. On submit,
the daemon creates a throwaway worktree for that task's branch, applies only the
owning participant's paths, commits, pushes, and removes it. Branch-per-task,
pull requests, claims, merge order and the entire mirror keep working unchanged;
the change is confined to *where a commit physically happens*.

C's hazard is real and worth naming: if an agent edits outside its owned paths,
copying only owned paths silently drops work. The mitigation makes the feature
better rather than papering over it — **refuse the submit and name the paths**.
Ownership stops being only collision-avoidance and becomes the gate that catches
an agent working outside its brief, which is a thing worth catching regardless.

Recommendation: **C**, with A as the fallback if the ephemeral-worktree plumbing
proves fragile in practice. B is rejected: it buys one sidebar entry with the
review protocol.

## 4. Identity without cwd

Shared root means every agent opens the same folder and finds the same
`.mcp.json`, so every agent authenticates as whoever that file names — which is
CT-8 and CT-9 verbatim, and happened twice on day one.

Fix: `mergeRegistration` writes one server per participant —
`crosstalk-leader`, `crosstalk-metrics`, `crosstalk-skeleton` — each with its own
`CROSSTALK_TOKEN_FILE`, and each brief names the namespace its agent uses.
Identity stops depending on the working directory.

Honest cost, stated because it is the weak point of this design: every agent sees
every namespace, so the tool list grows with the roster, and picking the right
namespace is convention rather than enforcement. That is not a regression —
reading a sibling's token is equally possible today — but the *default* stops
being automatically correct, which is worse ergonomics. Two existing mechanisms
blunt it: the daemon returns `x-crosstalk-you` on every call
(`server.ts:519`), and `roster` returns `"you"` (the CT-8 fix), so an agent can
check its own identity in one call and a brief can require it.

`WORKER_IN_REPO_ROOT` (`doctor.ts:324`) flips from `reject` to permitted when
ownership is declared, and stays `reject` when it is not.

## 5. What the hub shows: effort, model, harness

- **harness** — already renders. No work.
- **model** — renders when set; Rigit sets none. The field is optional and
  nothing collects it. Work: `init` asks for a model per participant, and
  `doctor`'s existing `PARTICIPANT_NO_MODEL` finding stays as the backstop for
  configs written by hand.
- **effort** — no contract field carries one, as `Dock.tsx:176` already records.
  Needs `Participant.effort?: string`. Free text, not an enum, and deliberately:
  harnesses do not agree on the scale — `low|medium|high|xhigh|max` here, other
  words elsewhere — and an enum would either exclude a harness or become a union
  that means nothing. Same reasoning as `model?: string` beside it, and it
  renders the same way: shown when set, absent when not, never defaulted.

The ledger argument for effort is the same one the `model` field's own comment
makes (`participant.ts:27`): a harness does not identify a model, and a model at
two effort levels does not behave alike, so anything aggregating outcomes by
participant is aggregating across a variable it cannot see.

## 6. What the hub shows: the GitHub mirror

The mirror is invisible in the hub for a load-bearing reason, not an oversight:
it has no write path into the log, and the hub is a projection of the log. That
one-way street is what makes *"mirror failure never blocks the protocol"*
structural rather than a discipline (`mirror/index.ts:44-58`), and this spec does
not propose breaking it. A `mirror_status` event would trade a real safety
property for a status line.

So mirror status must come from a surface that is not the log. The daemon already
serves HTTP, but has nothing to hang this on: `DAEMON_STATUS`
(`daemon/contract.ts:63`) maps error codes to HTTP statuses and is not a health
vocabulary, so this is a genuinely new endpoint rather than an extension of an
existing one. Proposal: `crosstalk up` hands the `MirrorHandle` to the
daemon, which exposes `enabled`, last drain result (`DrainResult` already carries
`completed` and `retrying`) and last error on a status endpoint; the hub polls it
and renders a dock card. When no mirror is configured the card says so, which is
the state Rigit is actually in and currently cannot tell.

Separately and first: **Rigit has no `mirror:` block**, so nothing is running to
report. `init` should write one, and CT-19 already covers that.

## 7. Frozen-contract changes this requires

`src/contracts/` is frozen; these are claims to be raised, not edits to be made.

| Contract | Change | For |
|---|---|---|
| `participant.ts` | `effort?: string` | §5 |
| `participant.ts` | `owns?: string[]` — repo-relative path prefixes | §3 |

Prefixes rather than globs, for two reasons. The repo allows two runtime
dependencies and neither is a glob matcher, so globs would mean writing one —
and a hand-rolled glob matcher that is subtly wrong about `**` is a way to
silently mis-scope a submit gate. Prefixes also happen to be exactly what was
asked for: *"their own folders."*
| `config.ts` | `mirror` present in what `init` writes | §6 |

`Task.branch` stays required and unchanged, which is the point of approach C.

## 8. What this spec declines

- **Breaking the mirror's one-way relationship with the log** (§6). The status
  line is not worth the invariant.
- **A `crosstalk open <id>` launcher**, and **relocating worktrees outside the
  repo** — options 1 and 2 in `CROSSTALK-ISSUES.md`. Both cost real work and
  neither changes the number of entries in the operator's project list, which is
  the thing that was asked for.
- **Enforcing namespace selection** (§4). It cannot be enforced without a real
  identity boundary, and claiming enforcement that does not exist is how the
  original CT-20 decline went wrong.

## 9. Order

§5 and §6 are small and independent; §3 and §4 must land together or shared root
is unsafe. Suggested order: effort and model (§5) → mirror status (§6) →
ownership plus per-participant MCP servers plus ephemeral commit worktrees
(§3, §4) as one change behind `WORKER_IN_REPO_ROOT`.
