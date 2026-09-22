import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { EXIT, run, type Io } from '../../src/cli/index.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

function capture(stdin = ''): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    stdin: async () => stdin,
  };
}

describe('ct', () => {
  it('joins, sends, reads and reports', async () => {
    const repo = await tempRepo();
    const io = capture();
    expect(await run(['join', 'orchestrator', '--repo', repo], io)).toBe(EXIT.ok);
    expect(await run(['join', 'builder-1', '--repo', repo], io)).toBe(EXIT.ok);
    expect(await run(['send', '--as', 'orchestrator', '--to', 'builder-1', 'take', 'the', 'dock', '--repo', repo], io)).toBe(EXIT.ok);
    expect(io.stdout.at(-1)).toBe('sent orchestrator-1');
    expect(await run(['inbox', '--as', 'builder-1', '--repo', repo], io)).toBe(EXIT.ok);
    expect(io.stdout.at(-1)).toMatch(/orchestrator: take the dock$/);
    expect(await run(['inbox', '--as', 'builder-1', '--repo', repo], io)).toBe(EXIT.empty);
    expect(await run(['who', '--repo', repo], io)).toBe(EXIT.ok);
    expect(await run(['stats', '--repo', repo], io)).toBe(EXIT.ok);
    expect(await run(['new', 'next', '--repo', repo], io)).toBe(EXIT.ok);
    expect(io.stdout.at(-1)).toMatch(/^started run .*-next$/);
  });

  it('exits 2 with usage for a bad command or missing flag', async () => {
    const repo = await tempRepo();
    const io = capture();
    expect(await run(['frobnicate'], io)).toBe(EXIT.usage);
    expect(await run(['send', '--to', 'x', 'hi', '--repo', repo], io)).toBe(EXIT.usage);
    expect(io.stderr.at(-1)).toMatch(/--as is required/);
    expect(await run(['inbox', '--as', 'x', '--wait', 'soon', '--repo', repo], io)).toBe(EXIT.usage);
  });

  it('exits 1 with the board’s message for a board error', async () => {
    const repo = await tempRepo();
    const io = capture();
    await run(['join', 'builder-1', '--repo', repo], io);
    expect(await run(['join', 'builder-1', '--repo', repo], io)).toBe(EXIT.error);
    expect(io.stderr.at(-1)).toMatch(/taken/);
  });

  it('runs as a script', async () => {
    const repo = await tempRepo();
    const entry = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
    const output = await new Promise<string>((done, fail) => {
      execFile(process.execPath, ['--import', 'tsx', entry, 'who', '--repo', repo], (error, stdout) =>
        error === null ? done(stdout) : fail(error),
      );
    });
    expect(output.trim()).toBe('no run yet');
  }, 30_000);
});
