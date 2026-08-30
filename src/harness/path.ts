import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const CLI_BINARIES = ['claude', 'codex', 'cursor-agent'] as const;

export type CliBinary = (typeof CLI_BINARIES)[number];

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
  for (const binary of CLI_BINARIES) {
    const path = await findExecutable(binary);
    found.push(path === undefined ? { binary, available: false } : { binary, available: true, path });
  }
  return found;
}
