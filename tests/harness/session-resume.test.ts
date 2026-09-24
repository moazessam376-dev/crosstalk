import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { openSession, type SpawnProcess } from '../../src/harness/session.js';

/**
 * A Codex seat that can be woken.
 *
 * `codex exec` reads its prompt once and exits, so a Codex seat used to be a
 * seat that could not lead: nothing could hand it the board after it started.
 * `codex exec resume <thread> <prompt>` picks the conversation up, so a turn
 * is a process and the seat is the thread. The event shapes below are what
 * codex-cli 0.151.0 actually prints under `--json`, captured before this was
 * written: `thread.started` first, then `item.completed` per item.
 */

interface Made {
  child: ChildProcess;
  args: string[];
  out: (line: string) => void;
  close: (code: number) => void;
  killed: boolean;
}

function fakeChild(args: string[]): Made {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const made: Made = {
    child: emitter,
    args,
    out: (line) => stdout.write(`${line}\n`),
    close: (code) => emitter.emit('close', code),
    killed: false,
  };
  Object.assign(emitter, {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => {
      made.killed = true;
      return true;
    },
  });
  return made;
}

function harness(): { spawn: SpawnProcess; made: Made[] } {
  const made: Made[] = [];
  const spawn: SpawnProcess = (_file, args) => {
    const child = fakeChild(args);
    made.push(child);
    return child.child;
  };
  return { spawn, made };
}

const tick = (): Promise<void> => new Promise((done) => setImmediate(done));

const ARGV = ['codex', 'exec', '--json', '--sandbox', 'workspace-write'];

describe('a seat driven one process per turn', () => {
  it('runs the job as the first process and resumes the thread it opened for the next turn', async () => {
    const { spawn, made } = harness();
    const session = openSession({ argv: ARGV, cwd: '/tmp', first: 'plan the job', turnFormat: 'resume', spawn });
    await tick();

    expect(made).toHaveLength(1);
    expect(made[0]!.args).toEqual(['exec', '--json', '--sandbox', 'workspace-write', 'plan the job']);

    made[0]!.out('{"type":"thread.started","thread_id":"01a0-thread"}');
    made[0]!.out('{"type":"turn.completed","usage":{}}');
    made[0]!.close(0);

    expect(session.canPush).toBe(true);
    const sent = session.send('builder-1 says done on T-01');
    await tick();
    expect(made).toHaveLength(2);
    expect(made[1]!.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      'resume',
      '01a0-thread',
      'builder-1 says done on T-01',
    ]);
    made[1]!.close(0);
    await sent;
  });

  it('serialises turns: a wake that lands mid-turn waits for the running process', async () => {
    const { spawn, made } = harness();
    const session = openSession({ argv: ARGV, cwd: '/tmp', first: 'first', turnFormat: 'resume', spawn });
    await tick();
    made[0]!.out('{"type":"thread.started","thread_id":"t"}');

    const second = session.send('second');
    const third = session.send('third');
    await tick();
    // Only the opening process exists until it exits.
    expect(made).toHaveLength(1);

    made[0]!.close(0);
    await tick();
    expect(made).toHaveLength(2);
    expect(made[1]!.args.at(-1)).toBe('second');
    made[1]!.close(0);
    await second;
    await tick();
    expect(made).toHaveLength(3);
    expect(made[2]!.args.at(-1)).toBe('third');
    made[2]!.close(0);
    await third;
  });

  it('does not count a finished turn as the seat leaving', async () => {
    const { spawn, made } = harness();
    let exited = false;
    const session = openSession({ argv: ARGV, cwd: '/tmp', first: 'x', turnFormat: 'resume', spawn });
    void session.exited.then(() => {
      exited = true;
    });
    await tick();
    made[0]!.out('{"type":"thread.started","thread_id":"t"}');
    made[0]!.close(0);
    await tick();
    expect(exited).toBe(false);
  });

  it('is gone when the opening process never opened a thread — the binary is missing or refused', async () => {
    const { spawn, made } = harness();
    const session = openSession({ argv: ['codex'], cwd: '/tmp', first: 'x', turnFormat: 'resume', spawn });
    await tick();
    (made[0]!.child as unknown as EventEmitter).emit('error', new Error('ENOENT'));
    await expect(session.exited).resolves.toBeNull();
  });

  it('stops by killing the running turn and settling exited', async () => {
    const { spawn, made } = harness();
    const session = openSession({ argv: ARGV, cwd: '/tmp', first: 'x', turnFormat: 'resume', spawn });
    await tick();
    session.stop();
    expect(made[0]!.killed).toBe(true);
    await expect(session.exited).resolves.toBeNull();
  });

  it('reports each turn boundary, which is the presence signal a hookless seat has', async () => {
    const { spawn, made } = harness();
    const starts: number[] = [];
    const ends: Array<number | null> = [];
    const session = openSession({
      argv: ARGV,
      cwd: '/tmp',
      first: 'x',
      turnFormat: 'resume',
      spawn,
      onTurnStart: () => starts.push(Date.now()),
      onTurnEnd: (code) => ends.push(code),
    });
    await tick();
    expect(starts).toHaveLength(1);
    made[0]!.out('{"type":"thread.started","thread_id":"t"}');
    made[0]!.close(0);
    await tick();
    expect(ends).toEqual([0]);
    const sent = session.send('again');
    await tick();
    expect(starts).toHaveLength(2);
    made[1]!.close(0);
    await sent;
    expect(ends).toEqual([0, 0]);
  });

  it('mirrors what the agent said rather than the JSON it said it in', async () => {
    const { spawn, made } = harness();
    const session = openSession({ argv: ARGV, cwd: '/tmp', first: 'x', turnFormat: 'resume', spawn, capture: {} });
    await tick();
    made[0]!.out('{"type":"thread.started","thread_id":"t"}');
    made[0]!.out('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Spec written to docs/crosstalk/SPEC.md"}}');
    made[0]!.out('{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"git commit -m spec"}}');
    await tick();
    const screen = session.screen()!.rows.map((row) => row.map((run) => run.text).join('')).join('\n');
    expect(screen).toContain('Spec written to docs/crosstalk/SPEC.md');
    expect(screen).toContain('$ git commit -m spec');
    expect(screen).not.toContain('thread.started');
  });
});
