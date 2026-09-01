import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

const execFile = promisify(execFileCb);

/**
 * Configuring the mirror from the hub.
 *
 * The measured reason nobody ever configured it: the only way in was a terminal
 * command against a YAML block with no documented shape, while the hub said "no
 * mirror configured" and offered nothing. The daemon had no config-write route
 * at all, so the field could not have existed.
 */

const dirs: string[] = [];

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
  - id: opus
    role: peer
    harness: claude-code-live
    lifecycle: attached
    workspace: .
`;

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mirror-config-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  await execFile('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function post(d: DaemonHandle, body: unknown, who = '@human'): Promise<Response> {
  return fetch(`${d.url}/mirror`, {
    method: 'POST',
    headers: { authorization: `Bearer ${d.tokens.get(who)!}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('pointing the mirror at a repository', () => {
  it('takes a pasted browser URL and writes the block', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      const response = await post(daemon, { url: 'https://github.com/moazessam376-dev/crosstalk' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        repo: 'moazessam376-dev/crosstalk',
        remote: 'origin',
        humanLogin: 'moazessam376-dev',
      });

      const config = parse(await readFile(join(dir, 'crosstalk.yaml'), 'utf8')) as {
        mirror?: { github: { enabled: boolean; humanLogin: string } };
        participants: unknown[];
      };
      expect(config.mirror?.github.enabled).toBe(true);
      expect(config.mirror?.github.humanLogin).toBe('moazessam376-dev');
      // Read-modify-write: the roster is in this file and must survive.
      expect(config.participants).toHaveLength(2);
    } finally {
      await daemon.close();
    }
  });

  it('sets the remote, which is how `gh` knows the repository', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      await post(daemon, { url: 'git@github.com:someone/thing.git' });
      const { stdout } = await execFile('git', ['remote', 'get-url', 'origin'], { cwd: dir });
      expect(stdout.trim()).toBe('https://github.com/someone/thing.git');
    } finally {
      await daemon.close();
    }
  });

  it('reports the mirror as configured without a restart', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      const before = (await (
        await fetch(`${daemon.url}/mirror`, { headers: { authorization: `Bearer ${daemon.tokens.get('@human')!}` } })
      ).json()) as { configured: boolean };
      expect(before.configured).toBe(false);

      await post(daemon, { url: 'owner/repo' });

      const after = (await (
        await fetch(`${daemon.url}/mirror`, { headers: { authorization: `Bearer ${daemon.tokens.get('@human')!}` } })
      ).json()) as { configured: boolean };
      expect(after.configured).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('refuses something that is not a repository rather than guessing', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      // A mirror pointed at the wrong repository is worse than one that refused
      // to be configured: this is the value every PR is opened against.
      const response = await post(daemon, { url: 'https://example.com/not-github' });
      expect(response.status).toBe(400);
      const config = await readFile(join(dir, 'crosstalk.yaml'), 'utf8');
      expect(config).not.toContain('mirror');
    } finally {
      await daemon.close();
    }
  });

  it('needs a url', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      expect((await post(daemon, {})).status).toBe(400);
    } finally {
      await daemon.close();
    }
  });

  it('is the operator’s to do, not a seat’s', async () => {
    const dir = await tempRepo();
    const daemon = await startDaemon({ repo: dir });
    try {
      expect((await post(daemon, { url: 'owner/repo' }, 'opus')).status).toBe(403);
    } finally {
      await daemon.close();
    }
  });
});
