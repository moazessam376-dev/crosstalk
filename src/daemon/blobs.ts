import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import {
  BLOB_KEY_PATTERN,
  capFor,
  extensionFor,
  isInlineSafe,
  typeForExtension,
} from '../core/attachments.js';

/**
 * Where the bytes of an attachment live, and how they get there safely.
 *
 * The operator's ask: "attached media, pics files videos etc. at least
 * pictures, I usually use it. rarely I use videos when I need to show
 * something that I am unable to articulate properly." Screenshots, mainly —
 * and the point of a screenshot is that describing it was the hard part.
 *
 * Three properties carry this module, and each is a way it could otherwise go
 * wrong quietly:
 *
 * **Content-addressed.** The path is derived from the sha256 of the bytes, so
 * the same screenshot pasted into three messages is one file, a record can
 * never point at bytes that are not the ones it was written about, and there
 * is no filename collision to resolve.
 *
 * **The extension comes from the declared type, never the filename.** A
 * filename is client input, and `join(dir, name)` with client input is the
 * oldest bug in file serving — this daemon runs with the operator's own
 * permissions in their own repository. There is no sanitising step to get
 * wrong, because the client's string never reaches a path at all.
 *
 * **The cap is counted as bytes arrive.** `content-length` is a claim, not a
 * measurement: a client that lies about it, or omits it under chunked
 * encoding, would otherwise write an unbounded file to the operator's disk.
 */

/**
 * How much of an over-cap body to read and discard before hanging up.
 *
 * Enough that an honest client finishes its request and reads a clean 413;
 * short of unbounded, so a sender that never stops cannot hold the handler
 * open. Nothing past the cap is ever written to disk either way.
 */
const DRAIN_CAP = 8 * 1024 * 1024;



export interface StoredBlob {
  sha: string;
  name: string;
  type: string;
  bytes: number;
  /** Absolute, for a seat that is about to open it with its own tools. */
  path: string;
}

export class BlobTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`too large: the cap for this kind of file is ${Math.round(limit / (1024 * 1024))} MB`);
    this.name = 'BlobTooLarge';
  }
}





export class BlobStore {
  readonly #root: string;

  constructor(crosstalkDir: string) {
    this.#root = join(crosstalkDir, 'blobs');
  }

  get root(): string {
    return this.#root;
  }

  /** `<root>/<sha[0:2]>/<sha><ext>` — two levels, so no directory holds thousands. */
  pathFor(sha: string, type: string): string {
    return join(this.#root, sha.slice(0, 2), `${sha}${extensionFor(type)}`);
  }

  /**
   * Read a stream to disk, hashing as it goes, and stop the moment it is over.
   *
   * Written to a temporary name and renamed only once the whole body has
   * arrived, because the destination is the *hash of the complete bytes*: a
   * partial upload landing at its final path would be a file whose name is a
   * lie, permanently, since content addressing means nothing ever overwrites
   * it.
   */
  async put(source: NodeJS.ReadableStream, name: string, type: string): Promise<StoredBlob> {
    const limit = capFor(type);
    const tmpDir = join(this.#root, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);

    const hash = createHash('sha256');
    const sink = createWriteStream(tmp);
    let bytes = 0;
    let over = false;
    let discarded = 0;

    try {
      for await (const chunk of source) {
        const buffer = chunk as Buffer;
        if (over) {
          /**
           * Past the cap: read the rest and throw it away, up to a point.
           *
           * Answering 413 while the client is still sending means one of two
           * things, and the wrong one is what the first version did: destroy
           * the request mid-flight, which destroys the socket the response was
           * about to go out on, so the client sees a connection error rather
           * than the refusal — and the operator, who has just dropped a 40 MB
           * photo, learns nothing about why.
           *
           * So we stop writing immediately — the disk is what the cap is
           * protecting — and keep draining so the exchange can finish
           * normally. Bounded, because a sender that never stops must not keep
           * this handler alive forever.
           */
          discarded += buffer.length;
          if (discarded > DRAIN_CAP) break;
          continue;
        }
        bytes += buffer.length;
        // Counted, not trusted. `content-length` is a claim the client makes
        // about itself, and chunked encoding does not make it at all.
        if (bytes > limit) {
          over = true;
          continue;
        }
        hash.update(buffer);
        if (!sink.write(buffer)) {
          await new Promise<void>((drained) => sink.once('drain', drained));
        }
      }
    } finally {
      await new Promise<void>((closed) => sink.end(closed));
    }

    if (over) {
      await unlink(tmp).catch(() => {});
      throw new BlobTooLarge(limit);
    }

    const sha = hash.digest('hex');
    const path = this.pathFor(sha, type);
    await mkdir(join(this.#root, sha.slice(0, 2)), { recursive: true });
    // Already there means the same bytes are already there — that is what
    // content addressing buys. Drop the duplicate rather than rewriting it.
    if (await exists(path)) await unlink(tmp).catch(() => {});
    else await rename(tmp, path);

    return { sha, name, type, bytes, path };
  }

  /**
   * Send a stored blob, with the headers that keep it from becoming a page.
   *
   * `nosniff` because a browser that guesses the type from the bytes can be
   * made to guess `text/html`; `default-src 'none'` because a rendered
   * attachment must not be able to fetch anything; and a download disposition
   * for everything outside the inline-safe list, which is what keeps an
   * attached SVG from being same-origin script on the hub.
   */
  async serve(response: ServerResponse, key: string, download = false): Promise<boolean> {
    // Rebuilt from the validated sha, so no client string reaches `join` — a
    // stronger guarantee than checking the resolved path afterwards.
    if (!BLOB_KEY_PATTERN.test(key)) return false;
    const sha = key.slice(0, 64);
    const ext = key.slice(64);
    const file = join(this.#root, sha.slice(0, 2), `${sha}${ext}`);

    let size: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) return false;
      size = info.size;
    } catch {
      return false;
    }

    const type = typeForExtension(ext);
    response.writeHead(200, {
      'content-type': type,
      'content-length': size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      // Content-addressed, so the bytes at this URL can never change.
      'cache-control': 'private, max-age=31536000, immutable',
      ...(download || !isInlineSafe(type) ? { 'content-disposition': 'attachment' } : {}),
    });
    await pipeline(createReadStream(file), response).catch(() => {});
    return true;
  }

  /**
   * Delete every blob no surviving record mentions.
   *
   * Mark and sweep, with an age floor: a blob uploaded seconds ago has no
   * record pointing at it *yet* — the operator is still typing the message —
   * and collecting it would make the paperclip lose files at random. An hour
   * is far longer than that gap and far shorter than caring about the space.
   */
  async sweep(keep: ReadonlySet<string>, now: number, minAgeMs = 3_600_000): Promise<number> {
    let removed = 0;
    let shards: string[];
    try {
      shards = await readdir(this.#root);
    } catch {
      return 0;
    }
    for (const shard of shards) {
      if (shard === 'tmp' || shard.length !== 2) continue;
      const dir = join(this.#root, shard);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (keep.has(file.slice(0, 64))) continue;
        const path = join(dir, file);
        try {
          const info = await stat(path);
          if (now - info.mtimeMs < minAgeMs) continue;
          await rm(path);
          removed += 1;
        } catch {
          // Gone already, or unreadable. Either way not ours to report.
        }
      }
    }
    return removed;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The filename off a request header, decoded and stripped of anything path-like.
 *
 * `x-crosstalk-filename`, percent-encoded — the convention `x-crosstalk-cwd`
 * already uses. No multipart parser: that is a dependency's worth of code in a
 * project that has two.
 *
 * The stripping is belt and braces, since the name is display-only and never
 * builds a path. But a name that renders as `../../etc/passwd` in the hub is a
 * lie told to the operator even when it is harmless to the disk.
 */
export function filenameFrom(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw === '') return 'attachment';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const base = decoded.split(/[\\/]/).pop() ?? '';
  // Control characters out: a newline in a filename is how a header ends up
  // splitting, and a name with one in it was never a real name anyway.
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' || clean === '.' || clean === '..' ? 'attachment' : clean.slice(0, 200);
}
