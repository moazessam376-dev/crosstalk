import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { HUMAN } from '../board/agents.js';
import type { Board } from '../board/board.js';
import { BoardError } from '../board/fsutil.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export const INSTRUCTIONS =
  'Crosstalk is a message board shared by the agents working in this repository, subagents included. ' +
  'Call join with a unique name before using it. When you start a subagent that should coordinate with others, ' +
  'tell it in its prompt which name to join as, and that when it is told it has unread Crosstalk messages it should call inbox and act on them.';

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, object>; required: string[] };
  run(board: Board, args: Args): Promise<string>;
}

const AS = { type: 'string', description: 'Your name on the board, as given to join.' };

export const TOOLS: readonly Tool[] = [
  {
    name: 'join',
    description: 'Join the Crosstalk board under a unique name. Returns the rules for using it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase letters, digits and dashes, e.g. "builder-1".' },
        rejoin: { type: 'boolean', description: 'Continue as this name after /clear or a restart.' },
      },
      required: ['name'],
    },
    run: (board, args) => board.join(text(args, 'name'), args['rejoin'] === true),
  },
  {
    name: 'send',
    description: 'Send a message to agents by name, or to "all".',
    inputSchema: {
      type: 'object',
      properties: {
        as: AS,
        to: { type: 'string', description: 'Comma-separated names, or "all".' },
        text: { type: 'string' },
      },
      required: ['as', 'to', 'text'],
    },
    run: (board, args) => board.send(caller(args), text(args, 'to'), text(args, 'text')),
  },
  {
    name: 'inbox',
    description: 'Your new messages, oldest first. With wait_s, waits up to that many seconds (at most 50) for one.',
    inputSchema: { type: 'object', properties: { as: AS, wait_s: { type: 'number' } }, required: ['as'] },
    run: async (board, args) =>
      (await board.inbox(caller(args), typeof args['wait_s'] === 'number' ? args['wait_s'] : 0)).text,
  },
  {
    name: 'who',
    description: 'Who is on the board, when each last sent, and how many messages each has unread.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: (board) => board.who(),
  },
];

function text(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new BoardError(`${key} is required`);
  return value;
}

function caller(args: Args): string {
  const as = text(args, 'as');
  if (as === HUMAN) throw new BoardError('"human" is reserved for the person at the hub');
  return as;
}

export function createServer(board: Board): Server {
  const server = new Server({ name: 'crosstalk', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      return { content: [{ type: 'text' as const, text: `unknown tool ${request.params.name}` }], isError: true };
    }
    try {
      return { content: [{ type: 'text' as const, text: await tool.run(board, request.params.arguments ?? {}) }] };
    } catch (error) {
      if (!(error instanceof BoardError)) throw error;
      return { content: [{ type: 'text' as const, text: error.message }], isError: true };
    }
  });

  return server;
}

export async function serveStdio(board: Board): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await createServer(board).connect(new StdioServerTransport());
}
