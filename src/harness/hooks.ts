import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Presence, fed by the harness itself.
 *
 * The alternative was to have Crosstalk own every process and read its output
 * stream. That works, and it is where this ends up — but it only covers seats
 * Crosstalk spawned, and beacon-1's seats were launched by hand. A hook covers
 * both, costs one HTTP call per tool use, and needs nothing from the model:
 * the seat does not have to remember to report, which is the only kind of rule
 * that survives a long run.
 *
 * Failure is silent on purpose. A presence ping that blocks a tool call would
 * make the agent slower to help a teammate know what it is doing, which is
 * exactly backwards.
 */
const SCRIPT = String.raw`#!/usr/bin/env node
// Written by crosstalk init. Reports what this seat is doing to the daemon.
// Never fails the tool call it is attached to: presence is a convenience.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = process.env.CROSSTALK_STATE_DIR;
const seat = process.env.CROSSTALK_SEAT;
const phase = process.argv[2] ?? 'pre';

async function main() {
  if (!stateDir || !seat) return;

  let payload = {};
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    /* a hook with no stdin is still a heartbeat */
  }

  let url;
  let token;
  try {
    url = JSON.parse(readFileSync(join(stateDir, 'daemon.json'), 'utf8')).url;
    token = readFileSync(join(stateDir, 'tokens', seat.replace(/[^A-Za-z0-9_.-]/g, '_')), 'utf8').trim();
  } catch {
    return;
  }
  if (!url || !token) return;

  const input = payload.tool_input ?? {};
  const body = {
    verb: payload.tool_name ?? (phase === 'stop' ? 'idle' : 'working'),
    path: input.file_path ?? input.path ?? input.notebook_path,
    working: phase !== 'stop',
  };

  try {
    await fetch(url + '/presence', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* the daemon may be down; the tool call is not ours to fail */
  }
}

main().catch(() => {});
`;

export function hookSettings(scriptPath: string): Record<string, unknown> {
  const run = (phase: string) => ({
    matcher: '*',
    hooks: [{ type: 'command', command: `node ${JSON.stringify(scriptPath)} ${phase}` }],
  });
  return {
    hooks: {
      PreToolUse: [run('pre')],
      PostToolUse: [run('post')],
      Stop: [run('stop')],
    },
  };
}

/**
 * Writes the reporter once per repo and returns its path.
 *
 * One script, not one per seat: the seat is passed in the environment, so a
 * roster change does not leave stale copies behind.
 */
export async function writePresenceHook(repo: string): Promise<string> {
  const path = join(resolve(repo), '.crosstalk', 'hooks', 'presence.mjs');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, SCRIPT, { encoding: 'utf8', mode: 0o755 });
  return path;
}
