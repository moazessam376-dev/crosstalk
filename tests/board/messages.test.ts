import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendMessage,
  merge,
  nextId,
  readFrom,
  senderFile,
  senders,
  type Line,
  type Message,
} from '../../src/board/messages.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

async function msgsDir(): Promise<string> {
  const dir = join(await tempRepo(), 'msgs');
  await mkdir(dir);
  return dir;
}

function msg(from: string, n: number, ts: string, text = `m${n}`): Message {
  return { id: `${from}-${n}`, ts, from, to: ['all'], text };
}

describe('append and read', () => {
  it('reads back what was appended, and nothing past the returned end', async () => {
    const dir = await msgsDir();
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z'));
    await appendMessage(dir, msg('a', 2, '2026-09-22T10:00:01.000Z'));
    const first = await readFrom(dir, 'a', 0);
    expect(first.lines.map((line) => line.msg.id)).toEqual(['a-1', 'a-2']);
    expect(first.lines.every((line) => line.sender === 'a')).toBe(true);
    expect((await readFrom(dir, 'a', first.end)).lines).toEqual([]);
  });

  it('leaves a line without its newline for the next read', async () => {
    const dir = await msgsDir();
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z'));
    const half = JSON.stringify(msg('a', 2, '2026-09-22T10:00:01.000Z'));
    await appendFile(senderFile(dir, 'a'), half.slice(0, 20));
    const partial = await readFrom(dir, 'a', 0);
    expect(partial.lines.map((line) => line.msg.id)).toEqual(['a-1']);
    await appendFile(senderFile(dir, 'a'), `${half.slice(20)}\n`);
    expect((await readFrom(dir, 'a', partial.end)).lines.map((line) => line.msg.id)).toEqual(['a-2']);
  });

  it('skips and counts a corrupt line, and reads on past it', async () => {
    const dir = await msgsDir();
    await appendFile(senderFile(dir, 'a'), '{not json\n');
    await appendMessage(dir, msg('a', 2, '2026-09-22T10:00:01.000Z'));
    const chunk = await readFrom(dir, 'a', 0);
    expect(chunk.corrupt).toBe(1);
    expect(chunk.lines.map((line) => line.msg.id)).toEqual(['a-2']);
  });

  it('keeps byte offsets right for multibyte text', async () => {
    const dir = await msgsDir();
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z', 'مرحبا 👋 café'));
    const first = await readFrom(dir, 'a', 0);
    await appendMessage(dir, msg('a', 2, '2026-09-22T10:00:01.000Z', 'ünïcødé again 🎮'));
    const second = await readFrom(dir, 'a', first.end);
    expect(first.lines[0]?.msg.text).toBe('مرحبا 👋 café');
    expect(second.lines.map((line) => line.msg.text)).toEqual(['ünïcødé again 🎮']);
  });

  it('reads nothing from a sender that never wrote', async () => {
    const dir = await msgsDir();
    expect(await readFrom(dir, 'ghost', 0)).toEqual({ lines: [], end: 0, corrupt: 0 });
  });
});

describe('ids and senders', () => {
  it('numbers a sender’s messages from 1', async () => {
    const dir = await msgsDir();
    expect(await nextId(dir, 'a')).toBe('a-1');
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z'));
    expect(await nextId(dir, 'a')).toBe('a-2');
  });

  it('lists senders by their files', async () => {
    const dir = await msgsDir();
    await appendMessage(dir, msg('b', 1, '2026-09-22T10:00:00.000Z'));
    await appendMessage(dir, msg('a', 1, '2026-09-22T10:00:00.000Z'));
    expect(await senders(dir)).toEqual(['a', 'b']);
  });
});

describe('merge', () => {
  const line = (sender: string, n: number, ts: string): Line => ({ sender, msg: msg(sender, n, ts), end: n });

  it('orders by time, then by sender', () => {
    const queues = new Map([
      ['b', [line('b', 1, '2026-09-22T10:00:01.000Z'), line('b', 2, '2026-09-22T10:00:03.000Z')]],
      ['a', [line('a', 1, '2026-09-22T10:00:01.000Z'), line('a', 2, '2026-09-22T10:00:02.000Z')]],
    ]);
    expect([...merge(queues)].map((l) => l.msg.id)).toEqual(['a-1', 'b-1', 'a-2', 'b-2']);
  });

  it('keeps each sender’s own order even if its clock went backwards', () => {
    const queues = new Map([
      ['a', [line('a', 1, '2026-09-22T10:00:05.000Z'), line('a', 2, '2026-09-22T10:00:01.000Z')]],
    ]);
    expect([...merge(queues)].map((l) => l.msg.id)).toEqual(['a-1', 'a-2']);
  });
});
