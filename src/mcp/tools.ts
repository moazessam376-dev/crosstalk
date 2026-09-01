import { DaemonClient } from './client.js';
import { MESSAGE_TAGS } from '../contracts/say.js';
import { renderTagTable } from '../core/says.js';
import type { WriteResponse } from './client.js';
import type { Inbox } from '../core/inbox.js';
import { ATTACHMENT_EXTENSIONS, capFor, MAX_ATTACHMENTS } from '../core/attachments.js';

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
    description: 'Cards, unread, and job. Leader job is the #floor brief; builder job is the assigned task brief. Idle waits.',
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
    // No number in here, and none in `head` or `body` below. The cap read
    // `1500` in this description and again in `body`'s, which is in context on
    // every call — and the median message across 1187 events came in at 1429.
    // A budget stated to the writer is a target. Sizes live in refusals now.
    description: 'Post to the board. tag says what it is for, head is the message, to sends it to one seat. Not a claim.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          enum: [...MESSAGE_TAGS],
          description: renderTagTable(),
        },
        head: {
          type: 'string',
          description: 'The message, in one line. Most messages need nothing else.',
        },
        to: {
          type: 'string',
          // Named for what it does. It read "Optional participant id", which
          // says nothing about the effect, and twelve of 1187 messages used it.
          description: 'Send this to one seat. Leave room off and Crosstalk opens the side room, so nobody else has to read it.',
        },
        room: { type: 'string', description: 'Room id, e.g. #floor or task:T-04. Leave off when you pass to.' },
        body: {
          type: 'string',
          description: 'Detail the head cannot carry. Usually unnecessary — put depth behind ref instead.',
        },
        ref: {
          type: 'string',
          description: 'The artifact carrying the detail — a path, a SHA, a file you wrote.',
        },
        task: { type: 'string', description: 'The slice this is about.' },
        attach: {
          type: 'array',
          items: { type: 'string' },
          // A property, not a fifth tool. `tests/mcp/schemas.test.ts` pins the
          // tool list at four on purpose: the four verbs are the interface, and
          // "attach a file" is a thing you do while saying something, not a
          // fifth thing to do.
          description: 'Files to send with this, as paths inside the repo. A screenshot, a diff, a report.',
        },
      },
      required: ['tag', 'head'],
    },
    invoke: async (client, args) => invokeSay(client, args),
  },

  {
    name: 'act',
    description: 'Task lifecycle: ack, assign, done, accept, or reject. Court is claim, not this.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['ack', 'assign', 'done', 'accept', 'reject'] },
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
        critique: {
          type: 'object',
          description: 'Required for done: {rounds, critic, findings}. findings may be [].',
        },
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

/**
 * Post a message, uploading anything it attaches first.
 *
 * The agent spends the tokens of a path; the bytes go over a separate request
 * from this same process, which is on the same machine as the daemon. Base64
 * in the tool call would put a screenshot through the model's context twice —
 * once written, once read back — for a picture nobody asked it to look at.
 *
 * Two refusals live here rather than at the daemon, because both are about
 * *this* process and the daemon cannot see either:
 *
 * - **the path must be inside the repo.** `attach: "/etc/passwd"` on a board
 *   that `src/mirror/` pushes to GitHub is an exfiltration path, and it is one
 *   an agent could be talked into by a file it read.
 * - **the cap, before reading.** The daemon enforces it too, but reading a
 *   200 MB file into this process to be refused is a way to be killed by the
 *   OOM killer instead of told no.
 */
async function invokeSay(client: DaemonClient, args: Record<string, unknown>): Promise<unknown> {
  const { attach, ...message } = args as { attach?: unknown } & Record<string, unknown>;
  if (attach === undefined) {
    return client.post<WriteResponse>('/events', { kind: 'message', ...message });
  }
  if (!Array.isArray(attach) || attach.some((entry) => typeof entry !== 'string')) {
    throw new Error('attach takes a list of paths');
  }
  if (attach.length > MAX_ATTACHMENTS) {
    throw new Error(`attach takes at most ${MAX_ATTACHMENTS} files`);
  }

  const { readFile, stat } = await import('node:fs/promises');
  const { basename, extname, isAbsolute, relative, resolve } = await import('node:path');
  const repo = resolve(process.env['CROSSTALK_REPO'] ?? process.cwd());

  const attachments = [];
  for (const path of attach as string[]) {
    const full = resolve(repo, path);
    const inside = relative(repo, full);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`${path} is outside the repository. Attach files your team can also see.`);
    }
    const type = typeForPath(extname(full).toLowerCase());
    const info = await stat(full);
    const cap = capFor(type);
    if (info.size > cap) {
      throw new Error(
        `${basename(full)} is ${Math.round(info.size / (1024 * 1024))} MB; the cap for this kind of file is ${Math.round(cap / (1024 * 1024))} MB`,
      );
    }
    attachments.push(await client.putFile(await readFile(full), type, basename(full)));
  }

  return client.post<WriteResponse>('/events', { kind: 'message', ...message, attachments });
}

/**
 * The media type of a file on disk, from its extension.
 *
 * The reverse of the daemon's whitelist, which is keyed on type. An agent
 * attaches a path and has no `File.type` to hand, so the extension is the only
 * thing there is to go on — and an unknown one is refused by the daemon rather
 * than guessed at here.
 */
function typeForPath(ext: string): string {
  for (const [type, candidate] of Object.entries(ATTACHMENT_EXTENSIONS)) {
    if (candidate === ext) return type;
  }
  throw new Error(`${ext === '' ? 'a file with no extension' : ext} is not a kind of file Crosstalk stores`);
}

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
  if (kind === 'accept') {
    const { taskId } = args;
    return client.post<WriteResponse>(`/tasks/${encodeURIComponent(String(taskId))}/state`, { state: 'accepted' });
  }
  if (kind === 'reject') {
    const { taskId, restatement } = args;
    return client.post<WriteResponse>(`/tasks/${encodeURIComponent(String(taskId))}/state`, {
      state: 'in_progress',
      reason: typeof restatement === 'string' && restatement !== '' ? restatement : 'rejected',
    });
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
