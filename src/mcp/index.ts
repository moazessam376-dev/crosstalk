#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DaemonClient } from './client.js';
import { loadMcpConfig } from './config.js';
import { createMcpServer } from './server.js';

/**
 * stdio entrypoint. `crosstalk init` writes the `.mcp.json` that launches this
 * with CROSSTALK_REPO and CROSSTALK_TOKEN; the daemon URL is discovered from
 * `.crosstalk/daemon.json` rather than configured, because the daemon binds an
 * ephemeral port and `.mcp.json` is written before any daemon exists.
 */
async function main(): Promise<void> {
  const config = await loadMcpConfig();
  const server = createMcpServer(new DaemonClient(config.url, config.token));
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout is the MCP transport — anything written there corrupts the protocol
  // frame, so a startup failure has to go to stderr or it becomes a parse error
  // in the host instead of a message someone can act on.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
