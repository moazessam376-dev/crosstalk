import { describe, expect, it } from 'vitest';
import type { Inbox } from '../../src/core/inbox.js';
import { driveSupervised, spawnSupervised } from '../../src/harness/runner.js';

function inbox(overrides: Partial<Inbox> = {}): Inbox {
  return {
    you: 'codex',
    role: 'builder',
    unread: [],
    mine: [],
    next: 'idle',
    ...overrides,
  };
}

describe('supervised wake', () => {
  it('writes exactly one turn when a card arrives, and does not call inbox inside the model', async () => {
    const writes: string[] = [];
    const waits: Array<(value: Inbox) => void> = [];
    let waitCount = 0;

    const wait = (): Promise<Inbox> =>
      new Promise((resolve) => {
        waitCount += 1;
        waits.push(resolve);
      });

    let settleExit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      settleExit = resolve;
    });

    const notices: string[] = [];
    const running = driveSupervised({
      wait,
      write: async (turn) => {
        writes.push(turn);
      },
      exited,
      notify: async (body) => {
        notices.push(body);
      },
    });

    await Promise.resolve();
    expect(waitCount).toBe(1);
    expect(writes).toEqual([]);

    waits[0]!({
      ...inbox(),
      next: 'T-04 is assigned to you',
      unread: [{ seq: 1, kind: 'assigned', from: 'leader', summary: 'T-04 assigned: Wire the list' }],
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('T-04');
    expect(waitCount).toBe(2);

    settleExit(0);
    await running;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/exited/);
    expect(writes).toHaveLength(1);
  });

  it('notices a child exit and does not start a second child', async () => {
    const starts: string[][] = [];
    const fake = spawnSupervised({
      argv: ['cursor-agent', '-p', 'hello'],
      cwd: '/tmp',
      execFile: ((file: string, argv: readonly string[]) => {
        starts.push([file, ...argv]);
        return { stdout: null, stderr: null, on: () => undefined } as never;
      }) as unknown as typeof import('node:child_process').execFile,
    });

    expect(starts).toEqual([['cursor-agent', '-p', 'hello']]);
    expect(fake).toBeDefined();
    expect(starts).toHaveLength(1);
  });
});
