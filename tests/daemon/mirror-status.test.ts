import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle, type MirrorStatus } from '../../src/daemon/server.js';

/**
 * The mirror is invisible in the hub for a load-bearing reason rather than an
 * oversight: it has no write path into the log (`mirror/index.ts`), and the hub
 * is a projection of the log. That one-way street is what makes "mirror failure
 * never blocks the protocol" structural instead of a discipline.
 *
 * So status comes from its own route. A `mirror_status` event would trade a real
 * safety property for a status line.
 */

const dirs: string[] = [];

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
  const dir = await mkdtemp(join(tmpdir(), 'ct-mirror-status-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

async function get(d: DaemonHandle, path: string): Promise<Response> {
  return fetch(`${d.url}${path}`, { headers: { authorization: `Bearer ${d.tokens.get('leader')!}` } });
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);

describe('the mirror status route', { timeout: 90_000 }, () => {
  it('reports an unconfigured mirror as unconfigured, not as broken', async () => {
    // The state the live project is actually in: no `mirror:` block at all.
    // "Never set up" and "set up and failing" are different facts and the
    // operator does different things about them.
    const daemon = await startDaemon({ repo: await tempRepo() });
    try {
      const response = await get(daemon, '/mirror');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ configured: false, enabled: false });
    } finally {
      await daemon.close();
    }
  });

  it('reports the last drain when a mirror is attached', async () => {
    const daemon = await startDaemon({
      repo: await tempRepo(),
      mirrorStatus: (): MirrorStatus => ({
        configured: true,
        enabled: true,
        lastDrain: { completed: 3, retrying: 1 },
      }),
    });
    try {
      expect(await (await get(daemon, '/mirror')).json()).toMatchObject({
        configured: true,
        enabled: true,
        lastDrain: { completed: 3, retrying: 1 },
      });
    } finally {
      await daemon.close();
    }
  });

  it('reads the status at request time, not at startup', async () => {
    // `up` starts the daemon *before* the mirror, because the mirror reads the
    // daemon's `/stream`. A value captured at startup would therefore report
    // `enabled: false` forever, which is indistinguishable from a mirror that
    // failed to start — the exact confusion this route exists to end.
    let live: MirrorStatus = { configured: true, enabled: false };
    const daemon = await startDaemon({ repo: await tempRepo(), mirrorStatus: () => live });
    try {
      expect(await (await get(daemon, '/mirror')).json()).toMatchObject({ enabled: false });

      live = { configured: true, enabled: true, lastDrain: { completed: 7, retrying: 0 } };

      expect(await (await get(daemon, '/mirror')).json()).toMatchObject({
        enabled: true,
        lastDrain: { completed: 7, retrying: 0 },
      });
    } finally {
      await daemon.close();
    }
  });

  it('refuses an unauthenticated caller, like every route that carries data', async () => {
    const daemon = await startDaemon({ repo: await tempRepo() });
    try {
      expect((await fetch(`${daemon.url}/mirror`)).ok).toBe(false);
    } finally {
      await daemon.close();
    }
  });
});
