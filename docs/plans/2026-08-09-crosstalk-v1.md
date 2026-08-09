# Crosstalk v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the runnable spine of Crosstalk — an append-only protocol engine where a code-review finding is a contestable claim rather than a command, plus the daemon, transports, workspace management and hub UI needed to run three real agents against it.

**Architecture:** An append-only JSONL event log is the single source of truth. A pure projection folds events into state; validators enforce the protocol at the API boundary rather than in prompts. A loopback HTTP daemon is the sole writer and serves three client tiers (MCP, shell CLI, and the hub UI over SSE). Every layer above the log is replaceable and none of them hold state the log doesn't.

**Tech Stack:** TypeScript (ESM, `NodeNext`), Node ≥ 20, Vitest, React 18 + Vite for the hub UI, `@modelcontextprotocol/sdk`, `yaml`. Build via `tsc` for the library and `vite build` for the UI.

## Global Constraints

Every task's requirements implicitly include this section. Copied verbatim from the spec.

- **Node ≥ 20**, **git ≥ 2.5**. No other runtime prerequisites.
- **Runtime dependencies are capped at two:** `@modelcontextprotocol/sdk` and `yaml`. Everything else must be a `node:` built-in. Adding a third runtime dependency requires a claim against this plan, not a commit.
- **No native modules.** No `better-sqlite3`, no `node-pty`, no Python, no Docker. A native module breaks `npx` on the first Windows machine without build tools.
- **Ordering is by daemon-assigned `seq`, never by `ts`.** Wall-clock ordering across processes is not reliable and replay must be deterministic.
- **The log is append-only.** No code may rewrite, reorder or delete a line in `events.jsonl`. State corrections are new events.
- **Log lines are `\n`-terminated on every platform.** The log is opened in binary append mode so no newline translation occurs.
- **Paths go through `node:path`.** No manual separator handling. Worktree paths are stored repo-relative in config and resolved at runtime.
- **`falsifier` is required on every claim and every rebuttal.** A validator that permits an empty one is a defect, not a relaxation.
- **`uphold` requires new evidence.** Restating the original claim must be rejected at the API.
- **Tests must fail before they pass.** A task whose test passes on first run has not demonstrated anything; treat it as a red flag and fix the test.
- **Cross-platform CI matrix:** `windows-latest`, `macos-latest`, `ubuntu-latest`. A task is not done if it only passes on one.

---

## File Structure

Ownership is exclusive. A track that needs a file outside its column raises a claim against this plan rather than editing it.

| Path | Responsibility | Owner |
|---|---|---|
| `src/contracts/**` | Types, JSON schemas, error codes. **Frozen after Phase 0.** | Leader |
| `tests/fixtures/**` | Golden event logs. **Frozen after Phase 0.** | Leader |
| `src/core/log.ts` | Append-only JSONL read/write, seq assignment | Track A |
| `src/core/projection.ts` | Events → state, deterministic fold | Track A |
| `src/core/claims.ts` | Claim state machine + validators | Track A |
| `src/core/tasks.ts` | Task state machine + the two gates | Track A |
| `src/core/decisions.ts` | Decision resolution + ladder engine | Track A |
| `src/core/rooms.ts` | Room id parsing and membership | Track A |
| `src/ui/**` | The hub, built against fixture logs | Track B |
| `src/workspace/git.ts` | Worktree lifecycle, branches, SHA ancestry | Track C |
| `src/workspace/staleness.ts` | Evidence staleness evaluation | Track C |
| `src/harness/registry.ts` | Harness descriptors + probing | Track C |
| `src/harness/brief.ts` | Brief generation + versioning | Track C |
| `src/harness/doctor.ts` | Prerequisite and config checks | Track C |
| `src/daemon/**` | HTTP server, SSE, sole-writer lock | Phase D |
| `src/mcp/**` | Tier-1 MCP server | Phase D |
| `src/cli/**` | Tier-2 shell CLI | Phase D |

---

## Agent Operating Protocol

Three Codex Luna Max agents, three chats, three PRs. We run the Crosstalk protocol by hand while building it; every friction point is logged as a requirement.

**Per task, per agent:**

1. **Acknowledge** — restate the task brief in your own words and list every ambiguity or conflict you see *before* writing code. If the brief contradicts the spec or another task, say so now. This is a required first reply, not a formality — it is the cheapest place to catch a bad brief.
2. **Implement** TDD, in the step order given. Commit at each commit step.
3. **Self-critique — exactly one harsh round.** Run a critic subagent against your own diff. Close every finding you agree with, and record the ones you reject with your reason. Post the critique record on the PR.
4. **Hand off** to the leader with: branch, commit SHA, the critique record, and evidence for each acceptance criterion — command run, output, and the SHA it was run at.
5. **Leader critique — up to two rounds.** Every finding you receive is a *claim*, not an instruction. For each one: verify it against the code before acting. Then reply `accept` (fix + evidence), `contest` (why you built it that way + counter-evidence + what would show you wrong), or `clarify` (the brief is ambiguous). **Contesting a wrong finding is the correct behavior and costs you nothing.** Roughly one in five findings in the session that motivated this project were leader errors.

**Evidence standard, enforced on both sides.** State what you would have observed if you were wrong. Evidence that looks identical whether or not the feature works is not evidence. `errors: []` proves the code did not throw. A test that passes on an empty input set proves nothing about a populated one. Quote the command, the output, and the SHA.

**Merge order is the leader's.** Track A merges first when tasks touch shared ground; B and C rebase onto it and re-run their evidence, because a passing test at a SHA that is no longer an ancestor of `main` is stale by definition.

---

## Phase 0 — Contracts (Leader, before any track starts)

Everything downstream imports from `src/contracts/`. It is written once, frozen, and changed only by claim. Interface churn is the single biggest killer of parallel agent work, so this phase exists specifically to eliminate it.

### Task 0: Contracts and fixtures

**Files:**
- Create: `src/contracts/participant.ts`, `claim.ts`, `task.ts`, `decision.ts`, `events.ts`, `room.ts`, `errors.ts`, `index.ts`
- Create: `tests/fixtures/session-basic.jsonl`, `tests/fixtures/session-dispute.jsonl`
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing
- Produces: every type name used by Tracks A, B, C and Phase D. Exact names below are normative.

- [ ] **Step 1: Scaffold the package**

```json
{
  "name": "crosstalk-ai",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "crosstalk": "./dist/cli/index.js", "ct": "./dist/cli/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "yaml": "^2.4.0"
  }
}
```

`tsconfig.json` uses `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`, `"target": "ES2022"`, `"outDir": "dist"`.

- [ ] **Step 2: Write `src/contracts/participant.ts`**

```ts
export type ParticipantId = string;
export type Role = 'leader' | 'worker' | 'observer' | 'human';
export type Tier = 'mcp' | 'shell' | 'file';
export type Lifecycle = 'attached' | 'supervised';

export interface Participant {
  id: ParticipantId;
  role: Role;
  harness: string;
  /** A harness does not identify a model: several run on cursor-app and
   *  they do not behave alike. The ledger aggregates by this. */
  model?: string;
  lifecycle: Lifecycle;
  /** Repo-relative path to a git worktree. Never the repo root — that is
   *  the leader's checkout and no worker may occupy it. */
  workspace: string;
  transport?: Tier;
}

/** Ids become directory names: case-insensitive filesystems and MAX_PATH. */
export const PARTICIPANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
```

- [ ] **Step 3: Write `src/contracts/claim.ts`**

```ts
import type { ParticipantId } from './participant.js';

export type Severity = 'blocker' | 'defect' | 'risk' | 'nit';
export type ClaimState = 'open' | 'triaged' | 'contested' | 'clarify' | 'resolved';
export type ClaimResolution = 'upheld' | 'withdrawn' | 'amended' | 'superseded';
export type TriageVerdict = 'accept' | 'contest' | 'clarify';
export type ContestVerdict = 'concede' | 'amend' | 'uphold';
export type ClaimVerdict = TriageVerdict | ContestVerdict;

export interface Evidence {
  kind: 'command' | 'file' | 'observation';
  command?: string;
  output?: string;
  ref?: string;
  sha: string;
  by: ParticipantId;
  stale?: boolean;
}

export interface Claim {
  id: string;                                  // "C-118"
  raisedBy: ParticipantId;
  against: ParticipantId | 'brief' | 'spec';
  target: string;                              // "src/economy.ts:41"
  assertion: string;
  severity: Severity;
  falsifier: string;
  evidence: Evidence[];
  state: ClaimState;
  resolution?: ClaimResolution;
  rounds: number;
  taskId?: string;
  supersedes?: string;
}
```

- [ ] **Step 4: Write `src/contracts/task.ts`**

```ts
import type { ParticipantId } from './participant.js';
import type { Evidence } from './claim.js';

export type TaskState =
  | 'draft' | 'assigned' | 'acknowledged' | 'in_progress'
  | 'self_reviewed' | 'submitted' | 'under_review'
  | 'resolving' | 'accepted' | 'merged';

export interface CritiqueFinding { assertion: string; closedBy: Evidence[]; rejected?: string; }
export interface CritiqueRecord { rounds: number; findings: CritiqueFinding[]; critic: string; }
export interface Acknowledgement { restatement: string; ambiguities: string[]; }

export interface Task {
  id: string;                                  // "T-04"
  title: string;
  brief: string;
  specRefs: string[];
  assignee: ParticipantId;
  deps: string[];
  acceptance: string[];
  state: TaskState;
  branch: string;
  pr?: number;
  acknowledgement?: Acknowledgement;
  critique?: CritiqueRecord;
}
```

- [ ] **Step 5: Write `src/contracts/decision.ts`**

```ts
import type { ParticipantId } from './participant.js';

export type LadderRung = 'discriminating_test' | 'third_agent' | 'leader' | 'human' | 'vote';
export type DecisionMethod =
  | 'unanimous' | 'majority' | 'leader' | 'human' | 'discriminating_test' | 'ladder';

export const TERMINAL_RUNGS: readonly LadderRung[] = ['leader', 'human', 'vote'] as const;

export interface Rationale { by: ParticipantId; text: string; }

export interface Decision {
  id: string;                                  // "D-07"
  question: string;
  options: string[];
  voters: ParticipantId[];
  method: DecisionMethod;
  ladder?: LadderRung[];
  currentRung?: number;
  deadline?: string;
  outcome?: string;
  rationale: Rationale[];
  claimId?: string;
  votes: Record<ParticipantId, string>;
}
```

- [ ] **Step 6: Write `src/contracts/room.ts`**

```ts
export type RoomId = string;                   // '#floor' | 'dm:a~b' | 'task:T-04' | 'dispute:C-118'
export type RoomKind = 'floor' | 'dm' | 'task' | 'dispute';
export const FLOOR: RoomId = '#floor';
export const HUMAN_ID = '@human';
```

- [ ] **Step 7: Write `src/contracts/events.ts`**

```ts
import type { ParticipantId } from './participant.js';
import type { Claim, ClaimVerdict, Evidence } from './claim.js';
import type { Task, TaskState, CritiqueRecord, Acknowledgement } from './task.js';
import type { Decision } from './decision.js';
import type { RoomId } from './room.js';

export type EventKind =
  | 'participant_joined' | 'participant_left' | 'message'
  | 'task_created' | 'task_state' | 'brief_ack'
  | 'claim_raised' | 'claim_response' | 'evidence_added' | 'evidence_stale'
  | 'rebase_notice' | 'decision_opened' | 'vote_cast' | 'decision_resolved'
  | 'brief_updated';

export interface EventBase { seq: number; ts: string; from: ParticipantId; room?: RoomId; }

export type CrosstalkEvent =
  // Carries the whole Participant: the roster must be derivable from the
  // log alone, or a replaying agent learns `codex-2` exists without
  // learning whether it is a leader, a worker, or what model it runs.
  | (EventBase & { kind: 'participant_joined'; participant: Participant })
  | (EventBase & { kind: 'participant_left'; participantId: ParticipantId })
  | (EventBase & { kind: 'message'; room: RoomId; body: string; to?: ParticipantId })
  | (EventBase & { kind: 'task_created'; task: Task })
  | (EventBase & { kind: 'task_state'; taskId: string; state: TaskState; reason?: string })
  | (EventBase & { kind: 'brief_ack'; taskId: string; ack: Acknowledgement })
  | (EventBase & { kind: 'claim_raised'; claim: Claim })
  | (EventBase & { kind: 'claim_response'; claimId: string; verdict: ClaimVerdict;
                   rationale?: string; falsifier?: string; evidence: Evidence[] })
  | (EventBase & { kind: 'evidence_added'; claimId: string; evidence: Evidence })
  | (EventBase & { kind: 'evidence_stale'; claimId: string; sha: string })
  | (EventBase & { kind: 'rebase_notice'; taskId: string; newBase: string })
  | (EventBase & { kind: 'decision_opened'; decision: Decision })
  | (EventBase & { kind: 'vote_cast'; decisionId: string; option: string; rationale: string })
  | (EventBase & { kind: 'decision_resolved'; decisionId: string; outcome: string })
  | (EventBase & { kind: 'brief_updated'; participant: ParticipantId; version: string });

/** An event as authored, before the daemon stamps ordering. */
export type DraftEvent = Omit<CrosstalkEvent, 'seq' | 'ts'> & { seq?: never; ts?: never };
```

- [ ] **Step 8: Write `src/contracts/errors.ts`**

```ts
export type ErrorCode =
  | 'MISSING_FALSIFIER' | 'VACUOUS_FALSIFIER'
  | 'CONTEST_WITHOUT_RATIONALE' | 'CONTEST_WITHOUT_COUNTER_EVIDENCE'
  | 'UPHOLD_WITHOUT_NEW_EVIDENCE'
  | 'GATE_NOT_ACKNOWLEDGED' | 'GATE_NOT_SELF_REVIEWED'
  | 'ILLEGAL_TRANSITION' | 'UNRESOLVED_CLAIMS'
  | 'NON_TERMINAL_LADDER' | 'NOT_ELIGIBLE_VOTER' | 'VOTE_WITHOUT_RATIONALE'
  | 'UNKNOWN_CLAIM' | 'UNKNOWN_TASK' | 'UNKNOWN_DECISION' | 'UNKNOWN_PARTICIPANT';

export class ProtocolError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}
```

- [ ] **Step 9: Write the fixture logs**

`tests/fixtures/session-basic.jsonl` — 14 lines covering: three `participant_joined`, a `task_created`, `brief_ack`, `task_state` through `submitted`, two `message` events on `#floor`, and a clean `accepted`.

`tests/fixtures/session-dispute.jsonl` — 22 lines covering: a `claim_raised` from `leader` against `codex`, a `claim_response` with `verdict: "contest"` carrying rationale and counter-evidence, a `claim_response` with `verdict: "uphold"` carrying new evidence, `rounds` reaching 3, a `decision_opened` with `method: "ladder"`, a `decision_resolved`, and one `evidence_stale`.

Both files use `\n` endings and are covered by the `*.jsonl -text` rule already in `.gitattributes`. **These are golden files: Tracks A and B assert against them, so a change to either is a change to two tracks' tests.**

- [ ] **Step 10: Write the CI matrix**

`.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm test`, `npm run build` on `windows-latest`, `macos-latest`, `ubuntu-latest` with Node 20 and 22.

- [ ] **Step 11: Commit and freeze**

```bash
git add package.json tsconfig.json vitest.config.ts src/contracts tests/fixtures .github
git commit -m "Freeze protocol contracts and golden fixtures"
```

---

## Track A — Protocol core

Pure logic, no I/O beyond one append-only file. This is the track that must be right; everything else is plumbing around it.

### Task A1: Append-only event log

**Files:**
- Create: `src/core/log.ts`
- Test: `tests/core/log.test.ts`

**Interfaces:**
- Consumes: `CrosstalkEvent`, `DraftEvent` from `src/contracts/events.js`
- Produces: `class EventLog` with `static open(path: string): Promise<EventLog>`, `append(draft: DraftEvent): Promise<CrosstalkEvent>`, `read(): Promise<CrosstalkEvent[]>`, `readFrom(seq: number): Promise<CrosstalkEvent[]>`, `get lastSeq(): number`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../../src/core/log.js';

describe('EventLog', () => {
  it('assigns monotonic seq starting at 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-'));
    const log = await EventLog.open(join(dir, 'events.jsonl'));
    const a = await log.append({ kind: 'message', from: 'leader', room: '#floor', body: 'one' });
    const b = await log.append({ kind: 'message', from: 'codex', room: '#floor', body: 'two' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it('writes LF-terminated lines regardless of platform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-'));
    const path = join(dir, 'events.jsonl');
    const log = await EventLog.open(path);
    await log.append({ kind: 'message', from: 'leader', room: '#floor', body: 'x' });
    const raw = await readFile(path, 'latin1');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.includes('\r')).toBe(false);
  });

  it('resumes seq after reopening an existing log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-'));
    const path = join(dir, 'events.jsonl');
    const first = await EventLog.open(path);
    await first.append({ kind: 'message', from: 'leader', room: '#floor', body: 'x' });
    const second = await EventLog.open(path);
    const next = await second.append({ kind: 'message', from: 'leader', room: '#floor', body: 'y' });
    expect(next.seq).toBe(2);
  });

  it('tolerates a truncated final line and truncates to the last valid seq', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ct-'));
    const path = join(dir, 'events.jsonl');
    const log = await EventLog.open(path);
    await log.append({ kind: 'message', from: 'leader', room: '#floor', body: 'good' });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"seq":2,"kind":"mess');
    const recovered = await EventLog.open(path);
    expect(recovered.lastSeq).toBe(1);
    expect((await recovered.read())).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/log.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/log.js'`

- [ ] **Step 3: Implement `EventLog`**

Open the file with `fs.open(path, 'a+')`. Serialise each event with `JSON.stringify` and write `line + '\n'` as a `Buffer` so no newline translation occurs. Assign `seq = ++this.#lastSeq` and `ts = new Date().toISOString()` at append time. On `open`, read the whole file, split on `\n`, `JSON.parse` each non-empty line inside a `try`; on the **first** parse failure, stop, record the byte offset, and `ftruncate` the file to that offset. Never attempt to skip a bad line and continue — a hole in the sequence is worse than a short log.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/log.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/log.ts tests/core/log.test.ts
git commit -m "Add append-only event log with seq assignment and truncation recovery"
```

### Task A2: Deterministic projection

**Files:**
- Create: `src/core/projection.ts`
- Test: `tests/core/projection.test.ts`

**Interfaces:**
- Consumes: `CrosstalkEvent`, `Claim`, `Task`, `Decision`, `Participant`
- Produces: `interface HubState { participants: Map<ParticipantId, Participant>; tasks: Map<string, Task>; claims: Map<string, Claim>; decisions: Map<string, Decision>; messages: CrosstalkEvent[]; lastSeq: number }` and `function project(events: CrosstalkEvent[]): HubState`, `function applyEvent(state: HubState, event: CrosstalkEvent): HubState`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { project } from '../../src/core/projection.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';

async function loadFixture(name: string): Promise<CrosstalkEvent[]> {
  const raw = await readFile(`tests/fixtures/${name}.jsonl`, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as CrosstalkEvent);
}

describe('project', () => {
  it('is deterministic — same events, same state', async () => {
    const events = await loadFixture('session-dispute');
    expect(JSON.stringify(project(events), replacer))
      .toEqual(JSON.stringify(project(events), replacer));
  });

  it('folds a contested claim to state "contested" with rounds preserved', async () => {
    const state = project(await loadFixture('session-dispute'));
    const claim = state.claims.get('C-118');
    expect(claim?.state).toBe('contested');
    expect(claim?.rounds).toBe(3);
  });

  it('marks evidence stale when an evidence_stale event names its sha', async () => {
    const state = project(await loadFixture('session-dispute'));
    const claim = state.claims.get('C-118')!;
    expect(claim.evidence.some((e) => e.stale === true)).toBe(true);
  });

  it('ignores ts entirely — reordering by ts does not change state', async () => {
    const events = await loadFixture('session-dispute');
    const scrambled = events.map((e, i) => ({ ...e, ts: new Date(2000, 0, events.length - i).toISOString() }));
    expect(JSON.stringify(project(scrambled), replacer))
      .toEqual(JSON.stringify(project(events), replacer));
  });
});

function replacer(_k: string, v: unknown) {
  return v instanceof Map ? Object.fromEntries([...v.entries()].sort()) : v;
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/projection.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `project` and `applyEvent`**

`project` sorts by `seq` ascending, then reduces with `applyEvent` from an empty state. `applyEvent` is a `switch` over `event.kind` with **no default fallthrough that silently ignores** — an unknown kind throws, so a contract addition cannot quietly produce wrong state. Never read `event.ts` for any purpose other than display.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/projection.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/projection.ts tests/core/projection.test.ts
git commit -m "Add deterministic event projection over golden fixtures"
```

### Task A3: Claim validators — the falsifier rule

**Files:**
- Create: `src/core/claims.ts`
- Test: `tests/core/claims.test.ts`

**Interfaces:**
- Consumes: `Claim`, `Evidence`, `ClaimVerdict`, `ProtocolError`, `HubState`
- Produces: `function validateRaise(input: RaiseClaimInput, state: HubState): Claim`, `function validateResponse(input: ClaimResponseInput, state: HubState): void`, and `interface RaiseClaimInput { raisedBy: ParticipantId; against: Claim['against']; target: string; assertion: string; severity: Severity; falsifier: string; evidence: Evidence[]; taskId?: string }`, `interface ClaimResponseInput { claimId: string; from: ParticipantId; verdict: ClaimVerdict; rationale?: string; falsifier?: string; evidence: Evidence[] }`

- [ ] **Step 1: Write the failing test**

These four cases encode the thesis of the whole project. If a later refactor weakens any of them, that is a defect regardless of what else passes.

```ts
import { describe, it, expect } from 'vitest';
import { validateRaise, validateResponse } from '../../src/core/claims.js';
import { ProtocolError } from '../../src/contracts/errors.js';

const base = {
  raisedBy: 'leader', against: 'codex', target: 'src/economy.ts:41',
  assertion: 'staffing coefficient applied twice', severity: 'defect' as const,
  evidence: [{ kind: 'command' as const, command: 'npm test', output: 'ok', sha: 'abc', by: 'leader' }],
};

describe('claim validators', () => {
  it('rejects a claim with no falsifier', () => {
    expect(() => validateRaise({ ...base, falsifier: '' }, emptyState()))
      .toThrowError(expect.objectContaining({ code: 'MISSING_FALSIFIER' }));
  });

  it('rejects a vacuous falsifier', () => {
    expect(() => validateRaise({ ...base, falsifier: 'if it did not work' }, emptyState()))
      .toThrowError(expect.objectContaining({ code: 'VACUOUS_FALSIFIER' }));
  });

  it('rejects a contest with no rationale', () => {
    const state = stateWithOpenClaim('C-1');
    expect(() => validateResponse(
      { claimId: 'C-1', from: 'codex', verdict: 'contest', falsifier: 'ledger would diverge on tick 3', evidence: [ev('x')] },
      state,
    )).toThrowError(expect.objectContaining({ code: 'CONTEST_WITHOUT_RATIONALE' }));
  });

  it('rejects an uphold that carries no evidence newer than the contest', () => {
    const state = stateWithContestedClaim('C-1', 'sha-old');
    expect(() => validateResponse(
      { claimId: 'C-1', from: 'leader', verdict: 'uphold', evidence: [ev('sha-old')] },
      state,
    )).toThrowError(expect.objectContaining({ code: 'UPHOLD_WITHOUT_NEW_EVIDENCE' }));
  });

  it('accepts an uphold carrying evidence not already on the claim', () => {
    const state = stateWithContestedClaim('C-1', 'sha-old');
    expect(() => validateResponse(
      { claimId: 'C-1', from: 'leader', verdict: 'uphold', evidence: [ev('sha-new')] },
      state,
    )).not.toThrow();
  });
});
```

Helper `ev(sha)` returns `{ kind: 'command', command: 'x', output: 'y', sha, by: 'leader' }`. `emptyState()`, `stateWithOpenClaim`, `stateWithContestedClaim` build a `HubState` directly — do not build them by replaying events, or a projection bug will hide a validator bug.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/claims.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the validators**

`validateRaise` throws `MISSING_FALSIFIER` on empty/whitespace. The vacuity lint throws `VACUOUS_FALSIFIER` when the falsifier is under 20 characters **or** matches `/^(if )?(it|this|that) (did ?n[o']?t|does ?n[o']?t|would ?n[o']?t) work/i` or normalizes to the same text as the assertion — keep the rule list in one exported `VACUITY_PATTERNS` array so it is greppable and extensible.

**Do not try to detect meaning from vocabulary.** An earlier draft of this task required the falsifier to contain a verb from a fixed list, which rejected `"The focused command prints two rows instead of one."` — a perfectly good falsifier whose verb happened to be absent. It is also English-only, and it is the same mistake as matching a localised error message by substring (see Task C1). The lint deliberately catches only the laziest cases; the `discriminating_test` rung is the real check.

`validateResponse` switches on verdict: `contest` requires non-empty `rationale`, non-empty `falsifier`, and at least one evidence item; `uphold` requires at least one evidence item whose `sha` **or** `command` differs from every item already on the claim; `concede`, `accept`, `clarify`, `amend` have their own required fields per the spec.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/claims.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/claims.ts tests/core/claims.test.ts
git commit -m "Enforce falsifier and new-evidence rules at the claim boundary"
```

### Task A4: Task state machine and the two gates

**Files:**
- Create: `src/core/tasks.ts`
- Test: `tests/core/tasks.test.ts`

**Interfaces:**
- Consumes: `Task`, `TaskState`, `CritiqueRecord`, `Acknowledgement`, `HubState`, `ProtocolError`
- Produces: `function canTransition(from: TaskState, to: TaskState): boolean`, `function validateTransition(taskId: string, to: TaskState, state: HubState): void`, `const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>>`

- [ ] **Step 1: Write the failing test**

```ts
describe('task gates', () => {
  it('refuses assigned -> in_progress without an acknowledgement', () => {
    const state = stateWithTask('T-1', 'assigned');
    expect(() => validateTransition('T-1', 'in_progress', state))
      .toThrowError(expect.objectContaining({ code: 'GATE_NOT_ACKNOWLEDGED' }));
  });

  it('allows assigned -> in_progress once acknowledged', () => {
    const state = stateWithTask('T-1', 'acknowledged', {
      acknowledgement: { restatement: 'build the log', ambiguities: [] },
    });
    expect(() => validateTransition('T-1', 'in_progress', state)).not.toThrow();
  });

  it('refuses in_progress -> submitted without a critique record', () => {
    const state = stateWithTask('T-1', 'in_progress');
    expect(() => validateTransition('T-1', 'submitted', state))
      .toThrowError(expect.objectContaining({ code: 'GATE_NOT_SELF_REVIEWED' }));
  });

  it('permits a zero-finding critique record — legal, and recorded', () => {
    const state = stateWithTask('T-1', 'self_reviewed', {
      critique: { rounds: 1, findings: [], critic: 'codex subagent' },
    });
    expect(() => validateTransition('T-1', 'submitted', state)).not.toThrow();
  });

  it('refuses under_review -> accepted while any claim on the task is unresolved', () => {
    const state = stateWithTaskAndOpenClaim('T-1', 'under_review', 'C-9');
    expect(() => validateTransition('T-1', 'accepted', state))
      .toThrowError(expect.objectContaining({ code: 'UNRESOLVED_CLAIMS' }));
  });

  it('rejects a transition not present in the table', () => {
    const state = stateWithTask('T-1', 'draft');
    expect(() => validateTransition('T-1', 'merged', state))
      .toThrowError(expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/tasks.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the state machine**

`TASK_TRANSITIONS` is an explicit table, not derived. Order of checks in `validateTransition` matters: table membership first (`ILLEGAL_TRANSITION`), then gate conditions. A zero-finding critique record satisfies gate 2 — the spec says these are legal and surfaced in the ledger, not blocked.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/tasks.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/tasks.ts tests/core/tasks.test.ts
git commit -m "Add task state machine with acknowledge and self-review gates"
```

### Task A5: Decision engine and the dispute ladder

**Files:**
- Create: `src/core/decisions.ts`
- Test: `tests/core/decisions.test.ts`

**Interfaces:**
- Consumes: `Decision`, `DecisionMethod`, `LadderRung`, `TERMINAL_RUNGS`, `HubState`, `ProtocolError`
- Produces: `function validateLadder(ladder: LadderRung[]): void`, `function resolvableRungs(ladder: LadderRung[], workerCount: number): LadderRung[]`, `function tally(decision: Decision): string | null`, `function advance(decision: Decision): Decision`

- [ ] **Step 1: Write the failing test**

```ts
describe('dispute ladder', () => {
  it('rejects a ladder whose last rung is not terminal', () => {
    expect(() => validateLadder(['discriminating_test', 'third_agent']))
      .toThrowError(expect.objectContaining({ code: 'NON_TERMINAL_LADDER' }));
  });

  it('accepts the default ladder', () => {
    expect(() => validateLadder(['discriminating_test', 'third_agent', 'leader'])).not.toThrow();
  });

  it('drops third_agent when there are fewer than two workers', () => {
    expect(resolvableRungs(['discriminating_test', 'third_agent', 'leader'], 1))
      .toEqual(['discriminating_test', 'leader']);
  });

  it('keeps third_agent with two workers', () => {
    expect(resolvableRungs(['discriminating_test', 'third_agent', 'leader'], 2))
      .toEqual(['discriminating_test', 'third_agent', 'leader']);
  });

  it('tallies a majority and returns null before quorum', () => {
    const d = decision({ method: 'majority', voters: ['a', 'b', 'c'], votes: { a: 'yes' } });
    expect(tally(d)).toBeNull();
    expect(tally({ ...d, votes: { a: 'yes', b: 'yes' } })).toBe('yes');
  });

  it('returns null for unanimous when any voter dissents', () => {
    const d = decision({ method: 'unanimous', voters: ['a', 'b'], votes: { a: 'yes', b: 'no' } });
    expect(tally(d)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/decisions.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`validateLadder` throws unless `TERMINAL_RUNGS.includes(ladder.at(-1)!)`. `resolvableRungs` filters `third_agent` out when `workerCount < 2` and returns a new array; it must not mutate. `tally` switches on method — `majority` needs `> voters.length / 2` for one option, `unanimous` needs every voter to have cast the same option, `leader`/`human` return the single authoritative vote if present. `advance` returns a copy with `currentRung` incremented; it never mutates its argument, because decisions are rebuilt from the log on every projection.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/decisions.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/decisions.ts tests/core/decisions.test.ts
git commit -m "Add decision tally and dispute ladder with worker-count degradation"
```

### Task A6: Room ids and membership

**Files:**
- Create: `src/core/rooms.ts`
- Test: `tests/core/rooms.test.ts`

**Interfaces:**
- Consumes: `RoomId`, `RoomKind`, `FLOOR`, `HUMAN_ID`, `HubState`
- Produces: `function parseRoom(id: RoomId): { kind: RoomKind; parts: string[] }`, `function dmId(a: ParticipantId, b: ParticipantId): RoomId`, `function membersOf(id: RoomId, state: HubState): ParticipantId[]`, `function isMember(who: ParticipantId, id: RoomId, state: HubState): boolean`

- [ ] **Step 1: Write the failing test**

```ts
describe('rooms', () => {
  it('sorts dm participants so the id is canonical', () => {
    expect(dmId('codex', 'leader')).toBe('dm:codex~leader');
    expect(dmId('leader', 'codex')).toBe('dm:codex~leader');
  });

  it('puts @human in every room', () => {
    const s = stateWith(['leader', 'cursor', 'codex']);
    for (const room of ['#floor', 'dm:codex~leader', 'task:T-1', 'dispute:C-1']) {
      expect(membersOf(room, s)).toContain('@human');
    }
  });

  it('includes uninvolved workers in a dispute room as observers', () => {
    const s = stateWithDispute('C-1', 'leader', 'codex', ['cursor']);
    expect(membersOf('dispute:C-1', s)).toContain('cursor');
  });

  it('excludes an unrelated worker from a dm', () => {
    const s = stateWith(['leader', 'cursor', 'codex']);
    expect(isMember('cursor', 'dm:codex~leader', s)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/rooms.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`dmId` sorts the two ids with `localeCompare` before joining with `~`, so `dm:a~b` is the only spelling. `membersOf` always appends `HUMAN_ID`. Dispute rooms return disputants plus every `role: 'worker'` participant not party to the dispute.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/rooms.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/rooms.ts tests/core/rooms.test.ts
git commit -m "Add canonical room ids and membership derivation"
```

---

## Track B — Hub UI

Built entirely against `tests/fixtures/*.jsonl`. No daemon required, no dependency on Track A's behavior — only on contract types. This track can start at the same minute as A and C.

### Task B1: Vite app shell and fixture loader

**Files:**
- Create: `src/ui/main.tsx`, `src/ui/App.tsx`, `src/ui/state/useLog.ts`, `vite.config.ts`, `index.html`
- Test: `tests/ui/useLog.test.ts`

**Interfaces:**
- Consumes: `CrosstalkEvent` from contracts
- Produces: `function useLog(source: LogSource): { events: CrosstalkEvent[]; connected: boolean }` where `type LogSource = { kind: 'fixture'; path: string } | { kind: 'sse'; url: string }`

- [ ] **Step 1: Write the failing test**

```ts
it('loads a fixture log into ordered events', async () => {
  const { result } = renderHook(() => useLog({ kind: 'fixture', path: '/fixtures/session-dispute.jsonl' }));
  await waitFor(() => expect(result.current.events.length).toBeGreaterThan(0));
  const seqs = result.current.events.map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/ui/useLog.test.ts`, FAIL, module not found

- [ ] **Step 3: Implement** — `useLog` branches on source kind: `fixture` does one `fetch` + split + parse; `sse` opens an `EventSource` and appends. Both sort by `seq`. Vite dev server serves `tests/fixtures` at `/fixtures` via `publicDir` config so the same code path works in dev and test.

- [ ] **Step 4: Run to verify it passes** — PASS, 1 test

- [ ] **Step 5: Commit**

```bash
git add src/ui/main.tsx src/ui/App.tsx src/ui/state/useLog.ts vite.config.ts index.html tests/ui/useLog.test.ts
git commit -m "Add hub app shell reading fixture and SSE log sources"
```

### Task B2: Design tokens

**Files:**
- Create: `src/ui/theme.css`
- Test: `tests/ui/theme.test.ts`

**Interfaces:**
- Produces: CSS custom properties on `:root` and `:root[data-theme="light"]`

- [ ] **Step 1: Write the failing test** — assert `theme.css` defines every token in this list and that no component file contains a raw hex literal:

```ts
const REQUIRED = ['--surface-base','--surface-panel','--surface-raised','--border-hairline',
  '--text-primary','--text-secondary','--text-tertiary','--accent',
  '--status-fresh','--status-stale','--status-contested','--status-blocker','--status-open',
  '--font-ui','--font-mono','--size-ui','--size-mono','--row-h','--radius'];

it('defines every design token', async () => {
  const css = await readFile('src/ui/theme.css', 'utf8');
  for (const t of REQUIRED) expect(css).toContain(t);
});

it('has no raw hex colours outside theme.css', async () => {
  const files = await glob('src/ui/**/*.{tsx,css}', { ignore: ['src/ui/theme.css'] });
  for (const f of files) {
    expect(await readFile(f, 'utf8')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  }
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, file missing

- [ ] **Step 3: Implement** — dark-first, layered near-black surfaces separated by hairline borders, no drop shadows. `--font-mono` is `ui-monospace, "Cascadia Code", "SF Mono", "JetBrains Mono", monospace` and is used for **every fact** — commands, SHAs, paths, output, falsifiers. `--size-ui: 13px`, `--size-mono: 12.5px`, `--row-h: 30px`, `--radius: 6px`. One accent hue for interactive elements only; all other colour is status. Light theme overrides under `:root[data-theme="light"]`.

- [ ] **Step 4: Run to verify it passes** — PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/ui/theme.css tests/ui/theme.test.ts
git commit -m "Add design tokens; forbid raw hex outside the theme"
```

### Task B3: Four-region layout

**Files:**
- Create: `src/ui/layout/Rail.tsx`, `ChannelList.tsx`, `Stream.tsx`, `Inspector.tsx`, `Layout.tsx`
- Test: `tests/ui/layout.test.tsx`

**Interfaces:**
- Consumes: `useLog`, `HubState` shape from contracts (Track B derives its own read-only projection helper `src/ui/state/derive.ts` — it must **not** import `src/core/projection.ts`, which is Track A's file)
- Produces: `<Layout state={...} activeRoom={...} onSelectRoom={...} />`

- [ ] **Step 1: Write the failing test**

```tsx
it('renders participants with live status and tier badge', () => {
  render(<Rail participants={[{ id: 'codex', role: 'worker', status: 'awaiting_turn', tier: 'mcp' }]} />);
  expect(screen.getByText('codex')).toBeInTheDocument();
  expect(screen.getByLabelText('awaiting turn')).toBeInTheDocument();
  expect(screen.getByText('mcp')).toBeInTheDocument();
});

it('groups channels and shows a round counter on disputes', () => {
  render(<ChannelList rooms={[{ id: 'dispute:C-118', kind: 'dispute', rounds: 2, maxRounds: 3 }]} />);
  expect(screen.getByText('2/3')).toBeInTheDocument();
});

it('sorts rooms awaiting a human decision to the top', () => {
  render(<ChannelList rooms={[
    { id: 'task:T-1', kind: 'task' },
    { id: 'dispute:C-9', kind: 'dispute', awaitingHuman: true },
  ]} />);
  const items = screen.getAllByRole('listitem');
  expect(items[0]).toHaveTextContent('C-9');
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, modules missing

- [ ] **Step 3: Implement** — CSS grid, four columns, no fixed pixel widths on the stream. `Rail` derives status from the most recent event per participant. `ChannelList` groups `FLOOR / TASKS / DISPUTES / DIRECT` and sorts `awaitingHuman` first within its group.

- [ ] **Step 4: Run to verify it passes** — PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/ui/layout tests/ui/layout.test.tsx
git commit -m "Add four-region hub layout with live participant status"
```

### Task B4: Event cards — messages are not claims

**Files:**
- Create: `src/ui/cards/MessageRow.tsx`, `ClaimCard.tsx`, `EvidenceRow.tsx`, `DecisionCard.tsx`, `cardFor.tsx`
- Test: `tests/ui/cards.test.tsx`

**Interfaces:**
- Produces: `function cardFor(event: CrosstalkEvent): JSX.Element`

- [ ] **Step 1: Write the failing test**

```tsx
it('renders a claim as a card, never as message text', () => {
  render(cardFor(claimRaised({ id: 'C-118', falsifier: 'produce() and consume() would differ' })));
  expect(screen.getByTestId('claim-card')).toBeInTheDocument();
  expect(screen.getByText(/produce\(\) and consume\(\) would differ/)).toBeInTheDocument();
});

it('renders the falsifier in monospace', () => {
  render(cardFor(claimRaised({ id: 'C-1', falsifier: 'ledger diverges on tick 3' })));
  expect(getComputedStyle(screen.getByTestId('falsifier')).fontFamily).toContain('mono');
});

it('collapses evidence to one line and expands on click', async () => {
  render(<EvidenceRow evidence={{ kind: 'command', command: 'npm test', output: 'a\nb\nc', sha: '7c18253', by: 'leader' }} />);
  expect(screen.queryByText(/^b$/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /npm test/ }));
  expect(screen.getByText(/^b$/)).toBeInTheDocument();
});

it('strikes through stale evidence and labels why', () => {
  render(<EvidenceRow evidence={{ kind: 'command', command: 'npm test', sha: 'old', by: 'leader', stale: true }} />);
  const row = screen.getByTestId('evidence-row');
  expect(row).toHaveAttribute('data-stale', 'true');
  expect(screen.getByText(/stale/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, modules missing

- [ ] **Step 3: Implement** — `cardFor` switches on `event.kind` and **throws on an unknown kind** rather than falling back to raw text; a new event type must be designed a card, not silently degraded into a paragraph. Evidence rows show `command · sha · fresh|stale` on one line.

- [ ] **Step 4: Run to verify it passes** — PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/ui/cards tests/ui/cards.test.tsx
git commit -m "Render protocol events as structured cards, not message text"
```

### Task B5: The dispute view

**Files:**
- Create: `src/ui/dispute/DisputeView.tsx`, `LadderRail.tsx`
- Test: `tests/ui/dispute.test.tsx`

**Interfaces:**
- Produces: `<DisputeView claim={...} contest={...} ladder={...} currentRung={...} onProposeTest={...} onIntervene={...} />`

- [ ] **Step 1: Write the failing test**

```tsx
it('shows both falsifiers side by side', () => {
  render(<DisputeView {...dispute()} />);
  const panes = screen.getAllByTestId('falsifier');
  expect(panes).toHaveLength(2);
});

it('lights only the current rung', () => {
  render(<LadderRail ladder={['discriminating_test','third_agent','leader']} currentRung={1} />);
  expect(screen.getByTestId('rung-third_agent')).toHaveAttribute('data-state', 'current');
  expect(screen.getByTestId('rung-leader')).toHaveAttribute('data-state', 'pending');
});

it('omits a rung that was skipped for lack of a third agent', () => {
  render(<LadderRail ladder={['discriminating_test','leader']} currentRung={0} skipped={['third_agent']} />);
  expect(screen.getByTestId('rung-third_agent')).toHaveAttribute('data-state', 'skipped');
});

it('shows the round counter against the cap', () => {
  render(<DisputeView {...dispute({ rounds: 2, maxRounds: 3 })} />);
  expect(screen.getByText('round 2 / 3')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, modules missing

- [ ] **Step 3: Implement** — two-column grid, claim left, contest right, each with assertion, falsifier and evidence. A skipped rung renders visibly rather than disappearing, so a user can see the ladder degraded and why.

- [ ] **Step 4: Run to verify it passes** — PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/ui/dispute tests/ui/dispute.test.tsx
git commit -m "Add dispute view with side-by-side falsifiers and ladder rail"
```

---

## Track C — Workspace, harness and doctor

Pure filesystem and process work. Depends on contract types only.

### Task C1: Git worktree lifecycle

**Files:**
- Create: `src/workspace/git.ts`
- Test: `tests/workspace/git.test.ts`

**Interfaces:**
- Produces: `function gitVersion(cwd: string): Promise<string>`, `function isRepo(cwd: string): Promise<boolean>`, `function headSha(cwd: string): Promise<string>`, `function isAncestor(sha: string, of: string, cwd: string): Promise<boolean>`, `function createWorktree(repo: string, id: string, branch: string): Promise<string>`, `function removeWorktree(repo: string, id: string): Promise<void>`, `function listWorktrees(repo: string): Promise<{ path: string; branch: string }[]>`

- [ ] **Step 1: Write the failing test**

Each test builds a real throwaway repo in `mkdtemp` with two commits — do not mock git, because the failures worth catching here are git's actual behavior on each platform.

```ts
it('creates a worktree at the expected path and branch', async () => {
  const repo = await tempRepo();
  const path = await createWorktree(repo, 'codex', 'ct/T-1-log');
  expect(await isRepo(path)).toBe(true);
  expect((await listWorktrees(repo)).some((w) => w.branch === 'ct/T-1-log')).toBe(true);
});

it('removes a worktree it created', async () => {
  const repo = await tempRepo();
  await createWorktree(repo, 'codex', 'ct/T-1-log');
  await removeWorktree(repo, 'codex');
  expect((await listWorktrees(repo)).some((w) => w.path.includes('codex'))).toBe(false);
});

it('detects a non-ancestor sha after a divergent commit', async () => {
  const repo = await tempRepo();
  const old = await headSha(repo);
  await commitEmpty(repo, 'second');
  expect(await isAncestor(old, await headSha(repo), repo)).toBe(true);
  const orphan = await commitOnOrphanBranch(repo);
  expect(await isAncestor(orphan, await headSha(repo), repo)).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, module not found

- [ ] **Step 3: Implement** — wrap `child_process.execFile` (not `exec` — no shell, so paths with spaces are safe on Windows). Worktrees go to `path.join(repo, '.crosstalk', 'worktrees', id)`. `isAncestor` uses `git merge-base --is-ancestor` and maps exit code 1 to `false` rather than throwing.

- [ ] **Step 4: Run to verify it passes** — PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/workspace/git.ts tests/workspace/git.test.ts
git commit -m "Add git worktree lifecycle and ancestry checks over real repos"
```

### Task C2: Evidence staleness

**Files:**
- Create: `src/workspace/staleness.ts`
- Test: `tests/workspace/staleness.test.ts`

**Interfaces:**
- Consumes: `Evidence`, `Claim`, `isAncestor` from `src/workspace/git.js`
- Produces: `function evaluateStaleness(claims: Claim[], head: string, cwd: string): Promise<{ claimId: string; sha: string }[]>`

- [ ] **Step 1: Write the failing test**

```ts
it('reports evidence whose sha is not an ancestor of head', async () => {
  const repo = await tempRepo();
  const orphan = await commitOnOrphanBranch(repo);
  const claims = [claim('C-1', [ev(orphan)]), claim('C-2', [ev(await headSha(repo))])];
  const stale = await evaluateStaleness(claims, await headSha(repo), repo);
  expect(stale).toEqual([{ claimId: 'C-1', sha: orphan }]);
});

it('does not re-report evidence already marked stale', async () => {
  const repo = await tempRepo();
  const orphan = await commitOnOrphanBranch(repo);
  const claims = [claim('C-1', [{ ...ev(orphan), stale: true }])];
  expect(await evaluateStaleness(claims, await headSha(repo), repo)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, module not found

- [ ] **Step 3: Implement** — returns descriptors only; it emits no events and mutates nothing. Phase D turns each descriptor into an `evidence_stale` event. Deduplicate `sha` lookups with a `Map` so a claim with twenty evidence items at one SHA costs one `git` call.

- [ ] **Step 4: Run to verify it passes** — PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/workspace/staleness.ts tests/workspace/staleness.test.ts
git commit -m "Detect evidence gone stale against the current head"
```

### Task C3: Harness registry and probing

**Files:**
- Create: `src/harness/registry.ts`, `src/harness/harnesses.yaml`
- Test: `tests/harness/registry.test.ts`

**Interfaces:**
- Produces: `interface HarnessDescriptor { key: string; briefFile: string; mcp: 'stdio' | 'http' | 'unverified' | 'none'; mcpConfigPath?: string; supervisable: boolean; spawn?: string[] }`, `function loadRegistry(): Promise<Map<string, HarnessDescriptor>>`, `function probeTier(d: HarnessDescriptor, cwd: string): Promise<Tier>`

- [ ] **Step 1: Write the failing test**

```ts
it('ships CLI and app variants as separate keys', async () => {
  const r = await loadRegistry();
  for (const k of ['claude-code-cli','claude-code-app','codex-cli','codex-app','cursor-cli','cursor-app']) {
    expect(r.has(k)).toBe(true);
  }
});

it('marks every app variant unsupervisable', async () => {
  const r = await loadRegistry();
  for (const [k, d] of r) if (k.endsWith('-app')) expect(d.supervisable).toBe(false);
});

it('falls back to shell when the mcp probe is unverified', async () => {
  const d = { key: 'codex-app', briefFile: 'AGENTS.md', mcp: 'unverified' as const, supervisable: false };
  expect(await probeTier(d, process.cwd())).toBe('shell');
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, module not found

- [ ] **Step 3: Implement** — descriptors live in `harnesses.yaml`, parsed with `yaml`, so adding a harness is a data change. `probeTier` returns `mcp` only when `mcpConfigPath` exists and is writable; `unverified` never resolves to `mcp` without that proof.

- [ ] **Step 4: Run to verify it passes** — PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/harness/registry.ts src/harness/harnesses.yaml tests/harness/registry.test.ts
git commit -m "Add harness registry with CLI/app variants and tier probing"
```

### Task C4: Brief generation

**Files:**
- Create: `src/harness/brief.ts`, `src/harness/templates/leader.md`, `worker.md`
- Test: `tests/harness/brief.test.ts`

**Interfaces:**
- Produces: `function renderBrief(p: Participant, d: HarnessDescriptor, policy: PolicyConfig, tier: Tier): string`, `function briefVersion(content: string): string`, `function writeBrief(...): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
it('embeds a stable version hash in the brief', () => {
  const a = renderBrief(worker(), descriptor(), policy(), 'mcp');
  expect(briefVersion(a)).toMatch(/^ct-brief-[0-9a-f]{8}$/);
  expect(briefVersion(a)).toBe(briefVersion(renderBrief(worker(), descriptor(), policy(), 'mcp')));
});

it('changes version when the policy changes', () => {
  const a = renderBrief(worker(), descriptor(), policy({ maxRounds: 3 }), 'mcp');
  const b = renderBrief(worker(), descriptor(), policy({ maxRounds: 5 }), 'mcp');
  expect(briefVersion(a)).not.toBe(briefVersion(b));
});

it('tells a shell-tier participant to use the CLI, not MCP tools', () => {
  expect(renderBrief(worker(), descriptor(), policy(), 'shell')).toContain('crosstalk claim raise');
  expect(renderBrief(worker(), descriptor(), policy(), 'shell')).not.toContain('raise_claim(');
});

it('states the contest-is-correct rule verbatim in every worker brief', () => {
  expect(renderBrief(worker(), descriptor(), policy(), 'mcp'))
    .toContain('Contesting a finding you believe is wrong is correct behavior');
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, module not found

- [ ] **Step 3: Implement** — templates are markdown with `{{token}}` substitution; no template engine dependency. `briefVersion` is `sha256(content).slice(0, 8)` prefixed `ct-brief-`. The tier decides whether the brief documents MCP tool names or CLI invocations — a brief that lists tools the agent cannot call is worse than no brief.

- [ ] **Step 4: Run to verify it passes** — PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/harness/brief.ts src/harness/templates tests/harness/brief.test.ts
git commit -m "Generate versioned, tier-aware role briefs"
```

### Task C5: Doctor

**Files:**
- Create: `src/harness/doctor.ts`
- Test: `tests/harness/doctor.test.ts`

**Interfaces:**
- Produces: `interface Finding { level: 'reject' | 'warn'; code: string; message: string; remedy: string }`, `function doctor(config: CrosstalkConfig, cwd: string): Promise<Finding[]>`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects a ladder whose last rung is not terminal', async () => {
  const f = await doctor(cfg({ ladder: ['discriminating_test','third_agent'] }), repo);
  expect(f).toContainEqual(expect.objectContaining({ level: 'reject', code: 'NON_TERMINAL_LADDER' }));
});

it('rejects supervised lifecycle on an app harness', async () => {
  const f = await doctor(cfg({ participants: [{ id:'codex', harness:'codex-app', lifecycle:'supervised' }] }), repo);
  expect(f).toContainEqual(expect.objectContaining({ level: 'reject', code: 'SUPERVISED_GUI_HARNESS' }));
});

// Observed on day one of building Crosstalk with Crosstalk: a worker told
// "one worktree per participant" branched in place in the repo root, which
// is the leader's checkout. It had followed the instruction exactly.
it('rejects a worker whose workspace resolves to the repo root', async () => {
  const f = await doctor(cfg({ participants: [{ id:'codex', role:'worker', workspace:'.' }] }), repo);
  expect(f).toContainEqual(expect.objectContaining({ level: 'reject', code: 'WORKER_IN_REPO_ROOT' }));
});

it('allows the leader to occupy the repo root', async () => {
  const f = await doctor(cfg({ participants: [{ id:'leader', role:'leader', workspace:'.' }] }), repo);
  expect(f.filter((x) => x.code === 'WORKER_IN_REPO_ROOT')).toHaveLength(0);
});

it('rejects zero or multiple leaders', async () => {
  expect(await doctor(cfg({ leaders: 0 }), repo)).toContainEqual(expect.objectContaining({ code: 'LEADER_COUNT' }));
  expect(await doctor(cfg({ leaders: 2 }), repo)).toContainEqual(expect.objectContaining({ code: 'LEADER_COUNT' }));
});

it('warns, not rejects, with a single worker and names the lost rung', async () => {
  const f = await doctor(cfg({ workers: 1 }), repo);
  const w = f.find((x) => x.code === 'THIRD_AGENT_UNAVAILABLE')!;
  expect(w.level).toBe('warn');
  expect(w.message).toContain('third_agent');
});

it('every finding carries a remedy', async () => {
  for (const f of await doctor(cfg({ workers: 1, ladder: ['third_agent'] }), repo)) {
    expect(f.remedy.length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL, module not found

- [ ] **Step 3: Implement** — checks in the spec's two groups. Every finding must carry a `remedy` naming the capability lost, not just the condition; the last test enforces that and should never be relaxed. Prerequisite checks (`node`, `git`, repo with a commit, at least one harness) run first and short-circuit to a single `reject`.

- [ ] **Step 4: Run to verify it passes** — PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/harness/doctor.ts tests/harness/doctor.test.ts
git commit -m "Add doctor with reject/warn split and a remedy on every finding"
```

---

## Phase D — Converge

Runs after A, B and C merge. Sequence is **D1, then D2 ∥ D3, then D4** — not four-way, and not fully serial either.

D1 comes first because a frozen wire contract is not a substitute for a running server at test time. That distinction was learned here: Tracks A and B built independent projections of the same event log, each passed its own tests, and they disagreed with each other about whether a claim was `contested` or `resolved` (finding B-005). Fixtures let components be self-consistently wrong. D2 and D3 then parallelise cleanly — they share `src/daemon/` with D1 but never a file — and D4 is last because its end-to-end test needs all three alive at once.

### Task D1: Daemon — sole writer, loopback HTTP, token

**Files:** Create `src/daemon/server.ts`, `src/daemon/lock.ts` · Test `tests/daemon/server.test.ts`

**Interfaces:** Produces `function startDaemon(opts: { repo: string; port?: number }): Promise<{ url: string; tokens: ReadonlyMap<ParticipantId, string>; close(): Promise<void> }>`

One token **per participant**, not one shared token — spec §6.1. A single token makes `from` self-asserted, which is friction-log entry 9 reintroduced one layer down, where it is far harder to see.

- [ ] **Step 1: Failing test** — a second `startDaemon` on the same repo rejects with `DAEMON_ALREADY_RUNNING` and reports the live URL; a request without a bearer token gets 401; a request whose payload sets `from` is rejected; `GET /events?since=N` returns the tail, exclusive of `since`.

**`POST /events` is not a general append.** Protocol-bearing kinds get typed routes — `POST /claims`, `POST /claims/:id/response`, `POST /tasks/:id/state`, `POST /tasks/:id/ack`, `POST /decisions`, `POST /decisions/:id/vote` — which take the validators' own input types and let the daemon construct the event. `POST /events` accepts only kinds with no invariants to violate (`message`), and rejects any other `kind` with a named error naming the correct route.

A generic append endpoint would be a back door around every rule in the project: `claim_raised` carries a whole `Claim`, so a client could hand-build one and never touch `validateRaise`, and `task_state` could move a task to `submitted` without passing `validateTransition`. Spec §4.1 puts validators at the API boundary precisely so they cannot be skipped — a transport that lets clients append raw events makes every falsifier requirement and every gate advisory.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `node:http` on port 0. Write `{version, url, pid, startedAt}` to `.crosstalk/daemon.json` with mode `0o600` where supported. **No token goes in that file** — one token per participant lives under `.crosstalk/tokens/<id>`, so a process that discovers the daemon does not thereby acquire everyone's identity. `lock.ts` uses exclusive `fs.open(path, 'wx')` on `.crosstalk/daemon.lock` containing `{pid, startedAt, url}`. Reclaim when the pid is gone (`process.kill(pid, 0)` throws `ESRCH`) **or** when the pid exists but `GET /health` at the recorded url does not answer within 500 ms — a present pid is not proof of liveness, pids get recycled, and a recycled pid would otherwise make the daemon permanently unstartable with no remedy but deleting a lock file by hand. `EPERM` means the process exists and belongs to someone else: treat as alive. All writes funnel through one `EventLog` instance.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** `git commit -m "Add loopback daemon as sole log writer with lock and token auth"`

### Task D2: SSE stream and UI wiring

**Files:** Create `src/daemon/sse.ts` · Modify `src/ui/App.tsx` · Test `tests/daemon/sse.test.ts`

- [ ] **Step 1: Failing test** — a client connected to `GET /stream` receives an event appended after connection, within 500ms, and reconnects with `Last-Event-ID` without gaps.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `text/event-stream`, `id:` set to `seq`, heartbeat comment every 15s. On reconnect, replay from `Last-Event-ID + 1`. Switch the UI's default `LogSource` from `fixture` to `sse`; the fixture path stays working for tests and `--replay`.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** `git commit -m "Stream events over SSE and wire the hub to the live log"`

### Task D3: MCP server — twelve tools

**Files:** Create `src/mcp/server.ts`, `src/mcp/tools.ts` · Test `tests/mcp/tools.test.ts`

- [ ] **Step 1: Failing test** — `raise_claim` with an empty `falsifier` returns an MCP tool **error** whose message names `MISSING_FALSIFIER`; `await_turn` returns `{idle:true}` after its cap even when nothing arrives; `await_turn` returns immediately when a `@human` message lands in a room the caller is in.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — the twelve tools from spec §6.2 over stdio, each delegating to the Track A validators. `roster()` returns id, role, harness, model and live status per participant; `board()` returns every task's id, title, assignee, state and branch — **metadata only, no message bodies**, so visibility scales past a dozen agents without becoming a noise flood. `await_turn` caps at 50s regardless of the requested timeout. Human messages resolve a pending wait immediately. Validation failures surface as tool errors, never as successful results containing an error string — the agent must see a failure it can retry.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** `git commit -m "Add tier-1 MCP server enforcing protocol validators in-band"`

### Task D4: CLI, init, down, and the end-to-end test

**Files:** Create `src/cli/index.ts` and one module per command · Test `tests/e2e/session.test.ts`

- [ ] **Step 1: Failing test** — a full scripted session: init a temp repo with three participants, start the daemon, create a task, acknowledge it, submit with a critique record, raise a claim, contest it, uphold with new evidence, hit `maxRounds`, resolve via ladder, accept, then `crosstalk down` and assert **no worktrees remain**.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — every MCP tool gets its CLI twin sharing one validator path. `init` runs the §14.3 flow and prints per-harness kickoff lines. `down` stops the daemon and removes only worktrees it created, verified against `listWorktrees`.
- [ ] **Step 4: Run — PASS on all three CI platforms**
- [ ] **Step 5:** `git commit -m "Add tier-2 CLI, init/down lifecycle, and end-to-end session test"`

---

## Out of scope for v1

Each gets its own plan. Named here so no one builds them speculatively.

- GitHub mirror, one-way and two-way-human (spec §8)
- Tier-3 file inbox (spec §6.4)
- The ledger (spec §12)
- Supervised lifecycle and process supervision (spec §4.2)
- `crosstalk ui --replay` as a shipped command
- npm publish and release automation

---

## Self-Review

**Spec coverage.** §4 objects → Task 0. §5.1 claims → A3. §5.2 tasks and gates → A4. §5.3 ladder → A5, with the two-worker degradation in A5 and C5. §5.4 staleness → C2, emitted in D1. §5.5 vacuity lint → A3. §6.1 daemon → D1. §6.2 MCP → D3. §6.3 CLI → D4. §6.5 harness and briefs → C3, C4. §7 git → C1. §9 human participation → D3 (priority wake) and B3. §10 UI → B1–B5. §11 config validation → C5. §13 cross-platform → global constraints plus the CI matrix in Task 0. §14 prerequisites → C5 and D4. **Gaps, deliberate:** §8 mirror, §6.4 tier 3, §12 ledger — all listed in Out of scope above.

**Type consistency.** `HubState` is defined in A2 and consumed by A3, A4, A5, A6 with the same shape. `Evidence.stale` is optional in the contract and set only by C2's descriptors via D1. `Tier` is used identically in C3, C4 and Task 0. Track B derives its own `src/ui/state/derive.ts` rather than importing `src/core/projection.ts`, so file ownership stays exclusive and B is never blocked on A.

**One risk worth stating plainly.** Task 0 freezes contracts before anyone has written code against them, which is exactly when they are least battle-tested. The mitigation is the protocol itself: a track that finds a contract wrong raises a claim against the plan rather than editing `src/contracts/`. Expect two or three such claims — that is the system working, not failing.
