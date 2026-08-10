import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves a path inside the package's own `dist`, from a module's location.
 *
 * The hub bundle and the MCP entry point ship with the *package*, not with the
 * repository being worked on — different directories the moment anyone runs
 * `crosstalk up` anywhere but this checkout, which is the only way it is ever
 * used.
 *
 * Deterministic rather than probing for whichever candidate happens to exist:
 * an earlier version tried `../ui` first and, running from source, found
 * `src/ui` — a real directory full of `.tsx` that is not a built bundle. It
 * served a 503 while looking like it had resolved correctly.
 *
 *   dist/daemon/server.js -> dist/<segments>
 *   src/daemon/server.ts  -> dist/<segments>
 */
export function distPath(moduleUrl: string, ...segments: string[]): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const parent = dirname(here);
  const dist = basename(parent) === 'dist' ? parent : resolve(parent, '..', 'dist');
  return resolve(dist, ...segments);
}
