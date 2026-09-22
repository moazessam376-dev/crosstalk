import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

/** A failure the caller can fix. The message says how. */
export class BoardError extends Error {}

export function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Write through a temp file and rename it over `path`, so a reader never sees
 * half a file. Windows refuses the rename while another process has the target
 * open, so that case is retried for about a second.
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, data, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      if (!RETRYABLE.has(errorCode(error)) || attempt >= 20) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      await new Promise((done) => setTimeout(done, 10 + attempt * 5));
    }
  }
}

export async function readJson(
  path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'missing' | 'corrupt' }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ok: false, reason: 'missing' };
    throw error;
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}
