import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  await fetch(`${d.url}/events`, {
    method: 'POST',
    headers: { ...auth(d, from), 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'message', room: '#floor', body, ...(to === undefined ? {} : { to }) }),
  });
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

  it('clips a long body so the raw text never appears in summary', async () => {
    await withDaemon(async (daemon) => {
      const long = 'x'.repeat(2000);
      await say(daemon, 'leader', long);
      const { body } = await getInbox(daemon, 'codex', '?wait=0');
      const said = body.unread.find((card) => card.kind === 'said');

      expect(said).toBeDefined();
      expect(said!.summary.length).toBeLessThanOrEqual(120);
      expect(said!.summary).not.toBe(long);
      expect(JSON.stringify(body)).not.toContain(long);
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

  it('does not wait 50s when a #floor job is already on the board', async () => {
    await withDaemon(async (daemon) => {
      await say(daemon, '@human', '# Quorum\n\nShip the seed list.');
      const started = Date.now();
      const { body } = await getInbox(daemon, 'codex');
      expect(Date.now() - started).toBeLessThan(1000);
      expect(body.job).toContain('Ship the seed list.');
      expect(body.next).toBe('job on #floor — start');
    });
  });
});
