import { describe, expect, it, afterEach } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runInit } from '../../src/cli/init.js';
import { startDaemon, exposureWarning, type DaemonHandle } from '../../src/daemon/server.js';

const execFile = promisify(execFileCallback);
const GIT_TEST_TIMEOUT = 45_000;

/**
 * CT-14a. `HOST` was pinned to `127.0.0.1` with no flag, so the operator who
 * asked to check the hub from a phone had no supported way to do it — every
 * workaround is a proxy bolted in front of a server that could have bound the
 * interface itself, and the token to authenticate the result already exists.
 *
 * The reason for the constant stays true and is worth keeping: `localhost`
 * resolves to `::1` first on Windows, which strands IPv4 clients on a server
 * that started fine. That is an argument about the *name*, not the interface.
 */
const daemons: DaemonHandle[] = [];

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.close().catch(() => undefined);
});

async function project(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-host-'));
  await execFile('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 't@e.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'test'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), '# t\n', 'utf8');
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  await runInit({ repo, participants: [], force: false });
  return repo;
}

async function daemonOn(repo: string, host?: string): Promise<DaemonHandle> {
  const daemon = await startDaemon({ repo, ...(host === undefined ? {} : { host }) });
  daemons.push(daemon);
  return daemon;
}

describe('the hub binds loopback unless told otherwise', () => {
  it(
    'defaults to 127.0.0.1, by address and by the name it reports',
    async () => {
      const daemon = await daemonOn(await project());

      expect(daemon.host).toBe('127.0.0.1');
      expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    'binds the interface it is given',
    async () => {
      // Asserted on the bound address rather than by connecting over a routable
      // IP: that needs a non-loopback address and an open host firewall, and
      // AGENTS.md rule 7 wants this green on three platforms.
      const daemon = await daemonOn(await project(), '0.0.0.0');

      expect(daemon.host).toBe('0.0.0.0');
      // Still reachable the ordinary way — binding every interface includes
      // loopback, and the printed url has to be one the operator can click.
      const response = await fetch(`${daemon.url}/health`);
      expect(response.ok).toBe(true);
    },
    GIT_TEST_TIMEOUT,
  );

  it('warns when the interface is not loopback, and stays quiet when it is', () => {
    // Both sides. A warning that fired on every start would be ignored by the
    // time it mattered.
    expect(exposureWarning('0.0.0.0')).toBeDefined();
    expect(exposureWarning('192.168.1.20')).toBeDefined();
    expect(exposureWarning('::')).toBeDefined();

    expect(exposureWarning('127.0.0.1')).toBeUndefined();
    expect(exposureWarning('::1')).toBeUndefined();
    expect(exposureWarning('127.0.0.53')).toBeUndefined();
  });

  it('names the token as the only guard, because it is', () => {
    expect(exposureWarning('0.0.0.0')).toMatch(/token/i);
  });
});
