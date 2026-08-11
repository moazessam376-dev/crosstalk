import type { CrosstalkEvent } from '../../contracts/events.js';
import type { Participant, Tier } from '../../contracts/participant.js';
import { FLOOR } from '../../contracts/room.js';

export type ParticipantStatus = 'awaiting_turn' | 'working' | 'offline';
export type ChannelKind = 'floor' | 'task' | 'dispute' | 'direct';

export interface ParticipantView extends Pick<Participant, 'id' | 'role' | 'harness' | 'workspace'> {
  status: ParticipantStatus;
  /** Absent when the participant's transport has not been probed. */
  tier?: Tier;
  /** A harness does not identify a model, and the dock shows both. */
  model?: string;
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
      harness: participant.harness,
      workspace: participant.workspace,
      model: participant.model,
      status: latest.has(participant.id) ? statusForEvent(latest.get(participant.id)!) : 'awaiting_turn',
      // Undefined means "not probed" and must stay undefined — `Tier` has no
      // unknown member, so a defaulted `file` is indistinguishable from a
      // probed `file`. Spec §10.1; the rail omits the badge entirely.
      tier: participant.transport,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

interface DecisionTrack {
  room: string;
  method: string;
  ladder?: readonly string[];
  /** The live rung, per rule 1 of the freeze. */
  rung: number;
  resolved: boolean;
}

/**
 * Whether a decision is sitting on the human.
 *
 * Read from the live rung, never from `decision.currentRung` alone. Computed
 * from the open-time snapshot, this fired only when `human` was the *first*
 * rung — so a dispute that escalated all the way to the person holding
 * terminal authority never told them (spec §10.3).
 */
function awaitsHuman(track: DecisionTrack): boolean {
  if (track.resolved) return false;
  return track.method === 'human' || track.ladder?.[track.rung] === 'human';
}

function projectRooms(events: readonly CrosstalkEvent[], maxRounds?: number): ChannelRoom[] {
  const rooms = new Map<string, ChannelRoom>();
  // #floor is seeded, not derived. It must exist before anyone has spoken, so
  // a log whose participants never posted there would otherwise contain no
  // evidence it exists at all. Spec §4.2. Every other room stays event-derived.
  rooms.set(FLOOR, { id: FLOOR, kind: channelKind(FLOOR) });
  const decisions = new Map<string, DecisionTrack>();

  for (const event of events) {
    if (event.room && !rooms.has(event.room)) {
      rooms.set(event.room, { id: event.room, kind: channelKind(event.room) });
    }

    if (event.kind === 'claim_raised' && event.room) {
      const room = rooms.get(event.room);
      if (room?.kind === 'dispute') {
        room.rounds = event.claim.rounds;
        room.maxRounds = maxRounds;
      }
    }

    if (event.kind === 'claim_response' && event.room) {
      const room = rooms.get(event.room);
      if (room?.kind === 'dispute') {
        room.rounds = (room.rounds ?? 0) + 1;
        room.maxRounds = maxRounds;
      }
    }

    if (event.kind === 'decision_opened' && event.room) {
      decisions.set(event.decision.id, {
        room: event.room,
        method: event.decision.method,
        ladder: event.decision.ladder,
        rung: event.decision.currentRung ?? 0,
        resolved: false,
      });
    }

    // Rule 1: the live rung is the last `rung_entered`, not the open-time
    // snapshot. This is the event that moves the badge.
    if (event.kind === 'rung_entered') {
      const track = decisions.get(event.decisionId);
      if (track) track.rung = event.index;
    }

    if (event.kind === 'decision_resolved') {
      const track = decisions.get(event.decisionId);
      if (track) track.resolved = true;
    }
  }

  for (const room of rooms.values()) {
    const pending = [...decisions.values()].filter((track) => track.room === room.id && awaitsHuman(track));
    if (pending.length > 0) room.awaitingHuman = true;
  }

  return [...rooms.values()];
}

/**
 * Build a read-only UI projection; replay order is always the event sequence.
 *
 * `maxRounds` comes from the daemon's `/config.json` and is threaded in rather
 * than defaulted. It is genuinely absent in fixture mode, and the honest render
 * for an unknown denominator is no denominator — the two hard-coded 3s this
 * replaces disagreed with each other and with the running config.
 */
export function deriveState(input: readonly CrosstalkEvent[], maxRounds?: number): HubState {
  const events = sortBySequence(input);
  return {
    participants: projectParticipants(events),
    rooms: projectRooms(events, maxRounds),
    events,
    lastSeq: events.at(-1)?.seq ?? 0,
  };
}
