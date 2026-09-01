import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { loadRegistry } from './registry.js';

/**
 * The binaries to look for: whatever the registry says it would spawn.
 *
 * This was a second hand-written list of the same three CLIs the registry
 * already names in its `spawn` lines, which is exactly the duplication that
 * lets a harness be added in one place and stay invisible in the other. A
 * harness with no spawn line is attach-only and there is nothing to probe for.
 */
async function cliBinaries(): Promise<string[]> {
  const registry = await loadRegistry();
  const binaries = new Set<string>();
  for (const descriptor of registry.values()) {
    const binary = descriptor.spawn?.[0];
    if (binary !== undefined) binaries.add(binary);
  }
  return [...binaries].sort();
}

export type CliBinary = string;

export interface PathProbe {
  binary: CliBinary;
  available: boolean;
  path?: string;
}

export async function findExecutable(name: string): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
    : [''];

  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory || '.', `${name}${extension}`);
      try {
        await access(candidate, constants.F_OK);
        return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  return undefined;
}

export async function probeCliHarnesses(): Promise<PathProbe[]> {
  const found: PathProbe[] = [];
  for (const binary of await cliBinaries()) {
    const path = await findExecutable(binary);
    found.push(path === undefined ? { binary, available: false } : { binary, available: true, path });
  }
  return found;
}
