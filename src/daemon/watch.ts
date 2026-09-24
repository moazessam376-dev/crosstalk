import type { ParticipantId, Role } from '../contracts/participant.js';
import type { Task } from '../contracts/task.js';

/**
 * The quiet-seat watchdog, as a pure function.
 *
 * The operator's previous long runs were nine to twelve hours, and most of
 * that was silence: a builder that ended its turn with the task still open —
 * "stopping at a checkpoint nobody asked for" — and a supervisor that found
 * out on its next scheduled poll, twenty-five minutes later, at the cost of a
 * turn every twenty-five minutes whether anything had happened or not.
 *
 * Nothing here polls a model. The daemon already knows when a seat's turn
 * ended (the `Stop` hook, or the turn process exiting for a seat driven by
 * `codex exec resume`) and whether that seat still holds an open task. When
 * both are true for long enough, the seat is told — one card, in its own side
 * room, which wakes it — and if it stays quiet, the lead is told once. Every
 * decision after that is the lead's: wait, reassign, release.
 *
 * Two thresholds, both deliberately long. A builder mid-thought that gets a
 * nudge every minute is a builder being nagged, and a nudge is a turn the
 * operator pays for. Ten minutes of ended-turn silence over an open task is
 * not thinking.
 */
export const QUIET_AFTER_MS = 10 * 60_000;
export const ESCALATE_AFTER_MS = 10 * 60_000;

/** What the watchdog knows about one seat, assembled by the daemon. */
export interface SeatWatch {
  id: ParticipantId;
  role: Role;
  /** Last presence report. Absent when the seat has never reported one. */
  activity?: { working: boolean; at: number };
  /** Whether a process this daemon spawned is still behind the seat. Absent when nobody spawned it. */
  running?: boolean;
  /** When this seat last wrote anything to the log. */
  spokeAt?: number;
}

/** Per-seat memory between ticks, so an episode is reported once. */
export interface WatchMemory {
  /** The task the current quiet episode is about. */
  taskId?: string;
  nudgedAt?: number;
  escalatedAt?: number;
}

export type WatchAction =
  | { kind: 'nudge'; seat: ParticipantId; taskId: string; quietMs: number }
  | { kind: 'escalate'; seat: ParticipantId; taskId: string; quietMs: number; lead: ParticipantId; reason: 'quiet' | 'exited' }
  | { kind: 'lead-nudge'; lead: ParticipantId; taskId: string; quietMs: number };

const OPEN: ReadonlySet<Task['state']> = new Set(['assigned', 'acknowledged', 'in_progress', 'self_reviewed']);

/** How long a seat has been silent, or undefined when it is not. */
function quietFor(seat: SeatWatch, now: number): number | undefined {
  if (seat.activity === undefined || seat.activity.working) return undefined;
  const since = Math.max(seat.activity.at, seat.spokeAt ?? 0);
  return now - since;
}

/**
 * What to do this tick. Mutates `memory` so the next tick knows what was said.
 */
export function watchSeats(args: {
  now: number;
  seats: readonly SeatWatch[];
  tasks: Iterable<Task>;
  memory: Map<ParticipantId, WatchMemory>;
  quietAfterMs?: number;
  escalateAfterMs?: number;
}): WatchAction[] {
  const quietAfter = args.quietAfterMs ?? QUIET_AFTER_MS;
  const escalateAfter = args.escalateAfterMs ?? ESCALATE_AFTER_MS;
  const actions: WatchAction[] = [];
  const lead = args.seats.find((seat) => seat.role === 'leader');
  const tasks = [...args.tasks];

  for (const seat of args.seats) {
    if (seat.role !== 'worker' && seat.role !== 'peer') continue;
    const open = tasks.find((task) => task.assignee === seat.id && OPEN.has(task.state));
    const memory = args.memory.get(seat.id) ?? {};

    if (open === undefined) {
      args.memory.delete(seat.id);
      continue;
    }

    // A seat whose process has gone cannot be nudged: nothing is there to read
    // the card. That goes straight to the lead, once.
    if (seat.running === false) {
      if (lead !== undefined && memory.escalatedAt === undefined) {
        actions.push({ kind: 'escalate', seat: seat.id, taskId: open.id, quietMs: 0, lead: lead.id, reason: 'exited' });
        args.memory.set(seat.id, { taskId: open.id, escalatedAt: args.now });
      }
      continue;
    }

    const quiet = quietFor(seat, args.now);
    // Working again, or a different task: the episode is over.
    if (quiet === undefined || memory.taskId !== open.id) {
      args.memory.set(seat.id, quiet === undefined ? {} : { taskId: open.id });
      if (quiet === undefined) continue;
    }
    const current = args.memory.get(seat.id) ?? {};
    if (quiet < quietAfter) continue;

    if (current.nudgedAt === undefined) {
      actions.push({ kind: 'nudge', seat: seat.id, taskId: open.id, quietMs: quiet });
      args.memory.set(seat.id, { ...current, taskId: open.id, nudgedAt: args.now });
      continue;
    }
    if (current.escalatedAt === undefined && lead !== undefined && args.now - current.nudgedAt >= escalateAfter) {
      actions.push({ kind: 'escalate', seat: seat.id, taskId: open.id, quietMs: quiet, lead: lead.id, reason: 'quiet' });
      args.memory.set(seat.id, { ...current, escalatedAt: args.now });
    }
  }

  // The symmetric case: a builder said done and the lead ended its turn
  // without ruling on it. Nothing is polling the lead either, so it gets one
  // card per task it has left waiting.
  if (lead !== undefined) {
    const quiet = quietFor(lead, args.now);
    const waiting = tasks.filter((task) => task.state === 'submitted');
    const memory = args.memory.get(lead.id) ?? {};
    if (quiet === undefined || waiting.length === 0) {
      args.memory.delete(lead.id);
    } else if (quiet >= quietAfter) {
      const nudgedFor = new Set((memory.taskId ?? '').split(',').filter(Boolean));
      const fresh = waiting.filter((task) => !nudgedFor.has(task.id));
      for (const task of fresh) {
        actions.push({ kind: 'lead-nudge', lead: lead.id, taskId: task.id, quietMs: quiet });
        nudgedFor.add(task.id);
      }
      args.memory.set(lead.id, { taskId: [...nudgedFor].join(','), nudgedAt: args.now });
    }
  }

  return actions;
}

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

/** The card each action becomes. Head is the message; body says what to do. */
export function renderWatchAction(action: WatchAction): { to: ParticipantId; head: string; body: string } {
  switch (action.kind) {
    case 'nudge':
      return {
        to: action.seat,
        head: `You went quiet with ${action.taskId} still open`,
        body:
          `Your last turn ended ${minutes(action.quietMs)} ago and ${action.taskId} is not done. ` +
          'Either finish it and call `act({kind:"done"})`, or say what stopped you with `say({tag:"blocked", to:"<the lead>"})`. ' +
          'A turn that ends with the task open is read as abandoned; the lead is told next.',
      };
    case 'escalate':
      return {
        to: action.lead,
        head:
          action.reason === 'exited'
            ? `${action.seat}'s process exited with ${action.taskId} open`
            : `${action.seat} has been quiet ${minutes(action.quietMs)} on ${action.taskId}`,
        body:
          (action.reason === 'exited'
            ? `${action.seat} is no longer running and ${action.taskId} is still assigned to it. `
            : `${action.seat} was nudged and did not answer. `) +
          `Decide: wait, reassign ${action.taskId} to another seat, or release ${action.seat} with \`act({kind:"release", id:"${action.seat}"})\` and hire a replacement.`,
      };
    case 'lead-nudge':
      return {
        to: action.lead,
        head: `${action.taskId} is waiting on your verdict`,
        body:
          `${action.taskId} has been submitted for ${minutes(action.quietMs)} and your last turn ended without ruling on it. ` +
          'Run it, then `act({kind:"accept"})` or `act({kind:"reject", restatement:"..."})`. The builder is idle until you do.',
      };
  }
}
