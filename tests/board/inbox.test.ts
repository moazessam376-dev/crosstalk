import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { UNLIMITED, collect, isDirectFor, isFor } from '../../src/board/inbox.js';
import { appendMessage, type Message } from '../../src/board/messages.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const JOINED = '2026-09-22T10:00:00.000Z';
const at = (second: number): string => new Date(Date.parse(JOINED) + second * 1000).toISOString();

async function msgsDir(): Promise<string> {
  const dir = join(await tempRepo(), 'msgs');
  await mkdir(dir);
  return dir;
}

let counter = 0;
async function post(dir: string, from: string, to: string[], second: number, text = `t${++counter}`): Promise<Message> {
  const msg = { id: `${from}-${++counter}`, ts: at(second), from, to, text };
  await appendMessage(dir, msg);
  return msg;
}

describe('delivery rules', () => {
  it('delivers a direct message sent before the join', async () => {
    const dir = await msgsDir();
    const early = await post(dir, 'orchestrator', ['builder-1'], -60);
    const got = await collect(dir, {}, isFor('builder-1', JOINED), UNLIMITED);
    expect(got.messages).toEqual([early]);
  });

  it('delivers a broadcast only if sent after the join', async () => {
    const dir = await msgsDir();
    await post(dir, 'orchestrator', ['all'], -1);
    const late = await post(dir, 'orchestrator', ['all'], 1);
    const got = await collect(dir, {}, isFor('builder-1', JOINED), UNLIMITED);
    expect(got.messages).toEqual([late]);
  });

  it('never delivers an agent its own messages', async () => {
    const dir = await msgsDir();
    await post(dir, 'builder-1', ['all'], 1);
    await post(dir, 'builder-1', ['builder-1'], 2);
    expect((await collect(dir, {}, isFor('builder-1', JOINED), UNLIMITED)).messages).toEqual([]);
  });

  it('skips messages for others but still moves past them', async () => {
    const dir = await msgsDir();
    await post(dir, 'orchestrator', ['builder-2'], 1);
    const got = await collect(dir, {}, isFor('builder-1', JOINED), UNLIMITED);
    expect(got.messages).toEqual([]);
    expect(got.next['orchestrator']).toBeGreaterThan(0);
    const mine = await post(dir, 'orchestrator', ['builder-1'], 2);
    expect((await collect(dir, got.next, isFor('builder-1', JOINED), UNLIMITED)).messages).toEqual([mine]);
  });

  it('isDirectFor ignores broadcasts', async () => {
    const dir = await msgsDir();
    await post(dir, 'orchestrator', ['all'], 1);
    const direct = await post(dir, 'orchestrator', ['builder-1', 'builder-2'], 2);
    expect((await collect(dir, {}, isDirectFor('builder-1'), UNLIMITED)).messages).toEqual([direct]);
  });
});

describe('limits', () => {
  it('pages 50 messages from two senders as 20, 20, 10 with nothing lost or repeated', async () => {
    const dir = await msgsDir();
    const sent: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      sent.push((await post(dir, 'a', ['reader'], i * 2)).id);
      sent.push((await post(dir, 'b', ['reader'], i * 2 + 1)).id);
    }
    const accept = isFor('reader', JOINED);
    const limit = { count: 20, chars: 100_000 };
    const first = await collect(dir, {}, accept, limit);
    const second = await collect(dir, first.next, accept, limit);
    const third = await collect(dir, second.next, accept, limit);
    const fourth = await collect(dir, third.next, accept, limit);
    expect([first.more, second.more, third.more]).toEqual([30, 10, 0]);
    expect([...first.messages, ...second.messages, ...third.messages].map((m) => m.id)).toEqual(sent);
    expect(fourth.messages).toEqual([]);
  });

  it('stops at the character budget but always delivers at least one message', async () => {
    const dir = await msgsDir();
    const big = await post(dir, 'a', ['reader'], 1, 'x'.repeat(5000));
    await post(dir, 'a', ['reader'], 2, 'small');
    const got = await collect(dir, {}, isFor('reader', JOINED), { count: 20, chars: 4000 });
    expect(got.messages).toEqual([big]);
    expect(got.more).toBe(1);
  });
});
