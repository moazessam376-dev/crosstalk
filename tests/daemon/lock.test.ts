import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireLock, readLock, releaseLock } from '../../src/daemon/lock.js';
import { startDaemon } from '../../src/daemon/server.js';

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
  const dir = await mkdtemp(join(tmpdir(), 'ct-lock-'));
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

/** A pid that certainly no longer exists: spawn a process and wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((done) => child.once('exit', done));
  return pid;
}

/** A port nothing is listening on. */
const DEAD_URL = 'http://127.0.0.1:1';

describe('daemon lock', () => {
  it('reclaims a lock whose holder has exited', async () => {
    const repo = await tempRepo();
    const lockPath = join(repo, '.crosstalk', 'daemon.lock');
    await writeFile(
      lockPath,
      JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString() }),
      'utf8',
    );

    const daemon = await startDaemon({ repo });
    try {
      expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await readLock(lockPath))?.pid).toBe(process.pid);
    } finally {
      await daemon.close();
    }
  });

  it('reclaims a lock whose pid is alive but is not a daemon', async () => {
    // The recycled-pid case. `process.pid` is certainly alive — it is us — so a
    // pid check alone would call this lock live and the daemon would be
    // permanently unstartable, with no remedy but deleting a file by hand.
    const repo = await tempRepo();
    const lockPath = join(repo, '.crosstalk', 'daemon.lock');
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), url: DEAD_URL }),
      'utf8',
    );

    const daemon = await startDaemon({ repo });
    try {
      expect(daemon.url).not.toBe(DEAD_URL);
    } finally {
      await daemon.close();
    }
  });

  it('refuses when the holder is alive and answering', async () => {
    const repo = await tempRepo();
    const daemon = await startDaemon({ repo });
    try {
      await expect(startDaemon({ repo })).rejects.toMatchObject({
        code: 'DAEMON_ALREADY_RUNNING',
        url: daemon.url,
      });
    } finally {
      await daemon.close();
    }
  });

  it('does not release a lock held by another process', async () => {
    const repo = await tempRepo();
    const lockPath = join(repo, '.crosstalk', 'daemon.lock');
    const foreign = { pid: process.pid + 1, startedAt: new Date().toISOString() };
    await writeFile(lockPath, JSON.stringify(foreign), 'utf8');

    await releaseLock(lockPath);

    // Still there: a crashed-then-reclaimed lock belongs to whoever holds it now.
    expect(JSON.parse(await readFile(lockPath, 'utf8')).pid).toBe(foreign.pid);
  });

  it('leaves no lock behind when startup fails after acquiring it', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ct-lock-'));
    await mkdir(join(repo, '.crosstalk'), { recursive: true });
    // No crosstalk.yaml, so loadConfig throws — but that happens before the lock.
    // Write a config that parses and then fails validation instead.
    await writeFile(join(repo, 'crosstalk.yaml'), 'version: 1\nparticipants: []\n', 'utf8');

    await expect(startDaemon({ repo })).rejects.toMatchObject({ code: 'MALFORMED_CONFIG' });
    expect(await readLock(join(repo, '.crosstalk', 'daemon.lock'))).toBeUndefined();
  });

  it('acquires and releases a bare lock', async () => {
    const repo = await tempRepo();
    const lockPath = join(repo, '.crosstalk', 'daemon.lock');

    await acquireLock(lockPath);
    expect((await readLock(lockPath))?.pid).toBe(process.pid);

    await releaseLock(lockPath);
    expect(await readLock(lockPath)).toBeUndefined();
  });
});
