import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { startDaemon } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/mcp/client.js';
import { createMcpServer } from '../../src/mcp/server.js';

/**
 * Everything else here tests `callTool` directly, which proves the tools behave
 * correctly *given* that something routes a request to them — and nothing at
 * all about whether the MCP server ever does.
 *
 * That is the seam this project has been caught by twice: 33 tests over code
 * that would not compile, and 28 tests over a screen that rendered blank. Both
 * times every component was individually verified and the wiring between them
 * was not. So this file drives a real MCP client over a real transport, and
 * asserts the schemas an agent actually receives.
 */
const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: leader
    role: leader
    harness: claude-code-app
    lifecycle: attached
    workspace: .
`;

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mcp-wire-'));
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const daemon = await startDaemon({ repo: await tempRepo() });
  const server = createMcpServer(new DaemonClient(daemon.url, daemon.tokens.get('leader')!));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'crosstalk-tests', version: '1.0.0' }, { capabilities: {} });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
    await daemon.close();
  }
}

function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content[0]?.text ?? '';
}

describe('what an agent actually receives over MCP', () => {
  it('lists every tool with its schema through a real client session', async () => {
    await withMcpClient(async (client) => {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toContain('raise_claim');
      expect(tools).toHaveLength(15);

      const raise = tools.find((tool) => tool.name === 'raise_claim');
      // The requirement survives the round trip: an agent reading the tool list
      // is told falsifier is mandatory, not merely that the server will refuse.
      expect(raise?.inputSchema.required).toContain('falsifier');
      expect(raise?.description ?? '').toMatch(/not an instruction/i);

      const respond = tools.find((tool) => tool.name === 'respond_to_claim');
      expect(respond?.description ?? '').toContain('UPHOLD_WITHOUT_NEW_EVIDENCE');
    });
  });

  it('runs a tool end to end and returns the appended events', async () => {
    await withMcpClient(async (client) => {
      const result = await client.callTool({
        name: 'say',
        arguments: { room: '#floor', body: 'joining' },
      });

      expect(result.isError).toBeFalsy();
      const events = (JSON.parse(firstText(result)) as { events: { kind: string; from: string }[] }).events;
      expect(events.map((event) => event.kind)).toContain('message');
      expect(events.every((event) => event.from === 'leader')).toBe(true);
    });
  });

  it('reports a protocol refusal as a tool error rather than a transport failure', async () => {
    await withMcpClient(async (client) => {
      const result = await client.callTool({
        name: 'raise_claim',
        arguments: {
          against: 'leader',
          target: 'src/mcp/tools.ts:1',
          assertion: 'the schema is wrong',
          severity: 'nit',
          falsifier: '',
        },
      });

      // An MCP error would surface as a thrown exception and tell the agent
      // nothing. This has to come back as a result it can read and correct.
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('MISSING_FALSIFIER');
    });
  });
});
