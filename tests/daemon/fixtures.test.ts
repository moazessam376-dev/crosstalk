import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

/**
 * Golden wire fixtures. Contract §10.
 *
 * One file per case, each recording what a broken implementation would produce
 * rather than merely what a correct one does. The MCP server (D3) and the CLI
 * (D4) replay these same files, so all three consumers assert against one set
 * of examples instead of against each other's implementations.
 */
interface WireCall {
  method: string;
  path: string;
  /** Participant id whose token is presented. Omitted means no credential at all. */
  as?: string;
  body?: unknown;
}

interface Fixture {
  name: string;
  /** What a broken implementation produces. A fixture that cannot fail is not a fixture. */
  why: string;
  setup?: WireCall[];
  request: WireCall;
  expect: {
    status: number;
    /** Subset match: seq and ts vary per run and are not part of the contract. */
    bodyMatches?: unknown;
    /** Raw substrings that must not appear anywhere in the response. */
    bodyExcludes?: string[];
    /** Path into the body whose value must equal the given number of items. */
    eventsOfKind?: { kind: string; count: number };
  };
}

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
  - id: codex
    role: worker
    harness: codex-app
    lifecycle: attached
    workspace: .crosstalk/worktrees/codex
  - id: cursor
    role: worker
    harness: cursor-app
    lifecycle: attached
    workspace: .crosstalk/worktrees/cursor
`;

const FIXTURE_DIR = join('tests', 'daemon', 'fixtures');

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-fixture-'));
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

async function call(daemon: DaemonHandle, wire: WireCall): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (wire.as !== undefined) headers['authorization'] = `Bearer ${daemon.tokens.get(wire.as)!}`;

  return fetch(`${daemon.url}${wire.path}`, {
    method: wire.method,
    headers,
    ...(wire.body === undefined ? {} : { body: JSON.stringify(wire.body) }),
  });
}

const fixtureFiles = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.json')).sort();

describe('golden wire fixtures', () => {
  it('has fixtures to run', () => {
    // A green suite over an empty fixture directory would prove nothing.
    expect(fixtureFiles.length).toBeGreaterThan(8);
  });

  for (const file of fixtureFiles) {
    it(file.replace(/\.json$/, ''), async () => {
      const fixture = JSON.parse(await readFile(join(FIXTURE_DIR, file), 'utf8')) as Fixture;
      expect(fixture.why, `${file} must record what a broken implementation produces`).toBeTruthy();

      const daemon = await startDaemon({ repo: await tempRepo() });
      try {
        for (const step of fixture.setup ?? []) {
          const response = await call(daemon, step);
          expect(
            response.status,
            `setup step ${step.method} ${step.path} failed: ${await response.text()}`,
          ).toBeLessThan(400);
        }

        const response = await call(daemon, fixture.request);
        const raw = await response.text();

        expect(response.status, `${fixture.name}: ${raw}`).toBe(fixture.expect.status);

        if (fixture.expect.bodyMatches !== undefined) {
          expect(JSON.parse(raw)).toMatchObject(fixture.expect.bodyMatches as object);
        }
        for (const excluded of fixture.expect.bodyExcludes ?? []) {
          expect(raw).not.toContain(excluded);
        }
        if (fixture.expect.eventsOfKind !== undefined) {
          const { events } = JSON.parse(raw) as { events: { kind: string }[] };
          expect(events.filter((event) => event.kind === fixture.expect.eventsOfKind!.kind)).toHaveLength(
            fixture.expect.eventsOfKind.count,
          );
        }
      } finally {
        await daemon.close();
      }
    });
  }
});
