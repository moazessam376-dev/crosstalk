import type { CrosstalkEvent } from '../contracts/events.js';
import type { ParticipantId } from '../contracts/participant.js';
import { FLOOR, HUMAN_ID } from '../contracts/room.js';
import { gateOfRef, type GateId, type Phase, type PhaseId, type TeamShape, type WriteScope } from './shape.js';

export interface GateStatus {
  id: GateId;
  need: string;
  met: boolean;
  /** Why not, in a form the seat can act on. */
  missing?: string;
}

export interface PhaseStatus {
  id: PhaseId;
  intent: string;
  writes: WriteScope;
  gates: GateStatus[];
  /** The needs still open. Empty means this phase is ready to leave. */
  blocking: string[];
  /** True when every phase in the shape has been left. */
  complete: boolean;
}

/** What a workspace check found. Supplied by the caller so this module stays pure. */
export type WorkspaceGates = ReadonlyMap<GateId, { met: boolean; missing?: string }>;

/**
 * Who has asserted which gate.
 *
 * An assertion is a board message carrying `ref: gate:<id>`. Reusing `ref`
 * rather than inventing an event kind keeps the log's vocabulary fixed and puts
 * the claim's *body* next to the claim — the split a seat is taking, or the bug
 * list, is the message, not a flag beside it.
 */
export function assertedGates(events: readonly CrosstalkEvent[]): Map<GateId, Set<ParticipantId>> {
  const asserted = new Map<GateId, Set<ParticipantId>>();
  for (const event of events) {
    if (event.kind !== 'message' || event.room !== FLOOR) continue;
    const id = gateOfRef(event.ref);
    if (id === undefined) continue;
    const seats = asserted.get(id) ?? new Set<ParticipantId>();
    seats.add(event.from);
    asserted.set(id, seats);
  }
  return asserted;
}

function statusOf(
  gate: Phase['exit'][number],
  args: { asserted: Map<GateId, Set<ParticipantId>>; seats: readonly ParticipantId[]; workspace: WorkspaceGates },
): GateStatus {
  if (gate.by === 'workspace') {
    const found = args.workspace.get(gate.id);
    if (found === undefined) {
      return { id: gate.id, need: gate.need, met: false, missing: 'not checked yet' };
    }
    return {
      id: gate.id,
      need: gate.need,
      met: found.met,
      ...(found.missing === undefined ? {} : { missing: found.missing }),
    };
  }

  const said = args.asserted.get(gate.id) ?? new Set<ParticipantId>();
  if (gate.quorum === 'all') {
    const silent = args.seats.filter((seat) => !said.has(seat));
    return silent.length === 0
      ? { id: gate.id, need: gate.need, met: true }
      : { id: gate.id, need: gate.need, met: false, missing: `waiting on ${silent.join(', ')}` };
  }

  return said.size > 0
    ? { id: gate.id, need: gate.need, met: true }
    : { id: gate.id, need: gate.need, met: false, missing: 'nobody has posted it' };
}

/**
 * Where the team is, derived rather than stored.
 *
 * A phase is a function of the world: the first one whose gates are not all
 * met. Nothing records a transition, so nothing can record a wrong one — and a
 * gate that stops being true takes the team back, which is the honest
 * behaviour when a merge undoes a split.
 */
export function phaseStatus(
  shape: TeamShape,
  args: {
    events: readonly CrosstalkEvent[];
    participants: readonly ParticipantId[];
    workspace?: WorkspaceGates;
  },
): PhaseStatus {
  const asserted = assertedGates(args.events);
  const seats = args.participants.filter((id) => id !== HUMAN_ID);
  const workspace = args.workspace ?? new Map();

  for (const phase of shape.phases) {
    const gates = phase.exit.map((gate) => statusOf(gate, { asserted, seats, workspace }));
    const blocking = gates.filter((gate) => !gate.met).map((gate) => gate.missing ?? gate.need);
    if (blocking.length > 0) {
      return { id: phase.id, intent: phase.intent, writes: phase.writes, gates, blocking, complete: false };
    }
  }

  const last = shape.phases[shape.phases.length - 1]!;
  return {
    id: last.id,
    intent: 'Every gate is met.',
    writes: last.writes,
    gates: last.exit.map((gate) => statusOf(gate, { asserted, seats, workspace })),
    blocking: [],
    complete: true,
  };
}
