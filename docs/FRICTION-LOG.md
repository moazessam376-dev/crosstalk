# Friction log

Crosstalk is being built by the process it describes: a leader agent and three worker agents on separate PRs, arguing on the record. Every place the hand-rolled version hurt is recorded here, because a system for multi-agent development should be shaped by the failures of multi-agent development rather than by guesses about them.

Each entry: what happened, why the design permitted it, and what changed as a result. Entries are not bugs in the agents. In every case so far the agent followed its brief.

---

## 1 · A worker set up shop in the leader's checkout

**What happened.** Three workers were told "work in your own git worktree." Two created one. The third branched in place in the repository root — which is the leader's checkout — and started writing. The leader's uncommitted edits and the worker's work landed in the same tree, and neither could switch branches without pulling the ground out from under the other.

**Why the design permitted it.** The spec said *one stable worktree per participant*. It never said the primary checkout is off-limits, because that seemed too obvious to write down. It is not inferable. The worker had followed the instruction exactly and still produced the wrong outcome.

**Changed.** Spec §7 states it explicitly. `doctor` rejects `WORKER_IN_REPO_ROOT`. All three kickoff briefs now open with the worktree command rather than mentioning it in prose.

---

## 2 · The roster was not derivable from the log

**What happened.** Asked whether agents would know who else was working and on what, the answer was *partly*. `participant_joined` carried only an id, so an agent replaying the log learned that `codex-2` existed without learning whether it was a leader or a worker.

Worse, `harness` did not identify a model. A fleet of three Grok agents and two Composer agents are all `cursor-app` and were indistinguishable — even though the whole reason to track them separately is that they behave differently enough to change whether you re-run their evidence.

**Changed.** `participant_joined` carries the whole `Participant`. `Participant` gained `model`. `roster()` and `board()` were added to the tool surface, with `board()` returning metadata only so visibility scales past a dozen agents without becoming a noise flood.

---

## 3 · Agents go idle after handoff with nothing to wake them

**What happened.** A worker finished its tasks, posted its handoff, and stopped — correctly. The leader posted a critique to the PR. Nothing connected the two. The critique sat unread until a human noticed and pasted a polling instruction into the session.

**Why the design permitted it.** Nothing was wrong with either agent. There is simply no delivery channel yet, so every session needs a hand-rolled watcher loop.

**Changed.** Nothing yet — this is precisely what `await_turn` exists to provide, and it is the clearest argument for building the daemon early rather than last. Recorded because the workaround is invisible in the finished product and the requirement would otherwise look speculative.

---

## 4 · Leader edits in a shared checkout look like worker violations

**What happened.** After vacating the shared checkout, the leader's uncommitted contract edits stayed behind in the worker's tree. The worker's `git status` showed five modified files under `src/contracts/` and `tests/fixtures/` — the two directories its brief forbids it from touching.

Had it committed them, its PR would have shown it editing frozen contracts. Had it reverted them, it would have broken its own code, which was already written against the amended shape.

**Changed.** Entry 1's rule extends to the leader: `crosstalk init` gives the leader its own worktree too, so the primary checkout belongs to no participant at all.

---

## 5 · Thirty-three passing tests on code that does not compile

**What happened.** A worker's branch had five green test files and thirty-three passing tests. `tsc` rejected the same code with eight errors. Vitest transpiles without typechecking, so the suite never noticed. CI runs `typecheck` before `test`, so the branch was red on all six matrix cells while every local signal was green.

**Why the design permitted it.** The handoff gate asked for evidence per acceptance criterion, and every criterion was phrased as a test. *"Thirty-three tests pass"* and *"the code builds"* feel like the same claim. They are not, and the gap is invisible from inside the test runner.

**Changed.** Handoff evidence must include `typecheck` and `build`, not only `test`. This is the project's own thesis turned on itself: evidence that looks identical whether or not the thing works is not evidence.

---

## 6 · Nine commits existed on exactly one disk

**What happened.** A power cut truncated a ref file to a null SHA, which broke `git fetch` for the entire repository. Behind that ref sat seven unpushed commits — a worker's whole day. The reflog survived and everything was recovered, but nothing about the process had guaranteed that.

The same worker had also been asked to open its PR before starting and had gone straight to building, so there was no remote copy and no review surface for nine commits.

**Why the design permitted it.** Evidence cites a commit SHA. Nothing required that SHA to exist anywhere except the machine that produced it — so the evidence was, strictly, unverifiable by anyone else.

**Changed.** Evidence must cite a SHA reachable on the remote. A result from a commit only you can see is not something a reviewer can check, which makes it the same category of non-evidence as entry 5.

---

## 7 · Twenty-eight passing tests over a blank screen

**What happened.** A worker finished the hub UI and handed off with accurate evidence: 28 tests, typecheck, build, all verified independently. Then the leader served the built app and opened it. The dispute view — the product's signature screen, the one whose entire job is making *"these two claims cannot both be true"* visible at a glance — rendered `No claim has been raised in this room.`

The same claim simultaneously reported three different states in three places on one screen: `3/3` in the channel list, `round 0 / 3` in the dispute header, `open` on the card.

**Why the design permitted it.** The component test passed `claim` and `contest` in as props. That proves the component draws correctly *given* data and nothing at all about whether anything ever hands it data. The wiring between projection and view was the untested seam, and no assertion in the suite could see it.

This is entry 5 one layer further out. There, tests were green over code that would not compile. Here, tests, typecheck and build were all green over a screen a user would call broken on sight.

**Changed.** For UI work, `npm test` is not the end of verification. Build it, serve it, open it, and look. Recorded as a rule in `AGENTS.md` rather than left as a review habit, because it only worked here because the reviewer insisted on it in advance.

---

## 8 · A tool reported success and discarded the payload

**What happened.** A worker posted its review response. The command returned success. The comment arrived containing forty-three characters — the heading, and nothing else. Its verdicts, evidence and experiment result were gone.

It caught this only because it checked afterwards, then reposted through a different path.

**Why it matters here.** `gh pr comment` exiting zero proves the request was accepted, not that the body survived. That is the same shape as every other entry: a green signal standing in for a claim it does not actually support.

**Changed.** Nothing structural, and that is the honest answer — this is a transport failure of the hand-rolled setup, and a hub that owns its own append-only log does not have it. Recorded because it is a good argument for the log being the source of truth rather than a chat surface someone else operates: an event either appended or it did not, and the writer finds out.

---

## 9 · Every participant was the same person

**What happened.** A worker sat in a polling loop for roughly forty minutes, re-issuing the same request for PR comments and never acting on any of them. The leader's review had been posted the whole time.

The worker was not confused. It was blind. Every participant — leader, all three workers, the human — posts through one GitHub account, so a watch predicate of the form *"comments by someone other than me"* can never match. It polled, saw only its own identity, concluded nothing was new, and polled again.

The leader's own monitor had the identical defect. It was noticed there only in its harmless direction — the leader's notifications occasionally echoed its own comments back — and the dangerous direction, that nobody can tell participants apart, went unexamined until a worker stalled on it.

**Why the design permitted it.** `from: ParticipantId` on every event exists precisely so a message carries who sent it independently of whatever moved the bytes. GitHub-as-transport cannot supply that: the account is the identity, and every participant shares one.

**Changed.** Nothing in the protocol — the protocol was already right, which is the point. But the question *"will Crosstalk have this problem?"* exposed a real gap in the daemon design: a single shared bearer token would have made `from` self-asserted, reintroducing the same collapse one layer down. §6.1 now specifies one token per participant with the daemon deriving `from` from the presenting token, and a payload that sets `from` itself being rejected.

Identity has to be established by the transport. When it isn't, everything downstream that attributes anything — the ledger, adjudicator selection, who owes a rebuttal — is quietly reading fiction.

---

## 10 · The document forbidding the mistake contained the mistake

**What happened.** The maintainer ran the first command handed to them after the merge and it failed immediately: Windows PowerShell 5.1 rejects `&&` as a statement separator.

`docs/CROSS-PLATFORM.md` §2 already said not to do that. The leader wrote that rule, then wrote a `&&` chain into the chat. Checking the repository afterwards found the same pattern in `AGENTS.md` — as the very first command a new contributor is told to run, directly above the sentence *"PowerShell and zsh run the same command."*

**Why the design permitted it.** Nothing verifies documentation against the platforms it claims to support. Tests run in CI on three operating systems; the shell snippets a human copies out of a markdown file run nowhere. Every other check in this project asks whether evidence could distinguish working from broken — the docs had no such check at all.

**Changed.** The commands are unchained, with the reason written next to them so nobody re-chains them for tidiness. `&&` inside `package.json` scripts is left alone: npm runs those through `cmd.exe` and it is correct there. The distinction is that a script is executed by a tool that was told how to run it, and a code block in a document is executed by whatever shell the reader happens to have.

Worth stating plainly, since this is entry ten and the pattern has held every time: **a rule you wrote is not a rule you follow.** This one had been in the repository for hours, was cited by the leader in review of another track's code, and was still violated by the leader in the same session.

---

## 11 · A server nobody remembered starting broke an install hours later

**What happened.** The maintainer ran `npm ci` in the shared checkout and it failed with `EPERM: operation not permitted, unlink 'rollup.win32-x64-msvc.node'`. Because `npm ci` deletes `node_modules` before reinstalling, the failure left the tree half-deleted: `tsc` vanished, and the next command pulled a different major version of the bundler from the registry and failed differently. Three errors, one cause, and none of them named it.

The cause was a `vite preview` process a worker had started hours earlier while trying to verify its own UI, still running, still holding a file open.

**Why the design permitted it.** `docs/CROSS-PLATFORM.md` §5 already said Windows will not let you delete a file another process holds — it predicted this failure exactly. But `crosstalk down` is specified to remove **worktrees**. Nothing in the design says anything about processes an agent started. A worker that binds a port or spawns a server has created state that outlives its task, and no part of the system knows the state exists.

**Changed.** `AGENTS.md` requires agents to stop what they start. The deeper requirement is recorded rather than solved: teardown is specified in terms of files, and agents leave processes too.

The shape is worth noticing. The failure surfaced hours later, in a different person's command, as an error mentioning a native module nobody had touched — the visible symptom shared no vocabulary with the cause.

---

## 12 · The validators had two front doors and only one was locked

**What happened.** Reviewing its brief before writing any code, a worker found that the daemon's specified `POST /events` endpoint — *"appends and returns the stamped event"* — was a complete bypass of every validator in the project.

`claim_raised` carries an entire `Claim`: id, state, rounds, falsifier. A client posting that kind directly builds its own claim and never reaches `validateRaise`. `task_state` carries a target state, so a client could move a task to `submitted` without ever passing `validateTransition`. Every falsifier requirement, every gate, enforced only by clients choosing to be polite.

**Why the design permitted it.** The spec says validators live *at the API boundary* rather than in prompts, precisely so they cannot be forgotten around turn forty. That principle was then applied to exactly one of the two boundaries. The MCP layer was specified as rigorous — twelve tools, each delegating to the validators, errors surfacing in-band. The HTTP layer underneath it was specified as a generic append, and the generic append is reachable by anything holding a token.

**Changed.** Protocol-bearing kinds get typed routes that take the validators' own input types and let the daemon construct the event; `POST /events` accepts only kinds with no invariants to violate, and rejects anything else with an error naming the correct route.

The lesson generalises past this bug: **"at the API boundary" is not a location, it is every surface a client can reach.** A rule enforced at one entrance and not the other is not enforced — it is documented. And it was found by the cheapest review in the system, before a line of the implementation existed.
