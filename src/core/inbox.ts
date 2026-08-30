import type { CrosstalkEvent } from '../contracts/events.js';
import type { ParticipantId, Role } from '../contracts/participant.js';
import { FLOOR, HUMAN_ID } from '../contracts/room.js';
import type { HubState } from './projection.js';

export type InboxRole = 'leader' | 'builder' | 'spoc' | 'observer' | 'human' | 'plan_reviewer';

export type InboxCardKind = 'said' | 'assigned' | 'acked' | 'done' | 'claim' | 'decision' | 'system';

export interface InboxCard {
  seq: number;
  kind: InboxCardKind;
  from: string;
  room?: string;
  summary: string;
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
  /** Latest `#floor` body from `@human`. Not clipped — this is the job. */
  job?: string;
  next?: string;
}

const SUMMARY_LIMIT = 120;

export function displayRole(role: Role): InboxRole {
  return role === 'worker' ? 'builder' : role;
}

export function renderInbox(args: {
  who: ParticipantId;
  role: Role;
  unread: CrosstalkEvent[];
  state: HubState;
}): Inbox {
  const unread = args.unread.map(cardFor);
  const mine = [...args.state.tasks.values()]
    .filter((task) => task.assignee === args.who)
    .map((task) => ({ id: task.id, title: task.title, state: task.state }));
  const job = floorJob(args.state);
  const submitted = [...args.state.tasks.values()]
    .filter((task) => task.state === 'submitted')
    .map((task) => task.id);

  const next = nextLine(unread, mine, args.role, job, submitted);
  return {
    you: args.who,
    role: displayRole(args.role),
    unread,
    mine,
    ...(job === undefined ? {} : { job }),
    ...(next === undefined ? {} : { next }),
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

function nextLine(
  unread: InboxCard[],
  mine: InboxTask[],
  role: Role,
  job: string | undefined,
  submitted: string[],
): string | undefined {
  const assigned = unread.find((card) => card.kind === 'assigned');
  if (assigned !== undefined) return assigned.summary;
  const claim = unread.find((card) => card.kind === 'claim');
  if (claim !== undefined) return claim.summary;
  const held = mine.find((task) => task.state === 'assigned' || task.state === 'acknowledged');
  if (held !== undefined) return `${held.id} is assigned to you`;
  if ((role === 'leader' || role === 'spoc' || role === 'human') && submitted[0] !== undefined) {
    return `${submitted[0]} is submitted — accept`;
  }
  if (job !== undefined) {
    if (role === 'leader') return 'cut tasks from #floor';
    if (role === 'worker') return 'job on #floor — start';
  }
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
      return { ...base, kind: 'said', summary: clip(event.body) };
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
      return {
        ...base,
        kind: 'claim',
        summary: clip(`${event.claim.id} raised: ${event.claim.assertion}`),
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
