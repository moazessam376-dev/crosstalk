import type { CrosstalkConfig } from '../contracts/config.js';
import type { Claim, ClaimVerdict, Evidence, Severity } from '../contracts/claim.js';
import type { Decision, LadderRung } from '../contracts/decision.js';
import { ProtocolError } from '../contracts/errors.js';
import type { CrosstalkEvent, DraftEvent } from '../contracts/events.js';
import type { ParticipantId } from '../contracts/participant.js';
import type { Acknowledgement, CritiqueRecord, Task, TaskState } from '../contracts/task.js';
import { responderFor, validateRaise, validateResponse, type ClaimResponseInput } from '../core/claims.js';
import { currentRungOf, tally, validateLadder } from '../core/decisions.js';
import type { HubState } from '../core/projection.js';
import { isMember } from '../core/rooms.js';
import { FLOOR, HUMAN_ID } from '../contracts/room.js';
import { validateTransition } from '../core/tasks.js';

import { DaemonError } from './errors.js';
import { closeLadderIfResolved, escalateIfNeeded } from './ladder.js';

export interface HandlerContext {
  /** Derived from the presenting token. Never read from a body. */
  who: ParticipantId;
  config: CrosstalkConfig;
  state: HubState;
  /** When each participant was last heard from. See `Presence`. */
  seenAt?: ReadonlyMap<ParticipantId, number>;
  append(draft: DraftEvent): Promise<CrosstalkEvent>;
}

type Body = Record<string, unknown>;

/* ---------------------------------------------------------------- claims -- */

export async function raiseClaim(ctx: HandlerContext, body: Body): Promise<CrosstalkEvent[]> {
  const claim = validateRaise(
    {
      raisedBy: ctx.who,
      against: requireString(body, 'against') as Claim['against'],
      target: requireString(body, 'target'),
      assertion: requireString(body, 'assertion'),
      severity: requireString(body, 'severity') as Severity,
      // Deliberately not `requireString`: an empty falsifier is MISSING_FALSIFIER,
      // a protocol refusal the agent is meant to see and correct. Rejecting it
      // here as a malformed body would replace the project's central rule with
      // a transport complaint.
      falsifier: readString(body, 'falsifier'),
      evidence: readEvidenceList(body, ctx.who),
      ...(body['taskId'] === undefined ? {} : { taskId: requireString(body, 'taskId') }),
    },
    ctx.state,
  );

  // Routed into the claim's dispute room, or `await_turn` never wakes the
  // participant the claim is against — which is the single event they most
  // need to be told about.
  return [
    await ctx.append({ kind: 'claim_raised', from: ctx.who, room: `dispute:${claim.id}`, claim }),
  ];
}

export async function respondToClaim(
  ctx: HandlerContext,
  claimId: string,
  body: Body,
): Promise<CrosstalkEvent[]> {
  const evidence = readEvidenceList(body, ctx.who);

  const input: ClaimResponseInput = {
    claimId,
    from: ctx.who,
    verdict: requireString(body, 'verdict') as ClaimVerdict,
    evidence,
    // Same reasoning as `falsifier` on raise: an empty rationale is
    // CONTEST_WITHOUT_RATIONALE, not a malformed body.
    ...(body['rationale'] === undefined ? {} : { rationale: readString(body, 'rationale') }),
    ...(body['falsifier'] === undefined ? {} : { falsifier: readString(body, 'falsifier') }),
  };

  validateResponse(input, ctx.state);

  const events = [
    await ctx.append({
      kind: 'claim_response',
      from: ctx.who,
      room: `dispute:${claimId}`,
      claimId,
      verdict: input.verdict,
      evidence,
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      ...(input.falsifier === undefined ? {} : { falsifier: input.falsifier }),
    }),
  ];

  // Automatic: no agent has to know the ladder exists, and none can decline to
  // escalate. `ctx.state` is a getter, so this reads the response just written.
  events.push(...(await escalateIfNeeded(ctx, claimId)));
  // ...and a response that settles the claim stops the ladder it opened.
  events.push(...(await closeLadderIfResolved(ctx, claimId)));
  return events;
}

export async function addEvidence(
  ctx: HandlerContext,
  claimId: string,
  body: Body,
): Promise<CrosstalkEvent[]> {
  if (!ctx.state.claims.has(claimId)) {
    throw new ProtocolError('UNKNOWN_CLAIM', `Unknown claim: ${claimId}`);
  }
  return [
    await ctx.append({
      kind: 'evidence_added',
      from: ctx.who,
      room: `dispute:${claimId}`,
      claimId,
      evidence: readEvidence(body, ctx.who),
    }),
  ];
}

/* ----------------------------------------------------------------- tasks -- */

export async function createTask(ctx: HandlerContext, body: Body): Promise<CrosstalkEvent[]> {
  requireRole(ctx, 'leader', 'POST /tasks');

  const id = requireString(body, 'id');
  if (ctx.state.tasks.has(id)) {
    throw new DaemonError('MALFORMED_BODY', `Task ${id} already exists — the log is append-only`);
  }

  const task: Task = {
    id,
    title: requireString(body, 'title'),
    brief: requireString(body, 'brief'),
    specRefs: readStringList(body, 'specRefs'),
    assignee: requireString(body, 'assignee'),
    deps: readStringList(body, 'deps'),
    acceptance: readStringList(body, 'acceptance'),
    // Never client-supplied: a task that could be born `accepted` would skip both gates.
    state: 'draft',
    branch: requireString(body, 'branch'),
  };

  return [await ctx.append({ kind: 'task_created', from: ctx.who, room: `task:${task.id}`, task })];
}

export async function acknowledgeTask(
  ctx: HandlerContext,
  taskId: string,
  body: Body,
): Promise<CrosstalkEvent[]> {
  const task = requireTask(ctx, taskId);
  requireAssignee(ctx, task, 'acknowledge');

  const ack: Acknowledgement = {
    restatement: requireString(body, 'restatement'),
    ambiguities: readStringList(body, 'ambiguities'),
  };

  const events = [
    await ctx.append({ kind: 'brief_ack', from: ctx.who, room: `task:${taskId}`, taskId, ack }),
  ];
  // Gate 1 in one request: making the caller issue a second one to reach
  // `acknowledged` invites the second to be skipped.
  events.push(...(await transitionIfLegal(ctx, taskId, 'acknowledged')));
  return events;
}

export async function submitTask(
  ctx: HandlerContext,
  taskId: string,
  body: Body,
): Promise<CrosstalkEvent[]> {
  const task = requireTask(ctx, taskId);
  requireAssignee(ctx, task, 'submit');

  const critique = readCritique(body);
  // `self_review` is gate 2's counterpart to `brief_ack`. Until it existed the
  // gate was unreachable from the log at all (CT-D-1).
  const events = [
    await ctx.append({ kind: 'self_review', from: ctx.who, room: `task:${taskId}`, taskId, critique }),
  ];
  events.push(...(await transitionIfLegal(ctx, taskId, 'self_reviewed')));
  return events;
}

type TaskAuthority =
  | 'leader'
  | 'assignee'
  /** Resolved per request from `policy.taskAcceptance.method`. */
  | 'acceptance_policy'
  /** No participant, ever. The transition table refuses it more precisely. */
  | 'unreachable';

/**
 * Whose move each task state is. Spec §5.2.
 *
 * `TASK_TRANSITIONS` answers a different question and cannot answer this one:
 * it says whether a move is *possible*, never whose it is. With only that
 * check, an unrelated worker drove another worker's task from `in_progress`
 * all the way to `merged` — `accepted` included, so both gates and the leader's
 * review were skipped by someone with no standing in the task at all. Every
 * step of that march was legal; not one of them was theirs.
 *
 * Total over `TaskState` on purpose, like `PROTOCOL_STATUS`: a state added to
 * the frozen contract with no authority named fails typecheck rather than
 * silently defaulting to "anyone".
 */
const TASK_AUTHORITY = {
  // Nothing moves a task *to* `draft`: `createTask` sets it and no edge leads
  // back. Left to `validateTransition`, which gives the truthful diagnosis.
  draft: 'unreachable',
  // The leader hands work out, opens review, sends it back, and merges.
  assigned: 'leader',
  under_review: 'leader',
  resolving: 'leader',
  merged: 'leader',
  // The assignee's own progress through its work, and both gates with it.
  acknowledged: 'assignee',
  in_progress: 'assignee',
  self_reviewed: 'assignee',
  submitted: 'assignee',
  accepted: 'acceptance_policy',
} as const satisfies Readonly<Record<TaskState, TaskAuthority>>;

export async function setTaskState(
  ctx: HandlerContext,
  taskId: string,
  body: Body,
): Promise<CrosstalkEvent[]> {
  const state = requireString(body, 'state') as TaskState;
  const reason = body['reason'] === undefined ? undefined : requireString(body, 'reason');

  // Permission before legality, matching `createTask` and `acknowledgeTask`
  // above: who you are does not depend on where the task has got to, and
  // GATE_NOT_ACKNOWLEDGED is advice for the party who is supposed to act, not
  // for a stranger. `ILLEGAL_TRANSITION` stays reachable for everyone who does
  // have the authority — the two codes answer different questions and neither
  // may swallow the other.
  requireTaskAuthority(ctx, requireTask(ctx, taskId), state);
  validateTransition(taskId, state, ctx.state);

  return [
    await ctx.append({
      kind: 'task_state',
      from: ctx.who,
      room: `task:${taskId}`,
      taskId,
      state,
      ...(reason === undefined ? {} : { reason }),
    }),
  ];
}

function requireTaskAuthority(ctx: HandlerContext, task: Task, to: TaskState): void {
  const authority = (TASK_AUTHORITY as Readonly<Record<string, TaskAuthority>>)[to];
  // Not a state at all. That is a legality question, and `validateTransition`
  // is a line away.
  if (authority === undefined) return;

  switch (authority) {
    case 'leader':
      if (roleOf(ctx, ctx.who) !== 'leader') {
        throw new ProtocolError(
          'NOT_TASK_AUTHORITY',
          `only the leader may move ${task.id} to ${to}; ${ctx.who} may not`,
        );
      }
      return;
    case 'assignee':
      if (ctx.who !== task.assignee) {
        throw new ProtocolError(
          'NOT_TASK_AUTHORITY',
          `${task.id} is assigned to ${task.assignee}; only the assignee may move it to ${to}`,
        );
      }
      return;
    case 'acceptance_policy':
      requireAcceptanceAuthority(ctx, task);
      return;
    case 'unreachable':
      return;
  }
}

/**
 * `policy.taskAcceptance.method` decides who accepts. The field was read but
 * never enforced — `brief.ts:55` prints it into a brief, so every participant
 * was told a rule the daemon did not apply.
 */
function requireAcceptanceAuthority(ctx: HandlerContext, task: Task): void {
  const { method } = ctx.config.policy.taskAcceptance;

  switch (method) {
    case 'leader':
      if (roleOf(ctx, ctx.who) !== 'leader') {
        throw new ProtocolError(
          'NOT_TASK_AUTHORITY',
          `policy.taskAcceptance.method is "leader", so only the leader may accept ${task.id}`,
        );
      }
      return;
    case 'human':
      if (ctx.who !== HUMAN_ID && roleOf(ctx, ctx.who) !== 'human') {
        throw new ProtocolError(
          'NOT_TASK_AUTHORITY',
          `policy.taskAcceptance.method is "human", so only ${HUMAN_ID} may accept ${task.id}`,
        );
      }
      return;
    default:
      // `majority` and `unanimous` name a decision rather than a participant,
      // and so do `discriminating_test` and `ladder`, which `DecisionMethod`
      // permits here. Nobody holds the authority personally, so the refusal
      // has to say where it lives or it is a dead end for the agent reading it.
      throw new ProtocolError(
        'NOT_TASK_AUTHORITY',
        `policy.taskAcceptance.method is "${method}": no participant may accept ${task.id} directly — ` +
          `open the decision with POST /decisions and let its outcome carry`,
      );
  }
}

/** Roles come from the config, not from `state.participants`: authority must not
 *  depend on who happens to have connected. Same source as `requireRole`. */
function roleOf(ctx: HandlerContext, who: ParticipantId): string | undefined {
  return ctx.config.participants.find((candidate) => candidate.id === who)?.role;
}

/* ------------------------------------------------------------- decisions -- */

export async function openDecision(ctx: HandlerContext, body: Body): Promise<CrosstalkEvent[]> {
  const ladder = body['ladder'] === undefined ? undefined : (readStringList(body, 'ladder') as LadderRung[]);
  if (ladder !== undefined) validateLadder(ladder);

  const decision: Decision = {
    id: `D-${ctx.state.decisions.size + 1}`,
    question: requireString(body, 'question'),
    options: readStringList(body, 'options'),
    voters: readStringList(body, 'voters'),
    method: requireString(body, 'method') as Decision['method'],
    rationale: [],
    votes: {},
    ...(ladder === undefined ? {} : { ladder, currentRung: 0 }),
    ...(body['claimId'] === undefined ? {} : { claimId: requireString(body, 'claimId') }),
    ...(body['deadline'] === undefined ? {} : { deadline: requireString(body, 'deadline') }),
  };

  // Task 0 minimum so the tree compiles. A decision about a claim belongs in
  // that claim's dispute room; anything else is project-wide. Waking the
  // voters is A2's job and is NOT done by this alone — room membership and
  // the voter list are different sets, which is the whole of claim C-1.
  return [await ctx.append({ kind: 'decision_opened', from: ctx.who, room: decisionRoom(decision), decision })];
}

/** A decision about a claim lives in its dispute room; anything else on the floor. */
export function decisionRoom(decision: Pick<Decision, 'claimId'>): string {
  return decision.claimId === undefined ? FLOOR : `dispute:${decision.claimId}`;
}

export async function castVote(
  ctx: HandlerContext,
  decisionId: string,
  body: Body,
): Promise<CrosstalkEvent[]> {
  const decision = ctx.state.decisions.get(decisionId);
  if (decision === undefined) {
    throw new ProtocolError('UNKNOWN_DECISION', `Unknown decision: ${decisionId}`);
  }
  if (!decision.voters.includes(ctx.who)) {
    throw new ProtocolError('NOT_ELIGIBLE_VOTER', `${ctx.who} is not a voter on ${decisionId}`);
  }

  const option = requireString(body, 'option');
  const rationale = (body['rationale'] ?? '') as unknown;
  if (typeof rationale !== 'string' || rationale.trim() === '') {
    throw new ProtocolError('VOTE_WITHOUT_RATIONALE', 'a vote requires a rationale');
  }

  const room = decisionRoom(decision);
  const events = [
    await ctx.append({ kind: 'vote_cast', from: ctx.who, room, decisionId, option, rationale }),
  ];

  const outcome = tally(ctx.state.decisions.get(decisionId)!, ctx.state);
  if (outcome !== null) {
    events.push(await ctx.append({ kind: 'decision_resolved', from: ctx.who, room, decisionId, outcome }));
  }
  return events;
}

/**
 * Propose a command whose result differs depending on who is right (§5.3).
 *
 * Crosstalk records the exchange and executes nothing: agents propose, run it
 * in their own workspace, and post the output as evidence. A daemon that
 * shelled out to whatever two arguing agents agreed on would be a remote code
 * execution hole, not a feature.
 */
export async function proposeTest(
  ctx: HandlerContext,
  decisionId: string,
  body: Body,
): Promise<CrosstalkEvent[]> {
  const decision = ctx.state.decisions.get(decisionId);
  if (decision === undefined) {
    throw new ProtocolError('UNKNOWN_DECISION', `Unknown decision: ${decisionId}`);
  }

  const claimId = decision.claimId;
  const current = currentRungOf(decision, ctx.state);
  if (claimId === undefined || current?.rung !== 'discriminating_test') {
    throw new ProtocolError(
      'RUNG_NOT_ACTIVE',
      `${decisionId} is not on the discriminating_test rung`,
    );
  }

  const claim = ctx.state.claims.get(claimId);
  if (claim !== undefined && ctx.who !== claim.raisedBy && ctx.who !== responderFor(claim, ctx.state)) {
    throw new ProtocolError(
      'NOT_CLAIM_RESPONDER',
      `${ctx.who} is not a party to ${claimId} and cannot propose its test`,
    );
  }

  const command = requireString(body, 'command');
  // Required for the same reason `Evidence.sha` is: two disputants running one
  // command at two commits get a difference explained by the diff between them,
  // not by who is right.
  const sha = requireString(body, 'sha');
  const predicts = readString(body, 'predicts');
  if (predicts.trim() === '') {
    throw new ProtocolError(
      'TEST_WITHOUT_PREDICTION',
      'a command nobody has predicted an outcome for discriminates nothing',
    );
  }

  return [
    await ctx.append({
      kind: 'test_proposed',
      from: ctx.who,
      room: `dispute:${claimId}`,
      decisionId,
      claimId,
      command,
      predicts,
      sha,
    }),
  ];
}

/* ----------------------------------------------------------------- reads -- */

export interface RosterEntry {
  id: ParticipantId;
  role: string;
  harness: string;
  model?: string;
  transport?: string;
  status: 'awaiting_turn' | 'active' | 'offline';
}

/**
 * @returns `you` first, deliberately.
 *
 * Identity is resolved from whichever `.mcp.json` a harness happened to find
 * from its working directory, and nothing echoed the answer back. Two sessions
 * started in the repo root both authenticated as the leader and neither could
 * tell: the envelope said `leader` while the message bodies said `metrics` and
 * `skeleton`, and the only detector was a human noticing they disagreed.
 *
 * Everything that routes on participant id degrades to one identity when that
 * happens — `raisedBy`, `adjudicatorFor`'s exclusion of the two disputants,
 * `taskAcceptance`, and the self-critique gate all stop holding apart the
 * things they exist to hold apart. So the first call an agent makes now
 * answers "who am I", whether or not it thought to ask.
 */
export function roster(
  ctx: Pick<HandlerContext, 'config' | 'state' | 'who'>,
  awaiting: ReadonlySet<ParticipantId>,
  /**
   * Has this participant been heard from recently? Presence used to mean "a
   * token was presented at some point", which never expired — one read-only
   * call from a human shell reported a never-started agent as `active` for the
   * life of the daemon.
   */
  isPresent: (who: ParticipantId) => boolean = (who) => ctx.state.participants.has(who),
): { you: ParticipantId; participants: RosterEntry[] } {
  const participants = ctx.config.participants.map((participant) => ({
    id: participant.id,
    role: participant.role,
    harness: participant.harness,
    ...(participant.model === undefined ? {} : { model: participant.model }),
    // Absent when unprobed: a defaulted `file` is indistinguishable from a
    // probed one, and only one of those claims is true (spec §10.1).
    ...(participant.transport === undefined ? {} : { transport: participant.transport }),
    status: awaiting.has(participant.id)
      ? ('awaiting_turn' as const)
      : isPresent(participant.id)
        ? ('active' as const)
        : ('offline' as const),
  }));
  return { you: ctx.who, participants };
}

export interface BoardEntry {
  id: string;
  title: string;
  assignee: ParticipantId;
  state: TaskState;
  branch: string;
  pr?: number;
}

/** Metadata only — no message bodies, so visibility scales past a dozen agents (spec §6.2). */
export function board(state: HubState): { tasks: BoardEntry[] } {
  return {
    tasks: [...state.tasks.values()].map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      state: task.state,
      branch: task.branch,
      ...(task.pr === undefined ? {} : { pr: task.pr }),
    })),
  };
}

export function myTasks(ctx: Pick<HandlerContext, 'who' | 'state'>): { tasks: Task[] } {
  return { tasks: [...ctx.state.tasks.values()].filter((task) => task.assignee === ctx.who) };
}

export function requireRoomMembership(ctx: Pick<HandlerContext, 'who' | 'state'>, room: string): void {
  if (!isMember(ctx.who, room, ctx.state)) {
    throw new DaemonError('NOT_A_ROOM_MEMBER', `${ctx.who} is not a member of ${room}`);
  }
}

/**
 * Does this event address `who`?
 *
 * The `from !== who` clause is deliberate: a wait that returns on the caller's
 * own writes is a busy loop that looks like progress.
 */
export function addressesParticipant(
  event: CrosstalkEvent,
  who: ParticipantId,
  state: HubState,
): boolean {
  if ('to' in event && event.to === who) return true;
  if (event.from === who) return false;

  // A decision addresses its voters, which is not the same set as its room's
  // membership: `membersOf('dispute:<id>')` adds a leader only for brief/spec
  // claims, so on a worker-vs-worker dispute the leader — the default terminal
  // rung — was never told about the decision it exists to rule on.
  if (votersOf(event, state)?.includes(who) === true) return true;

  return event.room !== undefined && isMember(who, event.room, state);
}

const DECISION_KINDS = [
  'decision_opened',
  'vote_cast',
  'decision_resolved',
  'rung_entered',
  'rung_failed',
] as const;

function votersOf(event: CrosstalkEvent, state: HubState): ParticipantId[] | undefined {
  if (!(DECISION_KINDS as readonly string[]).includes(event.kind)) return undefined;
  if (event.kind === 'decision_opened') return event.decision.voters;
  return 'decisionId' in event ? state.decisions.get(event.decisionId)?.voters : undefined;
}

/* --------------------------------------------------------------- helpers -- */

async function transitionIfLegal(
  ctx: HandlerContext,
  taskId: string,
  to: TaskState,
): Promise<CrosstalkEvent[]> {
  try {
    validateTransition(taskId, to, ctx.state);
  } catch {
    // The companion transition is a convenience, not the request's subject:
    // a task already past this point is not an error.
    return [];
  }
  return [
    await ctx.append({ kind: 'task_state', from: ctx.who, room: `task:${taskId}`, taskId, state: to }),
  ];
}

function requireTask(ctx: HandlerContext, taskId: string): Task {
  const task = ctx.state.tasks.get(taskId);
  if (task === undefined) throw new ProtocolError('UNKNOWN_TASK', `Unknown task: ${taskId}`);
  return task;
}

function requireAssignee(ctx: HandlerContext, task: Task, action: string): void {
  if (task.assignee !== ctx.who) {
    throw new DaemonError(
      'ROLE_NOT_PERMITTED',
      `${task.id} is assigned to ${task.assignee}; only the assignee may ${action} it`,
    );
  }
}

function requireRole(ctx: HandlerContext, role: string, route: string): void {
  const participant = ctx.config.participants.find((candidate) => candidate.id === ctx.who);
  if (participant?.role !== role) {
    throw new DaemonError('ROLE_NOT_PERMITTED', `${route} requires role ${role}`);
  }
}

/**
 * Requires the field to be a string but permits an empty one, so a validator
 * downstream — not the transport — decides whether empty is acceptable.
 */
function readString(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new DaemonError('MALFORMED_BODY', `\`${field}\` must be a string`);
  }
  return value;
}

function requireString(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw new DaemonError('MALFORMED_BODY', `\`${field}\` is required and must be a non-empty string`);
  }
  return value;
}

function readStringList(body: Body, field: string): string[] {
  const value = body[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new DaemonError('MALFORMED_BODY', `\`${field}\` must be an array of strings`);
  }
  return value as string[];
}

function readCritique(body: Body): CritiqueRecord {
  const value = body['critique'];
  if (value === null || typeof value !== 'object') {
    throw new DaemonError('MALFORMED_BODY', '`critique` is required');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['rounds'] !== 'number' || typeof record['critic'] !== 'string') {
    throw new DaemonError('MALFORMED_BODY', '`critique` requires `rounds` and `critic`');
  }
  if (!Array.isArray(record['findings'])) {
    // Zero findings is legal and recorded — the gate asks for a record, not for findings.
    throw new DaemonError('MALFORMED_BODY', '`critique.findings` must be an array');
  }
  return value as unknown as CritiqueRecord;
}

function readEvidenceList(body: Body, who: ParticipantId): Evidence[] {
  const value = body['evidence'];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DaemonError('MALFORMED_BODY', '`evidence` must be an array');
  }
  return value.map((item) => readEvidence({ evidence: item }, who));
}

function readEvidence(body: Body, who: ParticipantId): Evidence {
  const raw = (body['evidence'] ?? body) as Record<string, unknown>;
  const kind = raw['kind'];
  if (kind !== 'command' && kind !== 'file' && kind !== 'observation') {
    throw new DaemonError('MALFORMED_BODY', 'evidence.kind must be command, file or observation');
  }
  if (typeof raw['sha'] !== 'string' || raw['sha'] === '') {
    throw new DaemonError('MALFORMED_BODY', 'evidence requires a sha');
  }
  return {
    kind,
    sha: raw['sha'],
    // `by` is derived, never accepted — the daemon rejects a body that sets it
    // before this point is reached.
    by: who,
    ...(typeof raw['command'] === 'string' ? { command: raw['command'] } : {}),
    ...(typeof raw['output'] === 'string' ? { output: raw['output'] } : {}),
    ...(typeof raw['ref'] === 'string' ? { ref: raw['ref'] } : {}),
  };
}
