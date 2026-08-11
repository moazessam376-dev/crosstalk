import { describe, it, expect } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { runInit } from '../../src/cli/init.js';
import { humanTokenPath, postAsParticipant } from '../../src/mirror/poll.js';

import type { CrosstalkEvent } from '../../src/contracts/events.js';

const execFile = promisify(execFileCallback);

/**
 * D2 says to request a `src/daemon/server.ts` hook from Track A. These tests
 * exist to find out whether one is needed, and they are kept afterwards because
 * the answer is an assumption the mirror rests on: the inbound channel attributes
 * a pulled GitHub comment to `@human` by holding `@human`'s token, not by asking
 * the daemon to trust a `from` field. If Track A ever makes `from` self-asserted,
 * this file goes red rather than the mirror silently gaining the ability to
 * impersonate any participant.
 */

async function initialised(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ct-mirror-'));
  // A real repository with a commit: `init` now runs the same prerequisite
  // checks `doctor` does and refuses anything else (issue #23). Minimal repair
  // to a Track D file, made by Track B in the commit that changed the rule.
  await execFile('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.email', 'test@crosstalk.invalid'], { cwd: repo, windowsHide: true });
  await execFile('git', ['config', 'user.name', 'crosstalk test'], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, 'README.md'), '# mirror\n', 'utf8');
  await execFile('git', ['add', '-A'], { cwd: repo, windowsHide: true });
  await execFile('git', ['commit', '-qm', 'initial'], { cwd: repo, windowsHide: true });
  await runInit({ repo, participants: [], force: false });
  return repo;
}

async function withDaemon<T>(repo: string, fn: (d: DaemonHandle) => Promise<T>): Promise<T> {
  const daemon = await startDaemon({ repo });
  try {
    return await fn(daemon);
  } finally {
    await daemon.close();
  }
}

async function messagesIn(repo: string): Promise<CrosstalkEvent[]> {
  const raw = await readFile(join(repo, '.crosstalk', 'events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CrosstalkEvent)
    .filter((event) => event.kind === 'message');
}

describe('the seam the inbound mirror posts through', () => {
  it('attributes a message to @human when it carries @human\'s token', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const token = (await readFile(humanTokenPath(repo), 'utf8')).trim();

      await postAsParticipant({
        url: daemon.url,
        token,
        room: '#floor',
        body: 'ship it from the train',
      });

      const messages = await messagesIn(repo);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        kind: 'message',
        from: '@human',
        room: '#floor',
        body: 'ship it from the train',
      });
    });
  });

  /**
   * The other side of the discrimination. Without this, a `postAsParticipant`
   * that hard-coded `from: '@human'` — or a daemon that attributed every
   * message to the human — would pass the test above and be wrong.
   */
  it('attributes a message to the leader when it carries the leader\'s token', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      const token = (await readFile(join(repo, '.crosstalk', 'tokens', 'leader'), 'utf8')).trim();

      await postAsParticipant({ url: daemon.url, token, room: '#floor', body: 'not the human' });

      const messages = await messagesIn(repo);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ from: 'leader', body: 'not the human' });
    });
  });

  it('refuses an unknown token rather than appending an unattributed message', async () => {
    const repo = await initialised();
    await withDaemon(repo, async (daemon) => {
      await expect(
        postAsParticipant({ url: daemon.url, token: 'not-a-token', room: '#floor', body: 'nope' }),
      ).rejects.toThrow();

      expect(await messagesIn(repo)).toHaveLength(0);
    });
  });
});
