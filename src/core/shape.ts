import type { Role } from '../contracts/participant.js';

/**
 * A team's way of working, as data.
 *
 * Before this, "how a team works" was spread across seven places — the `Role`
 * union, `InboxRole`, the switch in `nextLine`, `jobFor`, `readTemplate`'s
 * literal union, a ternary in `brief.ts`, and four prose templates. Adding a
 * seat kind was a five-file change and composing a shape at runtime was not
 * possible at all, which is why the launcher had nothing to offer.
 *
 * The rule that makes a shape checkable rather than advisory: a phase names who
 * may write and what must exist to leave it, and *only the transitions* are
 * gated. Inside a phase the seats are free. Beacon-1's peer brief told seats to
 * post short asks and not narrate; one posted 54 narrations. A line agents can
 * ignore is a no-op, so the rules that matter are the ones something checks.
 */

export type PhaseId = 'plan' | 'build' | 'verify' | 'repair';

/**
 * What a phase permits its seats to write. Advisory in the brief today, and the
 * shape of the check when ownership is enforced at submit.
 */
export type WriteScope = 'no-source' | 'own-files' | 'tests-only' | 'anything';

export type GateId =
  | 'contract-exists'
  | 'split-agreed'
  | 'no-shared-files'
  | 'tests-green'
  | 'bug-list-posted'
  | 'run-clean';

export interface Gate {
  id: GateId;
  /** What the seat has to make true, in the seat's own language. */
  need: string;
  /**
   * How it is established.
   *
   * `workspace` — Crosstalk checks it against the repository, and no seat can
   * assert its way past it. `asserted` — a seat posts it to the board with
   * `ref: gate:<id>`, so the claim is on the record with a body attached. The
   * split is deliberate: mechanical where mechanical is possible, and visibly
   * a claim where it is not, rather than pretending a self-report is a check.
   */
  by: 'workspace' | 'asserted';
  /** For asserted gates: one seat is enough, or every seat has to say it. */
  quorum?: 'any' | 'all';
}

export interface Phase {
  id: PhaseId;
  /** One line the seat reads at the top of every turn. */
  intent: string;
  writes: WriteScope;
  /** Who is writing this phase. `one` means a single seat takes it for the team. */
  actors: 'all' | 'one';
  exit: readonly Gate[];
}

export interface SeatSpec {
  role: Role;
  count: number;
  /** Where this seat's work comes from. */
  job: 'floor' | 'assigned';
  /** Appended to this seat's brief. The shape's own voice, not the role's. */
  brief: string;
}

export interface TeamShape {
  name: string;
  summary: string;
  seats: readonly SeatSpec[];
  phases: readonly Phase[];
}

const CONTRACT_FIRST: Phase[] = [
  {
    id: 'plan',
    intent: 'Agree the contract and a split with no two seats in one file. Write no source yet.',
    writes: 'no-source',
    actors: 'all',
    exit: [
      {
        id: 'contract-exists',
        need: 'The shared contract file exists and is not empty.',
        by: 'workspace',
      },
      {
        id: 'split-agreed',
        need: 'Every seat has posted the split it is taking, with `ref: gate:split-agreed`.',
        by: 'asserted',
        quorum: 'all',
      },
    ],
  },
  {
    id: 'build',
    intent: 'Build your own files against the frozen contract. If the contract has to change, stop and say so.',
    writes: 'own-files',
    actors: 'all',
    exit: [
      {
        id: 'no-shared-files',
        need: 'No two seat branches touch the same file.',
        by: 'workspace',
      },
      {
        id: 'tests-green',
        need: 'Each seat has posted its own green run, with `ref: gate:tests-green`.',
        by: 'asserted',
        quorum: 'all',
      },
    ],
  },
  {
    id: 'verify',
    intent: 'One seat merges every branch, then plays the whole thing and writes down what is broken.',
    writes: 'tests-only',
    actors: 'one',
    exit: [
      {
        id: 'bug-list-posted',
        need: 'The bug list is on the board with `ref: gate:bug-list-posted`, before anything is fixed.',
        by: 'asserted',
        quorum: 'any',
      },
    ],
  },
  {
    id: 'repair',
    intent: 'The same seat fixes the list and keeps the rest working. Anything may be edited now.',
    writes: 'anything',
    actors: 'one',
    exit: [
      {
        id: 'run-clean',
        need: 'A full run is clean, posted with `ref: gate:run-clean`.',
        by: 'asserted',
        quorum: 'any',
      },
    ],
  },
];

/**
 * The trio the bench runs.
 *
 * Three writers is defensible only because of the contract freeze. Beacon-1
 * split three ways without one, and both team cells put a bug in a seam: a
 * defect fell between two files with no owner, and a fix landed in the renderer
 * because the sim's owner had gone quiet-done.
 */
const TRIO_CONTRACT: TeamShape = {
  name: 'trio-contract',
  summary: 'Three peers, one frozen contract, one of them integrates and repairs.',
  seats: [
    {
      role: 'peer',
      count: 3,
      job: 'floor',
      brief: [
        'You are one of three peers. There is no leader.',
        '',
        'The work moves through four phases and you can see the current one in `inbox()`.',
        'Only the transitions are gated — inside a phase, work however you like.',
        '',
        '- **plan** — agree the shared contract file and a split where no two seats own the same file. Post your slice with `say({room:"#floor", body:"...", ref:"gate:split-agreed"})`. Write no source yet.',
        '- **build** — your own files only. The contract is frozen: if it has to change, say so on the board instead of editing around it. Post your green run with `ref:"gate:tests-green"`.',
        '- **verify** — one of you merges every branch and plays the whole thing. Post what is broken with `ref:"gate:bug-list-posted"` *before* fixing anything, so the list is on the record.',
        '- **repair** — that same seat fixes the list. Post the clean run with `ref:"gate:run-clean"`.',
        '',
        'Ask a peer directly when you need one opinion rather than the room: `crosstalk dm --as <you> --with <them> --body "..."`. @human is in that room too, so it is a side room, not a back channel.',
      ].join('\n'),
    },
  ],
  phases: CONTRACT_FIRST,
};

/** One seat, no board. The control the team is measured against. */
const SOLO: TeamShape = {
  name: 'solo',
  summary: 'One builder, verifying its own work.',
  seats: [
    {
      role: 'peer',
      count: 1,
      job: 'floor',
      brief: [
        'You are the only seat. Build it, then verify it yourself.',
        '',
        'Verifying means playing the thing, not re-reading the code: a green suite over a blank page is not a delivery.',
        'Write down what you checked by eye and what you did not.',
      ].join('\n'),
    },
  ],
  phases: [
    {
      id: 'build',
      intent: 'Build it.',
      writes: 'anything',
      actors: 'one',
      exit: [{ id: 'tests-green', need: 'A green run, posted with `ref: gate:tests-green`.', by: 'asserted', quorum: 'any' }],
    },
    {
      id: 'verify',
      intent: 'Play the whole thing and write down what is broken.',
      writes: 'anything',
      actors: 'one',
      exit: [{ id: 'run-clean', need: 'A full run is clean, posted with `ref: gate:run-clean`.', by: 'asserted', quorum: 'any' }],
    },
  ],
};

export const SHAPES: ReadonlyMap<string, TeamShape> = new Map([
  [TRIO_CONTRACT.name, TRIO_CONTRACT],
  [SOLO.name, SOLO],
]);

export function shapeNamed(name: string | undefined): TeamShape | undefined {
  if (name === undefined) return undefined;
  return SHAPES.get(name);
}

/** The `ref` that marks a message as asserting a gate. */
export function gateRef(id: GateId): string {
  return `gate:${id}`;
}

export function gateOfRef(ref: string | undefined): GateId | undefined {
  if (ref === undefined || !ref.startsWith('gate:')) return undefined;
  const id = ref.slice('gate:'.length) as GateId;
  return id;
}
