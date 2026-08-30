import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SAY_LIMIT } from '../../src/contracts/events.js';
import type { Inbox } from '../../src/core/inbox.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

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
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
`;

async function withDaemon<T>(fn: (d: DaemonHandle) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-inbox-'));
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  const daemon = await startDaemon({ repo: dir });
  try {
    return await fn(daemon);
  } finally {
    await daemon.close();
  }
}

function auth(d: DaemonHandle, id: string): Record<string, string> {
  return { authorization: `Bearer ${d.tokens.get(id)!}` };
}

async function getInbox(d: DaemonHandle, id: string, query = ''): Promise<{ status: number; body: Inbox }> {
  const response = await fetch(`${d.url}/inbox${query}`, { headers: auth(d, id) });
  return { status: response.status, body: (await response.json()) as Inbox };
}

async function say(d: DaemonHandle, from: string, body: string, to?: string): Promise<void> {
  await postSay(d, from, body, to);
}

async function postSay(
  d: DaemonHandle,
  from: string,
  body: string,
  to?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${d.url}/events`, {
    method: 'POST',
    headers: { ...auth(d, from), 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'message', room: '#floor', body, ...(to === undefined ? {} : { to }) }),
  });
  return { status: response.status, body: await response.json() };
}

describe('GET /inbox', () => {
  it('turns a message that addresses you into one said card', async () => {
    await withDaemon(async (daemon) => {
      await say(daemon, 'leader', 'I took auth', 'codex');
      const { status, body } = await getInbox(daemon, 'codex', '?wait=0');

      expect(status).toBe(200);
      expect(body.you).toBe('codex');
      expect(body.role).toBe('builder');
      expect(body.unread).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'said', from: 'leader', summary: 'I took auth' })]),
      );
    });
  });

  it('does not wake you on your own message', async () => {
    await withDaemon(async (daemon) => {
      await getInbox(daemon, 'codex', '?wait=0');
      await say(daemon, 'codex', 'still working');
      const { body } = await getInbox(daemon, 'codex', '?wait=0');

      expect(body.unread.filter((card) => card.kind === 'said' && card.summary === 'still working')).toEqual([]);
      expect(body.next).toBe('idle');
    });
  });

  it('delivers a long body whole, and still gives one scannable line', async () => {
    await withDaemon(async (daemon) => {
      // Under SAY_LIMIT, so it posts — and the finding is at the end, where the
      // old 120-character clip lost it.
      const long = `${'context. '.repeat(120)}the run is unwinnable after a single wreck`;
      expect(long.length).toBeLessThan(SAY_LIMIT);

      await say(daemon, 'leader', long);
      const { body } = await getInbox(daemon, 'codex', '?wait=0');
      const said = body.unread.find((card) => card.kind === 'said');

      expect(said).toBeDefined();
      expect(said!.summary.length).toBeLessThanOrEqual(120);
      expect(said!.body).toBe(long);
      expect(said!.body).toContain('unwinnable after a single wreck');
    });
  });

  it('refuses a body over the cap, and names the way out', async () => {
    await withDaemon(async (daemon) => {
      const { status, body } = await postSay(daemon, 'leader', 'x'.repeat(SAY_LIMIT + 1));

      expect(status).toBe(422);
      const wire = body as { error: { code: string; message: string } };
      expect(wire.error.code).toBe('MESSAGE_TOO_LONG');
      expect(wire.error.message).toContain('ref');

      // Refused means not posted: nothing reaches the board half-said.
      const { body: inbox } = await getInbox(daemon, 'codex', '?wait=0');
      expect(inbox.unread.filter((card) => card.kind === 'said')).toEqual([]);
    });
  });

  it('exempts the operator, whose job brief is not chat', async () => {
    await withDaemon(async (daemon) => {
      const { status } = await postSay(daemon, '@human', 'J'.repeat(SAY_LIMIT * 2));
      expect(status).toBe(201);
    });
  });

  it('returns idle immediately when wait is false', async () => {
    await withDaemon(async (daemon) => {
      const started = Date.now();
      const { body } = await getInbox(daemon, 'codex', '?wait=0');
      expect(Date.now() - started).toBeLessThan(1000);
      expect(body.next).toBe('idle');
      expect(body.unread).toEqual([]);
    });
  });

  it('does not wait 50s when the leader still has to cut tasks from #floor', async () => {
    await withDaemon(async (daemon) => {
      await say(daemon, '@human', '# Quorum\n\nShip the seed list.');
      const started = Date.now();
      const { body } = await getInbox(daemon, 'leader');
      expect(Date.now() - started).toBeLessThan(1000);
      expect(body.job).toContain('Ship the seed list.');
      expect(body.next).toBe('cut tasks from #floor');
    });
  });

  it('does not hand a builder the floor novel before they hold a task', async () => {
    await withDaemon(async (daemon) => {
      await say(daemon, '@human', '# Quorum\n\nShip the seed list.');
      const { body } = await getInbox(daemon, 'codex', '?wait=0');
      expect(body.job).toBeUndefined();
      expect(body.next).toBe('idle');
    });
  });
});
