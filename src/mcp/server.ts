import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonRequestError } from './client.js';
import type { DaemonClient } from './client.js';
import { TOOLS, TOOLS_BY_NAME } from './tools.js';

export const SERVER_NAME = 'crosstalk';
export const SERVER_VERSION = '1.0.0';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /**
   * The SDK's `CallToolResult` carries an index signature for protocol
   * extensions, and a closed interface is not assignable to it. Declared here
   * rather than casting at the handler, so the shape stays checked.
   */
  [key: string]: unknown;
}

/**
 * Runs a tool and shapes the answer for an agent rather than for a program.
 *
 * Exported separately from the transport so the tests can drive every tool
 * against a real daemon without standing up a stdio pipe — the daemon is the
 * part worth testing against, and a mocked HTTP layer would have caught none of
 * the defects this project actually shipped.
 */
export async function callTool(
  client: DaemonClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) {
    return fail(`Unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(', ')}`);
  }

  try {
    return { content: [{ type: 'text', text: JSON.stringify(await tool.invoke(client, args), null, 2) }] };
  } catch (error) {
    if (error instanceof DaemonRequestError) {
      // The daemon's own message names the route or the rule that was broken —
      // `claim_raised is not directly appendable — use POST /claims`, or
      // `uphold requires new evidence`. Passing it through intact is the whole
      // point: an agent that found the wrong door should be told which one is
      // right, not that its request failed.
      return fail(`${error.domain}/${error.code}: ${error.message}`);
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createMcpServer(client: DaemonClient): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(client, request.params.name, request.params.arguments ?? {}),
  );

  return server;
}
