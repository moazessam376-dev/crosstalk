import { DaemonClient, roomPath } from './client.js';
import type { AwaitResponse, EventsResponse, WriteResponse } from './client.js';

/**
 * Raw JSON Schema rather than a schema library.
 *
 * The tool descriptions are the product: this is where Crosstalk's thesis —
 * that a review finding is a claim and that falsifiability is structural rather
 * than a prompt rule — stops being a design document and starts being enforced
 * on an agent mid-task. Prompt rules are forgotten around turn 40; a required
 * parameter is not. Writing the schema by hand keeps the wording under review
 * instead of generated.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  invoke(client: DaemonClient, args: Record<string, unknown>): Promise<unknown>;
}

const EVIDENCE_ITEM = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['command', 'file', 'observation'],
      description: 'command — something you ran. file — a location in the tree. observation — what you saw.',
    },
    sha: {
      type: 'string',
      description:
        'The commit this was gathered at. Required. Evidence without a sha cannot be checked by anyone else, and evidence from a commit that is no longer an ancestor of the main branch is marked stale automatically — a rebase means re-run, not re-assert.',
    },
    command: { type: 'string', description: 'The exact command, for kind "command".' },
    output: { type: 'string', description: 'What it printed. Truncate rather than omit.' },
    ref: { type: 'string', description: '"path:line", for kind "file".' },
  },
  required: ['kind', 'sha'],
} as const;

const EVIDENCE_LIST = {
  type: 'array',
  items: EVIDENCE_ITEM,
  description:
    'Results, not assertions. Push your commits before you cite them: a SHA only your machine can see is not something a reviewer can check.',
} as const;

const FALSIFIER = {
  type: 'string',
  description:
    'REQUIRED. What you would expect to observe if this claim were wrong — a specific, checkable observation that would settle it against you. This is the point of the whole protocol: a claim that cannot be refuted cannot be settled, so the server rejects a missing or vacuous one (MISSING_FALSIFIER, VACUOUS_FALSIFIER). Good: "if the coefficient were applied once, produce() and consume() would reference different multipliers". Bad, and rejected: "if it did not work", "if I am wrong", or a restatement of the assertion.',
} as const;

export const TOOLS: ToolDefinition[] = [
  {
    name: 'say',
    description:
      'Post a message to a room. This is the only event kind you may append directly — everything else in the protocol goes through a tool that validates it first. Room ids look like "#floor", "task:T-04", "dispute:C-118". Set `to` when the message is for one participant, which also wakes their await_turn immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room id, e.g. "#floor" or "task:T-04".' },
        body: { type: 'string', description: 'What you want to say.' },
        to: {
          type: 'string',
          description: 'Optional participant id. Addressing someone wakes their await_turn.',
        },
      },
      required: ['room', 'body'],
    },
    invoke: (client, args) => client.post<WriteResponse>('/events', { kind: 'message', ...args }),
  },

  {
    name: 'raise_claim',
    description:
      'Raise a claim — a review finding, a disagreement, a defect, a doubt about the brief. A claim is not an instruction: the participant it is against may accept it, contest it, or ask you to clarify, and contesting one they believe is wrong is correct and costs them nothing. Claims run in every direction — you may raise one against another agent, against the brief, or against the spec. `falsifier` is required and is enforced by the server, not by convention.',
    inputSchema: {
      type: 'object',
      properties: {
        against: {
          type: 'string',
          description:
            'Who or what the claim is against: a participant id, or the literal "brief" or "spec". A brief that contradicts itself is a claim against the brief, not a reason to guess.',
        },
        target: {
          type: 'string',
          description: 'What it is about: "src/economy.ts:41", "test:siege", "brief:T-04#3".',
        },
        assertion: { type: 'string', description: 'The claim itself, in one sentence.' },
        severity: {
          type: 'string',
          enum: ['blocker', 'defect', 'risk', 'nit'],
          description:
            'blocker — must be fixed before this lands. defect — wrong, fix it. risk — may be wrong, worth a look. nit — preference.',
        },
        falsifier: FALSIFIER,
        evidence: EVIDENCE_LIST,
        taskId: { type: 'string', description: 'The task this claim is about, if any.' },
      },
      required: ['against', 'target', 'assertion', 'severity', 'falsifier'],
    },
    invoke: (client, args) => client.post<WriteResponse>('/claims', args),
  },

  {
    name: 'respond_to_claim',
    description:
      'Answer a claim raised against you, or answer a contest of your own claim. Verify the claim against the source before answering — silently implementing a wrong finding turns working code into broken code.\n\nWho may use which verdict is enforced by the server. If the claim is open, the participant it is against answers with accept, contest or clarify. If the claim is contested, the participant who raised it answers with concede, amend or uphold.\n\n- accept — you agree. Requires evidence that the fix is real.\n- contest — you disagree. Requires a rationale, counter-evidence, AND a falsifier for your counter-argument.\n- clarify — the claim or the brief is ambiguous. Requires a rationale naming the ambiguity.\n- concede — you raised it, you now agree you were wrong. Requires a rationale, for the ledger.\n- amend — your argument changed. Requires a rationale, evidence, and a new falsifier, because it is a new claim.\n- uphold — you are restating a claim whose falsifier is already on the record, so no new falsifier is needed. It requires NEW EVIDENCE: evidence already on the claim is rejected with UPHOLD_WITHOUT_NEW_EVIDENCE. Repeating yourself more firmly is not a rebuttal.',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: { type: 'string', description: 'The claim you are answering, e.g. "C-118".' },
        verdict: {
          type: 'string',
          enum: ['accept', 'contest', 'clarify', 'concede', 'amend', 'uphold'],
          description:
            'accept | contest | clarify are the target\'s answers to an open claim. concede | amend | uphold are the raiser\'s answers to a contest.',
        },
        rationale: {
          type: 'string',
          description:
            'Why. Required for contest, clarify, concede and amend. This is what the ledger keeps, so write it for someone reading the argument later.',
        },
        falsifier: {
          type: 'string',
          description:
            'Required for contest and amend — what would show YOUR counter-argument wrong. Not required for uphold, which restates a claim whose falsifier is already on the record; uphold needs new evidence instead.',
        },
        evidence: EVIDENCE_LIST,
      },
      required: ['claimId', 'verdict'],
    },
    invoke: (client, args) => {
      const { claimId, ...body } = args;
      return client.post<WriteResponse>(`/claims/${encodeURIComponent(String(claimId))}/response`, body);
    },
  },

  {
    name: 'add_evidence',
    description:
      'Attach a result to an existing claim without taking a verdict on it — a command you ran, a file you read, something you observed. Use this when you have found something relevant but are not yet answering.',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: { type: 'string', description: 'The claim to attach to.' },
        kind: EVIDENCE_ITEM.properties.kind,
        sha: EVIDENCE_ITEM.properties.sha,
        command: EVIDENCE_ITEM.properties.command,
        output: EVIDENCE_ITEM.properties.output,
        ref: EVIDENCE_ITEM.properties.ref,
      },
      required: ['claimId', 'kind', 'sha'],
    },
    invoke: (client, args) => {
      const { claimId, ...evidence } = args;
      return client.post<WriteResponse>(`/claims/${encodeURIComponent(String(claimId))}/evidence`, evidence);
    },
  },

  {
    name: 'await_turn',
    description:
      'Block until something addresses you, then return every event that did. This is how you wait — do NOT write a polling loop, and do NOT schedule a task to check back. The server holds the request open and answers the moment an event lands in a room you are in from someone other than you, or is addressed to you directly. A message from the human jumps the queue.\n\nIt returns within about 50 seconds regardless of the timeout you ask for, so it always fits inside a tool timeout. If nothing arrived it returns idle — call it again. This project lost a night to an agent that invented its own poll with a predicate that could never match, and sat there for forty minutes while the review it was waiting for was already posted.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_s: {
          type: 'number',
          description: 'How long to wait, in seconds. Capped at 50 by the server.',
        },
        since: {
          type: 'number',
          description:
            'Optional. Wait for events after this seq. Exclusive — `since: 42` returns 43 onward. Omit it and the server tracks what it has already handed you.',
        },
      },
      required: [],
    },
    invoke: (client, args) =>
      client.get<AwaitResponse>('/await', {
        timeout_s: numberOrUndefined(args['timeout_s']),
        since: numberOrUndefined(args['since']),
      }),
  },

  {
    name: 'read_events',
    description:
      'Read the log. `since` is exclusive: `since: 42` returns events from seq 43. Pass the `lastSeq` you got back as the next `since` and you can neither skip nor re-read an event. Order is by `seq`, never by timestamp — replay has to be deterministic.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Exclusive. Defaults to 0, which returns the whole log.' },
        limit: { type: 'number', description: 'Defaults to 1000, capped at 1000.' },
        room: {
          type: 'string',
          description:
            'Optional room id to filter to, e.g. "#floor" or "dispute:C-118". You must be a member of it.',
        },
      },
      required: [],
    },
    invoke: (client, args) => {
      const room = args['room'];
      const query = {
        since: numberOrUndefined(args['since']),
        limit: numberOrUndefined(args['limit']),
      };
      return typeof room === 'string' && room !== ''
        ? client.get<EventsResponse>(roomPath(room), { since: query.since })
        : client.get<EventsResponse>('/events', query);
    },
  },

  {
    name: 'roster',
    description:
      'Who else is here: id, role, harness, model and current status. Two agents on the same harness are not interchangeable — the model is part of the identity, because it changes whether their evidence is worth re-running.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    invoke: (client) => client.get('/roster'),
  },

  {
    name: 'board',
    description:
      'Every task and its state — metadata only, deliberately no message bodies, so this stays readable with a dozen participants instead of becoming a firehose.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    invoke: (client) => client.get('/board'),
  },

  {
    name: 'my_tasks',
    description: 'The tasks assigned to you, in full: brief, acceptance criteria, deps and state.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    invoke: (client) => client.get('/tasks/mine'),
  },

  {
    name: 'create_task',
    description:
      'Create a task. Leader only. A task is always born in `draft` — you cannot start one in a later state, because a task that could be born `accepted` would skip both gates. Every acceptance criterion has to be independently checkable: "it works" is not one.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'e.g. "T-04". Ids are never reused — the log is append-only.' },
        title: { type: 'string' },
        brief: { type: 'string', description: 'What to build, and why. The assignee restates this back to you.' },
        specRefs: { type: 'array', items: { type: 'string' }, description: 'Spec sections this task implements.' },
        assignee: { type: 'string', description: 'Participant id.' },
        deps: { type: 'array', items: { type: 'string' }, description: 'Task ids that must land first.' },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: 'Each one independently checkable, with a command someone else could run.',
        },
        branch: { type: 'string', description: 'e.g. "ct/T-04-slug".' },
      },
      required: ['id', 'title', 'brief', 'specRefs', 'assignee', 'deps', 'acceptance', 'branch'],
    },
    invoke: (client, args) => client.post<WriteResponse>('/tasks', args),
  },

  {
    name: 'ack_task',
    description:
      'Acknowledge a task before you start work on it. The server refuses to move a task to in_progress without this, on purpose: restating the brief in your own words is the cheapest place to catch one that contradicts itself, and it costs one turn. List every ambiguity you found — an empty list is a claim that the brief is unambiguous, so do not pad it and do not leave a real one out. This single call also moves the task to acknowledged, so it returns two events.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task you are acknowledging.' },
        restatement: {
          type: 'string',
          description: 'The task in your own words. Not a copy of the brief.',
        },
        ambiguities: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Everything under-specified, contradictory, or that you had to guess at. Legal to be empty, and read as a claim that there were none.',
        },
      },
      required: ['taskId', 'restatement', 'ambiguities'],
    },
    invoke: (client, args) => {
      const { taskId, ...body } = args;
      return client.post<WriteResponse>(`/tasks/${encodeURIComponent(String(taskId))}/ack`, body);
    },
  },

  {
    name: 'submit_task',
    description:
      'Record your self-critique and move the task toward submission. The server refuses to submit a task without a critique record — you are asked to review your own work before anyone else does. Zero findings is legal and visible in the ledger: say so plainly rather than inventing one.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task you are submitting.' },
        critique: {
          type: 'object',
          description: 'Your self-review.',
          properties: {
            rounds: { type: 'number', description: 'How many critique rounds you ran.' },
            critic: {
              type: 'string',
              description: 'How the critique was run — a subagent, a checklist, a second pass.',
            },
            findings: {
              type: 'array',
              description: 'What you found, each with the evidence that closed it.',
              items: {
                type: 'object',
                properties: {
                  assertion: { type: 'string' },
                  closedBy: EVIDENCE_LIST,
                  rejected: {
                    type: 'string',
                    description: 'Set when you disagreed with your own critic, with the reason.',
                  },
                },
                required: ['assertion', 'closedBy'],
              },
            },
          },
          required: ['rounds', 'critic', 'findings'],
        },
      },
      required: ['taskId', 'critique'],
    },
    invoke: (client, args) => {
      const { taskId, ...body } = args;
      return client.post<WriteResponse>(`/tasks/${encodeURIComponent(String(taskId))}/submit`, body);
    },
  },

  {
    name: 'set_task_state',
    description:
      'Move a task to a new state. Legal transitions are enforced server-side; an illegal one is refused with ILLEGAL_TRANSITION rather than silently applied. States: draft, assigned, acknowledged, in_progress, self_reviewed, submitted, under_review, resolving, accepted, merged.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        state: {
          type: 'string',
          enum: [
            'draft',
            'assigned',
            'acknowledged',
            'in_progress',
            'self_reviewed',
            'submitted',
            'under_review',
            'resolving',
            'accepted',
            'merged',
          ],
        },
        reason: { type: 'string', description: 'Why, when it is not obvious from the log.' },
      },
      required: ['taskId', 'state'],
    },
    invoke: (client, args) => {
      const { taskId, ...body } = args;
      return client.post<WriteResponse>(`/tasks/${encodeURIComponent(String(taskId))}/state`, body);
    },
  },

  {
    name: 'open_decision',
    description:
      'Open a decision when a dispute needs resolving rather than continuing. `ladder` names the escalation rungs to try in order; the last rung must be terminal, or the decision could never close.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        voters: { type: 'array', items: { type: 'string' }, description: 'Participant ids eligible to vote.' },
        method: { type: 'string', description: 'How the votes resolve.' },
        ladder: { type: 'array', items: { type: 'string' }, description: 'Escalation rungs, in order.' },
        claimId: { type: 'string', description: 'The claim this decision settles, if any.' },
        deadline: { type: 'string', description: 'ISO-8601.' },
      },
      required: ['question', 'options', 'voters', 'method'],
    },
    invoke: (client, args) => client.post<WriteResponse>('/decisions', args),
  },

  {
    name: 'vote',
    description:
      'Cast a vote. A rationale is required — a vote with no reasoning is a number, and the ledger is meant to record an argument. If your vote closes the decision, this returns two events: your vote and the resolution. Read both.',
    inputSchema: {
      type: 'object',
      properties: {
        decisionId: { type: 'string' },
        option: { type: 'string', description: 'One of the decision\'s options.' },
        rationale: { type: 'string', description: 'Required. Why you voted this way.' },
      },
      required: ['decisionId', 'option', 'rationale'],
    },
    invoke: (client, args) => {
      const { decisionId, ...body } = args;
      return client.post<WriteResponse>(`/decisions/${encodeURIComponent(String(decisionId))}/vote`, body);
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
