# How Matt Pocock's AI Hero skills are built

**Date:** 2026-08-30
**Question:** How are the AI Hero skills (https://www.aihero.dev/skills) engineered, and what transfers to expressing agent-team "operating systems" as reusable versioned skills?
**Primary sources:** the `mattpocock/skills` repo (cloned at commit `6654f6b`, plugin version `1.2.3`), the published site, and the official Anthropic / Agent Skills documentation. Every claim below is traceable to a file in that repo or a cited URL.

> Reading note: the most valuable single file in the whole repo is
> [`skills/productivity/writing-for-agents/SKILL.md`](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md).
> It is his design theory, written as a skill. If you read one thing, read that.

---

## 1. What the skills actually are

### Yes, they are Agent Skills in the SKILL.md sense

Each skill is a directory containing a `SKILL.md` with YAML frontmatter, optionally beside sibling reference `.md` files and `scripts/`. That is the standard Agent Skills layout. The repo ships 37 `SKILL.md` files; 25 are "promoted" and shipped in the Claude Code plugin.

The frontmatter he actually uses is strikingly minimal. Across all 37 skills only four keys ever appear:

| Key | Usage | Purpose |
|---|---|---|
| `name` | every skill | matches the directory name |
| `description` | every skill | the trigger pointer (model-invoked) or a human one-liner (user-invoked) |
| `disable-model-invocation: true` | 22 of 37 | makes the skill reachable only by a human typing its name |
| `argument-hint` | 4 skills | autocomplete hint |

He uses **none** of `allowed-tools`, `version`, `license`, `metadata`, `model`, `effort`, `context: fork`, or `paths`. Versioning is done at the repo level, not per skill (see §5). Notably he does **not** use Claude Code's native `context: fork` to run a skill in a subagent; where he wants subagents he writes the dispatch into the prose of the skill body instead, which keeps the skill harness-portable.

### Two representative skills, end to end

The set has a bimodal size distribution. Here is the smallest shipped skill, complete:

```markdown
---
name: grill-me
description: A relentless interview to sharpen a plan or design.
disable-model-invocation: true
---

Call the Skill tool with "grilling".
```

That is the entire file: 157 bytes. It is a **named entry point** that delegates to a model-invoked skill holding the actual process. Its sibling is the same trick with two callees:

```markdown
---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

Call the Skill tool twice, for "grilling" and "domain-modeling".
```

And here is the process those two point at, `skills/productivity/grilling/SKILL.md`, which is model-invoked and is the reusable primitive:

```markdown
---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled... Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

[...format template for a round...]

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
```

Note what that file is and is not. It is **not knowledge about interviewing**. It is a *state machine*: a data structure (design tree), a derived working set (frontier), a loop (rounds), a division of labour (facts are the agent's, decisions are the user's), an escape hatch (dispatch a subagent for facts, don't block), and a termination condition (frontier empty, user confirms). That shape recurs in every good skill in the set.

### How they plug into harnesses

Deliberately harness-neutral, with a per-harness adapter:

- **Claude Code**: a native plugin, `.claude-plugin/plugin.json`, listing the 25 promoted skills as an explicit array of directory paths.
- **Codex and everything else**: every skill directory carries an `agents/openai.yaml` sidecar holding Codex UI metadata:
  ```yaml
  interface:
    display_name: "Grill Me"
    short_description: "Sharpen a plan through interview"
  policy:
    allow_implicit_invocation: false
  ```
  `policy.allow_implicit_invocation: false` is the Codex equivalent of `disable-model-invocation: true`. `.agents/invocation.md` mandates they stay in sync: "a skill is user-invoked in both harnesses or neither."
- **Local development**: `scripts/link-skills.sh` symlinks every skill into both `~/.claude/skills` and `~/.agents/skills`, so a `git pull` updates the installed set.

There is an ADR, `.agents/adr/0002-ship-as-a-claude-code-plugin.md`, explaining why there is no native Codex plugin: Codex's `plugin.json` accepts `skills` only as a single path string, not an array, and Codex "copies the plugin tree into its cache and **drops symlinks**", so neither a curated array nor a symlink farm can express "ship these two bucket folders and not the other three".

### Repo organisation

```
skills/
  engineering/     promoted, shipped in the plugin
  productivity/    promoted, shipped in the plugin
  misc/            kept, not promoted, not shipped
  in-progress/     public on purpose, feedback wanted, not shipped
  deprecated/      no longer used
docs/<bucket>/<skill>.md   human-facing page, published at aihero.dev/skills-<name>
.agents/                   the repo's own meta-docs: ADRs, invocation rules, install block
.out-of-scope/             written records of rejected feature requests
.changeset/                pending version bumps
```

The bucket a skill sits in is a **release channel**, not a category. `CLAUDE.md` makes the invariant machine-checkable: every skill in a promoted bucket must appear in the top-level README **and** in `plugin.json`'s `skills` array; skills in the other three buckets must appear in neither.

---

## 2. Engineering approach

### Authoring: a meta-skill, not a generator

He does not generate skills with tooling. He wrote a reference skill, `writing-for-agents`, and writes every other skill against it. It was called `writing-great-skills` until v1.1; the rename happened because "almost none of it is skill-specific" and it applies to `AGENTS.md`, specs, tickets and runtime prompts equally. The skill-only mechanics were split out into a `SKILL-MECHANICS.md` disclosed behind a pointer.

The stated default move of that skill is **deletion, not explanation**:

> "Ask an agent to write instructions for another agent and it spends most of its words explaining what the model already knows. Every one of those lines is a **no-op**, paying context and changing no behaviour."

He is explicit that asking a model to write a skill produces bad output, and that the review pass is where the value is:

> "You can, and it will produce something verbose. Left alone the model explains what it already knows, and it will not apply the no-op test or reach for a leading word on its own. Use the reference on the draft: a review pass is where most of its value lands."

He also names the most common authoring failure, which is directly relevant to us:

> "**My skill only works on the exact task I built it from.** The common route (do the work once, then have the agent write it up as a skill) over-indexes on that one run, and the exemplars come out too specific. Keep the run as evidence, then abstract deliberately: strip what belonged to that repo and those files, and write for the class of task."

### Testing: there is no eval harness

This is the clearest negative finding of the research. Searching the whole repo for eval, benchmark, or test infrastructure turns up nothing: no `evals/`, no test runner, no CI job beyond the changesets release workflow. He states it outright on the `writing-for-agents` docs page:

> "**How do I know when it's done?** When it works, and you can no longer find duplication, sediment or no-ops. **There is no automated eval here; the check is a manual run plus the failure-mode vocabulary as a diagnostic.** When a document misbehaves, that vocabulary is also the repair kit: name the failure mode first, then fix that."

And on settling disagreements about whether a line earns its place:

> "The test (does it change behaviour versus the default?) is model-relative, not reader-relative: two people disagreeing about a no-op disagree about the default, and settle it by **running the document**, not by debate."

So the method is: run it, name the failure mode from a shared vocabulary, fix that specific thing. The vocabulary *is* the test suite. This is much weaker than Anthropic's own tooling (§7) and is the single biggest gap between his practice and the official guidance.

The one place he does do systematic quality work is the `retro` skill (in-progress), which is a *post-hoc* eval on the agent's environment rather than on a skill. It reads session logs and looks for improvement candidates in seven named categories: navigation, automated checks, coding standards, global `AGENTS.md`, tool economy, no-ops, and information access. That is the closest thing in the repo to a measurement loop, and it is qualitative.

### CI is a release pipeline, not a quality gate

`.github/workflows/release.yml` runs changesets on push to `main` and opens a version PR. There is no lint of skill files, no frontmatter validation in CI, and no eval. Frontmatter validity is enforced by hand plus `claude plugin validate . --strict`, which `CLAUDE.md` instructs you to run after touching either manifest.

That gap has bitten him. Changeset `fix-yaml-frontmatter-colons.md` records:

> "Quote the `description` front matter in `to-spec`, `code-review`, `setup-matt-pocock-skills`, `writing-fragments`, `writing-shape`, and `wait-what`. An unquoted colon-space left over from the em-dash sweep in #905 made each block invalid YAML, so `skills.sh` skipped all six during discovery and they couldn't be listed or installed via `npx skills`."

Six skills silently vanished from the installer because nothing validated the YAML. A five-line CI check would have caught it.

### Progressive disclosure, as he formalises it

He has a more precise model than the official docs. He calls it the **information hierarchy**, a three-rung ladder:

1. **In-file step** — "the primary tier: what the agent does, in order."
2. **In-file reference** — "consulted on demand. Often a legitimately flat peer-set."
3. **Disclosed reference** — "pushed out into a separate file, reached by a context pointer, loaded only when the pointer fires."

> "**Progressive disclosure** is the move down the ladder (out of the main file and behind a pointer) so the top stays legible. **Not primarily a token optimisation: it is how the hierarchy is protected.** Branching is the cleanest disclosure test: inline what every branch needs, and push behind a pointer what only some branches reach."

That last sentence is the operational rule, and it is better than anything in the official docs: **disclose by branch**. If every path through the skill needs it, inline it. If only some paths do, push it out.

He also names the failure mode on each side. Push too little down and you get **sprawl** ("a document simply too long, even when every line is live and unique"). Push too much down and you hide material the agent needs.

The measured result: across the 25 shipped skills, the median `SKILL.md` is 3.5 KB (roughly 900 tokens) and the largest is 11.9 KB (roughly 3,000 tokens). Every one is comfortably inside Anthropic's "under 5k tokens, under 500 lines" guidance, and 10 of the 25 carry bundled reference files behind pointers.

### The two budgets

The organising idea of his whole approach is that every document spends one of two budgets:

> - "**Context load** is the cost of always-loaded material on the agent's window: an `AGENTS.md` line, a skill description, anything sitting in context every turn, spending tokens and attention whether or not it fires.
> - **Cognitive load** is the cost on the human: which documents exist and when to reach for each. The human is the index. **Not a cost to minimise: it is the price of human agency**; spend it where human judgement matters, remove it where it does not."

That framing is what generates the invocation split, the router skill, and the 63% reduction below. It is the most portable idea in the repo.

---

## 3. Design principles he states explicitly

### The `description` is a "context pointer", and its wording is the product

He generalises skill descriptions and `AGENTS.md` doc references into one object:

> "A **context pointer** is a reference held in the agent's context that names some out-of-context material and encodes the condition for reaching it. A skill's description is one; a line in `AGENTS.md` is the same object. **The pointer's _wording_, not its target, decides when the agent reaches the material, and how reliably.** A must-have target behind a weakly worded pointer is a variance bug: sharpen the wording first, and inline the material only if sharpening fails."

His three rules for writing one:

- "**Front-load the leading word**: the pointer is where it does its triggering work."
- "**One trigger per branch.** Synonyms that rename a single branch are one branch written twice; collapse them and keep only genuinely distinct branches."
- "**Cut identity the body already carries.**"

The "one trigger per branch" rule is a direct contradiction of the common practice of stuffing descriptions with synonyms. Measured in the shipped set: model-invoked descriptions run 72 to 421 characters, well under Anthropic's 1024 limit, and none of them is a keyword pile.

### Leading words

> "A **leading word** is a compact concept already living in the model's pretraining that the agent thinks with while running the document (_lesson_, _fog of war_, _tracer bullets_). Repeated as a token, never as a sentence, it accumulates a distributed definition and anchors a whole region of behaviour in the fewest tokens, by recruiting priors the model already holds. Coining your own works if you define it clearly, but a made-up word recruits no priors: you pay in definition tokens what a pretrained word gives free; reach for an existing word first."

It works twice: in the body it anchors execution, in the pointer it anchors invocation. His worked examples of the refactor:

- "fast, deterministic, low-overhead" collapses to **tight** (a *tight* loop).
- "a loop you believe in" collapses to **red**, "turning a fuzzy gate into a binary observable state".

### Prompt the positive, never the negative

> "**Negation** is the failure mode beside this lever: steering by prohibition drags the forbidden behaviour into context and makes it _more_ available, not less. _Don't think of an elephant_, and the elephant is all there is; the negation is a weak modifier the strongly-activated concept overruns, so the ban half-reads as an instruction to do the thing. Prompt the **positive**."

### Completion criteria, and premature completion

This is his sharpest process-design idea and the one most relevant to multi-agent work. Every step ends on a completion criterion with two properties:

> - "**Clarity**: can the agent tell done from not-done? A vague bound ('understanding reached') invites **premature completion**: ending the step before it is genuinely done, attention slipping to _being done_. The visible steps still ahead (the **post-completion steps**) supply the pull; the criterion's clarity is the resistance. Defend in order: **sharpen the bound first** (local and cheap); only if it is irreducibly fuzzy _and_ you observe the rush, hide the later steps by splitting the sequence. **Hiding only works across a real context boundary (a hand-off or a subagent dispatch; an inline call leaves the later steps in context and clears nothing).**
> - **Demand**: how much it requires. 'Every modified model accounted for' forces thorough work where 'produce a change list' does not."

The bolded clause is a load-bearing fact for team OS design: **a subagent dispatch is the only way to actually hide downstream steps from an agent**. Calling a skill inline does not clear anything.

### Pruning: the no-op test

> "Hunt **no-ops** sentence by sentence: an instruction the model already obeys by default pays load to say nothing... When a sentence fails, delete the whole sentence rather than trim words from it."

Related failure modes he names: **duplication** (one meaning in two places), **sediment** ("stale layers that settle because adding feels safe and removing feels risky"), **sprawl** (too long even when every line is unique), and the **cache** problem, where a document restates something the environment already says (`package.json` scripts, config, `--help`) and goes stale. His rule: "Cache what the agent cannot find by looking: the unwritten convention, the reason behind a choice, the gotcha no config confesses."

### Negative space

Added in v1.1, and a useful corrective to "keep skills short": "every decision a skill declines to make is **delegated to the agent's priors** rather than left neutral." Brevity is not free. What you leave out is not absent from the run; it is answered by the model's defaults. That is fine when the default is good and a silent bug when it is not.

### The smart zone, and budgeting sessions

His term for the usable part of the context window, currently "~150k tokens on state-of-the-art models" (revised up from ~120k in v1.2). The key claim:

> "**The zones don't track the context window limit.** A session can be deep in the dumb zone with most of the window still free... **Plan around the smart zone, not the window.** The smart zone is a budget, and unrelated work spends it... **Doing one task per session gives each task the sharpest part of the session.**"

### Parametric versus contextual knowledge, as a model-selection rule

From his "9 Things" post, a genuinely useful heuristic for assigning models to roles: grilling leans on **parametric** knowledge (what the model already knows), so use a large frontier model, because "a dumb model won't give you good ideas". Implementation leans on **contextual** knowledge (what is in front of it), "so you can use a smaller model."

He makes a related argument for reviewer independence, quoting a reader approvingly: *"Same context reviewing itself isn't review, it's confirmation bias with a slash command."*

### Skill vs subagent vs command vs compact: the phase-boundary tree

He does not frame this as "skill vs subagent". He frames it as: at a **phase boundary**, you have five options, evaluated top to bottom, first yes wins. From `skills/engineering/ask-matt/PHASE-BOUNDARIES.md`:

| Option | What it does |
|---|---|
| **Continue** | Stay in the session. No context switch at all. |
| **`/clear`** | Empty the context window and start from nothing. |
| **`/handoff`** | Write a portable markdown file and seed a session anywhere with it. |
| **Subagent** | Send the task to its own context window and get a report back. |
| **`/compact`** | Compress this context and seed a fresh session with the summary. |

1. **Can you continue?** Yes if "the next phase needs this phase as a **primary source**", or there is enough smart zone left (~150k tokens). "Continue costs nothing and loses nothing, so rule it out before anything else."
2. **Is the context irrelevant to what comes next?** Then `/clear`. "The cost of getting this wrong is one-way."
3. **Do you need to hand off?** Only for a new harness, a new directory, a colleague, or forking a side task mid-phase. "What `/handoff` buys is **portability**. If nothing is travelling, you don't need it."
4. **Can the task be done AFK?** "Is it scoped tightly enough to run with you away from the keyboard, no steering? Then send it to a **subagent** and leave this session untouched."
5. **Otherwise `/compact`**, which is "the **default, not the first reach**".

Underneath it is a single principle worth lifting wholesale:

> "Every move except **Continue** turns a **primary source** into a **secondary source**: the session as it happened, replaced by a summary of it."

| Source | Information | Noise | Room to move |
|---|---|---|---|
| Primary (Continue) | Full | Lots | Little |
| Secondary (`/compact`, `/handoff`) | Lossy | Less | Lots |

And the timing rule: "Make the decision **at** a boundary; mid-phase, continue or split the rest into subagents."

### The invocation decision, and why it is the token story

From `SKILL-MECHANICS.md`:

> "A **model-invoked** skill keeps a `description`, so the agent can fire it autonomously, and other skills can reach it... The description is the skill's top-level context pointer, forced to stay loaded at all times: **permanent context load in exchange for discoverability**.
>
> A **user-invoked** skill strips the description from the agent's reach: only the human typing its name can invoke it, and no other skill can. **Zero context load, but it spends cognitive load**: you are the index that must remember it exists.
>
> Pick model-invocation only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked and pay no context load."

And the crucial invariant, from `.agents/invocation.md`: "The test for whether a skill should stay model-invoked: _could the model usefully reach for this autonomously?_ (**Reuse is the reason to extract a skill, not the test.**)"

His stated philosophy for the split, from the v1 changelog: "**the user stays in control, not the agent**. The model is a tool you orchestrate, not the other way around. Yes, this means you carry more cognitive load when navigating which skill to use. But that's why `/ask-matt` exists."

### Skill versus slash command, hooks, and MCP

On **slash commands** he is unbothered, and decides on distribution rather than mechanism: "Both work; they suit different situations. As a skill it ships and updates through the same install path as everything else here, which is what makes it shareable; the constraint that the agent won't fire it itself is set by its frontmatter rather than by the mechanism."

On **`AGENTS.md`** the argument is progressive disclosure: it "is loaded into every session regardless of the task", so "most of it should be context pointers, not content. Keep the always-on rules inline; **turn the deploy runbook and the style guide into skills and leave a context pointer behind**."

On **hooks**: barely used, and both hook-based skills sit in `misc/`, his "kept around but rarely used, not promoted" bucket. No stated philosophy.

On **MCP**: no skills-versus-MCP argument anywhere. His only critical framing is the `retro` checklist item, "**Tool economy**: did the agent make expensive tool calls that could be streamlined? Is there any custom tooling (CLI's, MCP's) that is particularly token-inefficient?" He also polices the vocabulary: "*Avoid*: 'tool' — a tool is what the agent **calls**; a skill is instructions it **reads**."

### Killing harness bloat, which is a different lever entirely

Worth separating from the skill work, because it is his only quantified context win at scale. In "How To Kill The Bloat In Claude Code's System Prompt" he reports "**Mine dropped by tens of thousands of tokens per turn**", via: `/context` to measure; a logging proxy to rank individual tool schemas by cost; `disableBundledSkills` and `disableWorkflows`; `permissions.deny` entries; and `skillOverrides` set to `"off"` or `"user-invocable-only"`.

The one non-obvious mechanic, which matters for anyone trying to shrink a tool surface: **deny rules must use bare tool names**. A scoped rule such as `Skill(dataviz)` blocks the call but **leaves the schema in the payload**, so it costs the same tokens while doing nothing. His caveat: "some of what looks like bloat is machinery that background jobs and multi-agent runs rely on, the task tools, `Workflow`, worktree tools."

---

## 4. Composition, process encoding, and multi-agent coordination

This is the section that matters most for the team OS work, so it is treated at length.

### How skills call each other

There is a strict, written protocol in `.agents/invocation.md`. It is worth quoting nearly in full because it is the composition mechanism:

> "Dependencies are expressed as an explicit instruction to **call the Skill tool** with the named skill (`Call the Skill tool with "grilling"`), not deep `../other-skill/FILE.md` cross-references, and not a bare `/skill`-style mention left for the model to interpret. **Naming the tool is what gets it fired**: most harnesses expose skill invocation as a tool the model calls, and spelling that out gets a higher hit rate than dropping a `/name` into prose and hoping it's read as a command."
>
> "The Skill tool takes one skill per call. A step that needs two skills is two calls, not one call with two names: say so (`Call the Skill tool twice, for "grilling" and "domain-modeling"`), not 'call it with X and Y,' which reads as a single call taking both."

Two hard invariants fall out:

- A user-invoked skill **may** invoke model-invoked skills.
- A user-invoked skill can **never** be reached by another skill, only by a human. When a step's precondition is a user-invoked skill, "phrase it as an instruction for the human to act on: 'tell the user to run `/setup-matt-pocock-skills`', never as a Skill tool call."
- "Shared reference docs live **inside the skill that owns them**; other skills reach that material by calling the Skill tool with it, not by linking across folders."

So the composition graph is a DAG with a typed edge: human-to-anything, and model-invoked-to-model-invoked. A model-invoked skill whose content is all reference becomes the single home for vocabulary that several skills share; `codebase-design` and `domain-modeling` exist exactly for that.

### The layering pattern

The set resolves into four distinct layers, and the layering is the reusable idea:

1. **Primitives** (model-invoked, all process): `grilling`, `domain-modeling`, `tdd`, `code-review`, `research`, `prototype`.
2. **Vocabulary layers** (model-invoked, all reference, no steps): `codebase-design`, `writing-for-agents`. These are "one home for shared reference: another skill can invoke it, so reference needed by several skills lives in one place."
3. **Named entry points** (user-invoked, near-empty bodies that compose primitives): `grill-me`, `grill-with-docs`, `implement`.
4. **A router** (user-invoked): `ask-matt`, which names every user-reachable skill and how they relate.

The router exists because of the cost model: "When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. **It can only hint, never fire them**: user-invoked skills have no description, so nothing but the human can reach them."

`CLAUDE.md` treats router staleness as a defect: "a new skill it never mentions, or a stale one it still routes to, is **a router that lies**."

### Encoding a multi-step process rather than knowledge

Four techniques recur, and together they are the answer to "how do you put a process in a skill":

**(a) Name a data structure, then run a loop over it.** `grilling` has the design tree and frontier. `wayfinder` has a map of decision tickets with blocking edges and, again, a frontier. `implement-spec` reads the tickets as "a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed." `diagnosing-bugs` has the feedback loop that must go *red*. In every case the process is a named structure plus a rule for advancing it, not a checklist.

**(b) Gate the phases on hard, checkable criteria.** `diagnosing-bugs` will not let the agent proceed:

> "Phase 1 is done when the loop is **tight** and **red-capable**: you can name **one command** ... that you have **already run at least once** (show the invocation and its output, redacted)... If you catch yourself reading code to build a theory before this command exists, **stop: jumping straight to a hypothesis is the exact failure this skill prevents.** No red-capable command, no Phase 2."

**(c) Assign labour explicitly between agent and human.** `grilling`: "Finding _facts_ is your job, never the user's... The _decisions_ are the user's." `wayfinder` types every ticket as **HITL** or **AFK** and adds the anti-cheat: "the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this)."

**(d) State the rate limit.** `wayfinder`: "**never resolve more than one ticket per session**, with the exception of research tickets."

### Multi-agent coordination: what actually exists

There are five distinct multi-agent patterns in the repo. Note that all of them are **written as prose instructions inside a single skill body** rather than declared in frontmatter, and all are one-shot dispatches rather than long-lived peers.

**1. Parallel critics on orthogonal axes (`code-review`).** The builder-plus-critic pattern, and the best-engineered thing in the set.

> "Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings."

The engineering details are the valuable part:

- **Pre-flight validation before dispatch**: "confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. **A bad ref or empty diff should fail here, not inside two parallel sub-agents.**"
- **The subagent prompts are specified in the skill**, including what must be pasted in full because the subagent cannot see it: "plus the smell baseline from step 3 pasted in full (**the sub-agent has no other access to it**)."
- **Output budgets on each subagent**: both briefs end "Under 400 words."
- **A no-merge aggregation rule**: "Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. **Do not merge or rerank findings, because the two axes are deliberately separate.** ... Don't pick a single winner across axes: that's the reranking the separation exists to prevent."
- **A stated rationale for the split**: "A change can pass one axis and fail the other... Reporting them separately stops one axis from masking the other."
- **Graceful degradation**: "If the spec is missing, skip the Spec sub-agent and note this in the final report."

**2. Divergent parallel designers (`codebase-design/DESIGN-IT-TWICE.md`).** The leader-plus-N-builders pattern, used for design rather than build:

> "Spawn 3+ sub-agents in parallel. Each must produce a **radically different** interface for the deepened module."

Each gets a *different constraint* as its brief: minimise the interface; maximise flexibility; optimise for the most common caller; design around ports and adapters. Each returns a fixed five-part output contract (interface, usage example, what is hidden, dependency strategy, trade-offs). Two further details worth stealing:

- **Shared vocabulary is injected into every brief**: "Include both SKILL.md vocabulary and CONTEXT.md vocabulary in the brief so each sub-agent names things consistently."
- **The human is given work to do during the fan-out**: "Show this to the user, then immediately proceed to Step 2. **The user reads and thinks while the sub-agents work in parallel.**"
- **The leader must take a position**: "give your own recommendation... **Be opinionated: the user wants a strong read, not a menu.**"

**3. Concurrent implementers over a task graph (`implement-spec`, in-progress).** The closest thing in the repo to a full team OS, and it is still a draft. The whole skill is 35 lines:

> "The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.
>
> Communication to and from subagents should be sparse. **Communicate primarily through context pointers**: to the spec, tickets, research notes, and previous commits. **Don't duplicate information already available via pointers.**
>
> **Implementer subagents** should be run in the background where possible for **maximum concurrency**."

Its roles are: an optional **exploration subagent** that front-loads research into notes "in a directory outside the repo, accessible by all future subagents", so "implementer subagents focus on implementation rather than exploration"; **implementer subagents**, each "in its own worktree, on its own branch"; a **merger subagent** that folds each completed branch into the PR branch; and a closing `/code-review` pass whose findings are fixed "in a single implementer subagent". Then worktree cleanup.

That is: isolation by git worktree, a shared filesystem scratch space for context, pointer-based rather than message-based communication, dynamic re-dispatch as the frontier moves, and a merge role separate from the build role.

**4. Non-blocking fact-finding inside an interactive loop (`grilling`).** The most subtle one. The agent dispatches a subagent for an environmental fact, and then explicitly does not wait: "Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now."

**5. Session-to-session handoff (`handoff`, `claude-handoff`).** `handoff` writes a portable markdown file "to the temporary directory of the user's OS, not the current workspace". `claude-handoff` skips the file and launches the next agent directly: `claude --bg --name "<descriptive name>" "<handoff summary>"`. Both carry three rules that generalise to any inter-agent message:

- "Include a **'suggested skills' section** in the document, naming which skills the next agent should call the Skill tool for." (The handoff carries its own routing.)
- "**Do not duplicate content already captured in other artifacts** (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead."
- "**Redact any sensitive information**... since the summary becomes the agent's prompt."

### The agent brief format

`skills/engineering/triage/AGENT-BRIEF.md` is a spec for the message that goes to an AFK agent, and it is the most directly reusable artifact in the repo for a team OS. Its four principles:

- **Durability over precision.** "The issue may sit in `ready-for-agent` for days or weeks. The codebase will change in the meantime." So: describe interfaces, types, and behavioural contracts; name specific types and signatures to look for. Never reference file paths or line numbers, and never assume the current implementation structure survives.
- **Behavioural, not procedural.** "Describe **what** the system should do, not **how** to implement it. The agent will explore the codebase fresh and make its own implementation decisions." Good: "The `SkillConfig` type should accept an optional `schedule` field of type `CronExpression`". Bad: "Open src/types/skill.ts and add a schedule field on line 42".
- **Complete acceptance criteria.** "Every agent brief must have concrete, testable acceptance criteria. Each criterion should be independently verifiable."
- **Explicit scope boundaries.** "State what is out of scope. This prevents the agent from gold-plating."

The template is: Category, Summary, Current behavior, Desired behavior, Key interfaces, Acceptance criteria (checkboxes), Out of scope. The file carries three worked good examples (bug, enhancement, PR-continuation) and one annotated bad one.

### Roles are recognised, but implicitly

The `retro` skill states the role model most directly:

> "All work goes through two stages: implementation and review. **The implementation agent has the most context pressure.** They are responsible for exploration, writing code, and debugging failures. **The review agent has the least context pressure**, it receives a diff, so no exploration needed... This means **the review agent should be responsible for imposing coding standards, not the implementation agent**."

That is a genuine role-differentiation argument grounded in context economics, and it produces a concrete rule about *where a given piece of policy should live*: standards go in `CODING_STANDARDS.md` which "is read during review, not implementation", not in `AGENTS.md` which "is pushed to the context window of any agent working in this repo" and so "should be used incredibly sparingly."

### Hard-won operational findings (read this section)

His docs pages are unusually candid about what has gone wrong in the wild. Four findings are directly load-bearing for anyone building a multi-agent system.

**1. Naming a skill in prose does not reliably invoke it.** A v1.2 changeset records: a skill that names another skill in prose ("run the `/grilling` skill") "**does not reliably cause it to load**. This is the documented rough edge behind `grill-with-docs`'s most-reported problem. Naming the tool directly (`Call the Skill tool with "grilling"`) is intended to raise the hit rate." This is why the `.agents/invocation.md` convention exists at all. It is an empirical finding, not a style preference.

**2. Recursive subagent spawning burned 450k tokens on one task.** From the `research` docs page: the skill tells its caller to spin up a background agent "but does not restrict the agent type, so the agent it spawns is a `general-purpose` one that holds the `Agent` tool and the same instructions, and **fires them again**. One reporter measured a single research task costing roughly **450k tokens across three overlapping runs**, with the duplicate finishing half an hour later entirely out of view." It reproduces outside Claude Code, and there is no shipped fix ([issue #530](https://github.com/mattpocock/skills/issues/530)). The lesson: **a skill that dispatches agents must pin the agent type**, or a skill whose instructions include "spawn an agent" will be re-executed by the agent it spawns.

**3. Parallel implementation in one checkout corrupts git.** He refuses to fan out `/implement` and says why: "Batch dispatch across a ticket queue and subagent fan-out are both requested repeatedly, and **neither exists**. Running several `/implement` sessions side by side in one checkout is worse than unsupported: one field report describes a `git commit --amend` in one session landing on another session's commit, a stash vanishing from `refs/stash`, and commits landing on the wrong branch, all in a single afternoon across three issues... **Git worktrees are the community workaround, and note that `refs/stash` is shared across worktrees too.**" This is why `implement-spec` puts every implementer in its own worktree and is still in-progress.

**4. Subagent depth.** His own dictionary entry asserts a subagent "**Cannot spawn further subagents, the tree is one level deep. Subagents exist to isolate context, not to compose hierarchies.**" Note this conflicts with current Claude Code docs, which allow 3 levels of nesting and 20 concurrent by default. Either way his *design stance* is the useful part: fan out to isolate context, do not build hierarchies.

**5. The handoff loses the why, and the next agent will not re-check it.** The sharpest warning in the whole set, from the `handoff` docs page: "**It captures the what, not the why.** A fair and repeated criticism... watch for confident claims the session never actually verified... **The next agent treats the document as a contract and will not re-check it, so a belief written as a fact becomes a false premise for everything that follows.**"

**6. Hiding a skill from the model hides it from the model's own inventory.** A documented, unfixed consequence of `disable-model-invocation`: the agent cannot see those skills in its skill list, so `ask-matt` reports that half the set "isn't installed". The cost of the invocation split is not only cognitive load; it is that the model can no longer answer questions about its own capabilities.

### What is absent

To be precise about the limits of the source:

- **No long-lived agent teams.** Every pattern is fan-out, collect, terminate. Nothing has peer agents that talk to each other, hold state across turns, or negotiate.
- **No agent-to-agent messaging.** Coordination is exclusively through the leader, the filesystem, git branches, and the issue tracker. There is no channel between siblings.
- **No skill declares a team.** There is no frontmatter, schema, or manifest describing a roster. Roles exist only as capitalised nouns in prose ("implementer subagent", "merger subagent").
- **No conflict resolution.** The nearest thing is `code-review`'s refusal to rerank across axes, which sidesteps conflict rather than resolving it. There is nothing resembling a dispute or adjudication mechanism.
- **No per-role skill sets.** A subagent gets a prompt, not a role-scoped bundle of skills or tools.

---

## 5. Distribution and versioning

### Two mutually exclusive install routes

From the canonical wording in `.agents/install-block.md`, which the repo requires every doc to copy verbatim:

**Claude Code plugin** (managed, read-only, subscribe):
```bash
claude plugins install mattpocock-skills
```
`mattpocock-skills` is listed in Claude Code's official marketplace (`claude-plugins-official`, repo `anthropics/claude-plugins-official`), "which every Claude Code install has out of the box. There is no marketplace to add first."

**skills.sh** (editable files you own, every other harness):
```bash
npx skills@latest add mattpocock/skills
npx skills@latest add mattpocock/skills --skill=<name>
npx skills@latest update <name>
```

`skills.sh` is **not his tool**: it is an open-source agent-skills directory and installer built by Vercel (`vercel-labs/skills`), supporting Claude Code, Cursor, Copilot, Windsurf, Gemini, Cline and others. It copies editable skill files into your project.

The two routes are explicitly exclusive: "The plugin is a managed, read-only bundle you subscribe to. skills.sh writes files you own and edit. Installing both leaves the user with every skill twice: **always say 'pick one'**."

There is a third, undocumented fallback: `.claude-plugin/marketplace.json` makes the repo its own single-plugin marketplace, "kept as a fallback for installing the repo directly (an unreleased commit, or a fork), and is **not** documented to users."

### Versioning

Semver at the **repo** level via [changesets](https://github.com/changesets/changesets), not per skill. Each PR adds a `.changeset/*.md` file declaring `patch`/`minor`/`major` plus a human-written note. `.github/workflows/release.yml` runs the changesets action on push to `main` and opens a "chore: version skills" PR.

`plugin.json`'s `version` must track `package.json`'s version; `scripts/sync-plugin-version.mjs` enforces it, with a `--check` mode. The ADR states why this matters: "Claude uses the plugin `version` to decide when installed users see an update."

Breaking changes are real and documented. v1.0's changeset entries include removing `caveman` and `zoom-out`, renaming `diagnose` to `diagnosing-bugs`, and replacing `write-a-skill` with `writing-great-skills`, each labelled **Breaking**. There are no aliases: "There is no alias. Reinstall under the new name."

One subtlety about update propagation, verified by him on 2026-08-05: the official marketplace listing pins a **sha**, so "a release reaches installed users when that pin moves, not the moment we tag. At the time of writing the pin sits two commits behind `main`, which is why it lists 22 skills rather than the 24 in `plugin.json`."

---

## 6. Measuring effectiveness

Short answer: **one headline number, no ongoing measurement, and no eval harness.**

### The 63% claim

v1.0 (2026-06-18) was announced as "63% Token Reduction". In his own words:

> "The biggest structural change in v1 is the widespread use of `disable-model-invocation: true` across skills. When you set this flag on a skill, its description no longer gets included in the context window that the model reviews when deciding which skill to invoke. **This simple change achieves a 63% reduction in token cost for skill descriptions**, a massive improvement for anyone working with context-limited models."

The measured quantity is narrow and worth stating precisely: it is the **always-loaded description surface**, the Level-1 metadata. **He did not shorten a single skill body to get that number.** Not output quality, not total session tokens.

The secondary cut in the same release was de-duplication by extraction: `grilling`, `domain-modeling` and `codebase-design` were pulled out of the skills that had inlined them into standalone model-invoked skills that others call. "Since the `/grilling` skill is not disabled from the model, it remains invokable by the agent itself. This means you can share it freely across other skills **without bloating their descriptions**." That is what collapsed `grill-with-docs` to a single line.

No published methodology, before/after counts, or measurement script accompanies the figure, and it appears nowhere in the repo.

I reproduced the shape of this measurement against the current v1.2.3 shipped set:

| | count | always-loaded description chars |
|---|---|---|
| Shipped skills, as configured | 25 (14 user-invoked, 11 model-invoked) | 2,198 |
| Same 25, if all were model-invoked | 25 | 3,825 |

That is a **43% reduction at v1.2.3**, versus his 63% at v1.0. The gap is expected: the set has grown and the model-invoked share has shifted. The technique is real and the arithmetic is straightforward, but note what it does and does not buy. It saves a few hundred tokens of always-on context, and it pays for that by making the human the index, which is why the router skill had to be invented in the same release.

### Everything else is qualitative

- **No eval harness, stated outright**: "There is no automated eval here; the check is a manual run plus the failure-mode vocabulary as a diagnostic."
- **No A/B or with-skill/without-skill comparison** anywhere in the repo.
- **No output-quality metric.** The "It's working if" sections in the docs pages are human-checkable heuristics, e.g. "The document gets shorter as it gets better, and you are surprised how little is left" and "Nothing is stated twice, in any form. **Duplication is the most reliable sign a document was never tested.**"
- **The `retro` skill** is the only systematic feedback loop, and it evaluates the environment after a session, not a skill against a baseline.
- **Real usage signal** comes from GitHub issues and the community. `.out-of-scope/` records rejected requests with reasoning, and the docs process instructs writers to mine `gh issue list --repo mattpocock/skills --search "<skill-name>" --state all` because "A question filed twice is a question the page owes an answer to."

---

## 7. Official Anthropic guidance, and how he compares

### The spec, briefly

**Frontmatter** ([agentskills.io/specification](https://agentskills.io/specification)):

| Field | Required | Constraint |
|---|---|---|
| `name` | yes | max 64 chars; lowercase alphanumerics and hyphens; no leading/trailing/consecutive hyphens; must match the parent directory name |
| `description` | yes | 1 to 1024 chars; "should describe both what the skill does and when to use it"; "should include specific keywords that help agents identify relevant tasks" |
| `license` | no | free text |
| `compatibility` | no | max 500 chars |
| `metadata` | no | arbitrary key-value map |
| `allowed-tools` | no | space-separated tool list |

Only those six pass through to claude.ai / the Skills API; Claude Code-only fields (`disable-model-invocation`, `context`, `paths`, `argument-hint`, `model`, `effort`, `hooks`, ...) are a hard error on upload.

**Directory layout**: `SKILL.md` plus optional `scripts/`, `references/`, `assets/`. Skills resolve enterprise > personal (`~/.claude/skills/`) > project (`.claude/skills/`) > plugin (`<plugin>/skills/`, namespaced `plugin:skill`).

**Progressive disclosure**, three levels:

1. **Metadata**, ~100 tokens per skill, always loaded at startup: `name` + `description`.
2. **Instructions**, "< 5000 tokens recommended", loaded on trigger: the `SKILL.md` body. Claude Code adds "Keep `SKILL.md` under 500 lines."
3. **Resources**, loaded on demand: `scripts/`, `references/`, `assets/`.

Claude Code specifics: the skill listing is capped at 1,536 chars per skill (`description` + `when_to_use`) and budgeted at ~1% of the context window; after auto-compaction, skills are re-attached at the first 5,000 tokens each within a 25,000-token shared budget, filled most-recently-invoked first.

**Skill vs subagent** (Claude Code docs): use a **skill** when you want reusable workflows in the main context, need iterative back-and-forth, or latency matters. Use a **subagent** when the task "produces verbose output you don't need in your main context", when you want tool restrictions, when the work "is self-contained and can return a summary", or to route to cheaper models. Skills can themselves fork: `context: fork` (plus optional `agent:` and `background:`) runs the skill body as a subagent prompt, and "It won't have access to your conversation history." Subagents nest up to 3 deep and up to 20 concurrent by default.

**Testing**, per Anthropic: the `skill-creator` plugin stores cases in `evals/evals.json`, runs each in a fresh subagent, grades assertions into `grading.json`, aggregates with-skill vs without-skill pass rate, time and tokens into `benchmark.json`, supports blind A/B between two skill versions, and tunes descriptions by generating should-trigger and should-not-trigger prompts and measuring hit rate. The documented manual method is a **baseline comparison**: "run each one in a fresh session with the skill available and again with it disabled, and compare the results. A fresh session matters because leftover context from authoring the skill will mask gaps in the written instructions." `/skill-doctor` (early access) reports per-skill context cost and 7-day usage.

### Comparison

| Dimension | Anthropic spec | Pocock's practice | Verdict |
|---|---|---|---|
| Frontmatter | 6 portable fields plus harness extensions | 4 fields, only `name` / `description` portable | More conservative than the spec; deliberately so |
| `description` | up to 1024 chars, include keywords | 72 to 421 chars, "one trigger per branch", no synonym stuffing | **Diverges.** He argues keyword piles are branches written twice |
| Body size | < 5k tokens, < 500 lines | median ~900 tokens, max ~3k, max 140 lines | Comfortably compliant |
| Progressive disclosure | 3 levels by file location | same, plus "disclose **by branch**" as the decision rule | **Sharper than the spec** |
| Subagent dispatch | `context: fork` in frontmatter | prose instructions in the body | Diverges, for harness portability; costs him the isolation guarantees |
| Trigger control | model-invoked by default | 22 of 37 skills opt out of model invocation entirely | **Strong divergence**, and the source of the 63% claim |
| Evaluation | `skill-creator` evals, benchmarks, A/B, description hit-rate tuning | none; manual run plus a failure-mode vocabulary | **His clear weakness** |
| Distribution | plugin marketplace, `plugin.json`, semver | official marketplace plugin plus skills.sh; changesets | Fully aligned |

The honest summary: **his authoring theory is better than the official guidance, and his verification practice is much worse.** The official docs have nothing as sharp as context pointers, leading words, the no-op test, disclosure-by-branch, or the premature-completion analysis. But Anthropic ships a real eval harness and he ships none, and the six-skills-broken-by-a-YAML-colon incident is what that costs.

---

## 8. What we should steal, and what does not transfer

Framed against [CONTEXT.md](../../CONTEXT.md): seats are **builder**, **leader**, **SPOC**, **operator**; the two channels are **board** and **court**; a change must improve **blocked-wait**, **ceremony tokens**, or the **benchmark**.

Mapped to those three metrics, here is where his work actually lands:

| Metric | What in his set bears on it |
|---|---|
| **Ceremony tokens** | The two-budget frame, the invocation split (his 63%), the no-op test, pointer-not-payload communication, "cache what the agent cannot find by looking" |
| **Blocked-wait** | Non-blocking subagent dispatch in `grilling`, the frontier-over-task-graph scheduling in `implement-spec` and `wayfinder`, giving the human work to do during a fan-out in `DESIGN-IT-TWICE` |
| **Benchmark** | Nothing. He has no eval harness at all. This is ours to build (§8, items 15 to 16) |

### Steal

1. **The two-budget frame, applied to the roster.** Context load versus cognitive load is the right way to decide what a Crosstalk seat sees. Applied here: the leader's brief is always-loaded context load for every agent that reads it; a role's detailed playbook should sit behind a pointer and load only when that seat is occupied. The team OS design doc already fights this battle (16k of MCP schemas, protocol-heavy brief); "context load" is the vocabulary for the argument you are already making.

2. **The invocation split as a roster mechanism.** A team OS skill is a thing an *operator* starts, not a thing a model stumbles into. `disable-model-invocation: true` is exactly right for the top-level team skills, and it costs zero always-on context. Model-invoked should be reserved for the shared primitives that seats need to reach autonomously (a review protocol, a handoff format, a domain glossary). This gives a clean two-tier design: **user-invoked team definitions, model-invoked shared protocol**.

3. **Thin named entry point over a shared primitive.** `grill-me` being 157 bytes that calls `grilling` is the pattern for expressing team variants. `builder-critic` and `leader-3-builders` should be near-empty user-invoked skills composing the same model-invoked primitives (a brief format, a review protocol, a done rule), not two full copies of a process. This is how you get variants without duplication, and it makes the primitives the versioned unit.

4. **The `AGENT-BRIEF.md` format, close to wholesale.** Durability over precision, behavioural not procedural, independently verifiable acceptance criteria, explicit out-of-scope. This is the best available spec for the message a leader sends a builder, and the "no file paths, no line numbers, describe interfaces" rule is exactly right for briefs that sit in a queue while the tree changes underneath them.

5. **The `code-review` dispatch discipline, as the template for every leader-to-builder fan-out.** Five specific rules: validate preconditions in the leader *before* spawning (a bad ref should fail in one place, not in N parallel agents); write the subagent prompt out in the skill; paste in full anything the subagent cannot otherwise see; put a word budget on each return; and state an aggregation rule, including when *not* to merge. The last one generalises directly to Crosstalk's court/board split: `code-review` refuses to rerank across axes because "reporting them separately stops one axis from masking the other". That is the same instinct as keeping a claim from becoming a command.

   The role argument behind it is also worth lifting into the seat definitions. From `retro`: "the review agent should be responsible for imposing coding standards, not the implementation agent", because the builder carries all the context pressure (exploration, writing, debugging) and the reviewer carries almost none (it receives a diff). That is an argument for putting acceptance policy in the **SPOC's** brief and keeping it out of the **builder's**, and it is grounded in context economics rather than taste.

6. **Different constraints per parallel agent (`DESIGN-IT-TWICE`).** For a leader-plus-3-builders OS, giving each builder the *same* brief wastes the fan-out. Giving each a different explicit constraint, plus a fixed output contract, plus the shared vocabulary injected into every brief, is what makes parallelism produce diversity instead of three copies of the same answer. And the leader must then take a position: "Be opinionated: the user wants a strong read, not a menu."

7. **The frontier over a task graph, as the scheduling primitive.** `implement-spec` and `wayfinder` both encode the same idea: tickets are a graph with blocking edges, the frontier is the ready set, agents claim from the frontier, and completing work recomputes it. CONTEXT.md already says "the leader cuts tasks" and "Crosstalk does not invent the task graph" — **frontier** is the missing word for what the leader is then scheduling over, and it is a leading word in his sense (pretrained, already doing work in two of his skills). Claim-before-work comes free with it: "A session **claims** a ticket by assigning it to the dev driving the map, **first**, before any work, so concurrent sessions skip it. That assignee _is_ the claim: an open, unassigned ticket is unclaimed." That is a lock protocol expressible entirely in the existing `assign` verb, and it directly attacks **blocked-wait**.

8. **Communicate by pointer, not by payload.** From `implement-spec`: "Communicate primarily through **context pointers**... Don't duplicate information already available via pointers." From `handoff`: "Do not duplicate content already captured in other artifacts. Reference them by path or URL instead." This is directly the `InboxCard.summary` design in the team OS spec, and it is worth stating as an explicit protocol rule rather than leaving it to the server renderer.

9. **The phase-boundary tree, and the primary/secondary source distinction.** "Every move except Continue turns a primary source into a secondary source." A team OS needs an answer to "when does a seat hand off, clear, or keep going", and this five-question ordered tree is a better default than any policy we would invent. The rule that the decision belongs *at* a boundary and never mid-phase is worth encoding as a protocol constraint.

10. **Completion criteria as the anti-sloppiness lever, and the subagent-hiding fact.** Two properties: clarity (can the agent tell done from not-done) and demand (how much it forces). Plus the mechanical fact that matters for team design: **hiding downstream steps only works across a real context boundary; an inline skill call leaves them in context and clears nothing.** If we want a builder not to rush toward the review step, the builder has to be a real subagent, not an inline mode switch. This bears directly on the memory note about fixing the done-rule.

11. **The no-op test, run against our own briefs.** "Does this line change behaviour versus the default?" Delete whole sentences, not words. Settle disputes by running the document, not arguing. The team OS doc's complaint that "Claude Code sounds like a clerk because it treats the schemas as law" is a no-op problem: the protocol prose is competing with the schemas for attention.

12. **Leading words, and prompt-the-positive.** Crosstalk already has good ones (*board*, *court*, *seat*, *claim*). The lever is to make sure each is a pretrained word doing work in both the pointer and the body, and to check the brief for prohibitions that should be positive targets.

13. **Changesets for versioning a skill set.** Repo-level semver, one changeset per PR, a generated changelog, a script that keeps `plugin.json` in sync with `package.json`, and Breaking labels with no aliases. This is a solved problem and his solution is small and correct.

14. **The bucket-as-release-channel idea.** `in-progress/` is "public on purpose, feedback wanted, not shipped in the plugin". For team OS definitions, which will be experimental for a while, shipping a curated subset while developing the rest in the open is exactly right, and the enforcing invariant (promoted implies listed in the manifest and the README) is cheap to check.

    Its packaging sibling matters for the **canary** rule ("one interface for every harness; no Claude-only dialect"). He solves the same problem two ways: a per-harness metadata sidecar (`agents/openai.yaml` beside every `SKILL.md`, with a written rule that the invocation setting must match in both or the skill is broken), and harness-neutral phrasing inside the body. On the latter he is specific and it is worth copying verbatim as a house rule: name the tool rather than the syntax. "`Call the Skill tool with "grilling"`, not a bare `/skill`-style mention left for the model to interpret... **Naming the tool is what gets it fired**... Dropping the leading `/` also keeps this harness-neutral: a skill name on its own carries no assumption about which harness's trigger syntax it belongs to."

### Also steal: the operational lessons, which cost him real money to learn

These are not design ideas, they are scar tissue, and each maps onto a decision Crosstalk has to make anyway.

- **Pin the agent type when a skill dispatches agents.** His `research` skill says "spin up a background agent" without restricting the type, so the spawned `general-purpose` agent inherits the `Agent` tool *and the same instructions* and fires them again: 450k tokens across three overlapping runs from one task. Any Crosstalk skill that tells a leader to spawn builders must name the seat and the agent type, or a builder will read the same brief and spawn its own builders. Given the launcher is build-order item 2, encode this before it ships.
- **Isolate builders by worktree, and know that `refs/stash` is shared anyway.** His field report of parallel sessions in one checkout: an amend landing on another session's commit, a stash vanishing, commits on the wrong branch. This is a direct argument that the launcher's supervised mode should hand each builder its own worktree rather than seating three agents in one checkout, and that "same repo, different agents" is not a safe default.
- **Design the inbox card against "the what, not the why".** His handoff warning is the strongest sentence in the corpus for our purposes: "**The next agent treats the document as a contract and will not re-check it, so a belief written as a fact becomes a false premise for everything that follows.**" A server-rendered one-line `InboxCard.summary` is exactly the artifact this warning is about. Consider marking provenance on the card, so a builder can tell an observed fact from a leader's inference, and make the pointer the thing it trusts rather than the summary.
- **Deny by bare tool name, not scoped rule.** For the ceremony-token problem specifically: a `permissions.deny` entry like `Skill(dataviz)` blocks the call but leaves the schema in the payload. Only bare tool names remove the definition. If we are attacking a ~16k-character schema surface, this is the mechanic that determines whether the fix actually reduces tokens or just blocks calls. Pair it with his measurement method: `/context` first, then a logging proxy to rank individual schemas by cost, so the cut is evidence-led.
- **Assign models by parametric versus contextual load.** The leader's job (planning, cutting tasks, spotting the brief contradiction) is parametric and wants the strongest model; a builder working a well-specified ticket is contextual and can take a smaller one. The benchmark's fairness rule already says both team cells use the same three harnesses, so this is about *seat assignment within* that set, and it bears on both cost and the "did the brief contradiction get named" score line.
- **One task per session.** "The smart zone is a budget, and unrelated work spends it... Doing one task per session gives each task the sharpest part of the session." Combined with `wayfinder`'s "never resolve more than one ticket per session", this is an argument that a builder seat should take one task and then be replaced, rather than living for the whole job. That is a lifecycle decision the launcher has to make.

### Add what he does not have

15. **Actually evaluate.** This is his gap and it is the one we should not inherit, especially since a team OS has an obvious metric (the bench results already in this repo). Use Anthropic's `skill-creator` loop: cases in `evals/evals.json`, fresh subagent per case, with-skill versus without-skill pass rate and token counts, blind A/B between two versions of a team OS. A team OS is *more* measurable than a single skill, not less, because the whole point is comparative: solo versus builder+critic versus leader+3.

16. **Validate frontmatter in CI.** Six of his skills silently disappeared from the installer because of an unquoted colon. Any repo shipping skills should parse every `SKILL.md`'s YAML in CI and assert `name` matches its directory. Ten lines, and it prevents a whole class of silent failure.

### What does not transfer

17. **His set has no long-lived team, so there is no coordination protocol to copy.** Every pattern is fan-out, collect, terminate. There are no peer agents, no agent-to-agent messages, no shared mutable state beyond git and the issue tracker, and no conflict resolution. Crosstalk's board, court, seats and append-only log are solving a problem his skills do not have. Take his *dispatch* discipline; do not expect a coordination protocol.

18. **Prose-encoded roles will not scale to a real roster.** "Implementer subagent" and "merger subagent" are capitalised nouns in a 35-line markdown file. That is fine for a one-shot fan-out and wrong for a system where a seat has an identity, a permission set, an inbox, and a lifecycle. Crosstalk needs roles as *data*; his skills need them only as words. Do not copy the informality.

19. **The 63% number is not our ceremony-token number.** It measures always-loaded *description* characters, a few hundred tokens across a 25-skill set. Crosstalk's ceremony-token problem is a ~16k-character tool schema surface, a 50-second idle poll, and four gate tools plus a self-critique essay per task. The invocation split is worth doing and it is the right *technique*, but it is rounding error against those three; do not let the headline metric misdirect the optimisation. His deeper lever for our case is the no-op test applied to the brief and the tool descriptions, not the invocation flag.

20. **He avoids `context: fork` for portability, and we probably should not.** His subagent dispatches are prose because the skills must run on Codex, Cursor and others. If Crosstalk is targeting specific harnesses, the declarative fork (with its `agent`, `background`, and tool-restriction guarantees) buys real isolation that prose cannot. Take the portability discipline where it is cheap, not where it costs enforcement.

21. **The human-as-index model fights our automation goal.** He deliberately spends cognitive load to save context load, because a human is always at the keyboard choosing the skill. In a team OS the *leader agent* is the index for the builders, so leader-facing routing has to be model-reachable in a way his user-invoked skills are not. His router pattern is right; its user-invoked-only constraint is not, for the leader-to-builder edge.

22. **Skip the domain content.** The Fowler smell baseline, the deep-module vocabulary, the TDD rules, the triage label state machine: these are his engineering opinions, not OS mechanics. Steal the shapes, not the software-engineering positions embedded in them.

---

## Source index

**Primary (repo, commit `6654f6b`, plugin v1.2.3):**

- `skills/productivity/writing-for-agents/SKILL.md` and `SKILL-MECHANICS.md` — the design theory
- `skills/engineering/ask-matt/SKILL.md` and `PHASE-BOUNDARIES.md` — the router and the five-option tree
- `skills/engineering/code-review/SKILL.md` — parallel critic subagents
- `skills/engineering/codebase-design/DESIGN-IT-TWICE.md` — divergent parallel designers
- `skills/in-progress/implement-spec/SKILL.md` — concurrent implementers over a task graph
- `skills/engineering/wayfinder/SKILL.md` — multi-session decision map
- `skills/engineering/triage/AGENT-BRIEF.md` — the brief format
- `skills/productivity/grilling/SKILL.md`, `grill-me/SKILL.md`, `grill-with-docs/SKILL.md` — the composition pattern
- `skills/productivity/handoff/SKILL.md`, `skills/in-progress/claude-handoff/SKILL.md` — handoff
- `skills/in-progress/retro/SKILL.md` — the environment feedback loop and the role/context-pressure argument
- `.agents/invocation.md`, `.agents/writing-docs.md`, `.agents/install-block.md`, `.agents/adr/0001`, `.agents/adr/0002`
- `CLAUDE.md`, `CONTEXT.md`, `README.md`, `CHANGELOG.md`, `.changeset/`, `.github/workflows/release.yml`, `scripts/`

**Published (his own posts):**

- https://github.com/mattpocock/skills
- https://www.aihero.dev/skills
- Per-skill docs pages at `https://www.aihero.dev/skills-<name>`, fixed four-section frame (What it does / When to reach for it / Common questions / It's working if). The "Common questions" sections are unusually candid about open bugs and are where most of §4's operational findings come from.
- Changelog v1.0, "63% Token Reduction, /ask-matt, /writing-great-skills" (2026-06-18) — https://www.aihero.dev/skills/skills-changelog-v1-announcement
- Changelog v1.1, "/wayfinder, /to-spec, /to-tickets, /grilling improvements" (2026-07-08)
- Changelog v1.2, "/wait-what, /writing-for-agents, Claude Code Plugin" (2026-08-05)
- "How To Make Codebases AI Agents Love" — https://www.aihero.dev/how-to-make-codebases-ai-agents-love ("AI is not a super-powered developer. It's a new starter with no memory."; **grey box modules**: "You own the interface. AI owns the implementation. Tests keep it honest.")
- "How To Kill The Bloat In Claude Code's System Prompt" — https://www.aihero.dev/how-to-kill-the-bloat-in-claude-codes-system-prompt
- "5 Agent Skills I Use Every Day" — https://www.aihero.dev/5-agent-skills-i-use-every-day ("Skills don't have to be long to be impactful. You just need to choose the right words at the right time.")
- "9 Things People Get Wrong With /grill-me and /grill-with-docs" — https://www.aihero.dev/things-people-get-wrong-with-grill-me-and-grill-with-docs
- AI Coding Dictionary, `https://www.aihero.dev/ai-coding-dictionary/<term>` — his own definitions of *subagent*, *handoff*, *smart-zone*, *context-pointer*, *progressive-disclosure*, *skill*, *primary-source*, *afk*
- https://skills.sh/mattpocock/skills — the installer, built by **Vercel Labs** (`vercel-labs/skills`, maintainers include `rauchg`), not by him

**Research tip for follow-ups:** aihero.dev returns 404 to WebFetch but serves clean markdown when you append `.md` to a slug (e.g. `https://www.aihero.dev/5-agent-skills-i-use-every-day.md`). Machine-readable indexes exist at `/llms.txt`, `/skills.md`, `/sitemap.md`.

**Anthropic:**

- https://agentskills.io/specification
- https://code.claude.com/docs/en/skills.md
- https://code.claude.com/docs/en/sub-agents.md
- https://code.claude.com/docs/en/plugins-reference.md
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md
- https://agentskills.io/skill-creation/evaluating-skills
- https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
