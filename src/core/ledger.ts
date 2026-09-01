import type { CrosstalkEvent } from '../contracts/events.js';
import { FLOOR, HUMAN_ID } from '../contracts/room.js';
import type { ParticipantId } from '../contracts/participant.js';
import { isMessageTag, type MessageTag } from '../contracts/say.js';

/**
 * What a run cost, per seat, from the log it already wrote.
 *
 * There was no accounting at all — `.crosstalk/tokens/` holds bearer tokens,
 * not counts — so no change to the board could be shown to have worked. The
 * vault run was measured by hand with `jq`, six figures at a time, and "the
 * honest test is a re-run" means those six figures have to be cheap to get.
 *
 * Everything here is derived from the append-only log rather than collected
 * alongside it. That is the whole design: a counter maintained during a run is
 * a counter that can be wrong, can be lost when the daemon restarts, and has to
 * be trusted; a projection over the log is neither. It also means this reads
 * runs that finished before it existed, which is how the next run gets compared
 * to the last one rather than to nothing.
 *
 * **What it cannot see: model tokens.** Only the harness knows those, and only
 * some harnesses say. A seat on a pty says nothing at all. Rather than invent a
 * proxy and let it be read as a cost, the tokens a harness *did* report are
 * carried separately and the absence is reported as absence.
 */

export interface SeatLedger {
  seat: ParticipantId;
  messages: number;
  /** Median, not mean: one 1500-character message must not move it. */
  medianHead: number;
  medianBody: number;
  longestBody: number;
  /** How many carried a `ref` — a pointer instead of a paste. */
  withRef: number;
  /** Split by where it was said. A 1:1 exchange on the floor is a broadcast. */
  onFloor: number;
  inDirect: number;
  tags: Record<string, number>;
  /** Seconds from this seat's first event to its last. */
  spanSeconds: number;
  /** Seconds from its last event to the run's end — the "done means stop" number. */
  quietTailSeconds: number;
}

export interface RunLedger {
  events: number;
  /** Events written under `@human` that no person typed. Should be zero. */
  machineNoise: number;
  seats: SeatLedger[];
  startedAt?: number;
  endedAt?: number;
  runSeconds: number;
  /** Share of all messages sent in the final third of the run. */
  lateShare: number;
  /** Message counts by tag across the whole run. */
  tags: Record<string, number>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

/**
 * A message posted by the machinery rather than by a person.
 *
 * The vault run's single largest finding: 622 of 1187 events were supervisor
 * health notices posted to `#floor` under the operator's identity. They are
 * presence now, and this counts what is left, because a number that should be
 * zero is worth printing whether or not it is.
 */
function isMachineNoise(event: CrosstalkEvent): boolean {
  if (event.kind !== 'message' || event.from !== HUMAN_ID) return false;
  const text = (event.head ?? event.body ?? '').toLowerCase();
  return (
    text.includes('is taking turns again') ||
    text.includes('could not be given the board') ||
    text.includes('is waiting on something on its own screen')
  );
}

export function ledgerOf(events: readonly CrosstalkEvent[]): RunLedger {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const times = ordered.map((event) => Date.parse(event.ts)).filter((at) => Number.isFinite(at));
  const startedAt = times[0];
  const endedAt = times[times.length - 1];
  const runSeconds = startedAt !== undefined && endedAt !== undefined ? Math.round((endedAt - startedAt) / 1000) : 0;

  const bySeat = new Map<
    ParticipantId,
    { heads: number[]; bodies: number[]; refs: number; floor: number; direct: number; tags: Map<string, number>; first: number; last: number }
  >();
  const tags: Record<string, number> = {};
  let machineNoise = 0;
  let messages = 0;
  let late = 0;
  const lateFrom = startedAt !== undefined && endedAt !== undefined ? startedAt + ((endedAt - startedAt) * 2) / 3 : undefined;

  for (const event of ordered) {
    if (isMachineNoise(event)) machineNoise += 1;
    const at = Date.parse(event.ts);
    const from = (event as { from?: ParticipantId }).from;
    if (from !== undefined) {
      const row = bySeat.get(from) ?? {
        heads: [],
        bodies: [],
        refs: 0,
        floor: 0,
        direct: 0,
        tags: new Map<string, number>(),
        first: at,
        last: at,
      };
      if (Number.isFinite(at)) {
        row.first = Math.min(row.first, at);
        row.last = Math.max(row.last, at);
      }
      bySeat.set(from, row);
    }

    if (event.kind !== 'message') continue;
    messages += 1;
    if (lateFrom !== undefined && at >= lateFrom) late += 1;

    const tag = isMessageTag(event.tag) ? (event.tag as MessageTag) : 'untagged';
    tags[tag] = (tags[tag] ?? 0) + 1;

    const row = bySeat.get(event.from);
    if (row === undefined) continue;
    row.heads.push((event.head ?? '').length);
    // `body` falls back to `head` on the wire, so a head-only message would
    // otherwise be counted as a body of the same length and inflate the figure
    // this whole vocabulary exists to bring down.
    row.bodies.push(event.body === event.head ? 0 : (event.body ?? '').length);
    if (event.ref !== undefined) row.refs += 1;
    if (event.room === FLOOR || event.room === undefined) row.floor += 1;
    else if (event.room.startsWith('dm:')) row.direct += 1;
    row.tags.set(tag, (row.tags.get(tag) ?? 0) + 1);
  }

  const seats: SeatLedger[] = [...bySeat.entries()]
    .map(([seat, row]) => ({
      seat,
      messages: row.heads.length,
      medianHead: median(row.heads),
      medianBody: median(row.bodies),
      longestBody: row.bodies.length === 0 ? 0 : Math.max(...row.bodies),
      withRef: row.refs,
      onFloor: row.floor,
      inDirect: row.direct,
      tags: Object.fromEntries(row.tags),
      spanSeconds: Number.isFinite(row.last - row.first) ? Math.round((row.last - row.first) / 1000) : 0,
      quietTailSeconds:
        endedAt !== undefined && Number.isFinite(row.last) ? Math.round((endedAt - row.last) / 1000) : 0,
    }))
    .sort((left, right) => right.messages - left.messages);

  return {
    events: ordered.length,
    machineNoise,
    seats,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    runSeconds,
    lateShare: messages === 0 ? 0 : Math.round((late / messages) * 100),
    tags,
  };
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h${String(minutes).padStart(2, '0')}m`;
}

/**
 * The ledger as the six figures a re-run is compared on.
 *
 * Deliberately the same six the vault run was measured by hand with `jq`, in
 * the same order, so two runs can be read side by side without arithmetic.
 */
export function renderLedger(ledger: RunLedger): string {
  const lines: string[] = [];
  lines.push(`${ledger.events} events over ${duration(ledger.runSeconds)}`);
  lines.push(
    `machine noise on the floor: ${ledger.machineNoise}` +
      (ledger.machineNoise === 0 ? '' : ` (${Math.round((ledger.machineNoise / ledger.events) * 100)}% — should be 0)`),
  );
  lines.push(`messages in the final third: ${ledger.lateShare}%`);

  const histogram = Object.entries(ledger.tags).sort((left, right) => right[1] - left[1]);
  lines.push(`tags: ${histogram.length === 0 ? '—' : histogram.map(([tag, count]) => `${tag} ${count}`).join(' · ')}`);
  lines.push('');
  lines.push('seat            msgs  head  body   ref   floor    dm   quiet');
  for (const seat of ledger.seats) {
    if (seat.messages === 0) continue;
    lines.push(
      [
        seat.seat.padEnd(14).slice(0, 14),
        String(seat.messages).padStart(5),
        String(seat.medianHead).padStart(5),
        String(seat.medianBody).padStart(5),
        String(seat.withRef).padStart(5),
        String(seat.onFloor).padStart(7),
        String(seat.inDirect).padStart(5),
        duration(seat.quietTailSeconds).padStart(7),
      ].join(''),
    );
  }
  lines.push('');
  // Said plainly rather than left to be inferred from an absent column: a cost
  // report that quietly omits cost is worse than one that says it cannot see it.
  lines.push('Model tokens are not here: only the harness knows them, and a seat on a pty never says.');
  return lines.join('\n');
}
