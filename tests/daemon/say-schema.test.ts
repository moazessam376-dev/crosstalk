import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import type { Inbox } from '../../src/core/inbox.js';

/**
 * The schema, on the wire.
 *
 * `to` was purely additive — `addressesParticipant` fires on it, but `#floor`
 * membership still delivers to everybody, so naming one seat never removed a
 * reader. 312 of the vault-team run's 560 peer messages opened `peer-N — ` and
 * were read in full by three seats who were not being spoken to. Twelve set
 * `to`. None used a side room, though the brief's last line and the operator's
 * opening message both said to.
 *
 * The path was not there: those seats were MCP-tier and there is no MCP `dm`
 * verb, so reaching a side room meant hand-building `dm:a~b`. `say` routes on
 * `to` now, and the side room is the short way rather than the long one.
 */

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

function config(shape?: string): string {
  return `version: 1
project:
  repo: .
  mainBranch: main
${shape === undefined ? '' : `shape: ${shape}\n`}participants:
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
  - id: peer-1
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
  - id: peer-2
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
  - id: peer-3
    role: peer
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
`;
}

async function repo(shape?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-say-schema-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), config(shape), 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function say(daemon: DaemonHandle, who: string, payload: Record<string, unknown>) {
  const response = await fetch(`${daemon.url}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.tokens.get(who)!}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'message', ...payload }),
  });
  const json = (await response.json()) as Record<string, unknown> & { error?: { message: string } };
  return { status: response.status, json, refusal: json.error?.message ?? '' };
}

async function inboxOf(daemon: DaemonHandle, who: string): Promise<Inbox> {
  const response = await fetch(`${daemon.url}/inbox?timeout_s=0`, {
    headers: { authorization: `Bearer ${daemon.tokens.get(who)!}` },
  });
  return (await response.json()) as Inbox;
}

describe('say routes one-to-one traffic to a side room', () => {
  it('opens the room from `to` when no room is named', async () => {
    const dir = await repo('trio-contract');
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);
    // Wake all three so every seat is joined and could have been a reader.
    for (const seat of ['peer-1', 'peer-2', 'peer-3']) await inboxOf(daemon, seat);

    const posted = await say(daemon, 'peer-1', {
      tag: 'ask',
      head: 'does the HUD own the score, or does the sim?',
      to: 'peer-2',
    });
    expect(posted.status).toBe(201);

    const events = posted.json['events'] as { room: string; to?: string }[];
    expect(events[0]!.room).toBe('dm:peer-1~peer-2');
    // `to` is kept as well as the room, so the wake still fires on it.
    expect(events[0]!.to).toBe('peer-2');
  });

  it('delivers it to the seat asked, and to nobody else', async () => {
    // The measurement this whole change is for. A broadcast costs every reader
    // the whole message; a side room costs one.
    const dir = await repo('trio-contract');
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);
    for (const seat of ['peer-1', 'peer-2', 'peer-3']) await inboxOf(daemon, seat);

    await say(daemon, 'peer-1', { tag: 'ask', head: 'who owns the HUD?', to: 'peer-2' });

    const asked = await inboxOf(daemon, 'peer-2');
    const bystander = await inboxOf(daemon, 'peer-3');

    expect(asked.unread.map((card) => card.summary).join(' ')).toContain('who owns the HUD?');
    expect(bystander.unread.map((card) => card.summary).join(' ')).not.toContain('who owns the HUD?');
  });

  it('refuses an ask broadcast to the floor, and names the fix', async () => {
    const dir = await repo('trio-contract');
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);
    await inboxOf(daemon, 'peer-1');

    const refused = await say(daemon, 'peer-1', {
      tag: 'ask',
      room: '#floor',
      head: 'who owns the HUD?',
      to: 'peer-2',
    });

    expect(refused.status).toBe(422);
    expect(refused.refusal).toContain('to: "peer-2"');
  });

  it('refuses a gate asserted in a side room', async () => {
    // assertedGates only reads #floor, so a gate anywhere else is uncounted and
    // silent — the phase simply never advances and nothing says why.
    const dir = await repo('trio-contract');
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);
    await inboxOf(daemon, 'peer-1');

    const refused = await say(daemon, 'peer-1', {
      tag: 'gate',
      room: 'dm:peer-1~peer-2',
      head: 'my slice is done',
      ref: 'gate:tests-green',
    });

    expect(refused.status).toBe(422);
    expect(refused.refusal).toContain('#floor');
  });
});

describe('a project with no shape', () => {
  it('still posts a bare room and body, exactly as it always did', async () => {
    // The backward-compatibility guarantee, asserted rather than assumed. Every
    // repository already using Crosstalk is this one.
    const dir = await repo(undefined);
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);
    await inboxOf(daemon, 'peer-1');

    const posted = await say(daemon, 'peer-1', { room: '#floor', body: 'no tag, no head, no trouble' });

    expect(posted.status).toBe(201);
    const events = posted.json['events'] as { body: string; tag?: string }[];
    expect(events[0]!.body).toBe('no tag, no head, no trouble');
    expect(events[0]!.tag).toBeUndefined();
  });
});
