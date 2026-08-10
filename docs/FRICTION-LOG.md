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

---

## 13 · A gate nothing could ever pass, and two fixtures that passed it anyway

**What happened.** Writing the daemon contract, a worker found it could not implement `submit`. `validateTransition` refuses `submitted` unless `Task.critique` is set, and **no event in the contract could carry a `CritiqueRecord`.** Gate 2 — one of the two gates the entire task lifecycle rests on — was unreachable through the log.

Gate 1 had `brief_ack`. Gate 2 had nothing.

The worker implementing the gate had built it exactly as specified. The specification simply never gave the log a way to satisfy it.

Checking the claim turned up the worse half: **both golden fixtures transitioned to `submitted` with no critique anywhere.** They had been in the repository all day, asserted against by three merged tracks, encoding a state the project's own validators forbid.

**Why the design permitted it.** The two halves never met.

`project` folds events into state and deliberately does not validate — correct, because a projection replays history rather than authorising it. The validators are tested against hand-built state, not against fixtures — also correct, because building fixture state through the projection would let a projection bug hide a validator bug.

Both decisions were right. Together they left no test anywhere that asked whether the golden fixtures were *legal*. Every artifact was individually verified and the relationship between them was unexamined — the same shape as entry 7, where a component test and a wiring bug passed each other in the dark, and as B-005, where two projections each satisfied their own tests and contradicted each other.

**Changed.** `self_review` is gate 2's counterpart to `brief_ack`. But the fix that matters is the guard: every `task_state` transition in every fixture is now replayed through `validateTransition` against the state projected from the events preceding it.

It earned its place immediately. The first fixture was repaired by hand; on the next run the guard failed on the second fixture with the identical defect, which no one had thought to look for.

**The pattern this log keeps finding, stated at its most general:** a review that examines artifacts one at a time cannot see a defect that lives *between* two artifacts. Nothing was wrong with the validator. Nothing was wrong with the projection. Nothing was wrong with the fixtures on their own terms. The defect was in the agreement they were all assumed to have and none of them checked.

---

## 14 · Three predicates for one job, all wrong, each written after diagnosing the last

**What happened.** Agents need to recognise the leader's comments on a shared PR. Three filters were written for that. Every one failed, and every one was written by the leader immediately after diagnosing the previous failure.

| Filter | Failure |
|---|---|
| author is not me | Never fires. Every participant posts through one GitHub account, so nothing is "not me". Cost one agent forty idle minutes. |
| `endswith("— leader")` | Never fires. GitHub returns bodies with a trailing newline. An agent ran it on schedule for an hour reporting "no new leader comment" while two rulings sat unread. |
| `contains("— leader")` | **Fires on the wrong participant.** Matches the marker anywhere, including a worker comment quoting a ruling — so `last` returns the worker's own text and a fresh session acts on its own words believing they are the leader's. |

The third is the worst. The first two produce silence, which is at least ambiguous. The third produces a confident wrong answer.

The fix that works — `test("— leader[[:space:]]*$")`, anchored, no escape sequences to mangle through a shell and a markdown fence — was proposed by a worker, not the leader, and was the first one anybody ran against a real comment before writing it down.

**Why the design permitted it.** Nothing distinguishes participants at the transport layer, which is friction entry 9 again. But the sharper lesson is about the leader rather than the transport: **three times, a filter was reasoned about and shipped to three agents without once being executed against live data.** Reasoning about a predicate is not testing it, and the project's own rule — *break it on purpose and re-run* — was never applied to the one-line commands that carry every other rule.

**Changed.** The anchored filter, verified on two PRs first. And the general form: a predicate handed to another agent is code, and gets the same standard as code.

---

## 15 · The leader reviewed code against itself, never against its own plan

**What happened.** An independent audit filed nine findings against merged work. All nine were upheld. Two were spec sections the leader had personally reviewed and declared clean; two more were cases where the plan specified one behaviour, the implementation shipped another, and the leader approved it in review.

- §5.4's consequences were entirely unimplemented. The leader had mutation-tested that track's concurrency fix and its `uphold` guard, written *"no findings, I looked hard"*, and never compared the spec section to the transition table.
- The plan required the card switch to refuse an unknown event kind so a new protocol event could not silently become message-like text. The shipped switch rendered a plausible generic card. The leader passed it twice — and then added a new event kind to the contract, which rendered through that branch immediately.

**Why the design permitted it.** The leader's review method was: is this internally coherent, and can its tests fail? Both are good questions. Neither can detect **a correct implementation of the wrong thing.** Nothing in the process compared a task's output against the document that commissioned it, so a plan requirement that quietly went unimplemented left no trace anywhere.

**Changed.** Nothing structural yet, and that is the honest answer — the fix is a habit rather than a mechanism, and habits are what this log exists because of. What did change is where the reviewer looks: for each task, name the plan clause, then find the code that satisfies it.

The auditor's method was one sentence long and caught what the leader's could not: **read the documents against the code, not the code against itself.**

---

## 16 · The instrument reported success for a command it had not run

**What happened.** A worker verifying its own task ran:

```bash
npm run typecheck 2>&1 | tail -4; echo $?
```

It printed `0`. `typecheck` had exited `2` with twenty errors.

`$?` holds the exit status of the **last** command in a pipeline — `tail`, which succeeded at printing four lines of somebody else's failure. The worker noticed, reported it, and typed the tests against the contract's own response types so the underlying problem could not recur silently.

**Why this is its own entry and not a duplicate of entry 5.** Entry 5 is a green test suite over code that does not compile: the *subject* was broken and the instrument was honest. This is the instrument itself lying — the command that exists to check the work reported a status belonging to a different process.

Every rule in this repository about evidence assumes the measuring device is sound. *Run it and confirm it fails for the reason you expect. Break the code on purpose and re-run. Verify the comment body landed.* All of them reduce to reading the output of a command, and none of them check that the command reported on what you think it did.

**Nothing was changed structurally, and that is the honest answer.** The habit is to capture the status of the command you care about — `${PIPESTATUS[0]}` in bash, or redirect to a file and check the status directly — rather than piping and asking `$?`. The leader had been doing that already, by habit rather than by reasoning, and would not have noticed the hazard unprompted.

**Found by the worker, in its own evidence, while checking work nobody had questioned.** Which is the argument for self-critique being a gate rather than a courtesy: the leader's review would have read the reported `exit=0` and believed it, because reviewing evidence means reading what the instrument said.

---

## 17 · "Run the tests" was treated as atomic by everyone, including the rules

**What happened.** A daemon suite failed **two runs in five**. The failing tests were not marginal: one was the acceptance criterion that a second daemon must refuse to start, which resolved successfully instead of rejecting — the lock did not hold.

It surfaced only because the leader ran the suite four times instead of once, and only did *that* because the first run disagreed with the second. Before that, the same suite had passed a worker handoff and a leader review, each on a single execution, and each had reported it green in writing.

A suite that fails 40% of the time reports green on any one run 60% of the time. Both reports were honest. Both were nearly worthless.

**Why the design permitted it.** Every evidence rule in this repository — *the command, its output, and the SHA it ran at* — describes a single execution, and none of them mention repetition. "Run the tests" was treated as an atomic act by every track, by every brief the leader wrote, and by the leader's own reviews. Nothing was violated. The rule simply did not cover the case.

The underlying defect was itself introduced by a leader ruling: a lock-reclamation rule requiring a health probe, which opened a window where a live holder had not yet bound its listener. The worker implemented the ordering fix the leader proposed; it was necessary and not sufficient, and the flake got worse rather than better.

**Changed.** Any suite that binds a port, spawns a process or touches the filesystem gets **five consecutive runs** with per-run pass counts, in handoffs and in review. Now in `AGENTS.md`.

**The general form, which is the reason this is its own entry:** a flaky test is not a weaker version of a failing test. It is a *green signal that is sometimes true*, which is strictly more dangerous than one that is never true — it survives review, accumulates trust, and teaches everyone to re-run rather than investigate.

*Entry 18 corrects the cause given above: there was no lock defect. The claim is left standing because it is what was believed at the time, and because being able to see a wrong diagnosis in its original wording is most of this document's value.*

## 18 · The flake supplied evidence for whichever theory was brought to it

**What happened.** The 40% flake in entry 17 was diagnosed three times by the leader. All three were wrong.

1. *The lock does not hold* — a second daemon resolved instead of rejecting. A task was refused over it.
2. *The health probe opens a startup window* — a leader-mandated rule, so the leader wrote the fix, and the worker implemented it. The flake continued.
3. *It is unexplained but it is in the lock suite* — carried into the next brief as inherited work, with permission to quarantine it.

Three minutes of isolation, run before any of the above, would have settled it:

```
tests/daemon/server.test.ts alone ............. 6 runs, 6 green
tests/daemon, forks.singleFork=true ........... 3 runs, 3 green
tests/daemon, default parallelism ............. 5 runs, 3 green
```

Concurrent daemons inside one test run, in parallel worker threads. Not the lock, not reclamation, not the health probe, and not `startDaemon` — which is why it never threatened `crosstalk up`, where one daemon starts. One line of `vitest.config.ts`.

**Why three theories all fitted.** A deterministic failure constrains its explanation: the theory has to produce *that* failure, every time. A flaky one constrains nothing. Any theory that predicts "sometimes broken" matches the evidence, so the theory that gets adopted is whichever one the diagnostician already had — and each re-run returns a different-looking sample that can be read as support.

Both tells were visible and both were noted out loud. The failing test *names* changed between runs, which no single-defect theory explains. And theory 2 did not account for one of the four failures — a 1.4s failure on the fast path, recorded at the time as "does not explain" and then reasoned past anyway.

The real signature was in the message the whole time. `TypeError: fetch failed / Caused by: Error: bad port` is a client that never opened a connection. It is not what a lock that failed to hold looks like, and nobody read it until the fourth pass.

**Changed.** Before diagnosing a flaky test, **isolate it, and do not offer a cause until you have**: run the file alone, run the suite single-threaded, then form a theory. Three commands. Cheaper than every path taken here.

**The general form:** a flaky test is not only a green signal that is sometimes true — it is also a red signal that confirms whatever you already suspect. Deterministic failures are falsifiable; intermittent ones are not, until you make them so. This project puts a required `falsifier` field on every claim precisely to stop unfalsifiable arguments between agents, and its own leader then spent a night making three unfalsifiable ones to itself.

*Entry 19 corrects the cause given above. The claim stands as written for the same reason entry 17's does.*

## 19 · The same flake, diagnosed wrong three times, was never about tests at all

**What happened.** Entry 18 said the flake came from concurrent daemons in parallel worker threads, and a fix shipped on that basis: `fileParallelism: false`, with the reasoning written into `vitest.config.ts`. Five consecutive green runs followed and it was declared fixed.

It was not. On a branch with more daemon-starting tests it returned at the old rate, on an idle machine, with nothing else running.

The actual cause, found by a probe that did nothing but start 200 daemons and look at the URL:

```
round 161: FETCH FAILED against "http://127.0.0.1:5060" — bad port
round 162: FETCH FAILED against "http://127.0.0.1:5061" — bad port

malformed urls : 0
port range     : 4734 .. 5137
```

`listen(0)` takes whatever ephemeral port the OS offers. Some are on the WHATWG fetch **blocked-port list** — 5060 and 5061 are SIP, 6000 is X11 — and `fetch`, along with every browser, refuses them before opening a socket. Confirmed against servers that were bound and healthy in every case:

```
5060  REFUSED: bad port      4999  OK 200
5061  REFUSED: bad port      5062  OK 200
6000  REFUSED: bad port      8080  OK 200
```

**It was never a test bug.** `crosstalk up` binds the same way, and this machine's ephemeral range contains those ports, so roughly one start in a hundred opens a browser onto a connection failure with a daemon running perfectly behind it. The flake was the product defect, showing itself in the only place anyone was looking.

**The three diagnoses, and why each fitted.** Lock reclamation via the health probe — a task was refused over it. Then concurrent daemons — a fix shipped for it. Then, finally, blocked ports.

The second is the one worth dwelling on, because it came with an experiment:

```
tests/daemon/server.test.ts alone ..... 6 runs, 6 green
full suite ............................ 5 runs, 3 green
```

That reads as proof that running files together causes it. It is nothing of the kind. **One file starts far fewer daemons than the whole suite, so it samples a 1% event fewer times.** A lower rate was read as a different mechanism. The isolation step from entry 18 — the corrective the entry itself prescribed — was performed, and its output was still interpreted to fit the theory already in hand.

**Changed.** Two rules, both learned the expensive way:

- **A rate is not a mechanism.** Before concluding that condition X causes a failure, count how many *opportunities* X changes. If isolating a component reduces the number of attempts, a lower failure rate proves only that you tried fewer times.
- **Fix the mechanism or say you have not.** Five green runs after a change is the same evidence as five green runs before it when the underlying rate is 1% per attempt and a run makes thirty attempts. `fileParallelism: false` cost the suite 6s → 48s and bought nothing measurable.

**The general form:** the first two theories were about *this project's* machinery — its locks, its test runner — because that is what the diagnostician had been reading all night. The real cause was a constant in a web specification. Debugging kept proposing mechanisms from the part of the system that was already in context, and the flake, being intermittent, agreed with all of them.
