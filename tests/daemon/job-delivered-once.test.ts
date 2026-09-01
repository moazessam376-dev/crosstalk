import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { Inbox } from '../../src/core/inbox.js';

const execFile = promisify(execFileCb);

/**
 * The opening job reaches a seat down exactly one path.
 *
 * Two carry it. `runCompose` types it into the seat as its first turn — that is
 * the one that survives a start-up dialog, because it keeps offering until the
 * seat is at a prompt. `/launch` also posts it to `#floor`, for the operator
 * and for anyone joining later.
 *
 * The floor that stops a seat being handed history was being set *before* that
 * post, so the job landed above it and the wake loop delivered the same text a
 * second time. Every seat opened on its brief printed twice — the operator saw
 * it as one turn containing the whole job, then the whole job again.
 *
 * Order is the fix: post, then set the floor over it.
 */

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

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
  - id: peer-1
    role: peer
    harness: claude-code-app
    lifecycle: attached
    workspace: .
  - id: peer-2
    role: peer
    harness: claude-code-app
    lifecycle: attached
    workspace: .
`;

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-job-once-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

const JOB = 'Read JOB.md at the root of your worktree and work it.';

describe('launching a run', () => {
  it('does not also hand the job to a seat through the board', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    await fetch(`${daemon.url}/launch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemon.tokens.get('@human')!}`,
        'content-type': 'application/json',
      },
      // No seats named, so nothing is re-staffed and no process is spawned —
      // this is about what the *board* hands over, which is the duplicate half.
      body: JSON.stringify({ job: JOB }),
    });

    const response = await fetch(`${daemon.url}/inbox?wait=0`, {
      headers: { authorization: `Bearer ${daemon.tokens.get('peer-1')!}` },
    });
    const inbox = (await response.json()) as Inbox;

    // `runCompose` types the job as the seat's first turn. The board must not
    // deliver it as well, or the seat reads its brief twice.
    expect(JSON.stringify(inbox.unread)).not.toContain('Read JOB.md');
  }, 30_000);

  /** It is still on the board: that is where the operator reads it. */
  it('still posts the job to the floor', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    await fetch(`${daemon.url}/launch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemon.tokens.get('@human')!}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ job: JOB }),
    });

    const events = await fetch(`${daemon.url}/events?since=0`, {
      headers: { authorization: `Bearer ${daemon.tokens.get('@human')!}` },
    });
    expect(JSON.stringify(await events.json())).toContain('Read JOB.md');
  }, 30_000);

  /** And anything said after the launch still reaches the seats normally. */
  it('delivers what is said after the launch', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    const auth = { authorization: `Bearer ${daemon.tokens.get('@human')!}`, 'content-type': 'application/json' };
    await fetch(`${daemon.url}/launch`, { method: 'POST', headers: auth, body: JSON.stringify({ job: JOB }) });
    await fetch(`${daemon.url}/events`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kind: 'message', room: '#floor', body: 'one more thing' }),
    });

    const response = await fetch(`${daemon.url}/inbox?wait=0`, {
      headers: { authorization: `Bearer ${daemon.tokens.get('peer-1')!}` },
    });
    expect(JSON.stringify(((await response.json()) as Inbox).unread)).toContain('one more thing');
  }, 30_000);
});
