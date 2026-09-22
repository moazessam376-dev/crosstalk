import { appendFile, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { errorCode, isRecord } from './fsutil.js';

export interface Message {
  id: string;
  ts: string;
  from: string;
  /** Names, or `['all']`. */
  to: string[];
  text: string;
}

export interface Line {
  sender: string;
  msg: Message;
  /** Byte offset just after this line's newline. */
  end: number;
}

export interface Chunk {
  lines: Line[];
  /** Where the next read should start: the end of the last complete line. */
  end: number;
  corrupt: number;
}

const NEWLINE = 0x0a;

export function senderFile(msgsDir: string, sender: string): string {
  return join(msgsDir, `${sender}.jsonl`);
}

/** One call, one complete line. The sender is the file's only writer, so lines never interleave. */
export async function appendMessage(msgsDir: string, msg: Message): Promise<void> {
  await appendFile(senderFile(msgsDir, msg.from), `${JSON.stringify(msg)}\n`, 'utf8');
}

export async function nextId(msgsDir: string, sender: string): Promise<string> {
  let count = 0;
  try {
    for (const byte of await readFile(senderFile(msgsDir, sender))) if (byte === NEWLINE) count += 1;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return `${sender}-${count + 1}`;
}

export async function senders(msgsDir: string): Promise<string[]> {
  try {
    return (await readdir(msgsDir))
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => file.slice(0, -'.jsonl'.length))
      .sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

/**
 * The complete lines of `sender`'s file after byte `offset`. A last line
 * without its newline is still being written, and is left for the next read.
 */
export async function readFrom(msgsDir: string, sender: string, offset: number): Promise<Chunk> {
  let handle;
  try {
    handle = await open(senderFile(msgsDir, sender), 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { lines: [], end: offset, corrupt: 0 };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size <= offset) return { lines: [], end: offset, corrupt: 0 };
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const lines: Line[] = [];
    let corrupt = 0;
    let start = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      if (buffer[i] !== NEWLINE) continue;
      const text = buffer.toString('utf8', start, i);
      start = i + 1;
      if (text.trim() === '') continue;
      const msg = parseMessage(text);
      if (msg === undefined) corrupt += 1;
      else lines.push({ sender, msg, end: offset + start });
    }
    return { lines, end: offset + start, corrupt };
  } finally {
    await handle.close();
  }
}

/**
 * Merge per-sender queues by time, then sender. Only queue heads are compared,
 * so each sender's own order survives even if its clock stepped backwards.
 */
export function* merge(queues: ReadonlyMap<string, readonly Line[]>): Generator<Line> {
  const heads = new Map<string, number>();
  for (;;) {
    let best: Line | undefined;
    for (const [sender, lines] of queues) {
      const line = lines[heads.get(sender) ?? 0];
      if (line !== undefined && (best === undefined || before(line, best))) best = line;
    }
    if (best === undefined) return;
    heads.set(best.sender, (heads.get(best.sender) ?? 0) + 1);
    yield best;
  }
}

function before(a: Line, b: Line): boolean {
  return a.msg.ts < b.msg.ts || (a.msg.ts === b.msg.ts && a.sender < b.sender);
}

function parseMessage(text: string): Message | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { id, ts, from, to, text: body } = value;
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof from !== 'string' || typeof body !== 'string') {
    return undefined;
  }
  if (!Array.isArray(to) || !to.every((name): name is string => typeof name === 'string')) return undefined;
  return { id, ts, from, to, text: body };
}
