import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { Board } from '../../src/board/board.js';
import { removeTempRepos, tempRepo } from '../helpers.js';

afterEach(removeTempRepos);

const built = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

function once(repo: string, input: string): Promise<number> {
  return new Promise((done, fail) => {
    const started = performance.now();
    const child = execFile(process.execPath, [built, 'hook', '--repo', repo], (error) =>
      error === null ? done(performance.now() - started) : fail(error),
    );
    child.stdin?.end(input);
  });
}

describe.skipIf(!existsSync(built))('hook timing (built CLI)', () => {
  it('answers an ordinary tool call quickly', async () => {
    const repo = await tempRepo();
    const board = new Board(repo);
    await board.join('builder-1');
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash' });
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) times.push(await once(repo, input));
    times.sort((a, b) => a - b);
    // The target is 100 ms on a developer machine; CI runners are slower, so this only catches regressions like loading the MCP SDK.
    expect(times[2]).toBeLessThan(400);
  }, 30_000);
});
