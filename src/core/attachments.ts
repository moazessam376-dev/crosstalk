/**
 * What an attachment *is*, shared by the daemon and the hub.
 *
 * Split from `src/daemon/blobs.ts` for one hard reason: that module imports
 * `node:crypto` and `node:fs`, and the hub is a Vite bundle. Importing it from
 * a component fails the browser build outright — "randomBytes is not exported
 * by __vite-browser-external" — while `npm test` stays entirely green, which is
 * exactly how `src/core/runs.ts` came to exist. Same lesson, written down
 * twice because it cost a build both times.
 *
 * So: the tables and the predicates live here, where both sides can read them
 * and neither side needs a filesystem. The bytes stay next door.
 */

/** 25 MB. The operator's number, for the case they actually use. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** 200 MB. Also theirs — video is rare, and large when it happens. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/** Everything else: a diff, a log, a PDF. Generous, and not video-generous. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The types that may be stored, and the extension each gets on disk.
 *
 * A whitelist rather than a sanitiser. Anything not named here is stored with
 * no extension at all, which is harmless: the type travels in the event record
 * and on the response, and nothing ever executes the file.
 */
export const ATTACHMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/html': '.html',
  'text/csv': '.csv',
};

/**
 * What may be rendered in the browser, and what must be downloaded.
 *
 * The hub serves attachments from its **own origin**, so an SVG or an HTML
 * file rendered inline is same-origin script with access to everything the
 * page has. Both are legitimate things to attach — a diagram, a coverage
 * report — so they are stored and served, with `content-disposition:
 * attachment`, which makes the browser save them rather than run them.
 */
const INLINE_SAFE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/pdf',
  'text/plain',
]);

/** `<sha>` or `<sha>.<ext>` — the only shape `GET /attachments/:key` accepts. */
export const BLOB_KEY_PATTERN = /^[0-9a-f]{64}(\.[a-z0-9]{1,5})?$/;

/** A sha as it appears in a record, before anything treats it as a path. */
export const ATTACHMENT_SHA_PATTERN = /^[0-9a-f]{64}$/;

/** How many files may ride on one message. A delivery limit, not a storage one. */
export const MAX_ATTACHMENTS = 10;

/** The cap that applies to a declared type. Video is the only generous one. */
export function capFor(type: string): number {
  if (type.startsWith('video/')) return MAX_VIDEO_BYTES;
  if (type.startsWith('image/')) return MAX_IMAGE_BYTES;
  return MAX_FILE_BYTES;
}

export function extensionFor(type: string): string {
  return ATTACHMENT_EXTENSIONS[type.toLowerCase()] ?? '';
}

export function isInlineSafe(type: string): boolean {
  return INLINE_SAFE.has(type.toLowerCase());
}

/** The reverse of the table, for serving. An unknown extension is opaque bytes. */
export function typeForExtension(ext: string): string {
  for (const [type, candidate] of Object.entries(ATTACHMENT_EXTENSIONS)) {
    if (candidate === ext) return type;
  }
  return 'application/octet-stream';
}

/** Where the hub fetches an attachment from. One spelling of the key, here. */
export function attachmentUrl(sha: string, type: string): string {
  return `/attachments/${sha}${extensionFor(type)}`;
}

/**
 * Where an attachment's bytes are on the machine the daemon runs on.
 *
 * Built from the same two pieces the store uses — the sha's first two
 * characters as a shard, then the sha with the type's extension — so the hub
 * cannot show a path that disagrees with where the file actually is.
 *
 * Separator taken from the root itself, because the hub is JavaScript in a
 * browser and has no `node:path`: a Windows root gives Windows separators.
 */
export function attachmentPath(root: string, sha: string, type: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return [root, sha.slice(0, 2), `${sha}${extensionFor(type)}`].join(sep);
}

/** `412 KB`, `1.4 MB` — sized to be read, not to be precise. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
