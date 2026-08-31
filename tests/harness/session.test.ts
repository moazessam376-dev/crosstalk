import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { openSession, type SpawnProcess } from '../../src/harness/session.js';

/**
 * A child that records what was written to its stdin.
 *
 * The real claim — that a turn written mid-flight is queued and answered in
 * order — was verified against the `claude` binary before this module was
 * written. What is worth pinning here is the framing and the fallback, because
 * those are ours to get wrong.
 */
function fakeChild(): { child: ChildProcess; written: () => string[]; close: (code: number) => void } {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  const stdin = new PassThrough();
  const chunks: string[] = [];
  stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  Object.assign(emitter, { stdin, kill: () => true });
  return {
    child: emitter,
    written: () => chunks.join('').split('\n').filter((line) => line !== ''),
    close: (code) => emitter.emit('close', code),
  };
}

function harness(): { spawn: SpawnProcess; calls: Array<{ file: string; args: string[] }>; last: () => ReturnType<typeof fakeChild> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  let made: ReturnType<typeof fakeChild> | undefined;
  const spawn: SpawnProcess = (file, args) => {
    calls.push({ file, args });
    made = fakeChild();
    return made.child;
  };
  return { spawn, calls, last: () => made! };
}

describe('a harness that takes streamed turns', () => {
  it('writes the job as the first turn instead of an argv positional', async () => {
    const { spawn, calls, last } = harness();
    openSession({
      argv: ['claude', '-p', '--input-format', 'stream-json'],
      cwd: '/tmp',
      first: 'build the thing',
      turnFormat: 'stream-json',
      spawn,
    });
    await new Promise((done) => setImmediate(done));

    // The job must not appear on the command line: with streaming input a
    // positional prompt is a second, conflicting way to say the same thing.
    expect(calls[0]!.args).not.toContain('build the thing');
    expect(JSON.parse(last().written()[0]!)).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'build the thing' }] },
    });
  });

  it('accepts another turn after it has started — the wake path', async () => {
    const { spawn, last } = harness();
    const session = openSession({
      argv: ['claude', '-p'],
      cwd: '/tmp',
      first: 'the job',
      turnFormat: 'stream-json',
      spawn,
    });

    expect(session.canPush).toBe(true);
    await session.send('opus claimed harbor.ts');
    await new Promise((done) => setImmediate(done));

    const lines = last().written();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).message.content[0].text).toBe('opus claimed harbor.ts');
  });

  it('settles exited when the child closes, so a supervisor cannot hang', async () => {
    const { spawn, last } = harness();
    const session = openSession({ argv: ['claude'], cwd: '/tmp', first: 'x', turnFormat: 'stream-json', spawn });

    last().close(0);
    await expect(session.exited).resolves.toBe(0);
  });

  it('settles exited when the binary is missing, which emits error and never close', async () => {
    const { spawn, last } = harness();
    const session = openSession({ argv: ['nope'], cwd: '/tmp', first: 'x', turnFormat: 'stream-json', spawn });

    (last().child as unknown as EventEmitter).emit('error', new Error('ENOENT'));
    await expect(session.exited).resolves.toBeNull();
  });
});

describe('an interactive seat, watchable over Remote Control', () => {
  it('wraps the command in a pty, because without one Claude Code falls back to print', async () => {
    const { spawn, calls } = harness();
    openSession({
      argv: ['claude', '--remote-control', 'opus', '--permission-mode', 'bypassPermissions'],
      cwd: '/tmp',
      first: 'the job',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      spawn,
    });

    // Verified against the real binary: spawned without a terminal it exits
    // with "Input must be provided ... when using --print" and Remote Control
    // has nothing to attach to.
    expect(calls[0]!.file).toBe('script');
    expect(calls[0]!.args.slice(0, 3)).toEqual(['-q', '/dev/null', 'claude']);
    expect(calls[0]!.args).toContain('--remote-control');
  });

  it('types the job rather than putting a whole brief on the command line', async () => {
    const { spawn, calls, last } = harness();
    openSession({
      argv: ['claude', '--remote-control', 'opus'],
      cwd: '/tmp',
      first: 'build the thing',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      spawn,
    });
    await new Promise((done) => setTimeout(done, 5));

    expect(calls[0]!.args).not.toContain('build the thing');
    expect(last().written()).toEqual(['build the thing']);
  });

  it('sends one line, so a multi-line brief cannot submit itself halfway', async () => {
    const { spawn, last } = harness();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'x',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      spawn,
    });
    await new Promise((done) => setTimeout(done, 5));

    // A newline in the middle of a brief is a Return: it would submit the first
    // paragraph and leave the rest typing into a running turn.
    await session.send('line one\nline two\nline three');
    expect(last().written()).toEqual(['x', 'line one line two line three']);
  });

  it('waits for the TUI to draw before typing, or the job lands on a splash screen', async () => {
    const { spawn, last } = harness();
    openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'the job',
      turnFormat: 'interactive',
      readyDelayMs: 30,
      spawn,
    });

    expect(last().written()).toEqual([]);
    await new Promise((done) => setTimeout(done, 45));
    expect(last().written()).toEqual(['the job']);
  });

  it('can still be pushed a turn mid-run, which is what makes a peer feel live', async () => {
    const { spawn } = harness();
    const session = openSession({
      argv: ['claude'],
      cwd: '/tmp',
      first: 'x',
      turnFormat: 'interactive',
      readyDelayMs: 0,
      spawn,
    });
    expect(session.canPush).toBe(true);
  });
});

describe('a harness that reads its prompt once', () => {
  it('takes the job on argv and refuses a later turn', async () => {
    const { spawn, calls } = harness();
    const session = openSession({ argv: ['codex', 'exec', '--json'], cwd: '/tmp', first: 'the job', spawn });

    expect(calls[0]!.args).toEqual(['exec', '--json', 'the job']);
    expect(session.canPush).toBe(false);
    // Refused loudly. A silent no-op would look like delivery and be a lie.
    await expect(session.send('anything')).rejects.toThrow(/cannot take a turn/);
  });
});
