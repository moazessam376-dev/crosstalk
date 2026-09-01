import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DaemonClient } from '../../src/mcp/client.js';
import { TOOLS, TOOLS_BY_NAME } from '../../src/mcp/tools.js';

/**
 * An agent attaching a file.
 *
 * Not a fifth tool: `tests/mcp/schemas.test.ts` pins the tool list at four
 * because the four verbs *are* the interface, and attaching a file is
 * something you do while saying something rather than a fifth thing to do. So
 * `attach` is a property on `say`, taking paths.
 *
 * The agent spends the tokens of a path and never of a base64 blob — the MCP
 * server runs in the seat's own process on the same machine as the daemon, so
 * it can read the file itself.
 *
 * Two refusals live in this layer rather than at the daemon, because both are
 * about the seat's own process and the daemon cannot see either: the path must
 * resolve inside the repository, and the cap is checked before the file is
 * read into memory.
 */

const previous = process.env['CROSSTALK_REPO'];
let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ct-attach-'));
  process.env['CROSSTALK_REPO'] = repo;
});

afterEach(() => {
  if (previous === undefined) delete process.env['CROSSTALK_REPO'];
  else process.env['CROSSTALK_REPO'] = previous;
});

/** A fetch that records what it was asked for and answers plausibly. */
function daemon(): { client: DaemonClient; calls: { path: string; init: RequestInit }[] } {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetchImpl = (async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    if (String(path).endsWith('/attachments')) {
      return new Response(
        JSON.stringify({
          attachment: { sha: 'b'.repeat(64), name: 'shot.png', type: 'image/png', bytes: 4 },
          url: `/attachments/${'b'.repeat(64)}.png`,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ events: [] }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { client: new DaemonClient('http://d', 'tok', fetchImpl), calls };
}

const say = () => TOOLS_BY_NAME.get('say')!;

describe('say with files attached', () => {
  it('is a property on say, not a fifth tool', () => {
    expect(TOOLS.map((entry) => entry.name)).toEqual(['inbox', 'say', 'act', 'claim']);
    expect(say().inputSchema.properties['attach']).toBeDefined();
  });

  it('uploads the bytes and sends only the shas', async () => {
    const { client, calls } = daemon();
    await writeFile(join(repo, 'shot.png'), Buffer.from([1, 2, 3, 4]));

    await say().invoke(client, { tag: 'note', head: 'here is what I mean', attach: ['shot.png'] });

    expect(calls.map((call) => call.path)).toEqual(['http://d/attachments', 'http://d/events']);
    // The upload carried the file's own type, from the extension — an agent
    // has no `File.type` to hand, so the path is all there is to go on.
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('image/png');
    // And the message carries the record, not the bytes: the whole point is
    // that a screenshot never passes through the model's context.
    const posted = JSON.parse(calls[1]!.init.body as string) as {
      attachments: { sha: string }[];
      attach?: unknown;
    };
    expect(posted.attachments).toEqual([
      { sha: 'b'.repeat(64), name: 'shot.png', type: 'image/png', bytes: 4 },
    ]);
    expect(posted.attach).toBeUndefined();
  });

  it('refuses a path outside the repository', async () => {
    // `attach: "/etc/passwd"` on a board the mirror pushes to GitHub is an
    // exfiltration path, and one an agent could be talked into by a file it
    // read. It is refused here because only this process knows where it is.
    const { client, calls } = daemon();

    await expect(
      say().invoke(client, { tag: 'note', head: 'look', attach: ['../../../../etc/passwd'] }),
    ).rejects.toThrow(/outside the repository/);
    // Nothing was uploaded and nothing was said — a partial send here would
    // put the message on the board claiming a file that never arrived.
    expect(calls).toEqual([]);
  });

  it('refuses an over-cap file before reading it into memory', async () => {
    // The daemon enforces the cap too. Reading a 200 MB file into this process
    // to be told no is a way to be killed by the OOM killer instead.
    const { client, calls } = daemon();
    // 26 MB of zeroes, written sparse-ish; the check is on `stat`, not content.
    await writeFile(join(repo, 'huge.png'), Buffer.alloc(26 * 1024 * 1024));

    await expect(
      say().invoke(client, { tag: 'note', head: 'look', attach: ['huge.png'] }),
    ).rejects.toThrow(/25 MB/);
    expect(calls).toEqual([]);
  }, 30_000);

  it('refuses a kind of file Crosstalk does not store', async () => {
    const { client } = daemon();
    await writeFile(join(repo, 'a.bin'), Buffer.from([0]));

    await expect(
      say().invoke(client, { tag: 'note', head: 'look', attach: ['a.bin'] }),
    ).rejects.toThrow(/not a kind of file/);
  });

  it('leaves a message with no attach exactly as it was', async () => {
    const { client, calls } = daemon();

    await say().invoke(client, { tag: 'note', head: 'just words' });

    expect(calls.map((call) => call.path)).toEqual(['http://d/events']);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      kind: 'message',
      tag: 'note',
      head: 'just words',
    });
  });

  it('takes a file from a subdirectory the agent actually works in', async () => {
    // The neighbouring case, so "inside the repo" is not accidentally "in the
    // repo root". A builder attaches from its own slice's directory.
    const { client, calls } = daemon();
    await mkdir(join(repo, 'docs', 'shots'), { recursive: true });
    await writeFile(join(repo, 'docs', 'shots', 'diff.md'), '# a diff\n');

    await say().invoke(client, { tag: 'note', head: 'the diff', attach: ['docs/shots/diff.md'] });

    expect(calls.map((call) => call.path)).toEqual(['http://d/attachments', 'http://d/events']);
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('text/markdown');
  });

  it('will not take more files than a message may carry', async () => {
    const { client } = daemon();
    await writeFile(join(repo, 'a.png'), Buffer.from([1]));
    await expect(
      say().invoke(client, {
        tag: 'note',
        head: 'everything',
        attach: Array.from({ length: 11 }, () => 'a.png'),
      }),
    ).rejects.toThrow(/at most 10/);
  });

  it('rejects an attach that is not a list of paths', async () => {
    const { client } = daemon();
    await expect(
      say().invoke(client, { tag: 'note', head: 'x', attach: 'shot.png' }),
    ).rejects.toThrow(/list of paths/);
  });
});

describe('what an attachment costs the reader', () => {
  it('never puts bytes in the tool call', async () => {
    // The property in one assertion: whatever the request body is, it is not
    // the file. Base64 of a screenshot is most of a context window spent on a
    // picture nobody asked the model to look at.
    const { client, calls } = daemon();
    const bytes = Buffer.alloc(64 * 1024, 9);
    await writeFile(join(repo, 'shot.png'), bytes);

    await say().invoke(client, { tag: 'note', head: 'look', attach: ['shot.png'] });

    const posted = calls.find((call) => call.path.endsWith('/events'))!;
    expect((posted.init.body as string).length).toBeLessThan(1024);
  });
});
