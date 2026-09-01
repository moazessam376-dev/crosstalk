import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { CLI_COMMANDS } from '../../src/cli/index.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { PhaseStatus } from '../../src/core/phase.js';

/**
 * A shell-tier planner has to be able to ask the operator something.
 *
 * `operator-questioned` gates the plan phase, and the only way to open a
 * decision was `claim({kind:"open"})` on the MCP tier — `/decisions` had no CLI
 * path at all, for either opening or voting. So a planner on `codex-cli`, which
 * is shell tier until somebody hand-pastes `~/.codex/config.toml`, would have
 * sat in plan forever with no way out.
 *
 * That is precisely the shape of the `contract-exists` bug: a gate that one
 * transport cannot satisfy, blocking silently. Found by staffing a real team
 * and trying to drive the loop from the command line.
 */

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
shape: planner-integrator
participants:
  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
  - id: planner
    role: leader
    harness: claude-code-cli
    lifecycle: attached
    workspace: .
  - id: b-1
    role: worker
    harness: claude-code-cli
    lifecycle: attached
    workspace: .
`;

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-ask-'));
  dirs.push(dir);
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => {});
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function post(daemon: DaemonHandle, who: string, path: string, body: unknown) {
  const response = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.tokens.get(who)!}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as { events?: CrosstalkEvent[] } };
}

async function phaseOf(daemon: DaemonHandle): Promise<PhaseStatus> {
  const response = await fetch(`${daemon.url}/phase`, {
    headers: { authorization: `Bearer ${daemon.tokens.get('planner')!}` },
  });
  return (await response.json()) as PhaseStatus;
}

describe('the CLI can drive the planning question', () => {
  it('offers ask and answer as commands', () => {
    expect(CLI_COMMANDS).toContain('ask');
    expect(CLI_COMMANDS).toContain('answer');
  });

  it('opens a decision the operator can answer, and the gate then clears', async () => {
    // Through the running daemon, deliberately. The unit test for this gate
    // hand-built an array with decision events in it and passed, while the
    // daemon could never meet the gate at all: `phase()` hands `phaseStatus`
    // only `state.messages`, and decisions are a separate projection. A test
    // that supplies its own data proves the function works given data, never
    // that anything hands it any.
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    const opened = await post(daemon, 'planner', '/decisions', {
      question: 'Sim first, or art first?',
      options: ['sim first', 'art first'],
      voters: ['@human'],
      method: 'human',
    });
    expect(opened.status).toBe(201);
    expect((await phaseOf(daemon)).blocking.join(' ')).toContain('operator-questioned');

    const id = opened.json.events!.find((event) => event.kind === 'decision_opened')!;
    const decisionId = id.kind === 'decision_opened' ? id.decision.id : '';

    const answered = await post(daemon, '@human', `/decisions/${decisionId}/vote`, {
      option: 'sim first',
      rationale: 'the sim is what makes the art legible',
    });
    expect(answered.status).toBe(201);

    expect((await phaseOf(daemon)).blocking.join(' ')).not.toContain('operator-questioned');
  });

  it('is not cleared by the seats voting among themselves', async () => {
    const dir = await repo();
    const daemon = await startDaemon({ repo: dir });
    daemons.push(daemon);

    const opened = await post(daemon, 'planner', '/decisions', {
      question: 'Which renderer?',
      options: ['canvas', 'webgl'],
      voters: ['@human', 'b-1'],
      method: 'human',
    });
    const id = opened.json.events!.find((event) => event.kind === 'decision_opened')!;
    const decisionId = id.kind === 'decision_opened' ? id.decision.id : '';

    await post(daemon, 'b-1', `/decisions/${decisionId}/vote`, { option: 'webgl', rationale: 'faster' });

    expect((await phaseOf(daemon)).blocking.join(' ')).toContain('operator-questioned');
  });
});
