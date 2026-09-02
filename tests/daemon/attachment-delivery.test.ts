import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { boardTurn } from '../../src/harness/runner.js';
import type { Inbox } from '../../src/core/inbox.js';

/**
 * What an agent is handed when someone attaches a file, and what survives a
 * deleted run.
 *
 * The delivery half is one property: **a path, never bytes**. The seat has its
 * own Read tool; what it lacks is somewhere to point it. Base64 in the card
 * would put a screenshot through the model's context for a picture nobody
 * asked it to look at, and Beacon-1 already measured what filling a context
 * with unasked-for material costs.
 *
 * The collection half is the mirror image: a blob is shared by every message
 * that attached the same bytes, so deleting the run holding one reference must
 * not break the card in the run holding another.
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
    harness: claude-code-live
    lifecycle: supervised
    workspace: .
`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function open(): Promise<{ daemon: DaemonHandle; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-deliver-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  const daemon = await startDaemon({ repo: dir });
  daemons.push(daemon);
  return { daemon, dir };
}

function auth(daemon: DaemonHandle, who = '@human'): Record<string, string> {
  return {
    authorization: `Bearer ${daemon.tokens.get(who)!}`,
    'content-type': 'application/json',
  };
}

async function upload(daemon: DaemonHandle, bytes: Buffer, type: string, name: string) {
  const response = await fetch(`${daemon.url}/attachments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${daemon.tokens.get('@human')!}`,
      'content-type': type,
      'x-crosstalk-filename': encodeURIComponent(name),
    },
    body: bytes as unknown as ArrayBuffer,
  });
  return (await response.json()) as { attachment: { sha: string; name: string; type: string; bytes: number } };
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

describe('what the agent is handed', () => {
  it('gives a path it can open, and no bytes at all', async () => {
    const { daemon, dir } = await open();
    const { attachment } = await upload(daemon, PNG, 'image/png', 'shot.png');
    await fetch(`${daemon.url}/events`, {
      method: 'POST',
      headers: auth(daemon),
      body: JSON.stringify({
        kind: 'message',
        room: '#floor',
        body: 'here is what I mean',
        attachments: [attachment],
      }),
    });

    const inbox = (await (
      await fetch(`${daemon.url}/inbox`, { headers: auth(daemon, 'peer-1') })
    ).json()) as Inbox;

    const card = inbox.unread.find((entry) => entry.attachments !== undefined)!;
    expect(card.attachments).toHaveLength(1);
    const [file] = card.attachments!;
    // Absolute, inside this repository's blob store, and named by the sha —
    // which is also how the daemon finds it, so the two cannot drift.
    expect(file!.path).toBe(join(dir, '.crosstalk', 'blobs', attachment.sha.slice(0, 2), `${attachment.sha}.png`));
    expect(file!.type).toBe('image/png');
    // Not a byte of the file anywhere in the payload.
    expect(JSON.stringify(inbox)).not.toContain(PNG.toString('base64').slice(0, 24));
  });

  it('prints the path in a supervised seat’s turn, with what it is', () => {
    const turn = boardTurn({
      you: 'peer-1',
      role: 'peer',
      mine: [],
      unread: [
        {
          seq: 4,
          kind: 'said',
          from: '@human',
          room: '#floor',
          summary: 'here is what I mean',
          attachments: [{ path: '/repo/.crosstalk/blobs/ab/abc.png', type: 'image/png', bytes: 412_000 }],
        },
      ],
    } as Inbox);

    expect(turn).toContain('attached: /repo/.crosstalk/blobs/ab/abc.png (image/png, 402 KB)');
  });

  it('says nothing extra when a message has no files', () => {
    const turn = boardTurn({
      you: 'peer-1',
      role: 'peer',
      mine: [],
      unread: [{ seq: 4, kind: 'said', from: '@human', room: '#floor', summary: 'just words' }],
    } as Inbox);

    expect(turn).not.toContain('attached:');
  });
});

describe('collecting blobs when a run is deleted', () => {
  async function shards(dir: string): Promise<string[]> {
    const entries = await readdir(join(dir, '.crosstalk', 'blobs')).catch(() => [] as string[]);
    const found: string[] = [];
    for (const shard of entries) {
      if (shard === 'tmp') continue;
      found.push(...(await readdir(join(dir, '.crosstalk', 'blobs', shard))));
    }
    return found;
  }

  /**
   * Ages the blobs past the sweep's floor.
   *
   * A blob uploaded seconds ago has no record pointing at it *yet* — the
   * operator is still typing — so the sweep leaves anything under an hour old
   * alone. Without this, the test would prove only that the floor works.
   */
  async function age(dir: string): Promise<void> {
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 7 * 3_600_000);
    for (const shard of await readdir(join(dir, '.crosstalk', 'blobs'))) {
      if (shard === 'tmp') continue;
      for (const file of await readdir(join(dir, '.crosstalk', 'blobs', shard))) {
        await utimes(join(dir, '.crosstalk', 'blobs', shard, file), old, old);
      }
    }
  }

  it('keeps a blob a surviving archive still points at', async () => {
    // The case a naive sweep gets wrong, and it only bites when the archive is
    // the *only* thing holding the reference: the same screenshot pasted into
    // two runs is one file, so deleting the run that holds the first reference
    // must not break the card in the run that holds the second.
    //
    // So both references are archived away and none is left in the live log —
    // an earlier version of this test left one there, and passed with the
    // archive scan deleted.
    const { daemon, dir } = await open();
    const { attachment } = await upload(daemon, PNG, 'image/png', 'shot.png');

    const post = async (): Promise<void> => {
      await fetch(`${daemon.url}/events`, {
        method: 'POST',
        headers: auth(daemon),
        body: JSON.stringify({ kind: 'message', room: '#floor', body: 'shot', attachments: [attachment] }),
      });
    };
    const newRun = async (): Promise<void> => {
      await fetch(`${daemon.url}/runs`, { method: 'POST', headers: auth(daemon), body: '{}' });
    };

    await post();           // run 1 references it
    await newRun();
    await post();           // run 2 references it
    await newRun();         // run 3 is current, and references nothing

    const listed = (await (await fetch(`${daemon.url}/runs`, { headers: auth(daemon) })).json()) as {
      runs: { id: string; current: boolean }[];
    };
    const older = listed.runs.filter((run) => !run.current);
    expect(older.length).toBeGreaterThanOrEqual(2);
    // Archive both, oldest first — archiving moves a *prefix* of the log, so
    // taking the newer one out from under the older is refused, and rightly.
    for (const run of [...older].reverse()) {
      await fetch(`${daemon.url}/runs/${run.id}/archive`, { method: 'POST', headers: auth(daemon) });
    }
    await age(dir);

    const doomed = older.at(-1)!;
    const deleted = await fetch(`${daemon.url}/runs/${doomed.id}`, {
      method: 'DELETE',
      headers: auth(daemon),
      body: JSON.stringify({ confirm: doomed.id }),
    });

    expect(deleted.status).toBe(200);
    // Nothing in the live log points at it; the other archive does.
    expect(JSON.stringify(await (await fetch(`${daemon.url}/events?since=0`, { headers: auth(daemon) })).json()))
      .not.toContain(attachment.sha);
    expect(await shards(dir)).toEqual([`${attachment.sha}.png`]);
  }, 30_000);

  it('drops a blob nothing points at any more', async () => {
    const { daemon, dir } = await open();
    await upload(daemon, PNG, 'image/png', 'orphan.png');
    // Never attached to anything, and old enough to be past the floor.
    await age(dir);
    expect(await shards(dir)).toHaveLength(1);

    // Deleting a run is what triggers the sweep, so make one to delete.
    await fetch(`${daemon.url}/runs`, { method: 'POST', headers: auth(daemon), body: '{}' });
    await fetch(`${daemon.url}/runs`, { method: 'POST', headers: auth(daemon), body: '{}' });
    const runs = (await (await fetch(`${daemon.url}/runs`, { headers: auth(daemon) })).json()) as {
      runs: { id: string; current: boolean }[];
    };
    const oldest = runs.runs.filter((run) => !run.current).at(-1)!;
    await fetch(`${daemon.url}/runs/${oldest.id}/archive`, { method: 'POST', headers: auth(daemon) });
    await fetch(`${daemon.url}/runs/${oldest.id}`, {
      method: 'DELETE',
      headers: auth(daemon),
      body: JSON.stringify({ confirm: oldest.id }),
    });

    expect(await shards(dir)).toEqual([]);
  }, 30_000);

  it('leaves a blob that is too new to have been attached yet', async () => {
    // The paperclip uploads on attach, so between the upload and the send
    // there is a window where a blob is referenced by nothing. Collecting in
    // that window would make attaching files lose them at random.
    const { daemon, dir } = await open();
    await upload(daemon, PNG, 'image/png', 'just-pasted.png');

    await fetch(`${daemon.url}/runs`, { method: 'POST', headers: auth(daemon), body: '{}' });
    await fetch(`${daemon.url}/runs`, { method: 'POST', headers: auth(daemon), body: '{}' });
    const runs = (await (await fetch(`${daemon.url}/runs`, { headers: auth(daemon) })).json()) as {
      runs: { id: string; current: boolean }[];
    };
    const oldest = runs.runs.filter((run) => !run.current).at(-1)!;
    await fetch(`${daemon.url}/runs/${oldest.id}/archive`, { method: 'POST', headers: auth(daemon) });
    await fetch(`${daemon.url}/runs/${oldest.id}`, {
      method: 'DELETE',
      headers: auth(daemon),
      body: JSON.stringify({ confirm: oldest.id }),
    });

    expect(await shards(dir)).toHaveLength(1);
  }, 30_000);
});

describe('down --purge and attachments', () => {
  it('removes blobs nothing references, and leaves the archives alone', async () => {
    // `--purge` is the scratch broom. An attachment is scratch only once no
    // record names it; an *archive* is history and follows the event log's
    // rule ("the event log and tokens are kept"), so removing one stays an
    // explicit act — `ct runs rm`, with the id typed back.
    const { daemon, dir } = await open();
    const kept = await upload(daemon, PNG, 'image/png', 'kept.png');
    const orphan = await upload(daemon, Buffer.from('nobody asked'), 'text/plain', 'orphan.txt');

    await fetch(`${daemon.url}/events`, {
      method: 'POST',
      headers: auth(daemon),
      body: JSON.stringify({ kind: 'message', room: '#floor', body: 'kept', attachments: [kept.attachment] }),
    });
    // One archive, so the "reads archives too" half is exercised.
    await fetch(`${daemon.url}/runs`, { method: 'POST', headers: auth(daemon), body: '{}' });
    const listed = (await (await fetch(`${daemon.url}/runs`, { headers: auth(daemon) })).json()) as {
      runs: { id: string; current: boolean }[];
    };
    const older = listed.runs.find((run) => !run.current)!;
    await fetch(`${daemon.url}/runs/${older.id}/archive`, { method: 'POST', headers: auth(daemon) });
    await daemon.close();
    daemons.pop();

    const { purgeWorkspaces } = await import('../../src/cli/init.js');
    await purgeWorkspaces(dir);

    const left = await readdir(join(dir, '.crosstalk', 'blobs'));
    const files: string[] = [];
    for (const shard of left) {
      if (shard === 'tmp') continue;
      files.push(...(await readdir(join(dir, '.crosstalk', 'blobs', shard))));
    }
    // The archived run's attachment survives; the one nobody attached does not.
    expect(files).toEqual([`${kept.attachment.sha}.png`]);
    expect(files).not.toContain(`${orphan.attachment.sha}.txt`);
    // And the archive itself is untouched.
    expect(await readdir(join(dir, '.crosstalk', 'runs'))).toContain(`${older.id}.jsonl`);
  }, 30_000);
});
