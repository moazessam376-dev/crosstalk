import { DaemonClient } from './client.js';
import type { WriteResponse } from './client.js';
import type { Inbox } from '../core/inbox.js';

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

const FALSIFIER = {
  type: 'string',
  description: 'What you would observe if this claim were wrong. Required on raise, contest, and amend.',
} as const;

const EVIDENCE_LIST = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['command', 'file', 'observation'] },
      sha: { type: 'string', description: 'Commit this was gathered at. Required.' },
      command: { type: 'string' },
      output: { type: 'string' },
      ref: { type: 'string' },
    },
    required: ['kind', 'sha'],
  },
} as const;

export const TOOLS: ToolDefinition[] = [
  {
    name: 'inbox',
    description: 'Cards, tasks, and job (full #floor brief from @human). Does not wait when next is not idle.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_s: { type: 'number', description: 'Seconds to wait, capped at 50.' },
        since: { type: 'number', description: 'Exclusive seq. Omit to use the server cursor.' },
        wait: { type: 'boolean', description: 'Set false to return immediately.' },
      },
      required: [],
    },
    invoke: (client, args) =>
      client.get<Inbox>('/inbox', {
        timeout_s: numberOrUndefined(args['timeout_s']),
        since: numberOrUndefined(args['since']),
        wait: args['wait'] === false ? 0 : undefined,
      }),
  },

  {
    name: 'say',
    description: 'Post to a room. Use to for a directed wake. Not a claim.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room id, e.g. #floor or task:T-04.' },
        body: { type: 'string', description: 'What you want to say.' },
        to: { type: 'string', description: 'Optional participant id.' },
      },
      required: ['room', 'body'],
    },
    invoke: (client, args) => client.post<WriteResponse>('/events', { kind: 'message', ...args }),
  },

  {
    name: 'act',
    description: 'Task lifecycle: ack, assign (leader), or done. Court is claim, not this.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['ack', 'assign', 'done'] },
        taskId: { type: 'string' },
        restatement: { type: 'string', description: 'One line is enough. Required for ack.' },
        ambiguities: { type: 'array', items: { type: 'string' } },
        id: { type: 'string', description: 'New task id. assign only.' },
        title: { type: 'string' },
        brief: { type: 'string' },
        assignee: { type: 'string' },
        branch: { type: 'string' },
        specRefs: { type: 'array', items: { type: 'string' } },
        deps: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'array', items: { type: 'string' } },
        critique: { type: 'object' },
      },
      required: ['kind'],
    },
    invoke: async (client, args) => invokeAct(client, args),
  },

  {
    name: 'claim',
    description: 'Court only. Raise, respond, add evidence, open a decision, or vote. Falsifier required on raise, contest, amend.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['raise', 'respond', 'evidence', 'open', 'vote'] },
        against: { type: 'string' },
        target: { type: 'string' },
        assertion: { type: 'string' },
        severity: { type: 'string', enum: ['blocker', 'defect', 'risk', 'nit'] },
        falsifier: FALSIFIER,
        evidence: EVIDENCE_LIST,
        taskId: { type: 'string' },
        claimId: { type: 'string' },
        verdict: {
          type: 'string',
          enum: ['accept', 'contest', 'clarify', 'concede', 'amend', 'uphold'],
        },
        rationale: { type: 'string' },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        voters: { type: 'array', items: { type: 'string' } },
        method: { type: 'string' },
        ladder: { type: 'array', items: { type: 'string' } },
        decisionId: { type: 'string' },
        option: { type: 'string' },
        sha: { type: 'string' },
        command: { type: 'string' },
        output: { type: 'string' },
        ref: { type: 'string' },
      },
      required: ['kind'],
    },
    invoke: (client, args) => invokeClaim(client, args),
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

async function invokeAct(client: DaemonClient, args: Record<string, unknown>): Promise<unknown> {
  const kind = args['kind'];
  if (kind === 'ack') {
    const { taskId, restatement, ambiguities } = args;
    return client.post<WriteResponse>(`/tasks/${encodeURIComponent(String(taskId))}/ack`, {
      restatement,
      ambiguities: Array.isArray(ambiguities) ? ambiguities : [],
    });
  }
  if (kind === 'assign') {
    return client.post<WriteResponse>('/tasks/assign', args);
  }
  if (kind === 'done') {
    const { taskId, critique } = args;
    const submit = await client.post<WriteResponse>(`/tasks/${encodeURIComponent(String(taskId))}/submit`, {
      ...(critique === undefined ? {} : { critique }),
    });
    const submitted = await client.post<WriteResponse>(`/tasks/${encodeURIComponent(String(taskId))}/state`, {
      state: 'submitted',
    });
    return { events: [...submit.events, ...submitted.events] };
  }
  throw new Error(`Unknown act kind: ${String(kind)}`);
}

async function invokeClaim(client: DaemonClient, args: Record<string, unknown>): Promise<unknown> {
  const kind = args['kind'];
  if (kind === 'raise') {
    const { kind: _kind, ...body } = args;
    return client.post<WriteResponse>('/claims', body);
  }
  if (kind === 'respond') {
    const { claimId, ...body } = args;
    return client.post<WriteResponse>(`/claims/${encodeURIComponent(String(claimId))}/response`, body);
  }
  if (kind === 'evidence') {
    const { claimId, ...evidence } = args;
    return client.post<WriteResponse>(`/claims/${encodeURIComponent(String(claimId))}/evidence`, evidence);
  }
  if (kind === 'open') {
    const { kind: _kind, ...body } = args;
    return client.post<WriteResponse>('/decisions', body);
  }
  if (kind === 'vote') {
    const { decisionId, ...body } = args;
    return client.post<WriteResponse>(`/decisions/${encodeURIComponent(String(decisionId))}/vote`, body);
  }
  throw new Error(`Unknown claim kind: ${String(kind)}`);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
