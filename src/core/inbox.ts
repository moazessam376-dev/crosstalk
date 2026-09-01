import type { CrosstalkEvent } from '../contracts/events.js';
import type { ParticipantId, Role } from '../contracts/participant.js';
import { FLOOR, HUMAN_ID } from '../contracts/room.js';
import type { MessageTag } from '../contracts/say.js';
import type { HubState } from './projection.js';
import type { PhaseStatus } from './phase.js';

export type InboxRole = 'leader' | 'builder' | 'spoc' | 'observer' | 'human' | 'plan_reviewer' | 'peer';

export type InboxCardKind = 'said' | 'assigned' | 'acked' | 'done' | 'claim' | 'decision' | 'system';

export interface InboxCard {
  seq: number;
  kind: InboxCardKind;
  from: string;
  room?: string;
  /** One scannable line, for choosing what to read. */
  summary: string;
  /**
   * What was actually said, whole, up to `DELIVERY_BUDGET`.
   *
   * Beacon-1 shipped without this field, so a card was a 120-character clip and
   * nothing else — 5% of the strongest seat's output reached its teammates, and
   * the two findings that would have prevented a 21-minute duplicated build
   * were both cut mid-sentence. A summary is for scanning. This is the message.
   */
  body?: string;
  /** Set only when `body` was cut. Never silently: a fragment that reads whole is worse than one that admits it. */
  truncated?: true;
  /** The artifact the author pointed at for depth. */
  ref?: string;
  /** What the message is for. Absent on anything written before the amendment. */
  tag?: MessageTag;
  /** The slice this is about. */
  task?: string;
}

export interface InboxTask {
  id: string;
  title: string;
  state: string;
}

export interface Inbox {
  you: ParticipantId;
  role: InboxRole;
  unread: InboxCard[];
  mine: InboxTask[];
  /**
   * The work this seat should start from. Leader / SPOC / human get the
   * latest `@human` `#floor` body. A builder gets the brief of a task they
   * hold — never the floor novel. That split is first-edit ceremony.
   */
  job?: string;
  next?: string;
  /**
   * Where the team is, and what is stopping the next phase.
   *
   * Delivered with every turn rather than behind a fifth verb: the seat is told
   * the rule when it is about to act, which is the only moment a rule changes
   * anything. Absent when the roster names no shape.
   */
  phase?: PhaseStatus;
}

const SUMMARY_LIMIT = 120;

/**
 * How much of what was said a card carries.
 *
 * Wider than `SAY_LIMIT` on purpose: an agent-authored message is capped at
 * 1500 and so always arrives whole, and only an operator brief can reach this
 * ceiling. The budget exists so truncation is a policy with an owner rather
 * than a constant nobody can see.
 */
export const DELIVERY_BUDGET = 4000;

/** The body a card carries, and whether anything was cut. */
function carry(text: string): { body: string; truncated?: true } {
  if (text.length <= DELIVERY_BUDGET) return { body: text };
  return { body: `${text.slice(0, DELIVERY_BUDGET)}…`, truncated: true };
}

export function displayRole(role: Role): InboxRole {
  return role === 'worker' ? 'builder' : role;
}

export function renderInbox(args: {
  who: ParticipantId;
  role: Role;
  unread: CrosstalkEvent[];
  state: HubState;
  phase?: PhaseStatus;
}): Inbox {
  const unread = args.unread.map(cardFor);
  const mine = [...args.state.tasks.values()]
    .filter((task) => task.assignee === args.who)
    .map((task) => ({ id: task.id, title: task.title, state: task.state }));
  const floor = floorJob(args.state);
  const held = heldTask(args.state, args.who);
  const job = jobFor(args.role, floor, held);
  const submitted = [...args.state.tasks.values()]
    .filter((task) => task.state === 'submitted')
    .map((task) => task.id);
  const tasked = args.state.tasks.size > 0;

  const next = args.phase === undefined
    ? nextLine(unread, mine, args.role, floor, submitted, tasked)
    : phaseLine(args.phase);
  return {
    you: args.who,
    role: displayRole(args.role),
    unread,
    mine,
    ...(job === undefined ? {} : { job }),
    ...(next === undefined ? {} : { next }),
    ...(args.phase === undefined ? {} : { phase: args.phase }),
  };
}

function floorJob(state: HubState): string | undefined {
  let body: string | undefined;
  for (const event of state.messages) {
    if (event.kind === 'message' && event.room === FLOOR && event.from === HUMAN_ID) {
      body = event.body;
    }
  }
  return body;
}

const ACTIVE_TASK: ReadonlySet<string> = new Set([
  'assigned',
  'acknowledged',
  'in_progress',
  'self_reviewed',
]);

function heldTask(state: HubState, who: ParticipantId) {
  return [...state.tasks.values()].find((task) => task.assignee === who && ACTIVE_TASK.has(task.state));
}

function jobFor(role: Role, floor: string | undefined, held: { id: string; title: string; brief: string } | undefined): string | undefined {
  if (role === 'worker') {
    if (held === undefined) return undefined;
    return `${held.id} ${held.title}\n\n${held.brief}`;
  }
  return floor;
}

/**
 * With a shape, `next` is the phase — not a guess assembled from role and
 * inbox shape. The blocking reason comes with it, because "you are in build"
 * without "waiting on sonnet" sends the seat to ask on the board, which is the
 * traffic the shape exists to remove.
 */
function phaseLine(phase: PhaseStatus): string {
  if (phase.complete) return 'every gate is met';
  if (phase.blocking.length === 0) return `${phase.id} — ready to advance`;
  return `${phase.id}: ${phase.blocking.join('; ')}`;
}

function nextLine(
  unread: InboxCard[],
  mine: InboxTask[],
  role: Role,
  floor: string | undefined,
  submitted: string[],
  tasked: boolean,
): string | undefined {
  const assigned = unread.find((card) => card.kind === 'assigned');
  if (assigned !== undefined) return assigned.summary;
  const held = mine.find((task) => task.state === 'assigned' || task.state === 'acknowledged');
  if (held !== undefined) return `${held.id} is assigned to you`;
  if (role === 'worker' && mine.length === 0) return 'idle';
  // A peer's work comes from the floor, not from an assignment: with a job
  // posted it should be building, and with unread cards it should read them.
  if (role === 'peer') {
    if (unread.length > 0) return undefined;
    return floor === undefined ? 'idle' : 'build from #floor';
  }
  if ((role === 'leader' || role === 'spoc' || role === 'human') && submitted[0] !== undefined) {
    return `${submitted[0]} is submitted — accept`;
  }
  if (floor !== undefined && role === 'leader' && !tasked) return 'cut tasks from #floor';
  // Builders wait for assign. next stays `idle` so GET /inbox still blocks.
  // "job on #floor — start" made them read the novel and lose first-edit ceremony.
  if (role === 'leader' && tasked && submitted.length === 0) return 'idle';
  const claim = unread.find((card) => card.kind === 'claim');
  if (claim !== undefined) return claim.summary;
  if (unread.length === 0) return 'idle';
  return undefined;
}

export function cardFor(event: CrosstalkEvent): InboxCard {
  const base = {
    seq: event.seq,
    from: event.from,
    ...('room' in event && event.room !== undefined ? { room: event.room } : {}),
  };

  switch (event.kind) {
    case 'message':
      return {
        ...base,
        kind: 'said',
        // The author's own line when there is one. A clip at 120 characters is
        // a guess at what mattered, made by the reader's tooling; `head` is the
        // same judgement made by the only party who knows.
        summary: event.head ?? clip(event.body),
        ...carry(event.body),
        ...(event.ref === undefined ? {} : { ref: event.ref }),
        ...(event.tag === undefined ? {} : { tag: event.tag }),
        ...(event.task === undefined ? {} : { task: event.task }),
      };
    case 'task_created':
      return {
        ...base,
        kind: 'assigned',
        summary: clip(`${event.task.id} assigned: ${event.task.title}`),
      };
    case 'brief_ack':
      return { ...base, kind: 'acked', summary: `${event.taskId} acked` };
    case 'self_review':
    case 'task_state':
      if (event.kind === 'task_state' && event.state === 'submitted') {
        return { ...base, kind: 'done', summary: `${event.taskId} submitted` };
      }
      if (event.kind === 'self_review') {
        return { ...base, kind: 'done', summary: `${event.taskId} done` };
      }
      return { ...base, kind: 'system', summary: clip(`${event.kind} ${event.taskId} ${event.state}`) };
    case 'claim_raised':
      // The assertion is the claim. Clipping it to 120 leaves the reader with
      // an id and half a sentence to rule on.
      return {
        ...base,
        kind: 'claim',
        summary: clip(`${event.claim.id} raised: ${event.claim.assertion}`),
        ...carry(event.claim.assertion),
      };
    case 'claim_response':
      return { ...base, kind: 'claim', summary: clip(`${event.claimId} ${event.verdict}`) };
    case 'decision_opened':
      return { ...base, kind: 'decision', summary: clip(`decision: ${event.decision.question}`) };
    case 'vote_cast':
    case 'decision_resolved':
    case 'rung_entered':
    case 'rung_failed':
    case 'test_proposed':
      return { ...base, kind: 'decision', summary: clip(event.kind) };
    default:
      return { ...base, kind: 'system', summary: clip(event.kind) };
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUMMARY_LIMIT) return flat;
  return `${flat.slice(0, SUMMARY_LIMIT - 1)}…`;
}
