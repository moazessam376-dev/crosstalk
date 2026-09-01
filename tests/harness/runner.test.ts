import { describe, expect, it } from 'vitest';
import type { Inbox } from '../../src/core/inbox.js';
import { driveSupervised, spawnSupervised, type SeatHealth } from '../../src/harness/runner.js';

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

/**
 * Drive the wake loop by hand.
 *
 * Every health test needs the same three levers — hand it an inbox, watch what
 * was written, then end the child — so they live here rather than four times
 * over. `turn` varies per call because `driveSupervised` skips a turn identical
 * to the last one, and a repeated failure has to produce a repeated write.
 */
function driver(write: (turn: string) => Promise<void>) {
  const waits: Array<(value: Inbox) => void> = [];
  let settleExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => {
    settleExit = resolve;
  });
  const notices: string[] = [];
  const health: SeatHealth[] = [];
  let turn = 0;

  const running = driveSupervised({
    wait: () => new Promise<Inbox>((resolve) => waits.push(resolve)),
    write,
    exited,
    notify: async (body) => {
      notices.push(body);
    },
    onHealth: (state) => {
      health.push(state);
    },
  });

  return {
    notices,
    health,
    /** Hand the loop one card it has not seen before, and let it settle. */
    async deliver(): Promise<void> {
      turn += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      waits.shift()?.({
        ...inbox(),
        next: `T-0${turn} is assigned to you`,
        unread: [{ seq: turn, kind: 'assigned', from: 'leader', summary: `T-0${turn} assigned` }],
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    async end(): Promise<void> {
      settleExit(0);
      await running;
    },
  };
}

describe('supervised health never reaches the board', () => {
  it('reports a stuck seat through onHealth, and posts nothing', async () => {
    // 622 of 1187 events in the vault-team run were this notice, posted to
    // #floor as @human. Health is state, not history.
    const run = driver(async () => {
      throw new Error('claude is not at a prompt');
    });

    await run.deliver();
    await run.deliver();
    await run.deliver();

    expect(run.health).toEqual([{ stuck: true, why: 'claude is not at a prompt' }]);
    expect(run.notices).toEqual([]);

    await run.end();
    // The child exit is the one thing `notify` still carries.
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]).toMatch(/exited/);
  });

  it('keeps refreshing the row while the seat is still stuck', async () => {
    // `activityOf` expires a row after PRESENCE_TTL_MS. A transition-only report
    // would read as healthy five minutes into being stuck.
    const run = driver(async () => {
      throw new Error('not at a prompt');
    });

    await run.deliver();
    await run.deliver();
    await run.deliver();
    expect(run.health).toHaveLength(1);

    await run.deliver();
    await run.deliver();

    expect(run.health).toHaveLength(3);
    expect(run.health.every((state) => state.stuck)).toBe(true);
    expect(run.notices).toEqual([]);
    await run.end();
  });

  it('stays quiet below the threshold', async () => {
    // The neighbouring case. A seat that refuses one turn and takes the next is
    // not stuck, and saying so is how the oscillation started.
    let calls = 0;
    const run = driver(async () => {
      calls += 1;
      if (calls <= 2) throw new Error('transient');
    });

    await run.deliver();
    await run.deliver();
    await run.deliver();

    expect(run.health).toEqual([]);
    expect(run.notices).toEqual([]);
    await run.end();
  });

  it('reports recovery once, and only after it reported stuck', async () => {
    let failing = true;
    const run = driver(async () => {
      if (failing) throw new Error('not at a prompt');
    });

    await run.deliver();
    await run.deliver();
    await run.deliver();
    expect(run.health).toEqual([{ stuck: true, why: 'not at a prompt' }]);

    failing = false;
    await run.deliver();
    await run.deliver();

    expect(run.health).toEqual([{ stuck: true, why: 'not at a prompt' }, { stuck: false }]);
    expect(run.notices).toEqual([]);
    await run.end();
  });
});
