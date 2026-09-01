import { randomBytes } from 'node:crypto';

import type { CrosstalkEvent, DraftEvent } from '../contracts/events.js';
import { FLOOR, SYSTEM_ID } from '../contracts/room.js';

/**
 * A run is a range of the log, and its boundary is a message.
 *
 * There was no run concept at all: one flat `.crosstalk/events.jsonl` per
 * repository, never partitioned, replayed from seq 1 on every page load. The
 * operator opened the hub and read a bench run from the previous day — 1187
 * events, 982 KB — because the hub asks for the whole file and the daemon has
 * no reason to say no.
 *
 * ## Why a message and not an event kind
 *
 * CONTEXT.md forbids **new event kinds**, and it is right to: every reader
 * switches on `kind`, and a kind nobody handles is a blank card. `ref` is
 * already a namespaced scheme — `gate:<id>`, read by `assertedGates` — and
 * `phase.ts` makes the argument in as many words: reusing `ref` rather than
 * inventing a kind keeps the log's vocabulary fixed. This is that pattern's
 * second tenant, and the two are tested against each other in both directions,
 * because a run marker that read as a gate assertion would silently satisfy a
 * phase gate.
 *
 * ## Why the id is a pattern and not just a string
 *
 * An archived run lives at `.crosstalk/runs/<id>.jsonl`, and the id is the one
 * part of that path a client picks — `GET /runs/:id/events` takes it off the
 * URL. So it is validated as an *id* before anything treats it as a path, and
 * the path is rebuilt from the validated id rather than sanitised after the
 * fact. Refusing the wrong shape is easier to get right than escaping it.
 */

/** `r-20260902-1412-a3f1c9` — sortable by time, unique inside a minute. */
export const RUN_ID_PATTERN = /^r-\d{8}-\d{4}-[0-9a-f]{6}$/;

const RUN_SCHEME = 'run:';

function twoDigit(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * A new run id, stamped with local time.
 *
 * Local rather than UTC because the operator reads these in a picker beside
 * "today 14:12" and a run that says 21:12 when they started it at 14:12 is a
 * run they cannot find. The random suffix is what makes two launches inside one
 * minute two different archives rather than one overwritten one.
 */
export function newRunId(now: Date): string {
  const stamp =
    `${now.getFullYear()}${twoDigit(now.getMonth() + 1)}${twoDigit(now.getDate())}` +
    `-${twoDigit(now.getHours())}${twoDigit(now.getMinutes())}`;
  return `r-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function runRef(id: string): string {
  return `${RUN_SCHEME}${id}`;
}

/** The run id on a `ref`, or undefined — including for a ref that is malformed. */
export function runIdOfRef(ref: string | undefined): string | undefined {
  if (ref === undefined || !ref.startsWith(RUN_SCHEME)) return undefined;
  const id = ref.slice(RUN_SCHEME.length);
  return RUN_ID_PATTERN.test(id) ? id : undefined;
}

/**
 * The boundary itself.
 *
 * On `#floor` and not in a `run:` room, because `parseRoom` throws on an
 * unknown prefix and the sidebar files anything it does not know under DIRECT.
 * From `@crosstalk`, which already exists for exactly this — the daemon
 * speaking for itself, about something no participant asked for.
 */
export function runMarker(id: string): DraftEvent {
  return {
    kind: 'message',
    from: SYSTEM_ID,
    room: FLOOR,
    head: `run ${id}`,
    body: `run ${id}`,
    ref: runRef(id),
  } as DraftEvent;
}

/**
 * Whether this event begins a run.
 *
 * The author check is not decoration. `ref` is free text every seat can write,
 * so without it any agent could end the run — and, worse, could do it by
 * accident while quoting one.
 */
export function isRunStart(event: CrosstalkEvent): boolean {
  return (
    event.kind === 'message' &&
    event.from === SYSTEM_ID &&
    runIdOfRef((event as { ref?: string }).ref) !== undefined
  );
}

/** The id of the run this event begins, or undefined. */
export function runIdOf(event: CrosstalkEvent): string | undefined {
  return isRunStart(event) ? runIdOfRef((event as { ref?: string }).ref) : undefined;
}

/** What the operator sees in the run picker. */
export interface RunSummary {
  id: string;
  startedAt: string;
  /** The marker's own seq. Every event in the run is at or above it. */
  firstSeq: number;
  /** The seq the next run starts at, absent while this run is current. */
  endedSeq?: number;
  events: number;
  archived: boolean;
  current: boolean;
  /** The job the run was started with, when it was given one. */
  job?: string;
}
