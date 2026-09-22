import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const built = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

function once(args: string[], input: string): Promise<number> {
  return new Promise((done, fail) => {
    const started = performance.now();
    const child = execFile(process.execPath, args, (error) =>
      error === null ? done(performance.now() - started) : fail(error),
    );
    child.stdin?.end(input);
  });
}

const median = (times: number[]): number => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;

describe.skipIf(!existsSync(built))('hook timing (built CLI)', () => {
  it('answers an ordinary tool call about as fast as node starts', async () => {
    const repo = await tempRepo();
    const board = new Board(repo);
    await board.join('builder-1');
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash' });
    const hook: number[] = [];
    const bare: number[] = [];
    // Alternate with bare node startup so a busy machine slows both alike. Measured here:
    // bare node 77 ms, the hook 104 ms, node loading the MCP SDK 337 ms.
    for (let i = 0; i < 5; i += 1) {
      bare.push(await once(['-e', '0'], ''));
      hook.push(await once([built, 'hook', '--repo', repo], input));
    }
    expect(median(hook)).toBeLessThan(2.5 * median(bare));
  }, 60_000);
});
