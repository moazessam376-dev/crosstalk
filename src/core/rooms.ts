import { FLOOR, HUMAN_ID } from '../contracts/room.js';
import type { RoomId, RoomKind } from '../contracts/room.js';
import type { ParticipantId } from '../contracts/participant.js';
import type { HubState } from './projection.js';

export function parseRoom(id: RoomId): { kind: RoomKind; parts: string[] } {
  if (id === FLOOR) {
    return { kind: 'floor', parts: [] };
  }

  if (id.startsWith('dm:')) {
    return { kind: 'dm', parts: splitParts(id, 'dm:') };
  }

  if (id.startsWith('task:')) {
    return { kind: 'task', parts: [id.slice('task:'.length)] };
  }

  if (id.startsWith('dispute:')) {
    return { kind: 'dispute', parts: [id.slice('dispute:'.length)] };
  }

  throw new Error(`Unknown room id: ${id}`);
}

export function dmId(a: ParticipantId, b: ParticipantId): RoomId {
  const [left, right] = [a, b].sort((x, y) => x.localeCompare(y));
  return `dm:${left}~${right}`;
}

export function membersOf(id: RoomId, state: HubState): ParticipantId[] {
  const room = parseRoom(id);

  switch (room.kind) {
    case 'floor':
      return withHuman([...state.participants.keys()]);
    case 'dm':
      return withHuman(room.parts as ParticipantId[]);
    case 'task': {
      const taskId = room.parts[0] ?? '';
      const task = state.tasks.get(taskId);
      const leaders = [...state.participants.values()]
        .filter((participant) => participant.role === 'leader')
        .map((participant) => participant.id);
      return withHuman(task === undefined ? leaders : [...leaders, task.assignee]);
    }
    case 'dispute': {
      const claimId = room.parts[0] ?? '';
      const claim = state.claims.get(claimId);
      if (claim === undefined || claim.against === 'brief' || claim.against === 'spec') {
        return withHuman([]);
      }

      const observers = [...state.participants.values()]
        .filter((participant) => participant.role === 'worker')
        .map((participant) => participant.id)
        .filter((participantId) => participantId !== claim.raisedBy && participantId !== claim.against);

      return withHuman([claim.raisedBy, claim.against, ...observers]);
    }
  }
}

export function isMember(who: ParticipantId, id: RoomId, state: HubState): boolean {
  return membersOf(id, state).includes(who);
}

function splitParts(id: RoomId, prefix: string): string[] {
  const body = id.slice(prefix.length);
  return body === '' ? [] : body.split('~');
}

function withHuman(ids: ParticipantId[]): ParticipantId[] {
  return [...new Set([...ids, HUMAN_ID])];
}
