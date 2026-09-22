import { appendFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { BoardError } from '../../src/board/fsutil.js';
import { senderFile } from '../../src/board/messages.js';
import { currentRun, runPaths } from '../../src/board/runs.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

async function board(): Promise<Board> {
  return new Board(await tempRepo());
}

describe('join', () => {
  it('returns the rules, and refuses a second agent with the same name', async () => {
    const b = await board();
    const text = await b.join('builder-1');
    expect(text).toMatch(/^joined as builder-1 \(run \d{8}-\d{6}\)/);
    expect(text).toContain('Pass as: "builder-1" on every Crosstalk call.');
    await expect(b.join('builder-1')).rejects.toThrow(/taken/);
    expect(await b.join('builder-1', true)).toMatch(/^rejoined as builder-1/);
  });
});

describe('send and inbox', () => {
  it('refuses to send before joining', async () => {
    const b = await board();
    await b.join('orchestrator');
    await expect(b.send('builder-1', 'orchestrator', 'hi')).rejects.toThrow(/has not joined/);
  });

  it('keeps a message for a name that has not joined, and says so', async () => {
    const b = await board();
    await b.join('orchestrator');
    expect(await b.send('orchestrator', 'builder-2', 'start on the dock')).toBe(
      'sent orchestrator-1; builder-2 has not joined yet and will get it on joining',
    );
    await b.join('builder-2');
    const got = await b.inbox('builder-2');
    expect(got.count).toBe(1);
    expect(got.text).toMatch(/^\d\d:\d\d orchestrator: start on the dock$/);
  });

  it('delivers a message sent after a crash left half a line', async () => {
    const repo = await tempRepo();
    const b = new Board(repo);
    await b.join('orchestrator');
    await b.join('builder-1');
    await b.send('orchestrator', 'builder-1', 'one');
    const { msgs } = runPaths((await currentRun(repo))!);
    await appendFile(senderFile(msgs, 'orchestrator'), '{"id":"orchestrator-2","ts":"2026-09-22T');
    expect(await b.send('orchestrator', 'builder-1', 'two')).toBe('sent orchestrator-3');
    const got = await b.inbox('builder-1');
    expect(got.count).toBe(2);
    expect(got.text).toMatch(/: two\n1 unreadable line skipped$/);
  });

  it('gives broadcasts only to agents present when they were sent', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.send('orchestrator', 'all', 'before');
    await b.join('builder-1');
    await b.send('orchestrator', 'all', 'after');
    expect((await b.inbox('builder-1')).text).toMatch(/orchestrator → all: after$/);
  });

  it('continues from the same place after a rejoin', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    await b.send('orchestrator', 'builder-1', 'one');
    await b.send('orchestrator', 'builder-1', 'two');
    expect((await b.inbox('builder-1')).count).toBe(2);
    await b.join('builder-1', true);
    expect(await b.inbox('builder-1')).toEqual({ text: 'no new messages', count: 0 });
    await b.send('orchestrator', 'builder-1', 'three');
    expect((await b.inbox('builder-1')).text).toMatch(/three$/);
  });

  it('pages a backlog and says how much is left', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    for (let i = 0; i < 25; i += 1) await b.send('orchestrator', 'builder-1', `m${i}`);
    const first = await b.inbox('builder-1');
    expect(first.count).toBe(20);
    expect(first.text.endsWith('5 more; call inbox again')).toBe(true);
    expect((await b.inbox('builder-1')).count).toBe(5);
  });

  it('waits for a message when asked to', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    setTimeout(() => void b.send('orchestrator', 'builder-1', 'late'), 300);
    const started = Date.now();
    const got = await b.inbox('builder-1', 5);
    expect(got.count).toBe(1);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('gives up after the wait with nothing new', async () => {
    const b = await board();
    await b.join('builder-1');
    const started = Date.now();
    expect(await b.inbox('builder-1', 1)).toEqual({ text: 'no new messages', count: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('validates recipients and text', async () => {
    const b = await board();
    await b.join('builder-1');
    await expect(b.send('builder-1', 'all, builder-2', 'x')).rejects.toThrow(/not both/);
    await expect(b.send('builder-1', '', 'x')).rejects.toThrow(/to is required/);
    await expect(b.send('builder-1', 'builder-2', '   ')).rejects.toThrow(/empty/);
    await expect(b.send('builder-1', 'builder-1', 'x')).rejects.toThrow(/yourself/);
    await expect(b.send('builder-1', 'Builder 2', 'x')).rejects.toThrow(BoardError);
  });

  it('lets the human send without joining', async () => {
    const b = await board();
    await b.join('builder-1');
    await b.send('human', 'builder-1', 'stop and check the dock');
    expect((await b.inbox('builder-1')).text).toMatch(/human: stop and check the dock$/);
  });
});

describe('runs, who and stats', () => {
  it('a new run is an empty board that old names must join again', async () => {
    const b = await board();
    await b.join('builder-1');
    expect(await b.newRun('second')).toMatch(/^started run \d{8}-\d{6}-second$/);
    await expect(b.inbox('builder-1')).rejects.toThrow(/has not joined/);
  });

  it('who shows unread counts', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    await b.send('orchestrator', 'builder-1', 'x');
    const who = await b.who();
    expect(who).toMatch(/^builder-1\s+\d\d:\d\d\s+-\s+1$/m);
    expect(who).toMatch(/^orchestrator\s+\d\d:\d\d\s+\d\d:\d\d\s+0$/m);
  });

  it('stats counts delivered characters and estimates tokens', async () => {
    const b = await board();
    await b.join('orchestrator');
    await b.join('builder-1');
    await b.send('orchestrator', 'builder-1', 'x'.repeat(400));
    await b.inbox('builder-1');
    const stats = await b.stats();
    expect(stats).toMatch(/^builder-1\s+0\s+1\s+1\s+400\s+0\s+100$/m);
    expect(stats).toMatch(/^orchestrator\s+1\s+0\s+0\s+0\s+0\s+0$/m);
  });
});
