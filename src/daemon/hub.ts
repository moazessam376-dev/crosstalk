import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

import { distPath } from './paths.js';
import type { ServerResponse } from 'node:http';

/**
 * Serving the built hub from the daemon is not decoration. Contract §3 argues
 * for cookie auth on `/stream` *because the hub is same-origin*; `EventSource`
 * accepts no headers in any browser, so if the hub were served from anywhere
 * else it could not authenticate at all.
 */
export const HUB_DIST = join('dist', 'ui');

/** Where the built hub lives: always the package's own `dist/ui`. */
export function resolveHubDist(moduleUrl: string): string {
  return distPath(moduleUrl, 'ui');
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolves a URL path inside `distDir`, or undefined if it escapes.
 *
 * `..` in a request path is the oldest bug in static serving, and the daemon
 * runs with the maintainer's own file permissions in their own repository.
 */
export function resolveAsset(distDir: string, pathname: string): string | undefined {
  const root = resolve(distDir);
  const candidate = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  return candidate === root || candidate.startsWith(root + sep) ? candidate : undefined;
}

export async function serveAsset(
  response: ServerResponse,
  distDir: string,
  pathname: string,
): Promise<boolean> {
  const file = resolveAsset(distDir, pathname);
  if (file === undefined) return false;

  try {
    const info = await stat(file);
    if (!info.isFile()) return false;

    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      // The bundle is rebuilt in place and the port changes per run; a cached
      // shell against a new daemon is a confusing way to see stale data.
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a user sees when the hub was never built.
 *
 * A bare 404 here reads as "Crosstalk is broken" when the actual state is "one
 * command has not been run yet" — every failure message names the remedy, not
 * just the condition (docs/CROSS-PLATFORM.md §10).
 */
export function sendHubMissing(response: ServerResponse, distDir: string): void {
  const body = Buffer.from(
    `<!doctype html><meta charset="utf-8"><title>Crosstalk — hub not built</title>
<style>body{font:14px/1.6 ui-sans-serif,system-ui,sans-serif;background:#111;color:#ddd;padding:3rem;max-width:42rem;margin:0 auto}
code{font:13px ui-monospace,"Cascadia Code",monospace;background:#1c1c1c;border:1px solid #2c2c2c;border-radius:6px;padding:.15rem .4rem}
pre{background:#1c1c1c;border:1px solid #2c2c2c;border-radius:6px;padding:1rem;overflow-x:auto}</style>
<h1>The hub has not been built</h1>
<p>The daemon is running and the protocol is live — this is only the web interface.
Nothing is wrong with your session; the bundle at <code>${escapeHtml(distDir)}</code> does not exist yet.</p>
<p>Build it, then reload:</p>
<pre>npm run build:ui</pre>
<p>The CLI works regardless: <code>ct roster</code>, <code>ct events</code>, <code>ct await</code>.</p>`,
    'utf8',
  );
  response.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}
