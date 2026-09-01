import type { CrosstalkEvent } from '../contracts/events.js';
import type { ParticipantId, Role } from '../contracts/participant.js';
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
  /** The role this phase belongs to. Seats of other roles have nothing to do. */
  owner?: Role;
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

/**
 * Has the planner put a real choice to the operator and had it answered?
 *
 * A `Decision` is already a question, a list of options, who may answer and
 * what they chose — an operator-facing multiple choice, complete, in the
 * protocol since v1 and filed under a tool described as "Court only", so nobody
 * ever reached for it to plan with.
 *
 * Derived from the log rather than self-reported, because "plan with the
 * operator first" is exactly the kind of instruction that reads well in a brief
 * and changes nothing: the vault-team brief told every seat to use side rooms,
 * twice, and none did.
 */
export const LOG_GATES: readonly GateId[] = ['operator-questioned'];

export function operatorWasAsked(events: readonly CrosstalkEvent[]): boolean {
  const asked = new Set<string>();
  for (const event of events) {
    if (event.kind === 'decision_opened' && event.decision.method === 'human') {
      asked.add(event.decision.id);
    }
    // Answered, not merely posed. A question nobody replied to has not been a
    // conversation with anybody.
    if (event.kind === 'decision_resolved' && asked.has(event.decisionId)) return true;
    if (event.kind === 'vote_cast' && asked.has(event.decisionId) && event.from === HUMAN_ID) return true;
  }
  return false;
}

function statusOf(
  gate: Phase['exit'][number],
  args: {
    asserted: Map<GateId, Set<ParticipantId>>;
    seats: readonly ParticipantId[];
    workspace: WorkspaceGates;
    log: ReadonlySet<GateId>;
  },
): GateStatus {
  if (gate.by === 'log') {
    return args.log.has(gate.id)
      ? { id: gate.id, need: gate.need, met: true }
      : { id: gate.id, need: gate.need, met: false, missing: gate.need };
  }

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
  const log = new Set<GateId>();
  if (operatorWasAsked(args.events)) log.add('operator-questioned');

  for (const phase of shape.phases) {
    const gates = phase.exit.map((gate) => statusOf(gate, { asserted, seats, workspace, log }));
    // Name the gate, not just the reason. A phase can hold on two gates with
    // the same quorum — `tests-green` and `self-verified` both wait on every
    // seat — and "waiting on opus, sonnet, luna" twice over tells a seat
    // nothing about which of the two it still owes.
    const blocking = gates
      .filter((gate) => !gate.met)
      .map((gate) => `${gate.id} — ${gate.missing ?? gate.need}`);
    if (blocking.length > 0) {
      return {
        id: phase.id,
        intent: phase.intent,
        writes: phase.writes,
        gates,
        blocking,
        complete: false,
        ...(phase.owner === undefined ? {} : { owner: phase.owner }),
      };
    }
  }

  const last = shape.phases[shape.phases.length - 1]!;
  return {
    id: last.id,
    intent: 'Every gate is met.',
    writes: last.writes,
    gates: last.exit.map((gate) => statusOf(gate, { asserted, seats, workspace, log })),
    blocking: [],
    complete: true,
  };
}
