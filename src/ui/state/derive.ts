import type { CrosstalkEvent } from '../../contracts/events.js';
import type { Participant, Tier } from '../../contracts/participant.js';

export type ParticipantStatus = 'awaiting_turn' | 'working' | 'offline';
export type ChannelKind = 'floor' | 'task' | 'dispute' | 'direct';

export interface ParticipantView extends Pick<Participant, 'id' | 'role'> {
  status: ParticipantStatus;
  tier: Tier;
}

export interface ChannelRoom {
  id: string;
  kind: ChannelKind;
  rounds?: number;
  maxRounds?: number;
  awaitingHuman?: boolean;
}

export interface HubState {
  participants: ParticipantView[];
  rooms: ChannelRoom[];
  events: CrosstalkEvent[];
  lastSeq: number;
}

const DEFAULT_MAX_ROUNDS = 3;

function sortBySequence(events: readonly CrosstalkEvent[]): CrosstalkEvent[] {
  return [...events].sort((left, right) => left.seq - right.seq);
}

function channelKind(roomId: string): ChannelKind {
  if (roomId === '#floor') return 'floor';
  if (roomId.startsWith('task:')) return 'task';
  if (roomId.startsWith('dispute:')) return 'dispute';
  return 'direct';
}

function statusForEvent(event: CrosstalkEvent): ParticipantStatus {
  return event.kind === 'participant_left' ? 'offline' : event.kind === 'participant_joined' ? 'awaiting_turn' : 'working';
}

function latestParticipantEvents(events: readonly CrosstalkEvent[]): Map<string, CrosstalkEvent> {
  const latest = new Map<string, CrosstalkEvent>();
  for (const event of events) {
    const participantId =
      event.kind === 'participant_joined'
        ? event.participant.id
        : event.kind === 'participant_left'
          ? event.participantId
          : event.from;
    latest.set(participantId, event);
  }
  return latest;
}

function projectParticipants(events: readonly CrosstalkEvent[]): ParticipantView[] {
  const participants = new Map<string, Participant>();
  for (const event of events) {
    if (event.kind === 'participant_joined') participants.set(event.participant.id, event.participant);
  }

  const latest = latestParticipantEvents(events);
  return [...participants.values()]
    .map((participant) => ({
      id: participant.id,
      role: participant.role,
      status: latest.has(participant.id) ? statusForEvent(latest.get(participant.id)!) : 'awaiting_turn',
      tier: participant.transport ?? 'file',
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function projectRooms(events: readonly CrosstalkEvent[]): ChannelRoom[] {
  const rooms = new Map<string, ChannelRoom>();
  const decisionRooms = new Map<string, string | undefined>();
  const pendingHumanByRoom = new Map<string, Set<string>>();

  for (const event of events) {
    if (event.room && !rooms.has(event.room)) {
      rooms.set(event.room, { id: event.room, kind: channelKind(event.room) });
    }

    if (event.kind === 'claim_raised' && event.room) {
      const room = rooms.get(event.room);
      if (room?.kind === 'dispute') {
        room.rounds = event.claim.rounds;
        room.maxRounds = DEFAULT_MAX_ROUNDS;
      }
    }

    if (event.kind === 'claim_response' && event.room) {
      const room = rooms.get(event.room);
      if (room?.kind === 'dispute') {
        room.rounds = (room.rounds ?? 0) + 1;
        room.maxRounds = DEFAULT_MAX_ROUNDS;
      }
    }

    if (event.kind === 'decision_opened') {
      const decision = event.decision;
      const awaitingHuman = decision.method === 'human' || decision.ladder?.[decision.currentRung ?? 0] === 'human';
      decisionRooms.set(decision.id, event.room);
      if (event.room) {
        if (awaitingHuman) {
          let pending = pendingHumanByRoom.get(event.room);
          if (!pending) {
            pending = new Set<string>();
            pendingHumanByRoom.set(event.room, pending);
          }
          pending.add(decision.id);
        }
        const room = rooms.get(event.room);
        if (room) room.awaitingHuman = (pendingHumanByRoom.get(event.room)?.size ?? 0) > 0;
      }
    }

    if (event.kind === 'decision_resolved') {
      const roomId = decisionRooms.get(event.decisionId);
      if (roomId) {
        pendingHumanByRoom.get(roomId)?.delete(event.decisionId);
        const room = rooms.get(roomId);
        if (room) room.awaitingHuman = (pendingHumanByRoom.get(roomId)?.size ?? 0) > 0;
      }
    }
  }

  return [...rooms.values()];
}

/** Build a read-only UI projection; replay order is always the event sequence. */
export function deriveState(input: readonly CrosstalkEvent[]): HubState {
  const events = sortBySequence(input);
  return {
    participants: projectParticipants(events),
    rooms: projectRooms(events),
    events,
    lastSeq: events.at(-1)?.seq ?? 0,
  };
}
