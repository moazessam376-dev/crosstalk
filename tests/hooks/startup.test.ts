import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const built = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const server = fileURLToPath(new URL('../../dist/mcp/server.js', import.meta.url));

/** The packages a built file loads at startup: its static imports, followed through our own files. */
function packagesLoaded(entry: string): string[] {
  const seen = new Set<string>();
  const packages: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/^(?:import|export)\s(?:[^;]*?\sfrom\s)?['"]([^'"]+)['"]/gm)) {
      if (spec!.startsWith('.')) visit(resolve(dirname(file), spec!));
      else packages.push(spec!);
    }
  };
  visit(entry);
  return packages;
}

// Every tool call runs the hook, so it must not load the MCP SDK, which costs
// more than node's own startup. A timing test caught this too, but flaked on
// machines where node starts fast; following the imports cannot flake.
describe.skipIf(!existsSync(built))('hook startup (built CLI)', () => {
  it('sees the SDK where it is loaded', () => {
    expect(packagesLoaded(server)).toContain('@modelcontextprotocol/sdk/server/index.js');
  });

  it('never loads the MCP SDK on the way to a command', () => {
    expect(packagesLoaded(built).filter((name) => name.startsWith('@modelcontextprotocol/'))).toEqual([]);
  });
});
