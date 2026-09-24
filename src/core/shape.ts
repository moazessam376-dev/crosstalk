import type { Role } from '../contracts/participant.js';
import type { MessageTag } from '../contracts/say.js';

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
  | 'slices-posted'
  | 'no-shared-files'
  | 'tests-green'
  | 'self-verified'
  | 'bug-list-posted'
  | 'run-clean'
  | 'integration-verified'
  // The planner has put a real choice to the operator and had it answered.
  | 'operator-questioned'
  // One gate in place of `tests-green` and `self-verified`. Two all-quorum
  // gates cost 2N board messages to say one thing; the requirement survives
  // whole in the gate's own text.
  | 'slice-done'
  // The lead has seated at least one builder. Derived from the roster: a shape
  // whose crew is hired at runtime cannot leave plan with nobody to build.
  | 'crew-hired'
  // Every task the lead cut has been accepted by the lead. Derived from the
  // task projection, so a builder's "done" is a claim the lead has to check —
  // `act({kind:"accept"})` after running the thing — not a message that
  // counts itself.
  | 'tasks-accepted';

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
  by: 'workspace' | 'asserted' | 'log';
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
  /**
   * The role this phase belongs to. Absent means every seat is in it.
   *
   * Seats outside it go idle. `phaseLine` handed every seat the same blocking
   * string, so through Verify and Repair — owned by one seat — every builder was
   * told about a gate it could not meet, forever, and the wake loop wrote it a
   * turn each time the string changed. That is builders filling a board with
   * nothing, and it is a line of code rather than a habit.
   */
  owner?: Role;
  exit: readonly Gate[];
}

export interface SeatSpec {
  role: Role;
  count: number;
  /** Where this seat's work comes from. */
  job: 'floor' | 'assigned';
  /**
   * The board verbs this seat has.
   *
   * Absent means the daemon does not hold this seat to the message schema, so
   * every project that predates it keeps working unchanged. Present, it is also
   * how a shape says what a seat is *for*: a builder without `plan` has no verb
   * for reviewing another seat's work, which is a stronger statement than a
   * brief line telling it not to.
   */
  tags?: readonly MessageTag[];
  /** True when the operator may staff more or fewer of these. */
  varies?: boolean;
  /**
   * True when the lead seats these itself, during the run, with
   * `act({kind:"hire"})`. `count` is then the launcher's starting number — zero
   * is legal and is the point: the operator leaves the crew size blank and
   * the seat that has read the job decides it.
   */
  hired?: boolean;
  /** What this seat must have posted to be finished. */
  done?: GateId;
  /** Appended to this seat's brief. The shape's own voice, not the role's. */
  brief: string;
}

export interface TeamShape {
  name: string;
  summary: string;
  /**
   * The file `contract-exists` looks for, when the config names none.
   *
   * A shape that gates on a contract has to be able to say which one. Without
   * this the gate reads `config.contractPath`, which nothing writes, and the
   * shape can never leave its first phase — which is what `trio-contract` did
   * for every run it was ever used in.
   */
  contract?: string;
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
      {
        id: 'self-verified',
        need:
          'Each seat has *run* its own surface and looked at the result — not just a green suite — ' +
          'and posted what it saw with `ref: gate:self-verified`. Name the sizes, states and inputs you covered.',
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
      {
        id: 'integration-verified',
        need:
          'The integrating seat has re-run the same first-hand verification on the *assembled* build — ' +
          'not on its own branch — and posted what it saw with `ref: gate:integration-verified`.',
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
  contract: 'src/contract.ts',
  seats: [
    {
      role: 'peer',
      count: 3,
      job: 'floor',
      // Every verb: three peers with no leader plan together, so `plan` is
      // theirs too. What the schema buys here is not authority but shape — an
      // `ask` has to name a seat and leave the room, and a `status` is one line.
      tags: ['status', 'result', 'ask', 'answer', 'blocked', 'gate', 'plan', 'note'],
      brief: [
        'You are one of three peers. There is no leader.',
        '',
        'The work moves through four phases and you can see the current one in `inbox()`.',
        'Only the transitions are gated — inside a phase, work however you like.',
        '',
        '- **plan** — agree the shared contract file and a split where no two seats own the same file. Post your slice with `say({tag:"gate", head:"...", ref:"gate:split-agreed"})`. Write no source yet.',
        '- **build** — your own files only. The contract is frozen: if it has to change, say so on the board instead of editing around it. Post your green run with `ref:"gate:tests-green"`, and then verify your own surface first-hand and post that with `ref:"gate:self-verified"`.',
        '- **verify** — one of you merges every branch and plays the whole thing. Post what is broken with `ref:"gate:bug-list-posted"` *before* fixing anything, so the list is on the record.',
        '- **repair** — that same seat fixes the list, posts the clean run with `ref:"gate:run-clean"`, and then re-runs the first-hand verification on the assembled build with `ref:"gate:integration-verified"`.',
        '',
        '**Verifying your own work is a gate, not a courtesy.** Nobody may hand work to the team as done',
        'without having run it and looked at the result. A green suite over a surface no one has watched is not',
        'a delivery, and neither is a screenshot nobody opened.',
        '',
        '**Ask what your checks structurally cannot see, and go and look there.** A previous team passed 22 of 22',
        'acceptance checks, a 10-shot screenshot tour and every keyboard shortcut it advertised — all at the one',
        'window size its brief happened to name. More checks inside the frame you were handed will not find the',
        'thing outside it. State plainly what you covered and what you did not.',
        '',
        'Ask a peer directly when you need one opinion rather than the room: `crosstalk dm --as <you> --with <them> --body "..."`. @human is in that room too, so it is a side room, not a back channel.',
      ].join('\n'),
    },
  ],
  phases: CONTRACT_FIRST,
};

/**
 * One planner, N builders, and the planner integrates.
 *
 * The planner is the `leader` role and the builders are `worker`s — no new
 * `Role`, deliberately. CONTEXT.md already describes this seat ("Leader. One.
 * Plans, assigns, owns merge order"), and reusing it makes three things fall
 * out for nothing: `runInit` already accepts one leader plus workers,
 * `needsWorktree` already returns false for a leader so the planner sits at the
 * repo root — which is where merging N branches has to happen — and `jobFor`
 * already hands a worker its own slice rather than the whole floor. A new role
 * would have touched `Role`, `InboxRole`, `displayRole`, `needsWorktree`,
 * `membersOf`, doctor's count rules and a template.
 *
 * A builder has no `plan` tag, and that is the whole of "builders do not
 * cross-review". There is no board verb for reviewing another seat's work and
 * no long-form budget for one. The vault-team run put 298 of its 560 peer
 * messages into cross-review across 125 merges, none of it asked for; here it
 * has nowhere to go.
 */
const PLANNER_INTEGRATOR: TeamShape = {
  name: 'planner-integrator',
  summary: 'One planner writes the spec and the contract, cuts the slices, then merges and verifies every one of them.',
  contract: 'src/contract.ts',
  seats: [
    {
      role: 'leader',
      count: 1,
      job: 'floor',
      tags: ['plan', 'ask', 'answer', 'gate', 'status', 'blocked', 'note'],
      done: 'integration-verified',
      brief: [
        'You are the planner, and at the end you are the integrator. You do not write a slice.',
        '',
        '**Plan with the operator before you plan anything else.** Ask them the questions whose answers',
        'change what gets built — scope, the trade you are unsure about, what "done" means to them. Ask with',
        '`claim({kind:"open", question, options, voters:["@human"], method:"human"})`: it puts a real multiple',
        'choice on their board with a button per option, and they can write their own answer instead. One',
        'question per decision, and you cannot leave **plan** until one of them has been answered.',
        '',
        'Then write the spec, freeze the contract file, and cut one slice per builder with no two in the same',
        'file. Post the split with `ref:"gate:slices-posted"`.',
        '',
        'Through **build** you are quiet. The builders own their files and do not need you.',
        '',
        'In **verify** you take every branch, merge it, and play the whole thing yourself. Post what is broken',
        'with `ref:"gate:bug-list-posted"` *before* fixing any of it, so the list is on the record rather than',
        'in your head. Then repair it, post the clean run with `ref:"gate:run-clean"`, and re-verify the',
        'assembled build with `ref:"gate:integration-verified"`.',
        '',
        'You merge. Nobody else does, and nobody force-pushes.',
      ].join('\n'),
    },
    {
      role: 'worker',
      count: 3,
      varies: true,
      job: 'assigned',
      tags: ['status', 'result', 'ask', 'answer', 'blocked', 'gate', 'note'],
      done: 'slice-done',
      brief: [
        'You own one slice. `inbox().job` is yours and it is the whole of your work.',
        '',
        'The contract is frozen. If it has to change, stop and say so — do not edit around it.',
        'Write only your own files: two seats in one file is the seam every previous run shipped a bug into.',
        '',
        '**Do not review another builder\'s work.** The planner integrates and verifies; a second opinion on',
        'a slice that is not yours costs the team more than it has ever returned here.',
        '',
        'When your slice is real: run it, *watch it work*, push your branch and open a PR. Then post',
        '`ref:"gate:slice-done"` — one message saying your tests are green and what you watched with your own',
        'eyes. A green suite over a surface nobody has looked at is not a delivery.',
        '',
        'Then stop. Done means stop.',
      ].join('\n'),
    },
  ],
  phases: [
    {
      id: 'plan',
      intent: 'Ask the operator what you cannot decide for them, then write the contract and cut the slices.',
      writes: 'no-source',
      actors: 'one',
      owner: 'leader',
      exit: [
        {
          id: 'operator-questioned',
          need: 'The operator has answered a decision you opened for them.',
          by: 'log',
        },
        {
          id: 'contract-exists',
          need: 'The shared contract file exists and is not empty.',
          by: 'workspace',
        },
        {
          id: 'slices-posted',
          need: 'The split is posted, with `ref: gate:slices-posted`.',
          by: 'asserted',
          quorum: 'any',
        },
      ],
    },
    {
      id: 'build',
      intent: 'Build your own slice against the frozen contract. Do not review anyone else.',
      writes: 'own-files',
      actors: 'all',
      exit: [
        {
          id: 'no-shared-files',
          need: 'No two seat branches touch the same file.',
          by: 'workspace',
        },
        {
          id: 'slice-done',
          need: 'Every builder has posted a green run and what it watched, with `ref: gate:slice-done`.',
          by: 'asserted',
          quorum: 'all',
        },
      ],
    },
    {
      id: 'verify',
      intent: 'The planner merges every branch and plays the whole thing. Builders are done.',
      writes: 'anything',
      actors: 'one',
      owner: 'leader',
      exit: [
        {
          id: 'bug-list-posted',
          need: 'What is broken is posted before anything is fixed, with `ref: gate:bug-list-posted`.',
          by: 'asserted',
          quorum: 'any',
        },
      ],
    },
    {
      id: 'repair',
      intent: 'Fix the list, then verify the assembled build again.',
      writes: 'anything',
      actors: 'one',
      owner: 'leader',
      exit: [
        { id: 'run-clean', need: 'A full run is clean, posted with `ref: gate:run-clean`.', by: 'asserted', quorum: 'any' },
        {
          id: 'integration-verified',
          need: 'The assembled build was watched, not inferred, with `ref: gate:integration-verified`.',
          by: 'asserted',
          quorum: 'any',
        },
      ],
    },
  ],
};

/**
 * One lead, a crew it hires itself, and the lead holds every builder to
 * evidence until the job is done.
 *
 * Built for the operator's own loop: a strong planning model (the SPOC they
 * used to talk to) plans *with* them, writes the spec, decides how big the job
 * is and how many builders it needs, seats them from the harness it was told
 * to use, and then does not go quiet. Every task a builder finishes comes back
 * to the lead as `submitted`, and the lead runs it before `accept` — a builder
 * that says "done" over a surface nobody has watched is the failure this
 * shape exists to catch, and `tasks-accepted` is the gate that makes the
 * check mechanical rather than a habit.
 *
 * The crew is `worker`s with `count: 0` and `hired: true`: the launcher lays
 * out only the lead, and `act({kind:"hire"})` adds a builder mid-run. Nothing
 * here is a new role; the lead is the `leader` and everything that already
 * knows what a leader may do — assign, accept, reject, sit at the repo root —
 * comes for free.
 *
 * Wall-clock is the other thing this shape is about. The operator's previous
 * runs went nine to twelve hours, mostly silence: a builder that stopped at a
 * checkpoint nobody asked for, and a supervisor polling on a timer to find
 * out. Here nothing polls. A builder's `done` wakes the lead; a builder that
 * goes quiet with a task open is nudged by the daemon and, if it stays quiet,
 * the lead is told — see `src/daemon/watch.ts`. An accepted builder is
 * released, so it stops costing anything.
 */
const LEAD_CREW: TeamShape = {
  name: 'lead-crew',
  summary: 'One lead plans with you, hires as many builders as the job needs, and holds each one to evidence until it is done.',
  contract: 'docs/crosstalk/SPEC.md',
  seats: [
    {
      role: 'leader',
      count: 1,
      job: 'floor',
      tags: ['plan', 'ask', 'answer', 'gate', 'status', 'blocked', 'note'],
      done: 'integration-verified',
      brief: [
        'You are the lead. You plan with the operator, you hire the crew, you check every piece of work, and at the end you integrate. You do not write a slice yourself.',
        '',
        '**Plan with the operator first.** Read `inbox().job`, then ask the operator the questions whose answers change what gets built — scope, the trade you are unsure about, what "done" looks like to them. Ask with',
        '`claim({kind:"open", question, options, voters:["@human"], method:"human"})`: it puts a real multiple choice on their board. One question per decision, and you cannot leave **plan** until one has been answered.',
        '',
        '**Write the spec at `docs/crosstalk/SPEC.md`** — what is being built, what done means per slice, how each slice is verified, and the interfaces between slices. Commit it to the main branch before you hire: a builder\'s worktree is cut from main at the moment it is hired, and a spec that is only in your working tree is a spec no builder can read.',
        '',
        '**Decide the crew size yourself.** Cut the work into slices with no two in the same file; one builder per slice, and no more builders than slices. One builder is a fine answer for a small job. Then, for each: `act({kind:"hire", id:"builder-1", harness:"claude-code-live", model:"...", effort:"..."})` — the harness and model are what the operator asked for in the job, or the ones you were started on. Then `act({kind:"assign", id:"T-01", assignee:"builder-1", title, brief, branch:"ct/T-01"})` with the *whole* brief for that slice in `brief`: builders never see the floor. Post the split with `say({tag:"plan", head:"...", ref:"gate:slices-posted"})`.',
        '',
        '**Through build you check, you do not build.** Each builder\'s `done` reaches you as a `submitted` card. Go to its branch, run it, watch it work, and only then `act({kind:"accept", taskId})`. If it is not done — a test that proves nothing, a claim you cannot reproduce, a regression — `act({kind:"reject", taskId, restatement:"<exactly what is wrong and what would show it fixed>"})`. Reject as often as it takes; do not accept to move on. A builder that goes quiet with a task open is nudged by Crosstalk and then reported to you: decide whether to wait, reassign the slice, or release the seat.',
        '',
        '**Release a builder when its work is accepted:** `act({kind:"release", id})`. A seat with nothing to do costs the operator every minute it sits there.',
        '',
        'In **verify** you merge every accepted branch and play the whole thing yourself. Post what is broken with `say({tag:"gate", head:"...", ref:"gate:bug-list-posted"})` *before* fixing any of it. Then repair, post the clean run with `ref:"gate:run-clean"`, and re-verify the assembled build with `ref:"gate:integration-verified"`. Then tell the operator what shipped and what you did not check, and stop.',
        '',
        'You merge. Nobody else does, and nobody force-pushes.',
      ].join('\n'),
    },
    {
      role: 'worker',
      count: 0,
      varies: true,
      hired: true,
      job: 'assigned',
      tags: ['status', 'result', 'ask', 'answer', 'blocked', 'note'],
      brief: [
        'You own one slice. `inbox().job` is yours and it is the whole of your work. The spec is at `docs/crosstalk/SPEC.md` in your checkout.',
        '',
        'Write only your own files, on the branch your task names. If the slice needs a file or an interface the spec does not give you, `say({tag:"blocked", to:"<the lead>", head:"..."})` — do not widen your slice to get past it.',
        '',
        '**Finish means: it runs, you watched it, and you said so.** `act({kind:"done", taskId, critique:{rounds:1, critic:"<you>", findings:[]}})` — put what you ran and what you saw in `findings` (empty is legal only if you actually looked and found nothing). Then wait. The lead runs it too; if the task comes back `in_progress` with a reason, that reason is your next job, not an opinion to argue with — unless it is wrong, in which case `claim` it with a falsifier.',
        '',
        '**Do not stop early.** A turn that ends with the task still open is read as you having gone quiet, and you will be nudged. If you are stuck, say `blocked` and to whom. If you are done, say `done`. There is no third state.',
        '',
        'When the lead accepts, you are finished. Do not polish, do not start another slice, do not review anyone else. Done means stop.',
      ].join('\n'),
    },
  ],
  phases: [
    {
      id: 'plan',
      intent: 'Ask the operator what you cannot decide for them, write and commit the spec, hire the crew, cut the slices.',
      writes: 'no-source',
      actors: 'one',
      owner: 'leader',
      exit: [
        {
          id: 'operator-questioned',
          need: 'The operator has answered a decision you opened for them.',
          by: 'log',
        },
        {
          id: 'contract-exists',
          need: 'The spec exists at docs/crosstalk/SPEC.md and is not empty.',
          by: 'workspace',
        },
        {
          id: 'crew-hired',
          need: 'At least one builder has been hired with `act({kind:"hire"})`.',
          by: 'log',
        },
        {
          id: 'slices-posted',
          need: 'The split is posted, with `ref: gate:slices-posted`.',
          by: 'asserted',
          quorum: 'any',
        },
      ],
    },
    {
      id: 'build',
      intent: 'Builders build their slices; the lead runs each one and accepts or rejects it. Nothing is accepted unwatched.',
      writes: 'own-files',
      actors: 'all',
      exit: [
        {
          id: 'no-shared-files',
          need: 'No two seat branches touch the same file.',
          by: 'workspace',
        },
        {
          id: 'tasks-accepted',
          need: 'Every task has been run by the lead and accepted with `act({kind:"accept"})`.',
          by: 'log',
        },
      ],
    },
    {
      id: 'verify',
      intent: 'The lead merges every accepted branch and plays the whole thing. Builders are done.',
      writes: 'anything',
      actors: 'one',
      owner: 'leader',
      exit: [
        {
          id: 'bug-list-posted',
          need: 'What is broken is posted before anything is fixed, with `ref: gate:bug-list-posted`.',
          by: 'asserted',
          quorum: 'any',
        },
      ],
    },
    {
      id: 'repair',
      intent: 'Fix the list, then verify the assembled build again.',
      writes: 'anything',
      actors: 'one',
      owner: 'leader',
      exit: [
        { id: 'run-clean', need: 'A full run is clean, posted with `ref: gate:run-clean`.', by: 'asserted', quorum: 'any' },
        {
          id: 'integration-verified',
          need: 'The assembled build was watched, not inferred, with `ref: gate:integration-verified`.',
          by: 'asserted',
          quorum: 'any',
        },
      ],
    },
  ],
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
      // Deliberately none. There is one seat and no room, so there is nobody to
      // spare from reading and no `to` for an `ask` to name. Enforcing a board
      // schema on a seat with no board is ceremony for its own sake.
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
  [LEAD_CREW.name, LEAD_CREW],
  [PLANNER_INTEGRATOR.name, PLANNER_INTEGRATOR],
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
