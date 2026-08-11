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

/**
 * The canonical spelling of a room id.
 *
 * `dmId` sorts its two participants, but nothing sorted an id arriving from
 * outside — a CLI argument, an MCP call, a request written by hand. So
 * `dm:leader~codex` and `dm:codex~leader` addressed two different rooms with
 * identical membership: two entries in the sidebar, neither showing the other's
 * messages, and `membersOf` cheerfully resolving both.
 *
 * Applied on the way in *and* on the way out. The read path filters
 * `event.room === room` on the raw string, so normalising only on append would
 * make a room that accepts messages and then returns none of them.
 *
 * Only `dm:` ids are touched. A malformed one — no `~`, or more than two parts —
 * is returned unchanged, so the refusal happens downstream where the message can
 * name the real problem instead of here, where it would become a plausible id
 * for a room nobody asked for.
 */
export function normaliseRoom(id: RoomId): RoomId {
  if (!id.startsWith('dm:')) return id;
  const parts = splitParts(id, 'dm:');
  if (parts.length !== 2) return id;
  return dmId(parts[0] as ParticipantId, parts[1] as ParticipantId);
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
      if (claim === undefined) {
        return withHuman([]);
      }

      const parties: ParticipantId[] = [claim.raisedBy];
      if (claim.against !== 'brief' && claim.against !== 'spec') {
        parties.push(claim.against);
      } else {
        const briefOwner = [...state.participants.values()].find((participant) => participant.role === 'leader');
        if (briefOwner !== undefined && !parties.includes(briefOwner.id)) {
          parties.push(briefOwner.id);
        }
      }

      const observers = [...state.participants.values()]
        .filter((participant) => participant.role === 'worker')
        .map((participant) => participant.id)
        .filter((participantId) => !parties.includes(participantId));

      return withHuman([...parties, ...observers]);
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