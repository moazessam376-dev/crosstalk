# Agentic-coding benchmarks with token accounting, and when a team beats a solo model

Primary-source research note. Compiled 2026-08-30. All leaderboard figures were
read on that date unless stated otherwise.

**Why this exists.** The beacon-1 run (2026-08-30) had solo Opus 5 beat both team
cells decisively on efficiency — 332k output tokens / 51 min, against github 713k
/ 49 min and crosstalk 894k / 89 min. All three shipped gate-green. That is a
real finding, and it is also the *predicted* finding given the published
literature. This note establishes what the primary sources actually measure so
the next benchmark choice is made against evidence.

**Reading conventions.**

- **MEASURED** — a number produced by a described experiment, an official
  leaderboard, or a lab's own instrumented run.
- **CLAIMED** — an assertion with no reproducible artifact attached.
- Where a paper is a 2026 preprint with no peer review, it is marked
  *(preprint)*. Peer-reviewed and first-party-lab sources are weighted higher.

---

## 0. The headline, before the detail

Four findings dominate everything below.

**One. The two benchmarks you would reach for first are both disowned.** OpenAI
retired SWE-bench Verified on 2026-02-23 (contamination + test design), then
retracted its own replacement recommendation, SWE-bench Pro, on 2026-07-08
(~30% of tasks broken). §1.1.

**Two. There is now a peer-reviewed decision rule for multi-agent, and it is
against us on the obvious benchmarks.** *Capable language models can outgrow the
benefits of collaboration* (Nature Machine Intelligence, 2026-07-24) finds
coordination goes net-negative once a single agent already clears **~45%** on
the task. On SWE-bench Verified specifically, **every** multi-agent architecture
tested *degraded* performance. §2.1.

**Three. Terminal-Bench 4.0 publishes tokens and dollars per run as *required*
schema fields, separates model from agent, takes an arbitrary scaffold, has a
median task horizon of 4 expert-hours, and still has ~48 points of headroom** —
but its leaderboard is closed to community submissions, so it is a measurement
instrument rather than a scoreboard to climb. §1.2, §3.

**And a fourth, which is the quantitative heart of this note.** SWE-bench
Verified — the benchmark everyone reports — has a **median task of 7 changed
lines in 1 file**, is **85.8% single-file**, and only **9.0% of its tasks touch
more than one directory**. It cannot show a team benefit because there is nothing
to divide. Measured on its own leaderboard, the gap between a bare bash loop and
the best multi-model multi-attempt system is **2.0 points**. §1.1.

---

## 1. Question 1 — benchmarks with token accounting

### 1.1 What broke in 2026

Two first-party OpenAI publications reset this landscape. Both are MEASURED
audits, not opinion.

**SWE-bench Verified — retired 2026-02-23.**
[Why SWE-bench Verified no longer measures frontier coding capabilities](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)

- State of the art moved only 74.9% → 80.9% in six months before the audit.
- OpenAI audited a **27.6% subset** (138 problems o3 failed inconsistently over
  64 runs), each reviewed by **at least six** experienced engineers. **59.4% of
  the audited problems had material test-design or problem-description flaws**
  that reject functionally correct submissions. Breakdown: 35.5% narrow tests
  (enforce unspecified implementation details), 18.8% wide tests (check
  unspecified functionality), 5.1% miscellaneous.
- Contamination: **all frontier models tested** could reproduce gold patches or
  verbatim problem-statement specifics. The post shows GPT-5.2 emitting the
  `django__django-11451` gold patch from a one-line hint, and Claude Opus 4.5
  quoting a verbatim inline comment from `astropy__astropy-13236`.
- Verdict, quoted: improvements "no longer reflect meaningful improvements in
  models' real-world software development abilities." OpenAI stopped reporting
  the score.

**How saturated, exactly? The evaluators disagree, and the spread is itself the
finding.** Three independent readings on 2026-08-30:

| Source | Harness | Top score |
|---|---|---|
| [Vals AI](https://www.vals.ai/benchmarks/swebench) | minimal bash-only | **Claude Opus 5 97.00%** (2026-08-26) |
| [Epoch AI](https://epoch.ai/benchmarks/swe-bench-verified) | own infra, 484/500, public logs | **claude-opus-4-7_max 83.47% ± 1.69** (2026-04-20) |
| Official leaderboard, "Bash Only" track | mini-SWE-agent, 1 attempt | **Claude 4.5 Opus 76.8%** (2026-02-17) |

A ~20-point spread on the same 500 tasks, driven by harness and methodology
alone. ⚠️ **Do not quote a single SWE-bench Verified number as "the" score.** But
every one of these readings is high enough that a team has no room to demonstrate
anything, and the residue is dominated by broken tasks.

**And SWE-bench Verified is structurally incapable of showing a multi-agent
benefit.** Statistics computed directly from all 500 gold patches:

| Metric | Value |
|---|---|
| Median lines changed | **7.0** |
| Median files touched | **1.0** |
| Single-file patches | **429/500 = 85.8%** |
| Single-hunk patches | 280/500 = 56.0% |
| Exactly one FAIL_TO_PASS test | 345/500 = 69.0% |
| **Multi-file AND multi-directory** | **45/500 = 9.0%** |
| Human-annotated as <1 hour of work | **455/500 = 91.0%** |

Nine percent of tasks touch more than one directory. There is nothing to
parallelise. The expensive part is *localisation* inside a ~3,010-file
codebase — a serial search problem.

Cross-tabulating the 500 tasks against 40 systems' per-instance results shows
where agents actually fail, and it is exactly the property this benchmark lacks:

| Patch breadth | Solve rate |
|---|---|
| 1 file | **62.3%** |
| 2 files | 31.1% |
| 3 files | 18.3% |
| 4+ files | 20.8% |

| Human est. time | n | Solve rate | Never solved by any system |
|---|---|---|---|
| <15 min | 194 | 70.5% | 4.1% |
| 15 min – 1 h | 261 | 53.6% | 10.3% |
| 1–4 h | 42 | **23.0%** | 28.6% |
| >4 h | 3 | 14.2% | 66.7% |

**Breadth and horizon are where agents fail — and SWE-bench Verified contains
almost none of either.** This is the quantitative core of the whole note: the
benchmark everyone reports is the benchmark least able to distinguish a team from
a solo agent. Empirically it bears out — on the official board, a bare bash loop
scores 76.8% and the best multi-attempt multi-model system scores 78.8%, a
**2.0-point gap**, and the two best entries overall are *single-attempt*.

⚠️ **Two further practical blockers on the official board.** Since **2025-11-18**
it accepts submissions only from "academic teams and research institutions with
open source methods and peer-reviewed publications" — requiring an arXiv preprint
and a university-affiliated author, with Augment Code, Solver AI and Honeycomb.sh
explicitly named as no longer eligible. And the last entry landed **2026-02-26**.
Of 180 entries, only **60 are team-verified** and only **45 carry cost data — all
45 of them minimal bash loops**. Every system claiming a multi-agent advantage
publishes no cost at all.

⚠️ **Licence gap.** SWE-bench *code* is MIT, but the HF dataset cards for
`SWE-bench`, `SWE-bench_Verified` and `SWE-bench_Multimodal` **declare no licence
at all**, while the underlying repos span BSD-3, Apache-2.0, MIT and **GPL-2.0**.
The same is true of `ScaleAI/SWE-bench_Pro`, whose 11 public repos are all
GPL-3.0 or AGPL-3.0. Redistribution or training on this task data is legally
unresolved.

**SWE-bench Pro — recommendation retracted 2026-07-08.**
[Separating signal from noise in coding evaluations](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)

- On the 731-task public split, frontier models went **23.3% → 80.3% in eight
  months**.
- Automated pipeline flagged **200 tasks (27.4%)** as broken; the human
  annotation campaign (five engineers per task) identified **249 (34.1%)**.
  Reviewer/agent category agreement 74%; **in no flagged task was "not broken"
  the majority human verdict**.
- Four failure categories: overly strict tests, underspecified prompts,
  low-coverage tests, misleading prompts.
- Verdict, quoted: "Given the issues uncovered in this analysis, we retract our
  earlier recommendation to adopt SWE-Bench Pro."

Note the scaffold gap this exposes. On [Scale's own public SWE-bench Pro
leaderboard](https://labs.scale.com/leaderboard/swe_bench_pro_public) (read
2026-08-30), the standardised top entries are Muse Spark 1.1 at 61.50 ± 3.10%
and gpt-5.4 (xHigh) at 59.10 ± 3.56%, with entries marked as run under
`mini-swe-agent` and a note that greyed rows are capped at 50 turns vs 250
uncapped. Vendor-reported numbers in the 80% range are not the same measurement.

### 1.2 Benchmark-by-benchmark

| Benchmark | Maintained 2026? | Horizon | Parallel surfaces? | Custom scaffold? | Public token/cost? | Headroom |
|---|---|---|---|---|---|---|
| **Terminal-Bench 4.0** | Yes — released 2026-08-28 | **Hours — median 4.0h, mean 6.54h** | **~23% of tasks** (15 of 66) | **Yes**, `BaseAgent` in Harbor | **Yes — tokens + $ required in schema** | **Large (top 51.8%)** |
| **MLE-bench** | Repo yes; **board frozen 2026-04-24** | **2h to >10h**; 24h agent budget | **Yes — ensembling is a real join** | **Yes — CSV submission only** | No ($); tokens in paper | **Large (top 64.4%)** |
| **METR RE-Bench** | **No — stale since 2025-01-30** | **8 hours** | **Yes — `score@k` to k=128** | METR Task Standard / Inspect | **Yes — ~$123 per 8h run** | Large, but no leaderboard |
| **SWE-bench Verified** | Code yes; **retired by OpenAI, board closed to industry** | **91% under 1 hour** | **No — 85.8% single-file** | Yes, but academics only | ⚠️ 45/180 entries only | **None (76.8–97%)** |
| **SWE-rebench** | **Yes — rolling monthly splits** | ~SWE-bench-like | Weak | Yes | **Yes — $ AND tokens per problem** | **Large (top 64.5%)** |
| **SWE-bench Multimodal** | Dataset yes; **0 submissions in 2026** | Medium | **Yes — 56.5% multi-directory** | Yes, open to all | No | **Large (top 35.98%)** |
| **SWE-bench Pro** | Leaderboard live; **retracted by OpenAI** | Longer than Verified | Weak | Yes (`mini-swe-agent` standard) | No | Moderate but untrustworthy |
| **SWE-Bench ProMax** | New, 2026-08-10 | Long — mean 115 steps | **Yes — mean 11.4 files** | Yes (mini-swe-agent, OpenHands) | **$ per instance published in paper** | **Large (top 41.2%)** |
| **Claw-SWE-Bench** | New, 2026-06-10 | ~SWE-bench-like | Weak | **Yes — that is the point** | Tokens in metadata, not standardised | Large (19.1%–73.4% by harness) |
| **SWE-Chain** | New, 2026-05-14 | Long, chained | **No — explicitly sequential** | Yes | No | Moderate (best 60.8%) |
| **Commit0** | Yes (in OpenHands Index) | Hours | **Yes — 54 libraries, many modules** | Yes | Not on the site | Not established |
| **OpenHands Index** | Yes, from 2026-01-29 | Aggregate | n/a | Contribute a harness | Cost-accuracy curve, per-task $ not published | n/a |
| **Artificial Analysis Coding Agent Index v1.4** | Yes, Aug 2026 | Aggregate of 326 tasks | n/a | **No public submission path** | **Yes — $ and 5-way token split per task** | n/a |
| **Aider polyglot** | **No — zero 2026 entries** | Minutes; single-file katas | **No — Exercism exercises** | **No — harness runs aider itself** | **Yes — $ per full run + token detail** | Little (top 88.0%) |
| **METR time horizon (TH1.1) / RE-Bench / HCAST** | Yes — TH1.1 2026-01-29, data 2026-05-08 | **Hours — up to 8h+; 31 tasks over 8h** | Partially | Runs on Inspect; scaffold-sensitive | **No** | Large |

Sources and detail for each follow.

**Terminal-Bench 4.0** — [tbench.ai/leaderboard](https://www.tbench.ai/leaderboard),
[Harbor Hub](https://hub.harborframework.com), repo now
**`harbor-framework/terminal-bench`** (Apache-2.0 for benchmark code *and* task
data; pushed 2026-08-30). The TB 1.0 paper is **ICLR 2026**
([OpenReview a7Qa4CcHak](https://openreview.net/forum?id=a7Qa4CcHak)).

It is **continuously versioned**, not a sequence of sequels — major version = a
re-run, minor = a re-grade ([Continuous Benchmarks](https://www.tbench.ai/news/continuous-benchmarks), 2026-07-30):

| Version | Released | Tasks | Board |
|---|---|---|---|
| 1.0 | 2025-05-19 | 80 | frozen, last entry 2025-11-11 |
| 2.0 | 2025-11-07 | 89 | **live, 142 community entries** |
| 2.1 | 2026-05-06 | 89 | frozen 2026-07-14 |
| 3.0 | 2026-07-30 | 74 | superseded |
| **4.0** | **2026-08-28** | **66** | **current, 10 entries** |

**Task horizon — this is not a minutes benchmark any more.** Every TB 4.0 task
carries an `expert_time_estimate_hours` field. Across all 66:
**min 0.75 h, median 4.0 h, mean 6.54 h, max 60 h, total 431.8 expert-hours**,
with a flat **8-hour agent timeout** (`timeout_sec = 28800`). Compare TB 1.0,
where most tasks had a **5-minute** limit. The horizon moved from minutes to
hours in fifteen months. Domain mix: Software 18, Science 14, ML 11, Operations
9, Hardware 5, Security 5, Media 4.

**Parallel surfaces — roughly a quarter of tasks.** 15 of 66 tasks (23%)
enumerate four or more deliverables. The clean positive example is
`nextjs-performance`: optimise **six independent routes**, with the instruction
stating that "optimizing only one route or one obvious bottleneck is not
sufficient" — a natural 2–3 way split. The clean negative is
`wal-recovery-ordering`: one tightly-coupled module set with interlocking
LSN/durability invariants, where splitting creates conflicts rather than
throughput. **The majority of TB 4.0 tasks are single-artifact and
coordination-hostile.**

**Scaffold swap — yes, first-class.** Harbor documents two integration paths that
need no changes to Harbor itself: `BaseAgent` (external, drives
`BaseEnvironment.exec`) and `BaseInstalledAgent` (installed in-container,
headless). ~40 agent adapters and 85 benchmark adapters ship with it (including
`aider_polyglot`, `swebench`, `swebenchpro`, `swelancer`, `multi-swe-bench`).
Notably, **ATIF** — Harbor's trajectory format, mandatory for leaderboard
submission — explicitly supports "multi-agent systems: subagent delegation and
hierarchical architectures."

**Cost accounting is mandatory in the schema.** `leaderboard.yaml` *requires*
`accuracy`, `accuracy_ci95_half_width`, `total_tokens`, `total_cost_usd` and
`n_trials`, with optional `uncached_input_tokens`, `cached_input_tokens`,
`output_tokens`, `avg_trial_duration_sec` and `pass_at_2..5`.

⚠️ **Two caveats that decide how you can use it.**

1. **You cannot post a score to TB 4.0 today.** The board states: *"Community
   submissions are currently closed for Terminal-Bench 4.0. Only submissions run
   by the maintainers will be added."* The 4.0 entries are maintainer-run, 5
   trials per task (330 trials), with anti-tampering checks and an **LLM
   trajectory judge auditing every passing trial for reward hacking**
   (disqualified trials score 0). The **TB 2.0 board is open** to community PRs —
   but its Tokens and Cost columns are **empty for every one of its 142 rows**.
2. **The open board has a documented cheating history**
   ([Leaderboard Integrity Update](https://www.tbench.ai/news/leaderboard-integrity-update),
   2026-04-19): one entrant shipped **encrypted solutions inside their agent
   binary**; another uploaded the `tests/` folder; another curled solutions into
   `AGENTS.md`. **Treat any pre-2026-04 community Terminal-Bench score as
   unverified.**

**And the multi-agent evidence on this benchmark is not encouraging.** On the TB
2.0 community board, the best multi-model entry (LemonHarness, model listed as
"Multiple") scores **84.5% ± 2.6** — *below* the best solo entry (NexAU-AHE with
GPT-5.5, **84.7% ± 2.1**) and barely above a plain **Codex CLI baseline at
82.2%**. All three are self-reported. On the maintainer-run 2.1/3.0/4.0 boards
there are **no multi-agent entries at all**.

Leaderboard as read 2026-08-30 (MEASURED, with 95% CIs, and note the separate
MODEL and AGENT columns):

| # | Model | Agent | Resolution | Release | Tokens | Cost |
|---|---|---|---|---|---|---|
| 1 | Opus 5 (max) | Claude Code | **51.8% ± 3.4%** | 2026-07-24 | 6.5B | $6.0k |
| 2 | Fable 5 (max) | Claude Code | 44.5% ± 3.8% | 2026-06-09 | 3.8B | $7.3k |
| 3 | GLM-5.3 (max) | Claude Code | 41.8% ± 3.2% | 2026-08-14 | 8.7B | $2.7k |
| 4 | GPT-5.6 Sol (max) | Codex | 37.3% ± 3.8% | 2026-06-26 | 4.4B | $2.5k |
| 5 | Opus 4.8 (max) | Claude Code | 23.6% ± 3.6% | 2026-05-28 | 6.4B | $6.5k |
| 6 | GPT-5.6 Terra (max) | Codex | 21.5% ± 3.3% | 2026-06-26 | 5.7B | $1.7k |
| 7 | Grok 4.6 (high) | Grok Build | 20.3% ± 3.1% | 2026-08-12 | 4.0B | $3.6k |
| 8 | GPT-5.6 Luna (max) | Codex | 17.3% ± 2.8% | 2026-06-26 | 11.6B | $0.3k |
| 9= | Grok 4.5 (high) | Grok Build | 12.4% ± 2.6% | 2026-07-16 | 3.4B | $2.1k |
| 9= | Sonnet 5 (max) | Claude Code | 12.4% ± 3.1% | 2026-06-30 | 21.6B | $9.6k |

Read the token column: Sonnet 5 burned **21.6B tokens for 12.4%**; Opus 5 got
51.8% on **6.5B**. The leaderboard already publishes exactly the efficiency
comparison Crosstalk's rubric cares about, for free.

**SWE-Bench ProMax** — [arXiv:2608.09802](https://arxiv.org/abs/2608.09802),
2026-08-10, Yuling Shi et al. 170 instances from 29,782 candidates across **70
repositories, 7 languages** (Python, Java, TypeScript, Go, C, C++, Rust).
Large-scale *refactoring*: **mean 11.4 modified files (max 182), mean 261.6 LOC
(max 4,503), mean gold-patch 8,179.5 tokens (max 72,623)**. Graded purely by
tests: resolved iff every test in the suite passes. Run under `mini-swe-agent`
and OpenHands with a 300-step and $10-per-instance cap. Task data CC-BY-4.0;
underlying repos Apache-2.0/MIT/GPL/BSD/AGPL. MEASURED results (OpenHands):

| Model | Overall | Steps | Cost/instance |
|---|---|---|---|
| GPT-5.2 | **41.2%** | 115.1 | $3.60 |
| Claude Sonnet 4.6 | 38.8% | 117.9 | $4.77 |
| Qwen3.5 | 36.5% | 141.2 | $0.78 |
| GLM-5 | 36.5% | 114.2 | $0.24 |

Paper's own efficiency observation: "Higher cost does not translate to
proportionally higher resolve rate" — GLM-5 reaches 36.5% at $0.24 against
Sonnet 4.6's 38.8% at $4.77, a **~20× cost gap for 2.3 points**.

**Claw-SWE-Bench** — [arXiv:2606.12344](https://arxiv.org/abs/2606.12344),
2026-06-10, Zheng, Han, Wang et al. 350 instances, 8 languages, 43 repos (300
from SWE-bench Multilingual + 50 SWE-bench Verified-Mini); 80-instance Lite
subset. MIT licence, repo `opensquilla/claw-swe-bench`, leaderboard at
`claw-swe-bench.github.io`. It is a **harness benchmark**: one adapter protocol,
five harnesses (OpenClaw, Hermes, NanoBot, ZeroClaw, GenericAgent), identical
prompting and grading across all. MEASURED headline: OpenClaw with a minimal
adapter scores **19.1% Pass@1** and with a full adapter **73.4%** — and the paper
decomposes the variance: **model choice moves performance 29.4 points; harness
choice moves it 27.4 points.** *(preprint)*

That number is the strongest published argument that a coordination layer is
worth measuring at all: the harness is nearly as large a lever as the model.

**SWE-Chain** — [arXiv:2605.14415](https://arxiv.org/abs/2605.14415),
2026-05-14, Lam, Wang, Zhuo, Lyu et al. 12 upgrade chains, 9 Python packages,
155 version transitions, 1,660 grounded requirements. **Explicitly not
decomposable** — each transition builds on the agent's own prior codebase.
MEASURED: nine agent-model configurations average 44.8% resolving / 65.4%
precision / 50.2% F1; best is Claude-Opus-4.7 under Claude Code at 60.8% / 80.6%
/ 68.5%. No cost reporting. Useful to this note as the *negative* archetype: a
long-horizon benchmark with zero parallel surface. *(preprint)*

**SWE-rebench** — [swe-rebench.com](https://swe-rebench.com/),
[arXiv:2505.20411](https://arxiv.org/abs/2505.20411); V2
[arXiv:2602.23866](https://arxiv.org/abs/2602.23866), ICML 2026, **CC BY 4.0**,
32,079 train instances across 20 languages and 3,617 repos. ⚠️ The org is
`github.com/SWE-rebench`, not `nebius/`.

**Its leaderboard columns are, verbatim: `Resolved Rate (%)` · `Pass@5 (%)` ·
`Cost per Problem ($)` · `Tokens per Problem`.** It is the only benchmark in this
survey publishing cost *and* tokens against a **rolling, continuously
decontaminated window** — the leaderboard dataset carries monthly splits from
`2025_01` through `2026_03` (110 tasks in the latest). Top entries: Anthropic
Fable 5 [high] **64.5% ± 1.41**, Grok 4.5 [high] 63.8%, Opus 5 [high] 63.4%.

**This is the closest thing to Terminal-Bench's accounting discipline inside the
SWE-bench family, and unlike SWE-bench Verified it is not closed to industry and
not contaminated.** Headroom ~35 points.

**Commit0** — [commit-0.github.io](https://commit-0.github.io/),
[arXiv:2412.01769](https://arxiv.org/abs/2412.01769) (2024-12-02),
[repo](https://github.com/commit-0/commit0) **MIT**. The agent receives a **spec
PDF** crawled from the library's real docs plus a starter repo where **every
public function body is replaced with `pass` and all private functions are
deleted**. ⚠️ Install from git, not PyPI — `commit0` on PyPI is stuck at v0.1.8
(2024-11-22) while git has commits through 2026-02-24. ⚠️ Correcting a common
misreading: **the score is unit-test pass rate only** — lint and typecheck are
feedback channels inside the environment, not scored components. Library count
is published inconsistently (paper 54; `SPLIT_ALL` 56; README 57; Lite 16).

**Commit0 has by far the most parallel structure of anything surveyed.** Checking
out tinydb — one of the *small* Lite libraries — at its base commit yields **48
independent stub functions across 7 files**. Larger entries run to **>250 public
functions, exceeding 1,300 in some cases**, with specs of 10,000–300,000 tokens;
networkx alone is 375 source files and 5,440 tests. Across all 56 libraries there
are **142,292 unit tests, median 680 per library**. The harness supports
incremental per-surface scoring natively: `commit0 test REPO [TEST_IDS]` runs an
arbitrary subset, `commit0 get-tests` enumerates the ID space, and
`commit0 lint REPO --files <paths>` is per-file. The reference agent decomposes
exactly this way — building a **DAG of source modules from imports, topologically
sorted**, then filling modules in dependency order. ⚠️ Surfaces are
**dependency-ordered, not independent**: parallel work fans out across the DAG's
independent branches, not across all files at once. A **Feb 2026 fix** switched
to shallow clones "to prevent reward hacking via git history."

⚠️ **The leaderboard is dead — latest entry 2024-11-26.** MEASURED there: on Lite
(16 repos) the gold reference resolves 10/16 at 100%, **OpenHands 2 repos /
41.24%**, Claude 3.5 Sonnet + test feedback 0 / 30.59%, SWE-Agent 0 / 9.70%. On
All (56): gold 19 repos / 98.29%, **OpenHands 2 / 15.08%**. Note the gold
reference itself only resolves 19 of 56 repos — environments are not perfectly
reproducible, which caps achievable scores. Paper costs: Claude 3.5 Sonnet stage
3 = 29.30% at **$99.39**; o1-preview stage 3 = 21.46% at **$913.35**. Notably,
static-analysis feedback actively *hurt* weaker models; **only execution feedback
reliably helped.**

**SWE-bench Multimodal** — [arXiv:2410.03859](https://arxiv.org/abs/2410.03859),
ICLR 2025. Worth its own line because it is the **mildest step up from Verified
that actually has parallel surfaces**, on familiar infrastructure, and its
leaderboard remains **open to all submitters** (unlike Verified). Recomputed
patch statistics: median **29.5 lines / 2.0 files**, single-file only **30.4%**,
and **multi-file-and-multi-directory 56.5%** — against Verified's 9.0%. All 480
test instances contain at least one image. ⚠️ Serious problems: the task count
has drifted across published sources (617 / 619 / 517 / 510 / 480) and the
leaderboard still scores against **N=517, a denominator no downloadable artifact
matches**, so historical scores are not reproducible. The only submission path,
`sb-cli`, last shipped 2025-08-14. **Zero submissions in 2026**, and no frontier
2026 model has ever been evaluated on it. Top entry: GUIRepair + o3 **35.98%**.

**SW-A²-Bench** (arXiv:2604.04226) — flagged but not verified in depth. It ships
**multi-repo tasks with oracle subtask decompositions**, i.e. it is purpose-built
for exactly the parallel-work research question Crosstalk is asking. If it holds
up on inspection it may be a better second benchmark than anything else here.

**OpenHands Index** — [openhands.dev/blog/introducing-the-openhands-index](https://www.openhands.dev/blog/introducing-the-openhands-index),
2026-01-29. Aggregates SWE-Bench-Verified, Commit0, SWE-Bench Multimodal
(verified subset), SWT-Bench, and GAIA. Evaluates "with respect to ability, cost,
and run time" and discusses a cost-accuracy curve. Nine models across Anthropic,
OpenAI, Google, DeepSeek, Qwen. Third parties may "contribute a harness to our
benchmarks repo." Note it is anchored on SWE-bench Verified, which §1.1 retires.

**Artificial Analysis Coding Agent Index v1.4** (Aug 2026) —
[methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking).
326 tasks: DeepSWE (113 long-horizon SWE tasks), Terminal-Bench v2.1 (89 agentic
terminal tasks), SWE-Atlas-QnA (124 repo Q&A). pass@1 averaged over three
attempts per task. Reports **cost as "average pay per token API cost per task,
based on provider token pricing rather than consumer plans"** and reports tokens
split **five ways: input, cache, cache-write, reasoning, output**. Since Aug 2026
it also runs reward-hacking detection that zeroes runs which manipulate tests or
retrieve reference solutions. No documented path for an outside scaffold to be
listed — this is an index *of* agents AA chooses, not a submission leaderboard.

**Aider polyglot** — [aider.chat/docs/leaderboards](https://aider.chat/docs/leaderboards/).
**225 Exercism exercises across C++, Go, Java, JavaScript, Python, Rust.** The
page states **"last updated November 20, 2025"** — over nine months stale as of
this note, so it fails the "actively maintained in 2026" test. It does what few
others do: publishes **cost in USD for a complete benchmark run** alongside
percent correct, correct-edit-format rate, and detailed token/timeout/error
counts. MEASURED top entries: gpt-5 (high) **88.0% at $29.08** (2025-08-23);
gpt-5 (medium) 86.7% at $17.69; o3-pro (high) 84.9% at **$146.32** (2025-06-28);
gemini-2.5-pro-preview-06-05 83.1% at $49.88; gpt-5 (low) 81.3% at $10.37. Note
the o3-pro line — 84.9% for **5× the cost** of gpt-5 (high)'s 88.0%. Useful as a
historical example of a cost-aware leaderboard; useless for Crosstalk, because
Exercism exercises are single-file and admit **no parallel surface at all**.

**METR — time horizon, RE-Bench, HCAST** —
[metr.org/time-horizons](https://metr.org/time-horizons/) (data last updated
**2026-05-08**), [Time Horizon 1.1](https://metr.org/blog/2026-1-29-time-horizon-1-1/)
(**2026-01-29**). TH1.1 expanded the suite from **170 to 228 tasks** (73 added,
15 removed, 53 updated), doubled long tasks (8h+) from **14 to 31** — though only
**5 of those 31 have measured human baselines** — and migrated from METR's
in-house Vivaria to **Inspect**, the UK AI Security Institute's open framework.
Sources are "RE-Bench, HCAST, and a set of shorter novel software tasks."

MEASURED 50% time horizons, from METR's published `benchmark_results_1_1.yaml`
(26 models; page last updated 2026-05-08):

| Release | Model | 50% horizon | 95% CI |
|---|---|---|---|
| 2023-03-14 | GPT-4 | 4.0 min | 1.9–8.0 |
| 2025-02-24 | Claude 3.7 Sonnet | 60.4 min | 33.0–104.2 |
| 2025-08-07 | GPT-5 | 203.0 min | 112.6–405.6 |
| 2025-11-24 | Claude Opus 4.5 | 293.0 min | 161.7–623.7 |
| 2026-02-05 | **Claude Opus 4.6** | **718.8 min (12.0 h)** | 316.7–3633.8 |
| 2026-04-07 | **Claude Mythos Preview (early)** | **1044.8 min (17.4 h)** | 508.9–3304.3 |

Doubling time: all-time stitched **187.8 days**; **from 2023 on, 128.7 days
[104.4–158.0]** — that is the figure to quote. Task suite human-minutes: min
0.02, **median 12.6**, mean 142.5, max 1800 (30 h).

⚠️ **METR publishes unusually candid caveats, and they matter.** The
[limitations note](https://metr.org/notes/2026-01-22-time-horizon-limitations/)
(2026-01-22) states error bars are historically ~2× each way — "I really have no
idea whether Claude's 'true' time horizon is 3.5h or 6.5h" — and that horizons
are **40–100× lower for visual computer-use tasks**. The
[modelling-assumptions note](https://metr.org/notes/2026-03-20-impact-of-modelling-assumptions-on-time-horizon-results/)
(2026-03-20) reports Opus 4.6 dropping **40% on private-only tasks (7h11m vs
11h59m)**. And the [Frontier Risk Report](https://metr.org/blog/2026-05-19-frontier-risk-report/)
(2026-05-19) says the suite is **near saturation** — "can't reliably measure time
horizons above 16 hours" — and that **≥16% of successful runs on >8h tasks were
illegitimate on review**. Licensing is also a practical blocker:
`METR/public-tasks` is MIT but holds only ~11 task families of the 228; the bulk
of the suite is private.

**METR RE-Bench** ([arXiv:2411.15114](https://arxiv.org/abs/2411.15114), v2
2025-05-27; repo `METR/RE-Bench`, MIT) is the closest published analogue to a
long-horizon team job, and it is **stale — last substantive commit 2025-01-30**.
Seven AI-R&D environments. Human baseline: **71 attempts × 8 h by 61 experts =
568 expert-hours**, ~$1,855 per attempt. MEASURED budget crossover: at **2 h
agents score ~4× humans; at 8 h humans are narrowly ahead; at 32 h humans are
~2× agents**. Cost is unusually well documented: **~29M input + ~499K output
tokens ≈ $123 per 8-hour agent run**, ~15× cheaper than the human.

**RE-Bench has the strongest parallel story of anything surveyed**: `score@k` is
its native metric, tested to **k = 128**, and for the Modular scaffold 30-minute
runs beat 2-hour runs. But best-of-128 still lost to top humans — **breadth is
not a substitute for serial depth.** ⚠️ There has **never been a public
leaderboard and no vendor has ever self-reported a RE-Bench score**; the most
recent per-model numbers in existence are still the Nov 2024 paper's.

**MLE-bench** ([arXiv:2410.07095](https://arxiv.org/abs/2410.07095), ICLR 2025;
repo `openai/mle-bench`, **MIT**, last push 2026-04-24). **75 Kaggle
competitions** (Lite = 22). Horizon is defined in expert-hours: Low **<2 h**,
Medium **2–10 h**, High **>10 h**, with a **24-hour agent budget per
competition** — while the original human contestants had weeks to months.
**Fully agent-agnostic: it requires only a CSV submission**, so any scaffold
plugs in. No dollar figures published; the paper reports **1,800 GPU-hours and
127.5M input + 15.0M output tokens per seed** for o1-preview + AIDE.

MEASURED: paper baseline AIDE + o1-preview **16.9% ± 1.1** Any Medal (pass@8
34.1%). Leaderboard (self-reported with grading reports): **Famou-Agent 2.0 +
Gemini-3-Pro 64.44% ± 1.18** (2026-02-23), AIBuildAI + Claude-Opus-4.6 63.11%,
CAIR MARS+ 62.67% — roughly **3.8× improvement in 16 months**. Two entries were
**demoted for test-set feedback**, so enforcement is real. ⚠️ Submissions frozen
since 2026-04-24 pending "an improved process for ensuring submissions are fair
and comparable."

**MLE-bench is the one benchmark in this survey where multi-agent decomposition
demonstrably wins.** The leaderboard is dominated by multi-agent and evolutionary
systems beating single-scaffold baselines by roughly 4×. The reason is
structural: an ML competition decomposes into EDA, feature engineering,
architecture search, validation plumbing — and **ensembling is a genuine join
step**, a place where independent work products combine into something better
than any one of them. That is the rarest property in this entire survey. ⚠️
Caveat: a single contended machine (one A10, 440GB RAM) means parallel agents
compete for compute, so wall-clock gains will not match the score gains.

**2026 cost-aware boards worth knowing.** [Harbor-Index 1.0](https://harbor-index.org/)
(2026-07-07): 82 tasks distilled from 6,627 across 54 benchmarks, publishes a
**cost/pass-rate Pareto front**; seeding cost 226B tokens and >$300K; top entry
GPT-5.5 + Codex CLI **28.1%**. **MirrorCode** (Epoch AI + METR, 2026-04-10):
24 programs, human estimates of **2–17 weeks** for a ~16k-LOC Go program, with a
**1B token cap ≈ $550/task**. **Terminal-Bench-Science 0.1** (2026-08-27, 70
tasks, Apache-2.0): Claude Opus 5 + Claude Code **30.0%** at $7.0k.
**PaperBench** (arXiv 2504.01848): 20 ICML papers, 8,316 rubric nodes,
~$400/paper rollout — leaderboard frozen at 2025-04-02. ⚠️ **HAL** (Princeton,
ICLR 2026), previously the best cost-vs-accuracy board, was **archived
2026-07-01**; its CORE-Bench Hard figures remain a striking illustration of
scaffold dominance — **Claude Code + Opus 4.5 at 77.78% for $87** against
CORE-Agent + Opus 4.1 at **51.11% for $412**.



Two things matter here for Crosstalk. First, this is **the only source in the
survey with a genuine multi-hour task horizon** — the regime where Anthropic's
"information that exceeds single context windows" justification for multi-agent
actually applies. Second, METR itself reports that Vivaria and Inspect produced
significantly different results for GPT-4o and o3, i.e. **these measurements are
scaffold-sensitive** — which cuts both ways: it means a scaffold can move the
number, and it means METR's numbers are not a clean model-only baseline. No token
or dollar cost is reported.

### 1.3 Saturated vs. genuine headroom

**Saturated — do not run Crosstalk here.**

- **SWE-bench Verified.** Saturated on every reading (76.8% bash-only / 83.47%
  Epoch / 97.00% Vals), retired by OpenAI, contaminated, board closed to
  industry since 2025-11-18, no new entries since 2026-02-26. And **structurally
  incapable of showing a team benefit**: 85.8% single-file, 9.0% multi-directory,
  91% under an hour. The measured multi-agent-vs-bash-loop gap on its own board
  is **2.0 points**, and Nature MI measured every multi-agent architecture
  *losing* here. A "win" would be noise on defects.
- **SWE-bench Pro.** Not saturated in raw score (59.1% standardised) but ~30% of
  the public split is broken by OpenAI's audit and the recommendation is
  retracted. Any measured delta sits inside the defect rate.
- **Aider polyglot.** Top 88.0%, and the leaderboard has not been updated since
  **2025-11-20**. 225 single-file Exercism exercises — no parallel surface even
  in principle. Fails criterion (a) and criterion (b)-for-our-purposes.

**Genuine headroom, and a shape a team could exploit.**

- **Terminal-Bench 4.0** — top 51.8%, ~48 points open, published tokens and cost,
  model/agent columns separated, Apache-2.0, `--agent` adapter seam. Caveat in
  §2.1: the Nature MI study measured Terminal-Bench as *close to neutral* for
  multi-agent (Independent +1.7%, Centralized −19.2%), attributing the failure of
  orchestration to its low tool count.
- **SWE-Bench ProMax** — top 41.2%, ~59 points open, and structurally the best
  parallel surface in the whole survey: **mean 11.4 files per instance across 7
  languages**, behaviour-preserving refactors graded by tests. A coordinated
  multi-file refactor is precisely the task shape where independent workers on
  disjoint files plus a shared test gate should beat one agent grinding
  sequentially through 11 files in one context window. Published per-instance
  cost makes the efficiency comparison legible. Its weakness is age — released
  three weeks before this note, with no independent replication and no public
  leaderboard I could confirm (§3).
- **Claw-SWE-Bench** — headroom is enormous *in the harness dimension*
  (19.1% → 73.4% on the same model by adapter alone). It is the only benchmark
  built to answer "does my coordination layer help", but it is a June 2026
  preprint with no independent uptake I could verify.

### 1.4 Which benchmarks actually publish token accounting

Ranked by how usable the accounting is:

1. **Terminal-Bench 4.0** — `total_tokens` and `total_cost_usd` are **required
   schema fields**, with 95% CIs and 5 trials per task. Maintainer-run only.
2. **SWE-rebench** — `Cost per Problem ($)` **and** `Tokens per Problem`, on a
   rolling decontaminated window. Open.
3. **Artificial Analysis Coding Agent Index** — richest cost model (five-way
   token split, provider pricing, cache-write included). Closed submission.
4. **CursorBench** (`Cost per task`, `Tokens per task`, `Steps per task`) and
   **DeepSWE** (`Mean cost (USD)`, `Mean output tokens`, `Mean agent steps`) —
   noted but not verified in depth for this note.
5. **Aider polyglot** — `total_cost` per full run plus token detail. Stale.
6. **METR RE-Bench** — ~$123 per 8-hour run, in the paper. No leaderboard.
7. **SWE-bench Verified / Multilingual** — `Avg. $` column with `cost`,
   `instance_cost`, `instance_calls` fields, **but populated for only 45 of 180
   Verified entries, all of them minimal bash loops.** The SWE-bench Multilingual
   split is the exception and is well-instrumented: **13/13 entries carry cost**,
   12/13 team-verified, all under one scaffold.
8. **SWE-Bench ProMax** — per-instance $ in the paper, not on a live board.

**Nobody publishes cost for a multi-agent system.** That absence is itself the
strongest evidence in this note: on the SWE-bench boards, every entry claiming a
multi-agent advantage reports no cost at all, while every entry that does report
cost is a single-agent bash loop.

⚠️ **A cost-transparency asymmetry worth internalising.** Because only simple
scaffolds publish cost, the public record systematically flatters them on
efficiency and flatters complex systems on score. Crosstalk should publish both
or the comparison is not honest in either direction.

---

## 2. Question 2 — when multi-agent beats single-agent, and at what token cost

### 2.1 The capability ceiling — the strongest result, and it is peer-reviewed

**Kim, Gu, Park, Park, Schmidgall, Heydari, Yan, Zhang, Zhuang, Liu, Malhotra,
Liang, Park, Yang, Xu, Du, Patel, Althoff, McDuff, Liu — "Capable language models
can outgrow the benefits of collaboration", *Nature Machine Intelligence* 8,
1157–1172, published 2026-07-24.** Preprint: *Towards a Science of Scaling Agent
Systems*, [arXiv:2512.08296](https://arxiv.org/abs/2512.08296) (v1 2025-12-09,
v3 2026-04-08). [MIT Media Lab listing](https://www.media.mit.edu/publications/capable-language-models-can-outgrow-the-benefits-of-collaboration/).

Design: **260 configurations**, **six agentic benchmarks** (BrowseComp-Plus,
Finance-Agent, PlanCraft, Workbench, **SWE-bench Verified**, **Terminal-Bench**),
**five architectures** (Single-Agent, Independent, Centralized, Decentralized,
Hybrid), **three LLM families**, with task prompts, tools and compute budgets
held constant and only coordination structure and model capability varied.

MEASURED results that bear directly on Crosstalk:

**The threshold.** The decision boundary between single-agent and multi-agent is
**P_SA\* ≈ 0.45**. Above a ~45% single-agent baseline, additional agents produce
negative returns. Interaction term P_SA × log(1+n_a), **β̂ = −0.236, p = 0.004**.
The Nature abstract states the threshold correctly predicts the direction of the
coordination effect in **94% of validation configurations on SWE-bench Verified
and Terminal-Bench**; the preprint reports the fuller architecture-selection
model picking the best architecture for **87% of held-out configurations**
against a 20% random baseline.

**SWE-bench Verified — multi-agent lost, every time.** Single-agent mean 0.522.
Hybrid **−2.1%**, Centralized **−3.1%**, Decentralized **−5.4%**, Independent
**−14.9%**. The authors attribute this to the >45% single-agent baseline.

**Terminal-Bench — near neutral.** Single-agent mean 0.344. Independent
**+1.7%** (0.350), Centralized **−19.2%** (0.278). The Centralized collapse is
attributed to low tool count (2 tools) making an orchestrator pure overhead.

**Decomposability is the swing factor.** Finance-Agent with Centralized
coordination: **+80.8%** (0.631 vs single-agent 0.349), driven by parallelizable
reasoning across independent information streams. PlanCraft with Independent
coordination: **−70.0%** (0.170), coordination overhead against sequential
planning. Same architectures, opposite sign, decided by task shape.

**Token efficiency (Table 5), at matched budgets, mean 4,800 tokens/trial.**
E_c is success normalised by relative turn count; the last column is trace-level
error amplification.

| Architecture | Success rate | E_c | Successes / 1k tokens | Error amplification |
|---|---|---|---|---|
| **Single-agent** | 0.466 | **0.466** | **67.7** | 1.0× |
| Independent | 0.370 | 0.234 | 42.4 (−37%) | **17.2×** |
| Decentralized | 0.477 | 0.132 | 23.9 (−65%) | 7.8× |
| Centralized | 0.463 | 0.120 | 21.5 (−68%) | 4.4× |
| Hybrid | 0.452 | 0.074 | 13.6 (−80%) | 5.1× |

Note what that table says: **Decentralized reaches a slightly higher success rate
than a single agent (0.477 vs 0.466) while costing 2.8× more tokens per
success.** That is the beacon-1 shape exactly — teams found real bugs, and paid
2.7× the output tokens to do it.

**Verification gates are the named fix for error amplification.** Quoted:
"Independent systems amplify trace-level errors 17.2× through unchecked error
propagation… Centralized coordination, however, contains this to 4.4× by
enforcing validation bottlenecks that intercept errors before aggregation."

Their explicit prescriptions: single-agent above 45% baseline; Centralized for
decomposable analysis with moderate tool count and low baseline; Decentralized
for tool-heavy tasks despite the efficiency loss; avoid multi-agent for
sequential planning. Also MEASURED: efficiency × tool-count interaction
**β̂ = −0.096, p = 0.002**, with single-agent E_c 0.466 against multi-agent
0.074–0.234 — a **2–6× efficiency penalty** described in the paper's own terms.

### 2.2 Anthropic's own numbers — research, then coding

**[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), published 2025-06-13.** First-party, MEASURED on internal evals.

- A multi-agent system (Claude Opus 4 lead, Claude Sonnet 4 subagents)
  **outperformed single-agent Claude Opus 4 by 90.2%** on Anthropic's internal
  research eval.
- On BrowseComp, three factors explain **95%** of performance variance; **token
  usage alone explains 80%**, with tool-call count and model choice the others.
  Quoted: "Multi-agent systems work mainly because they help spend enough tokens
  to solve the problem."
- The cost, quoted: "agents typically use about **4× more tokens** than chat
  interactions, and multi-agent systems use about **15× more tokens** than chats."
- And the caveat that matters most here, quoted verbatim: "some domains that
  require all agents to share the same context or involve many dependencies
  between agents are not a good fit for multi-agent systems today. For instance,
  **most coding tasks involve fewer truly parallelizable tasks than research**,
  and LLM agents are not yet great at coordinating and delegating to other agents
  in real time."
- Where it does work: "valuable tasks that involve heavy parallelization,
  information that exceeds single context windows, and interfacing with numerous
  complex tools."

**[Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler), Nicholas Carlini, published 2026-02-05.** This is the closest first-party analogue to Crosstalk: a *coding* task, a real team, real instrumentation.

MEASURED: **16 agents**, ~**2,000 Claude Code sessions** over two weeks,
**2 billion input tokens**, **140 million output tokens**, **just under $20,000**.
Output: a 100,000-line Rust C compiler that builds a bootable Linux 6.9 on x86,
ARM and RISC-V, compiles QEMU/FFmpeg/SQLite/postgres/redis, and passes 99% of the
GCC torture suite. Clean-room, no internet access.

The design lessons are the substance:

- **No orchestrator, no inter-agent messaging.** Quoted: "I haven't yet
  implemented any other method for communication between agents, nor do I enforce
  any process for managing high-level goals. I don't use an orchestration agent."
  Coordination is a **file lock in git**: an agent writes
  `current_tasks/parse_if_statement.txt`; git's synchronisation forces a
  colliding second agent to pick something else. Merge conflicts are frequent and
  the agents resolve them.
- **Parallelism is a property of the task, and it can be manufactured.** Quoted:
  "When there are many distinct failing tests, parallelization is trivial: each
  agent picks a different failing test." Then the failure: "compiling the Linux
  kernel is one giant task. Every agent would hit the same bug, fix that bug, and
  then overwrite each other's changes. **Having 16 agents running didn't help
  because each was stuck solving the same task.**" The fix was to build a
  *bisection oracle* — compile most of the kernel with GCC and only a subset with
  Claude's compiler — which converted one indivisible task into many independent
  per-file failures.
- **Verifier quality is the binding constraint.** Quoted: "it's important that
  the task verifier is nearly perfect, otherwise Claude will solve the wrong
  problem."
- **Harness ergonomics are token economics.** Explicit design rules: don't print
  thousands of bytes into context; log to file and print a few lines; write
  `ERROR` and the reason on the same line so `grep` finds it; pre-compute
  aggregate statistics; provide a `--fast` deterministic 1%/10% sample because
  "Claude can't tell time and, left alone, will happily spend hours running tests
  instead of making progress."
- **Specialisation was worth it**: separate agents for de-duplicating code,
  compiler performance, generated-code quality, a Rust-idiom design critic, and
  documentation.

### 2.3 The counter-argument: Cognition

**Walden Yan, ["Don't Build Multi-Agents"](https://cognition.ai/blog/dont-build-multi-agents), published 2025-06-12.** Read first-hand for this note.

This is **CLAIMED, not MEASURED** — there is no experiment, no benchmark, no
number anywhere in the post. It is an architectural argument from production
experience building Devin. Weight it accordingly, but note that §2.1's measured
error-amplification figures are the same phenomenon with a number attached.

Two principles, quoted verbatim:

> **Principle 1.** Share context, and share full agent traces, not just
> individual messages.

> **Principle 2.** Actions carry implicit decisions, and conflicting decisions
> carry bad results.

The worked example: "build a Flappy Bird clone" split into a background subtask
and a bird subtask. Subagent 1 builds something that looks like Super Mario Bros;
subagent 2 builds a bird that doesn't move like Flappy Bird's. Even after fixing
that by sharing the original task text with both, you get "a bird and background
with completely different visual styles", because "the actions subagent 1 took
and the actions subagent 2 took were based on conflicting assumptions not
prescribed upfront."

Yan's recommendation is a **single-threaded linear agent** by default, and for
genuinely long tasks, not fan-out but **a dedicated context-compression model**
that condenses history into "key details, events, and decisions" — something
Cognition fine-tuned a smaller model for.

Three observations from the post that bear directly on Crosstalk:

- **On Claude Code's subagents (as of June 2025):** it "never does work in
  parallel with the subtask agent, and the subtask agent is usually only tasked
  with answering a question, not writing any code." The stated benefit is purely
  context offloading — "all the subagent's investigative work does not need to
  remain in the history of the main agent." Note that Anthropic's own C compiler
  experiment (§2.2, Feb 2026) is precisely the opposite configuration, eight
  months later. The state of the art moved.
- **On agents negotiating like engineers do:** "If Engineer A's code causes a
  merge conflict with Engineer B, the correct protocol is to talk out the
  differences and reach a consensus. However, agents today are not quite able to
  engage in this style of long-context proactive discourse with much more
  reliability than you would get with a single agent." **This is a direct
  challenge to Crosstalk's court**, stated as of mid-2025 and untested since.
- **And the opening it leaves, quoted:** "The decision-making ends up being too
  dispersed and context isn't able to be shared thoroughly enough between the
  agents. **At the moment, I don't see anyone putting a dedicated effort to
  solving this difficult cross-agent context-passing problem.** I personally
  think it will come for free as we make our single-threaded agents even better
  at communicating with humans. When this day comes, it will unlock much greater
  amounts of parallelism and efficiency."

That last sentence is the sharpest statement of Crosstalk's thesis and its risk
in one place. Crosstalk *is* a dedicated effort at cross-agent context-passing.

### 2.3b The reversal — same author, ten months later

**Walden Yan, ["Multi-Agents: What's Actually Working"](https://cognition.com/blog/multi-agents-working), published 2026-04-22.** Anyone citing "Don't Build
Multi-Agents" without this is citing a superseded position.

The governing rule, quoted:

> **"Multi-agent systems work best today when writes stay single-threaded and
> the additional agents contribute intelligence."**

Three patterns Cognition now says work in production — note that all three add
*intelligence* without adding *writers*:

1. **A code-review loop.** MEASURED (internal production telemetry, no control
   arm): "Devin Review catches an average of **2 bugs per PR, of which roughly
   58% are severe**."
2. **"Smart friend"** — a smaller primary model consulting a larger model on hard
   subproblems.
3. **Manager–child delegation** — "map-reduce-and-manage": a manager splits work,
   children execute, the manager synthesises.

And crucially, **the justification for giving the reviewer its own agent is
context rot, not parallelism**: "When the coding agent has been working for hours
on a task… the dedicated review agent gets to skip this extraneous context."

Still explicitly not working, per the same post: parallel-writer swarms — "the
unstructured-swarm approach… is mostly a distraction" — and weaker-to-stronger
escalation.

**What this means for Crosstalk.** The 2025 post said don't. The 2026 post says
do, but with a specific shape: **one writer, extra agents supplying judgement
from clean context.** Crosstalk's board-and-court design puts multiple *builders*
on the work. That is the configuration both Cognition posts reject, and §2.7's
Co-Coder measurement rejects too. The configuration both endorse is the one
beacon-1 accidentally validated: teams "caught real bugs via review that solo
never checked for."

### 2.4 Where the tokens actually go

**Salim, Latendresse, Khatoonabadi, Shihab — "Tokenomics: Quantifying Where
Tokens Are Used in Agentic Software Engineering", [arXiv:2601.14470](https://arxiv.org/abs/2601.14470), 2026-01-20.** *(preprint)* 30 software
development tasks through ChatDev on a **GPT-5 reasoning backend** (i.e. a modern
model, not a 2023 artefact), traced across six stages.

MEASURED, from the abstract: **the iterative Code Review stage accounts for
59.4% of token consumption on average**, and **input tokens are 53.9%** of total.
The authors' conclusion, quoted: "the primary cost of agentic software
engineering lies not in initial code generation but in automated refinement and
verification."

For Crosstalk this is the most actionable number in the note. The expensive part
of a team is not the building. It is the reviewing. Ceremony tokens before the
first edit — the metric CONTEXT.md already tracks — is measuring the cheap end.
The costly end is every review round after it.

**Bai, Huang, Wang, Sun, Mihalcea, Brynjolfsson, Pentland, Pei — "How Do AI
Agents Spend Your Money? Analyzing and Predicting Token Consumption in Agentic
Coding Tasks", [arXiv:2604.22750](https://arxiv.org/abs/2604.22750), v1
2026-04-24, v2 2026-04-29.** *(preprint)* Eight frontier LLMs (named in the
abstract: Kimi-K2, Claude-Sonnet-4.5, GPT-5) on SWE-bench Verified. MEASURED:
agentic tasks consume **~1000× more tokens than code reasoning and code chat**,
with **input** tokens driving cost; runs on the **same task differ by up to 30×**
in total tokens; Kimi-K2 and Claude-Sonnet-4.5 consume **over 1.5 million more
tokens than GPT-5**; models predict their own token usage with correlation of at
most **0.39**.

The 30× same-task variance is a methodological warning for beacon-2: a single
run per cell cannot distinguish a coordination effect from run noise.

**AgentTaxo** ([OpenReview](https://openreview.net/forum?id=0iLbiYYIpC), ICML
2025) decomposes tokens across MetaGPT, CAMEL and AgentVerse and names duplicated
inter-agent tokens a **"communication tax"**. ⚠️ **Do not cite its numbers.** The
often-repeated 2:1–3:1 input:output ratio reaches this note only second-hand via
the Token Economics survey; the OpenReview page is Cloudflare-gated and the
figures could not be verified at source. The *concept* is sound and corroborated
by Tokenomics above; the specific ratios are not established here.

**Phase-Scheduled Multi-Agent Systems for Token-Efficient Coordination**
([arXiv:2604.17400](https://arxiv.org/abs/2604.17400), 2026-04-19, single
author) *(preprint)*. MEASURED for its own method: **27.3% mean token reduction**
(range 21.4–34.8%) within 2.1 points of a fully-activated baseline (p<0.01,
n=500/config); on HumanEval-MAS, 34.8% token reduction for −2.4% pass@1. Its
widely-quotable framing figure — production five-agent code-review pipelines at
**42,000–71,000 tokens per invocation, of which 29–38% is redundant context
consumed by agents that do not act on it** — appears in the introduction with no
cited methodology. Treat as an order-of-magnitude illustration, not a measurement.

### 2.5 The positive case: a 3-agent parallel scaffold that does win

**Chen, Ahmad, Zhou, Jabbarvand — "Unlocking Model Potentials Through Adaptive
Multi-Agent Scaffolding for Efficient Issue Resolution", [arXiv:2606.25514](https://arxiv.org/abs/2606.25514), 2026-06-24.** *(preprint)*
Code: [Intelligent-CAT-Lab/icat-agent](https://github.com/Intelligent-CAT-Lab/icat-agent).

Architecture: a rubric-based issue-quality checker routes the task, then **three
specialised agents run in parallel** — **Explorer** (AST-based repo navigation,
triggered only for low-quality issue text), **Validator** (test generation and
patch evaluation), **Patch Editor** (code modification). Critically, they
communicate by **synchronous event-based message passing with structured
payloads, not shared context**.

MEASURED head-to-head against single-agent scaffolds on identical models:

| Benchmark | Scaffold | Model | Resolved | % | Avg cost |
|---|---|---|---|---|---|
| SWE-bench Verified (500) | icat-agent | MiniMax M2.5 | 397 | **79.4%** | $0.08 |
| SWE-bench Verified (500) | mini-SWE-agent | MiniMax M2.5 | 379 | 75.8% | $0.07 |
| SWE-bench Verified (500) | icat-agent | GPT-5-mini | 323 | **64.6%** | $0.07 |
| SWE-bench Verified (500) | mini-SWE-agent | GPT-5-mini | 281 | 56.2% | $0.05 |
| SWE-bench Pro (731) | icat-agent | Claude Sonnet 4.5 | 454 | **62.2%** | $1.27 |
| SWE-bench Pro (731) | SWE-agent | Claude Sonnet 4.5 | 319 | 43.7% | — |
| SWE-bench Pro (731) | icat-agent | GPT-5.4-xhigh | 493 | **67.4%** | $1.49 |
| SWE-bench Pro (731) | mini-SWE-agent | GPT-5.4-xhigh | 431 | 59.1% | — |
| SWE-bench Pro (731) | Claude Code | GPT-5.4-xhigh | 447 | 61.1% | $2.67 |

Reported gains: **3.6–8.4% on SWE-bench Verified, 6.3–18.5% on SWE-bench Pro**.
Ablation: forcing exploration on already-well-specified issues **reduced
cost-effectiveness by 18–24% with minimal resolution gain** — i.e. the routing
gate, not the fan-out, is what makes it economical. Explorer file-level
localisation recall 63.9–88.7%.

**This table is the single most important evidence in the note, because it
reproduces the capability ceiling from the other direction.** On the easier,
higher-baseline benchmark (SWE-bench Verified, 75.8% single-agent) the team gains
**+3.6 points at +14% cost**. On the harder, lower-baseline benchmark (SWE-bench
Pro, 43.7% single-agent) the same architecture gains **+18.5 points**, and beats
Claude Code by 6.3 points at **44% lower cost** ($1.49 vs $2.67). Headroom
predicts the team advantage. Caveats: preprint, no independent replication, and
the SWE-bench Pro results sit on a dataset OpenAI says is ~30% broken (§1.1).

### 2.5b The head-to-head that matters most: agent teams lost to one sequential agent

**Yang, Nie, Chandra, Gannutin, Lin, Chaudhuri — "When Parallelism Pays Off:
Cohesion-Aware Task Partitioning for Multi-Agent Coding",
[arXiv:2606.00953](https://arxiv.org/abs/2606.00953), 2026-05-31.** *(preprint)*
**All methods run on gpt-5-mini** — a genuine controlled comparison. Benchmarks:
DevEval (28 real-world repo-level tasks) and CodeProjectEval. The method
formalises orchestration as **graph partitioning over the codebase's dependency
structure**. MEASURED:

**DevEval**

| Method | Pass rate | Cost | Latency |
|---|---|---|---|
| Sequential (single agent) | 56.8% | $0.25 | 800s (1×) |
| File-based parallel | 57.7% | $0.36 | 806s |
| **Claude Code w/ Agent Teams** | **54.1%** | $0.23 | 536s |
| **Co-Coder** | **68.1%** | **$0.18** | 442s |

**CodeProjectEval**

| Method | Pass rate | Cost | Latency |
|---|---|---|---|
| Sequential (single agent) | 20.1% | $1.03 | 2756s |
| File-based parallel | 23.3% | $1.65 | 1771s |
| **Claude Code w/ Agent Teams** | **16.3%** | $0.38 | 680s |
| **Co-Coder** | **34.1%** | $0.67 | 1315s |

Three measured findings, each one a direct hit on Crosstalk's design space:

1. **Off-the-shelf agent teams lost to a single sequential agent on both
   benchmarks** — 54.1% vs 56.8%, and 16.3% vs 20.1%. Faster and cheaper, and
   worse. This is the closest published analogue to beacon-1, and it reproduces
   beacon-1's result on a public benchmark with a controlled backend model.
2. **Naive file-based parallelism "inflates API cost by 60%" for no quality
   gain**, attributed to "concurrent violations of cross-file contracts requiring
   expensive yet unproductive iterations." Splitting by file is not splitting by
   dependency.
3. **Dependency-aware partitioning wins on all three axes at once** — accuracy,
   cost and latency — and the paper states the condition explicitly: **"The
   advantage of cohesion-aware partitioning grows with the density of inter-file
   coupling."** On loosely-coupled projects all methods performed comparably.

**This is the single most actionable paper in the note.** It says the value is
not in having a team; it is in *where you cut*. A leader that cuts tasks along
the dependency graph beats a single agent. A leader that cuts by file loses to
one.

### 2.5c The rest of the negative evidence, briefly

Four more controlled results, all pointing the same way. Each is summarised to
its load-bearing number.

**Agentless** ([arXiv:2407.01489](https://arxiv.org/abs/2407.01489), Xia, Deng,
Dunn, Zhang, UIUC; v2 2024-10-29). A fixed three-phase pipeline — localise,
repair, validate — with **no tools and no LLM-chosen actions**. MEASURED on
SWE-bench Lite (300) with GPT-4o: **32.00% at $0.70 and 78,166 tokens**, against
SWE-agent's **18.33% at $2.53 and 498,346 tokens on the same model**. **+13.7
points at 3.6× lower cost and 6.4× fewer tokens.** 🚩 GPT-4o era — the specific
numbers are dated, but the structural point (a fixed pipeline beat an agent that
chose its own actions) is why "add more agency" is not automatically progress.

**Seven frameworks, one backend model**
([arXiv:2511.00872](https://arxiv.org/abs/2511.00872), 2025-11-02). **All run on
DeepSeek-v3.1.** MEASURED program-repair rate on SWE-bench Lite: single-agent
systems SE-Agent 54% ($40.73), SWE-Agent 53% ($42.16), Trae 51% ($15.53),
OpenHands 49% ($54.48) — against multi-agent **OWL at 10%** ($2.49) and
**AgentOrchestra at 3% ($64.05)**. AgentOrchestra was **the most expensive system
tested and the worst performing**. Their design conclusion: **"incorporating
specialized tools yields superior results compared to adding dedicated agents."**
⚠️ Their single/multi labels are their own and are contestable.

**"The Illusion of Multi-Agent Advantage"**
([arXiv:2606.13003](https://arxiv.org/abs/2606.13003), v2 2026-06-13). MEASURED:
"automatic MAS consistently underperform CoT-SC despite being up to 10× more
expensive." On SWE-Bench Lite (168 sampled) with GPT-5, plain **chain-of-thought
with 5-sample self-consistency scored 57.09%**, beating DyLAN (55.97%), MAS-Zero
(45.52%), AFlow (39.05%), MaAS (32.71%) and ADAS (27.23%). Diagnosed bloat:
agents reach immediate unanimous consensus in **>90% of GPT-5 cases** (i.e. they
function as an expensive ensemble), and 50% of AFlow's learned workflows
degenerate into running one prompt three times. ⚠️ **Scope it correctly** — the
indictment is of *automatically generated* topologies; the authors' own
hand-designed Expert-MAS reached 96.51% against CoT-SC's 56.97% on a structured
diagnostic set. **Decomposition is not the problem; unprincipled decomposition
is.**

**"Why Do Multi-Agent LLM Systems Fail?" (MAST)**
([arXiv:2503.13657](https://arxiv.org/abs/2503.13657), Berkeley; **cite v3,
2025-10-26**). 1,642 annotated traces across 7 systems, Cohen's κ = 0.88.
MEASURED failure distribution: **Specification & System Design 43.9%**,
Inter-Agent Misalignment 32.15%, Verification & Termination 23.5%. ⚠️ Two traps:
the widely-repeated "inter-agent misalignment is the top failure mode" is **v1
only and now stale**, and **MAST contains no token or cost accounting at all** —
it explains why coordination fails, not what it costs. Its interventions on
ChatDev/ProgramDev: baseline 25.0% → improved role specification 34.4% → new
topology plus verification 40.6%.

The distribution is itself the lesson. **The largest failure category is
specification and system design — the brief, the roles, the task cut — not the
agents talking to each other.** That is squarely Crosstalk's leader-and-brief
surface, and it is where CONTEXT.md's "brief contradiction was named" score is
already pointing.

### 2.6 Parallel coding agents with verifier gates — an existence proof

**Philippov, Katunin, Andreev, Ostanin, Nikolaev — "Glite ARF: Verifier-Driven
Research with Parallel LLM Coding Agents", [arXiv:2606.27416](https://arxiv.org/abs/2606.27416), 2026-06-25.** *(preprint)*
**Up to twelve parallel agents** (Claude and Codex CLI) with deterministic Python
verifier scripts enforcing task isolation, immutability of completed work, and a
materialised project overview; each task in its own git worktree/branch.

MEASURED: 273 tracked tasks / 146 experiment runs / 129 feature sets; **~$450 in
LLM API spend** ($498 total third-party); **structural overhead ~1% of wall-clock
time**; **no merge conflict reached main**; baseline RMSE reduced 29.9% (closed
track) and 35.9% (open track), placing first and second in a shared task. The
verifier caught and stripped **four target-leaking feature sets**.

Important limitation: **there is no single-agent baseline.** It proves twelve
agents can be coordinated cheaply with verifier gates and worktree isolation; it
does not prove twelve beat one.

### 2.7 Equal-budget comparisons, and the coordination-overhead literature

**Tran & Kiela (Stanford) — "Single-Agent LLMs Outperform Multi-Agent Systems on
Multi-Hop Reasoning Under Equal Thinking Token Budgets", [arXiv:2604.02460](https://arxiv.org/html/2604.02460v1), 2026-04-02.** *(preprint)*
Holds the *global thinking-token budget* B equal across single- and multi-agent
systems. Models: Qwen3-30B-A3B, DeepSeek-R1-Distill-Llama-70B, Gemini-2.5-Flash,
Gemini-2.5-Pro. Benchmarks: FRAMES, MuSiQue (4-hop). MEASURED samples —
Qwen3-30B on FRAMES @1000 tokens: SAS **0.252** vs sequential MAS 0.225;
DeepSeek-R1-70B on MuSiQue-4hop @1000: SAS **0.407** vs 0.320; Gemini-2.5-Pro on
FRAMES @5000: SAS **0.700** vs 0.680. Finding: single-agent consistently matched
or exceeded multi-agent at equal reasoning tokens. **Caveat: this is multi-hop QA,
not coding** — it is evidence about the general mechanism, not about repo work.

Weaker supporting material, recorded with its weakness stated:

- **"Token Coherence: Adapting MESI Cache Protocols…", [arXiv:2603.15183](https://arxiv.org/abs/2603.15183), 2026-03-16** *(preprint, single
  author)*. Models naive broadcast synchronisation as **O(n × S × |D|)** in
  agents, steps and artifact size, reduced to **O((n + W) × |D|)**; reports 81–95%
  token savings across configurations. **No named tasks or benchmarks** — this is
  simulation, not measurement on real workloads. Use the *scaling shape* as
  intuition, not the savings numbers as evidence.
- **"Token Economics for LLM Agents", [arXiv:2605.09104](https://arxiv.org/abs/2605.09104), 2026-05-09** is a **survey**, not an
  experiment. Useful only as an index into the papers above.

---

### 2.8 Critic and verifier loops — the one pattern that survives scrutiny

This is where the positive evidence for a second agent is strongest, and it is
also more conditional than it first looks.

**The direct experiment.** *"Cross-Model LLM Code Review: Should you use Claude
to review Codex or vice versa?"*
([arXiv:2607.21656](https://arxiv.org/abs/2607.21656), 2026-07-22) *(preprint)*.
Claude Opus 4.7 (Claude Code 2.1.50) and Codex GPT-5.5, both at high reasoning,
on LiveCodeBench hard+medium post-cutoff problems. **n = 116, single trial per
condition.** The reviewer gets **fresh context** and **cannot execute tests**.
MEASURED:

| Condition | Pass rate | Δ vs writer solo | $/task | Regressions |
|---|---|---|---|---|
| Claude solo | 91.4% | — | $0.226 | — |
| Codex solo | 71.6% | — | $0.190 | — |
| **Codex → Claude review** | 89.7% | **+18.1 pp** | $0.443 | 4.3% |
| **Codex → Codex self-review** | 84.5% | **+12.9 pp** | $0.312 | 5.2% |
| **Claude → Claude self-review** | 91.4% | **+0.0 pp** | $0.389 | 2.6% |
| **Claude → Codex review** | 82.8% | **−8.6 pp** | $0.382 | **11.2%** |

Four things this establishes, and they are the whole argument for a reviewer seat:

1. **A separate, stronger critic beats same-model self-review** — +18.1 vs +12.9.
2. **Same-model self-review on the frontier model did literally nothing**:
   91.4% → 91.4%, for **+$0.163 per task and +49.6 seconds**. A 2026-model
   replication of the 2023 self-correction null result, on code, against
   correctness.
3. **A weaker separate critic actively harms** — −8.6 points with an **11.2%
   regression rate**. A critic seat is a two-sided bet on relative capability,
   not free insurance.
4. **The review pass roughly doubles cost.**

The authors' own rule: "the useful pairing is asymmetric: use Claude to review
Codex, not the other way around… If Claude Opus 4.7 writes the draft, skip
review." ⚠️ n=116, single trial, one model pair, self-contained functions rather
than repo-scale work, reviewer cannot run tests. The authors call it "a first
controlled diagnostic."

**Structured disagreement, not mere separation, is what pays.** *Adversarial
Review* ([arXiv:2608.18167](https://arxiv.org/abs/2608.18167), 2026-08-16) runs
all agents as Claude Sonnet 4.5. MEASURED: **SWE-bench Verified 75.2% vs 71.6%
zero-shot — +3.6 points for ~4.5× the tokens**; LiveCodeBench 87% vs 77%. Two
findings underneath the headline matter more:

- On LiveCodeBench, **Self-Refine (77%) and a single separate reviewer (77%)
  tied.** Their explanation: "the critic and the generator are the same model
  making the same mistakes." **Moving the critic to a separate call bought
  nothing.** The gain came from forcing structure.
- A named, measured failure mode: **false consensus** — "When two LLM agents are
  asked to agree on a joint output, they tend to agree with each other. They do
  not always find the truth." Naive adversarial review *underperformed* (0.457
  F1 on SWE-PRBench) until the critic was constrained to choose among
  **AGREE / DISAGREE_EVIDENCE (with code citation) / DISAGREE_CONCERN**.

**That constraint is, structurally, Crosstalk's contest schema.** It is the
closest thing in the literature to independent support for requiring a falsifier
and counter-evidence rather than free-text disagreement.

**Spend the budget on generation, not criticism.** Olausson, Inala, Wang, Gao,
Solar-Lezama, *"Is Self-Repair a Silver Bullet for Code Generation?"*
([arXiv:2306.09896](https://arxiv.org/abs/2306.09896), ICLR 2024) — the only
paper here that builds token cost into its primary metric, `pass@t` at
`t = E[num_tokens]`, explicitly "because standard pass@k risks overemphasizing
the benefits of self-repair." MEASURED, GPT-4 on APPS: **10 initial samples × 1
repair each → 1.05× pass@20; 2 initial samples × 10 repairs each → 0.97×, worse
than not repairing at all.** Their conclusion: "the most important factor… is the
diversity of the base samples generated up-front, rather than the diversity of
repairs sampled." With *human* feedback substituted for self-critique, repair
success went **33.3% → 52.6%**. Self-critique is the bottleneck.

**What actually scales on code is a verifier, not agents.** *Large Language
Monkeys* ([arXiv:2407.21787](https://arxiv.org/abs/2407.21787), Stanford/Oxford/
GDM) MEASURED DeepSeek-Coder-V2-Instruct on SWE-bench Lite going **15.9% at 1
sample → 56% at 250 samples**, and 5 cheap samples at **29.62% for $10.80 total**
beating one Claude 3.5 Sonnet sample at 26.70% for $51. But the decisive caveat:
on MATH with 10,000 samples, oracle coverage was **98.44%** while majority voting
reached **41.41%** — a 57-point gap that selection never closes, and voting
saturates after ~100 samples. AlphaCode's ablation makes the same point: without
execution filtering the sampling curve is **flat**. **Coding's advantage over
research is that it has a cheap automatic verifier — the test suite. That is the
asset to exploit, and it is not an agent.**

### 2.9 Why the multiplier is structural, not a prompting problem

**Xu et al., "Rethinking the Value of Multi-Agent Workflow: A Strong Single Agent
Baseline"** ([arXiv:2601.12307](https://arxiv.org/abs/2601.12307), 2026-01-18)
*(preprint)*. Executor GPT-4o-mini. MEASURED: HumanEval AFlow (multi-agent)
90.1% vs OneFlow (single-agent) **92.1%**; MBPP 78.8% vs **81.4%**. Cost on
HumanEval: **AFlow $0.198 ± 0.003 vs OneFlow $0.020 ± 0.000 — 10× cheaper at
equal-or-better accuracy.**

The mechanism is the answer to "what makes multi-agent token-inefficient": a
single agent in a multi-turn conversation **reuses the KV / prefix cache across
turns**. Splitting the same work across agents means each agent re-reads its
context cold. **Multi-agent architectures forfeit cache reuse, and that is a
structural cost, not something prompt engineering removes.** It compounds with
Tokenomics' finding that input tokens are 53.9% of the bill and Bai et al.'s that
input dominates cost — the duplicated half is exactly the half you pay for.

**And a noise floor for every small delta above.** *"How Much Coordination Gain
Is Real? A Paired Noise-Floor Protocol"*
([arXiv:2606.20695](https://arxiv.org/abs/2606.20695), 2026-06) *(preprint)*.
Claude Haiku 4.5 on τ²-bench retail, two n=100 seeds. MEASURED:
configuration-equivalent protocols — both inert at trial 0 — produced signed
paired gaps of **+10pp and 0pp**; the largest single-seed contrast (**+18pp,
p=0.012**) **did not reproduce at the second seed (−3pp, p=1.0)**. Envelope
**[−3, +18]pp**. Their conclusion:

> **"Seven of ten recent multi-agent coordination architectures report headline
> effects below this local floor."**

Apply this symmetrically. It undercuts icat-agent's +3.6 on SWE-bench Verified
and Adversarial Review's +3.6, as much as it undercuts anyone's claim that teams
help. It does **not** undercut Co-Coder's +11.3, Cross-Model Review's +18.1, or
the Nature MI −14.9%.

---

## 3. Decision 1 — which benchmark to run Crosstalk on first

**Run Terminal-Bench 4.0 locally via Harbor, with a Crosstalk agent adapter.**

First, the constraint that shapes this: **you cannot post a score to the TB 4.0
leaderboard** — community submissions are closed and only maintainer runs are
listed. That turns out not to matter, and here is why. What Crosstalk needs is
not a leaderboard slot; it is a **credible solo baseline on the same tasks, the
same model and the same accounting**, so the team-vs-solo comparison is not
self-graded. TB 4.0 hands you exactly that: **Opus 5 + Claude Code, 51.8% ± 3.4%,
6.5B tokens, $6.0k, over 330 maintainer-run trials.** Run Crosstalk on the same
66 tasks with the same model and you have a controlled A/B against a published,
audited, cost-accounted number. That is a far better experiment than beacon-1's
self-instrumented three cells.

Reasons, in order of weight:

1. **The solo baseline you need already exists, measured properly** — 5 trials
   per task, 95% CIs, mandatory token and dollar accounting, and an LLM
   trajectory judge auditing every passing trial for reward hacking.
2. **The scaffold seam is a first-class interface.** `BaseAgent` or
   `BaseInstalledAgent`, no Harbor source changes. Apache-2.0 for code *and* task
   data — the only benchmark surveyed with a clean licence on both. And **ATIF,
   the mandatory trajectory format, explicitly supports "multi-agent systems:
   subagent delegation and hierarchical architectures"** — Crosstalk's shape is
   anticipated by the format.
3. **Headroom is real**: 51.8%, roughly 48 points open.
4. **The horizon finally matches the product.** Median **4.0 expert-hours**,
   mean 6.54, with an 8-hour agent timeout. Crosstalk is built for a two-hour
   box on multi-agent work; TB 1.0's five-minute tasks were meaningless for that,
   and TB 4.0's are not.
5. **It is one of the two benchmarks Nature MI actually measured**, so the prior
   is quantified: single-agent baseline 0.344 — **below the 0.45 ceiling** — and
   Independent coordination measured **+1.7%**, the only non-negative multi-agent
   result in that study. A narrow, honest target: a win is meaningful, a loss is
   informative.
6. It is neither contaminated-and-retired nor audited-as-30%-broken.

⚠️ **Set expectations honestly.** Only **~23% of TB 4.0 tasks (15 of 66) have
real parallel surfaces** — `nextjs-performance`'s six independent routes is the
archetype; `wal-recovery-ordering`'s interlocking LSN invariants is the
anti-archetype. **Report the split.** A team result averaged over 66 tasks will
be diluted by the ~51 that are coordination-hostile, and the honest headline is
the per-stratum result, not the mean. If the parallel-surface subset shows a gain
and the rest shows a loss, that is a *better* finding than a wash — it tells you
what Crosstalk is for.

**Second choice, if you want a public number: SWE-rebench.** It is the only open
leaderboard publishing **`Cost per Problem ($)` and `Tokens per Problem`**, on a
rolling monthly decontaminated window, with ~35 points of headroom (top 64.5%).
You can actually submit. Its weakness for Crosstalk is task shape — SWE-bench-like
patches with weak parallel surfaces.

**Third, and the one to reach for if the TB 4.0 result is ambiguous: Commit0.**
It has by far the strongest decomposition story in the survey — **48 to 1,300+
independent function stubs per library**, a dependency DAG the reference agent
already topologically sorts, per-file and per-test incremental scoring built into
the CLI, MIT-licensed, and enormous headroom (best published agent **15.08%** on
the full set). Its leaderboard is dead (last entry 2024-11-26), so you would be
generating your own solo baseline — but the *task shape* is the closest match to
Crosstalk's thesis of anything surveyed, and it is already a component of the
OpenHands Index if you want external corroboration.

**Also worth knowing.** **MLE-bench** is the one benchmark where multi-agent
decomposition *demonstrably* wins (leaderboard dominated by multi-agent systems,
~4× over single-scaffold baselines) — because ensembling is a genuine join step.
If the goal were to show a team winning, that is where it happens. But it is ML
engineering, not software engineering, its submissions are frozen, and the win
may not transfer. **SW-A²-Bench** ships oracle subtask decompositions and is worth
an inspection.

**Do not run SWE-bench Verified** (§1.3), and **do not run SWE-bench Pro**
without accounting for the ~30% broken rate.

**Consider Claw-SWE-Bench as an internal diagnostic**, not a headline: it is
built to isolate the harness contribution (**27.4 points** from harness choice
alone), which is the exact quantity Crosstalk claims to move.

**Three methodology notes that apply to all of them.**

- **Multi-seed or it did not happen.** Bai et al. measured **up to 30×
  run-to-run token variance on the same task**; the noise-floor protocol found
  inert configurations producing paired gaps across **[−3, +18]pp**, with a
  p=0.012 result failing to replicate on a second seed. Beacon-1 was one run per
  cell. TB 4.0's own baselines use **5 trials per task with 95% CIs** — match
  that or the comparison is not admissible.
- **Publish cost even when it is unflattering.** §1.4: nobody publishes cost for
  a multi-agent system, which is exactly why nobody believes their scores.
- **Guard against reward hacking explicitly.** Terminal-Bench's open board had
  entrants shipping **encrypted solutions inside the agent binary**, uploading
  the `tests/` folder, and curling solutions into `AGENTS.md`; MLE-bench demoted
  two entries for test-set feedback; METR found **≥16% of successful runs on >8h
  tasks were illegitimate on review**. Crosstalk's `vacuousGreenWin` guard is the
  right instinct and needs to survive contact with a real benchmark.

---

## 4. Decision 2 — what a team must do differently to beat a solo model

Synthesised from the measured sources above. Each item names its evidence.

**1. Pick tasks below the ~45% single-agent ceiling.** This is the single
strongest rule in the literature (Nature MI, 260 configs, 94% predictive on
SWE-bench Verified + Terminal-Bench). Above it, coordination is measured as
net-negative in every architecture tested. The icat-agent table shows the same
law from the other side: +3.6 points where the baseline was 75.8%, +18.5 points
where it was 43.7%. **Corollary for Crosstalk's own bench: the beacon/leeward/
quorum fixtures are tasks a solo frontier model completes gate-green. That is
above the ceiling by construction, and the literature predicts solo wins. The
fixture must get harder before a team result is interpretable.**

**2. Consider keeping writes single-threaded and adding agents for judgement,
not typing.** This is the sharpest reversal in the literature and it is aimed
directly at Crosstalk's seat model. Cognition, after a year in production:
**"Multi-agent systems work best today when writes stay single-threaded and the
additional agents contribute intelligence."** Co-Coder measured off-the-shelf
**Claude Code Agent Teams losing to a single sequential agent on both
benchmarks** (54.1% vs 56.8%; 16.3% vs 20.1%). The seven-framework study on one
backend model put multi-agent OWL and AgentOrchestra at **10% and 3%** against
single-agent systems at ~50%. Crosstalk's current design puts multiple
**Builders** on the work — the configuration with the worst measured record. The
configuration with the best record is one builder plus a reviewer in clean
context, which is also what beacon-1's teams actually delivered value through.

**3. If you do fan out, cut along the dependency graph — not by file, not by
feature.** Co-Coder is unambiguous: dependency-aware partitioning won on
accuracy, cost *and* latency simultaneously (68.1% at $0.18 vs sequential 56.8%
at $0.25), while **naive file-based parallelism "inflates API cost by 60%" for no
quality gain**. The stated condition: "The advantage of cohesion-aware
partitioning grows with the density of inter-file coupling"; on loosely-coupled
projects everything tied. Anthropic's C compiler run shows the same thing from
the other end — 16 agents were *useless* on the Linux kernel until a GCC oracle
bisected one giant task into independent per-file failures. **Crosstalk's leader
"cuts tasks" (CONTEXT.md). The quality of that cut is the entire product.**

**4. Treat specification, not chatter, as the main failure surface.** MAST v3,
1,642 annotated traces across 7 systems: **Specification & System Design 43.9%**,
Inter-Agent Misalignment 32.15%, Verification & Termination 23.5%. The largest
category is the brief and the role definitions — not the protocol between agents.
Crosstalk's two task gates (restate the brief; self-critique before submit) are
aimed at the right target; the court is aimed at the second-largest.

**5. Put a verification gate between fan-out and integration.** MEASURED:
Independent (ungated) architectures amplify trace-level errors **17.2×**;
Centralized coordination with validation bottlenecks contains it to **4.4×**.
This is the strongest empirical justification for Crosstalk's court — but note
the mechanism credited is a *validation bottleneck before aggregation*, i.e. a
gate on merge, not a debate in a channel.

**6. Make the critic at least as strong as the writer, and force it to disagree
in a structured way.** Cross-Model Review MEASURED **+18.1 points** for a
stronger separate critic, **+0.0** for same-model self-review on the frontier
model, and **−8.6 points with an 11.2% regression rate** for a weaker critic —
each at roughly double the cost. Adversarial Review found a plain separate
reviewer tied with same-context self-refinement (77% vs 77%), and only gained
once the critic was constrained to **AGREE / DISAGREE_EVIDENCE (with code
citation) / DISAGREE_CONCERN** — because "when two LLM agents are asked to agree
on a joint output, they tend to agree with each other." **Two consequences for
Crosstalk.** First, the falsifier-and-counter-evidence schema is the right
mechanism and has independent support. Second, a mixed-vendor roster is not
automatically safe: a reviewer weaker than the writer measurably makes the code
worse, so seat assignment must consider relative model strength, not just
diversity.

**7. Pass structured evidence, not shared context.** icat-agent's three parallel
agents communicate by "synchronous, event-based message passing with structured
payloads" — the Validator shares only pass/fail, never the reproduction tests;
the Patch Editor never sees the generated test code — and the authors argue this
deliberate **isolation** prevents context poisoning. Note this directly
contradicts Cognition's 2025 Principle 1 ("share full agent traces"), and is the
most interesting open disagreement in the literature. Crosstalk's append-only
board with compact `inbox` reads sits on the isolation side; the risk is agents
re-reading the whole log and re-importing the cost.

**8. Gate the expensive phase, which is review — not setup.** Tokenomics
measures **59.4% of tokens in iterative code review** against a stage-level
minority in generation, on a GPT-5 backend. Crosstalk currently instruments
`ceremonyTokensBeforeFirstEdit`. That is the cheap end. The metric that would
have explained beacon-1's 894k is **tokens spent in review and rework after the
first edit**. Recommend adding it to `CellResult`.

**9. Route, don't always fan out.** icat-agent's ablation: forcing the Explorer
on well-specified issues cost **18–24% of cost-effectiveness for minimal gain**.
The economical design spends the extra agent only when a cheap classifier says
the task needs it. A team that always convenes is a team that always costs 2–3×.
Cognition's own scaling rule is the same instinct: "simple fact-finding requires
just 1 agent."

**10. Spend the marginal token on generation, not on criticism.** Olausson et
al., matched-budget: **10 samples × 1 repair → 1.05×; 2 samples × 10 repairs →
0.97×, worse than not repairing at all.** And the deeper point from Large
Language Monkeys and AlphaCode — what makes extra compute pay on code is a
**cheap automatic verifier** (the test suite), not more conversation. Without
execution filtering, AlphaCode's sampling curve is flat; with 10,000 samples on
MATH, oracle coverage hit 98.44% while majority voting reached 41.41%. **The
asset Crosstalk should be exploiting is the repo's test suite, and its
`discriminating_test` ladder rung is the right primitive — arguably it should be
the first move, not a rung reached after argument.**

**11. Give the team a stopping rule.** Anthropic's harness needed an explicit
`--fast` sampling default because "Claude can't tell time and, left alone, will
happily spend hours running tests." Beacon-1's own memory note records ct-opus
polishing **40 minutes past team agreement**. Nature MI's efficiency table is
successes per 1k tokens — an agent that keeps going after the job is done is pure
denominator.

**12. Budget for the multiplier, and know that part of it is structural.**
First-party Anthropic figures: agents ~**4×** chat tokens, multi-agent ~**15×**.
Nature MI: the best multi-agent architecture delivers **42.4 successes/1k tokens
against single-agent's 67.7**. And the mechanism is not all avoidable —
**splitting work across agents forfeits KV/prefix cache reuse**, which is most of
why OneFlow was 10× cheaper than AFlow at equal accuracy. Since input tokens are
53.9% of the agentic bill (Tokenomics) and input dominates cost (Bai et al.), the
duplicated half is exactly the half you pay for. A team that merely matches solo
quality at 2.7× the tokens — beacon-1 — is the modal outcome, not a bug. The
claim Crosstalk needs to support is not "the team is better" but "**the team is
better per token, on a task class where solo demonstrably plateaus.**"

**13. Do not believe your own small deltas.** Two independent methodological
warnings. Bai et al.: **up to 30× run-to-run token variance on the same task**.
The noise-floor protocol: configuration-equivalent (inert) protocols produced
paired gaps spanning **[−3, +18]pp**, and a +18pp result significant at p=0.012
failed to reproduce on a second seed — leading to "seven of ten recent
multi-agent coordination architectures report headline effects below this local
floor." **Beacon-1 was one run per cell.** Multi-seed replication is not
optional; it is the difference between a finding and an anecdote.

---

## 5. What I could not establish

**The most important gap, because it is a gap in the field and not in this
note:** *no published paper measures cost-per-solved-task for a matched
single-agent vs multi-agent pair on SWE-bench Verified at frontier scale.* The
closest are the seven-framework study (DeepSeek-v3.1, SWE-bench **Lite**) and the
Illusion paper (GPT-5, SWE-bench **Lite**). **The exact experiment Crosstalk
wants to cite does not exist — which is also the opportunity.**

Related: **no controlled experiment isolates "different context" from "different
model" for critics.** Cross-Model Review varies the *model* across contexts; CTRL
varies critic *training*. Nobody holds weights fixed and varies only
fresh-context vs same-context. Adversarial Review's tie (Self-Refine 77% = single
separate reviewer 77%) is suggestive that separation alone buys little, but it is
not the clean experiment.

Everything else, itemised:

- **Wall-clock time per task** for SWE-bench (any variant), SWE-bench Pro,
  Commit0, SWE-bench-Live and SWE-rebench. None publishes it. Human *estimates*
  exist for Terminal-Bench, MLE-bench and METR; agent wall-clock largely does not.
- **Human completion times for SWE-bench Pro.** Its "hours to days" horizon is an
  assertion — no timing study or human baseline exists.
- **Task-data licences.** `SWE-bench`, `SWE-bench_Verified`,
  `SWE-bench_Multimodal`, `ScaleAI/SWE-bench_Pro` and `princeton-nlp/SWE-bench_Multimodal`
  **all declare no licence**. `SWE-bench/experiments` has no LICENSE file.
  `METR/eval-analysis-public` has none either, and `METR/public-tasks` (MIT)
  covers only ~11 of the 228 task families.
- **SWE-bench Multimodal's task count** — 617 / 619 / 517 / 510 / 480 all appear
  across official sources, the leaderboard scores against a **517 denominator no
  downloadable artifact matches**, and no changelog explains the full drift.
- **Why SWE-bench Pro's paper statistics do not reproduce** against its own
  released public set (paper: 107.4 lines / 4.1 files; recomputed: 169.58 / 5.07),
  or what Scale's unresolved 2026-05-18 "issues with the leaderboard" are. Its
  claim that "all tasks involve multiple files" is false for 14.4% of the set.
- **Absolute RE-Bench normalized scores** at the 2h / 8h / 32h budgets — only the
  4× / ~1× / 2× ratios are in prose; the values live in a figure. And the size of
  METR's held-out RE-Bench environments is confirmed to exist but never
  quantified.
- **GDPval's per-task human-hour distribution** — the open 220-row gold set has no
  hours field; only the 7-hour average is published, and win/tie percentages are
  in a bar chart rather than text.
- **SW-A²-Bench, CRUX-1, Vending-Bench 2, LiveCodeBench Pro** — flagged but not
  verified to primary-source depth (JS-only sites or blocked fetches). SW-A²-Bench
  in particular deserves a follow-up given its oracle subtask decompositions.
- **Whether any leaderboard has ever listed a genuinely multi-agent *team* entry**
  — several independently-driven agents collaborating, as opposed to one operator
  driving a multi-agent scaffold. Terminal-Bench 2.0 has "Multiple"-model entries
  but they are self-reported scaffolds. **Crosstalk would be establishing the
  category, not joining it.**
- **AgentTaxo's token-duplication figures** could not be verified at source
  (Cloudflare-gated) and **should not be cited**; the 2:1–3:1 ratio here is
  second-hand.
- **The 8.6% code-generation share** attributed to Tokenomics circulates in
  secondary summaries but is not in the abstract; only 59.4% (review) and 53.9%
  (input) are confirmed at source.
- **What the field adopted after OpenAI's July 2026 retraction.** No primary
  source establishes a consensus replacement. The honest answer is that there is
  not one yet — which is why §1.4's ranking is by accounting quality rather than
  by adoption.
- **Verbatim text of OpenAI's original SWE-bench Verified announcement** —
  openai.com returns HTTP 403 to automated fetching for that page (the two 2026
  audit posts were readable in-browser and are quoted directly).

---

## 6. Source index

**First-party lab publications**
- OpenAI, [Why SWE-bench Verified no longer measures frontier coding capabilities](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/), 2026-02-23
- OpenAI, [Separating signal from noise in coding evaluations](https://openai.com/index/separating-signal-from-noise-coding-evaluations/), 2026-07-08
- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), 2025-06-13
- Anthropic / Nicholas Carlini, [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler), 2026-02-05
- Cognition / Walden Yan, [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents), 2025-06-12
- Cognition / Walden Yan, [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working), **2026-04-22** — supersedes the above

**Peer-reviewed**
- Kim et al., [Capable language models can outgrow the benefits of collaboration](https://www.nature.com/articles/s42256-026-01268-y), *Nature Machine Intelligence* 8:1157–1172, 2026-07-24. Preprint: [arXiv:2512.08296](https://arxiv.org/abs/2512.08296)
- AgentTaxo, [OpenReview 0iLbiYYIpC](https://openreview.net/forum?id=0iLbiYYIpC), ICML 2025

**Also peer-reviewed / venue-accepted**
- [arXiv:2306.09896](https://arxiv.org/abs/2306.09896) Is Self-Repair a Silver Bullet for Code Generation? — ICLR 2024
- [arXiv:2310.01798](https://arxiv.org/abs/2310.01798) LLMs Cannot Self-Correct Reasoning Yet — ICLR 2024
- [arXiv:2407.21787](https://arxiv.org/abs/2407.21787) Large Language Monkeys
- [arXiv:2410.07095](https://arxiv.org/abs/2410.07095) MLE-bench — ICLR 2025
- [arXiv:2410.03859](https://arxiv.org/abs/2410.03859) SWE-bench Multimodal — ICLR 2025
- [arXiv:2412.01769](https://arxiv.org/abs/2412.01769) Commit0
- [arXiv:2411.15114](https://arxiv.org/abs/2411.15114) METR RE-Bench
- [arXiv:2602.23866](https://arxiv.org/abs/2602.23866) SWE-rebench V2 — ICML 2026
- [OpenReview a7Qa4CcHak](https://openreview.net/forum?id=a7Qa4CcHak) Terminal-Bench — ICLR 2026
- [arXiv:2601.14470](https://arxiv.org/abs/2601.14470) Tokenomics — MSR 2026
- [arXiv:2608.09802](https://arxiv.org/abs/2608.09802) SWE-Bench ProMax — COLM 2026

**Preprints (2026, unreplicated)**
- [arXiv:2606.25514](https://arxiv.org/abs/2606.25514) icat-agent, 2026-06-24
- [arXiv:2606.27416](https://arxiv.org/abs/2606.27416) Glite ARF, 2026-06-25
- [arXiv:2606.17799](https://arxiv.org/abs/2606.17799) Position: Coding Benchmarks Are Misaligned with Agentic SE, 2026-06-16 (rev. 07-18)
- [arXiv:2606.12344](https://arxiv.org/abs/2606.12344) Claw-SWE-Bench, 2026-06-10
- [arXiv:2605.14415](https://arxiv.org/abs/2605.14415) SWE-Chain, 2026-05-14
- [arXiv:2604.22750](https://arxiv.org/abs/2604.22750) How Do AI Agents Spend Your Money?, 2026-04-24
- [arXiv:2604.02460](https://arxiv.org/html/2604.02460v1) Single-Agent LLMs Outperform MAS Under Equal Thinking Token Budgets, 2026-04-02
- [arXiv:2603.15183](https://arxiv.org/abs/2603.15183) Token Coherence, 2026-03-16 (simulation only)
- [arXiv:2601.14470](https://arxiv.org/abs/2601.14470) Tokenomics, 2026-01-20
- [arXiv:2605.09104](https://arxiv.org/abs/2605.09104) Token Economics (survey), 2026-05-09
- [arXiv:2606.00953](https://arxiv.org/abs/2606.00953) Co-Coder / When Parallelism Pays Off, 2026-05-31
- [arXiv:2606.13003](https://arxiv.org/abs/2606.13003) The Illusion of Multi-Agent Advantage, 2026-06-13
- [arXiv:2601.12307](https://arxiv.org/abs/2601.12307) OneFlow / Rethinking the Value of Multi-Agent Workflow, 2026-01-18
- [arXiv:2607.21656](https://arxiv.org/abs/2607.21656) Cross-Model LLM Code Review, 2026-07-22
- [arXiv:2608.18167](https://arxiv.org/abs/2608.18167) Adversarial Review, 2026-08-16
- [arXiv:2606.20695](https://arxiv.org/abs/2606.20695) Paired Noise-Floor Protocol, 2026-06
- [arXiv:2604.17400](https://arxiv.org/abs/2604.17400) Phase-Scheduled Multi-Agent Systems, 2026-04-19
- [arXiv:2605.23950](https://arxiv.org/abs/2605.23950) Stop Comparing LLM Agents Without Disclosing the Harness, 2026-05-07
- [arXiv:2511.00872](https://arxiv.org/abs/2511.00872) Seven agent frameworks on one backend model, 2025-11-02
- [arXiv:2503.13657](https://arxiv.org/abs/2503.13657) MAST — **cite v3, 2025-10-26**
- [arXiv:2407.01489](https://arxiv.org/abs/2407.01489) Agentless, 2024

**Leaderboards and harnesses** (all read 2026-08-30)
- [Terminal-Bench leaderboard](https://www.tbench.ai/leaderboard) · [Harbor Hub](https://hub.harborframework.com) · repo `harbor-framework/terminal-bench` (Apache-2.0; the old `laude-institute/terminal-bench` path is now `terminal-bench-1`)
- [Scale SEAL SWE-bench Pro public](https://labs.scale.com/leaderboard/swe_bench_pro_public)
- [Vals AI SWE-bench Verified](https://www.vals.ai/benchmarks/swebench)
- [Artificial Analysis Coding Agent Index methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking)
- [OpenHands Index](https://www.openhands.dev/blog/introducing-the-openhands-index), 2026-01-29
- [Commit0](https://commit-0.github.io/)
- [SWE-rebench](https://swe-rebench.com/) — the only open board with `Cost per Problem ($)` and `Tokens per Problem`
- [Epoch AI SWE-bench Verified](https://epoch.ai/benchmarks/swe-bench-verified) — independent runs, public logs, error bars, no cost data
- [Harbor-Index 1.0](https://harbor-index.org/) (2026-07-07) · [Terminal-Bench continuous versioning](https://www.tbench.ai/news/continuous-benchmarks) (2026-07-30) · [leaderboard integrity update](https://www.tbench.ai/news/leaderboard-integrity-update) (2026-04-19)
- [Aider LLM leaderboards](https://aider.chat/docs/leaderboards/) (page says last updated 2025-11-20; leaderboard YAML last modified 2025-10-04; zero 2026 entries)
- [METR task-completion time horizons](https://metr.org/time-horizons/) (data 2026-05-08) · [Time Horizon 1.1](https://metr.org/blog/2026-1-29-time-horizon-1-1/) (2026-01-29)

**Also relevant, one line each**

*Position: Coding Benchmarks Are Misaligned with Agentic Software Engineering*
(Gorinova, Baker, Heineike, Shaposhnikov, Willoughby, Knox; 2026-06-16, rev.
2026-07-18) argues benchmark scores "conflate the model with the rest of the
harness", that grading against a single reference solution "penalises equally
valid alternatives", and that the absence of component-level signal makes an
end-to-end score hard to iterate on. That is a direct argument for the
Claw-SWE-Bench style of measurement, and against reading a single resolve-rate
delta as evidence about a coordination layer.
