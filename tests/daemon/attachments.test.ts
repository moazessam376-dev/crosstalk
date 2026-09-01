import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

/**
 * Files on a message: upload, serve, and refuse.
 *
 * The operator uses screenshots — "when I need to show something that I am
 * unable to articulate properly" — so the failure that matters most is the
 * silent one: an upload that appears to work and produces a card with a broken
 * image, or a cap that is announced and not enforced.
 *
 * Two of these are security properties rather than features, and both are the
 * kind that pass every functional test while being wrong: the route must sit
 * *below* authentication, or every screenshot ever pasted is readable by
 * anything that can reach the port; and an SVG must be sent as a download,
 * because the hub serves attachments from its own origin and an inline SVG
 * there is same-origin script.
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

async function open(): Promise<DaemonHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-blobs-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  const daemon = await startDaemon({ repo: dir });
  daemons.push(daemon);
  return daemon;
}

function token(daemon: DaemonHandle, who = '@human'): string {
  return daemon.tokens.get(who)!;
}

interface Uploaded {
  attachment: { sha: string; name: string; type: string; bytes: number };
  url: string;
}

async function upload(
  daemon: DaemonHandle,
  bytes: Buffer | Uint8Array,
  type: string,
  name: string,
): Promise<Response> {
  return fetch(`${daemon.url}/attachments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token(daemon)}`,
      'content-type': type,
      'x-crosstalk-filename': encodeURIComponent(name),
    },
    body: bytes as unknown as ArrayBuffer,
  });
}

/** A tiny valid PNG, so nothing here depends on a fixture file. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

describe('uploading a file', () => {
  it('answers with the sha of the bytes it actually stored', async () => {
    const daemon = await open();
    const response = await upload(daemon, PNG, 'image/png', 'Screenshot 2026-09-02.png');

    expect(response.status).toBe(201);
    const body = (await response.json()) as Uploaded;
    // Re-hashed here rather than compared to a constant: the point of content
    // addressing is that the name is a function of the bytes, and a store that
    // returned any other string would break every reader downstream quietly.
    expect(body.attachment.sha).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(body.attachment.bytes).toBe(PNG.length);
    expect(body.attachment.name).toBe('Screenshot 2026-09-02.png');
    expect(body.url).toBe(`/attachments/${body.attachment.sha}.png`);
  });

  it('stores the same bytes once, however many times they are pasted', async () => {
    const daemon = await open();
    const first = (await (await upload(daemon, PNG, 'image/png', 'a.png')).json()) as Uploaded;
    const second = (await (await upload(daemon, PNG, 'image/png', 'b.png')).json()) as Uploaded;

    expect(second.attachment.sha).toBe(first.attachment.sha);
    // And the second upload did not corrupt the first: the file is still whole.
    const fetched = await fetch(`${daemon.url}${first.url}`, {
      headers: { authorization: `Bearer ${token(daemon)}` },
    });
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(PNG);
  });

  it('never builds a path from the filename the client sent', async () => {
    const daemon = await open();
    const response = await upload(daemon, PNG, 'image/png', '../../../../etc/passwd');

    expect(response.status).toBe(201);
    const body = (await response.json()) as Uploaded;
    // The path is the sha; the name is display only, and even for display it
    // is reduced to a basename so the hub does not show the operator a lie.
    expect(body.attachment.name).toBe('passwd');
    expect(body.url).toBe(`/attachments/${body.attachment.sha}.png`);
  });

  it('refuses a body over the cap when nothing declared its length', async () => {
    // The cap has to be counted as bytes arrive, and this is the case that
    // proves it: a chunked upload carries no `content-length` at all, so
    // there is nothing to check up front and a server that only checked the
    // header would write the whole thing to the operator's disk.
    //
    // (A *lying* `content-length` is not the interesting case, and testing it
    // does not work: Node's parser hands the handler exactly the declared
    // number of bytes, so a lie that understates is a truncated upload rather
    // than an oversized one.)
    const daemon = await open();
    const megabyte = Buffer.alloc(1024 * 1024, 7);
    const body = new ReadableStream({
      start(controller) {
        for (let sent = 0; sent < 30; sent += 1) controller.enqueue(megabyte);
        controller.close();
      },
    });

    const response = await fetch(`${daemon.url}/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token(daemon)}`,
        'content-type': 'image/png',
        'x-crosstalk-filename': 'huge.png',
      },
      body,
      duplex: 'half',
    } as RequestInit);

    expect(response.status).toBe(413);
    const detail = (await response.json()) as { error: { code: string; message: string } };
    expect(detail.error.code).toBe('PAYLOAD_TOO_LARGE');
    // The cap is named in the refusal. An operator who has just dropped a
    // 40 MB photo needs to know the number, not that there is one.
    expect(detail.error.message).toContain('25 MB');
    // And nothing landed: the shards are where finished blobs go.
    const shards = await readdir(join(dirs[dirs.length - 1]!, '.crosstalk', 'blobs'));
    expect(shards.filter((entry) => entry !== 'tmp')).toEqual([]);
  }, 30_000);

  it('will not take a file with no declared type', async () => {
    const daemon = await open();
    const response = await fetch(`${daemon.url}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token(daemon)}` },
      body: PNG as unknown as ArrayBuffer,
    });
    expect(response.status).toBe(400);
  });
});

describe('serving a file', () => {
  it('is behind authentication, like every other reader of the log', async () => {
    // If this route sat with the hub's own bundle on the front door, every
    // screenshot the operator ever pasted would be readable by anything that
    // could reach the port. Contract §3: log readers authenticate.
    const daemon = await open();
    const body = (await (await upload(daemon, PNG, 'image/png', 'a.png')).json()) as Uploaded;

    const anonymous = await fetch(`${daemon.url}${body.url}`);

    expect(anonymous.status).toBe(401);
  });

  it('sends svg and html as downloads, not as pages', async () => {
    // The hub serves these from its *own origin*. An SVG rendered inline is
    // same-origin script with everything the hub page has. They are legitimate
    // attachments — a diagram, a coverage report — so they are stored and
    // served, with the header that makes the browser save them instead.
    const daemon = await open();
    for (const [type, name] of [
      ['image/svg+xml', 'diagram.svg'],
      ['text/html', 'coverage.html'],
    ] as const) {
      const bytes = Buffer.from(`<x>${name}</x>`);
      const body = (await (await upload(daemon, bytes, type, name)).json()) as Uploaded;
      const served = await fetch(`${daemon.url}${body.url}`, {
        headers: { authorization: `Bearer ${token(daemon)}` },
      });
      expect(served.headers.get('content-disposition'), type).toBe('attachment');
      expect(served.headers.get('x-content-type-options'), type).toBe('nosniff');
    }
  });

  it('sends an image inline, so the card can show it', async () => {
    const daemon = await open();
    const body = (await (await upload(daemon, PNG, 'image/png', 'a.png')).json()) as Uploaded;
    const served = await fetch(`${daemon.url}${body.url}`, {
      headers: { authorization: `Bearer ${token(daemon)}` },
    });

    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('content-disposition')).toBeNull();
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG);
  });

  it('refuses a key that is not a sha, without touching the disk', async () => {
    const daemon = await open();
    for (const key of ['../../../../etc/passwd', '..%2f..%2fevents.jsonl', 'nope', 'a'.repeat(64)]) {
      const response = await fetch(`${daemon.url}/attachments/${encodeURIComponent(key)}`, {
        headers: { authorization: `Bearer ${token(daemon)}` },
      });
      expect(response.status, key).toBe(404);
    }
  });
});

describe('a message that carries files', () => {
  async function say(daemon: DaemonHandle, body: object): Promise<Response> {
    return fetch(`${daemon.url}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token(daemon)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'message', room: '#floor', ...body }),
    });
  }

  it('keeps the record, and keeps the hash out of the path', async () => {
    const daemon = await open();
    const uploaded = (await (await upload(daemon, PNG, 'image/png', 'shot.png')).json()) as Uploaded;

    const response = await say(daemon, {
      body: 'here is what I mean',
      attachments: [uploaded.attachment],
    });

    expect(response.status).toBe(201);
    const { events } = (await response.json()) as {
      events: { attachments?: { sha: string; name: string }[] }[];
    };
    expect(events[0]!.attachments).toEqual([
      { sha: uploaded.attachment.sha, name: 'shot.png', type: 'image/png', bytes: PNG.length },
    ]);
  });

  it('refuses a sha that is not one', async () => {
    // The sha is a path component in every reader that resolves it. A record
    // carrying `../..` would be a traversal in all of them, so it is checked at
    // the one point where the log gains one.
    const daemon = await open();
    const response = await say(daemon, {
      body: 'trust me',
      attachments: [{ sha: '../../../etc/passwd', name: 'x', type: 'image/png', bytes: 1 }],
    });
    expect(response.status).toBe(400);
  });

  it('caps how many ride on one message', async () => {
    const daemon = await open();
    const sha = createHash('sha256').update(PNG).digest('hex');
    const response = await say(daemon, {
      body: 'everything I have',
      attachments: Array.from({ length: 11 }, () => ({
        sha, name: 'a.png', type: 'image/png', bytes: 1,
      })),
    });
    expect(response.status).toBe(400);
  });

  it('leaves a message with none of them exactly as it was', async () => {
    // The amendment is optional, and every message written before it has no
    // `attachments` key at all — not an empty array, which would change what
    // every existing reader sees.
    const daemon = await open();
    const response = await say(daemon, { body: 'just words' });
    const { events } = (await response.json()) as { events: Record<string, unknown>[] };
    expect('attachments' in events[0]!).toBe(false);
  });
});
