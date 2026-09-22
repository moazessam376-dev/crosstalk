import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { createServer } from '../../src/mcp/server.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

async function connect(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(new Board(await tempRepo())).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content[0]?.text ?? '', isError: result.isError === true };
}

describe('mcp server', () => {
  it('offers four tools with short descriptions, and instructions that mention join', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['join', 'send', 'inbox', 'who']);
    for (const tool of tools) expect((tool.description ?? '').length).toBeLessThan(160);
    expect(client.getInstructions()).toContain('join');
  });

  it('carries a message from one agent to another as plain text', async () => {
    const client = await connect();
    expect((await call(client, 'join', { name: 'orchestrator' })).text).toMatch(/^joined as orchestrator/);
    await call(client, 'join', { name: 'builder-1' });
    expect((await call(client, 'send', { as: 'orchestrator', to: 'builder-1', text: 'skip step two' })).text).toBe(
      'sent orchestrator-1',
    );
    expect((await call(client, 'inbox', { as: 'builder-1' })).text).toMatch(/^\d\d:\d\d orchestrator: skip step two$/);
    expect((await call(client, 'who', {})).text).toContain('builder-1');
  });

  it('reports mistakes as tool errors that say what to do', async () => {
    const client = await connect();
    const missing = await call(client, 'send', { to: 'x', text: 'y' });
    expect(missing).toEqual({ text: 'as is required', isError: true });
    const human = await call(client, 'inbox', { as: 'human' });
    expect(human.isError).toBe(true);
    expect(human.text).toMatch(/reserved/);
    const unknown = await call(client, 'inbox', { as: 'nobody' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/call join first|no run yet/);
  });
});
