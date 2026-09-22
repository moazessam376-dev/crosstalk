import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

/** A throwaway directory that looks like a repository root. */
export async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ct-'));
  await mkdir(join(root, '.git'));
  made.push(root);
  return root;
}

export async function removeTempRepos(): Promise<void> {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
}

/** Run a TypeScript file in its own Node process. Resolves with the exit code. */
export function runTs(script: string, args: string[]): Promise<number> {
  return new Promise((done) => {
    execFile(process.execPath, ['--import', 'tsx', script, ...args], (error) => {
      done(error === null ? 0 : typeof error.code === 'number' ? error.code : 1);
    });
  });
}
