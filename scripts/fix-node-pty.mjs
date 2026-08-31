#!/usr/bin/env node
/**
 * Make node-pty's `spawn-helper` executable.
 *
 * node-pty 1.1.0 publishes the helper with mode 0644. Without the executable
 * bit every `pty.spawn()` on macOS throws `posix_spawnp failed.` — a message
 * that names nothing useful and sends you looking at your own arguments. This
 * is a packaging bug in the dependency, not a choice, so it is repaired on
 * install rather than written down as a step people will skip.
 *
 * Silent when there is nothing to fix: a platform or install with no prebuilds
 * is not an error.
 */
import { chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PREBUILDS = 'node_modules/node-pty/prebuilds';

let entries;
try {
  entries = await readdir(PREBUILDS);
} catch {
  entries = [];
}

for (const entry of entries) {
  const helper = join(PREBUILDS, entry, 'spawn-helper');
  try {
    const info = await stat(helper);
    // 0o111 is the three execute bits. Already set means another install — or a
    // future node-pty that fixed this — got there first.
    if ((info.mode & 0o111) !== 0) continue;
    await chmod(helper, info.mode | 0o755);
    process.stdout.write(`crosstalk: made ${helper} executable (node-pty ships it 0644)\n`);
  } catch {
    // No helper for a platform we are not on.
  }
}
