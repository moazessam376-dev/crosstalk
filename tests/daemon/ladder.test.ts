import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { EventsResponse } from '../../src/daemon/contract.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';

const CONFIG = `version: 1
project:
  repo: .
  mainBranch: main
participants:
  - id: leader
    role: leader
    harness: claude-code-app
    lifecycle: attached
    workspace: .
  - id: codex
    role: worker
    harness: codex-app
    lifecycle: attached
    workspace: .crosstalk/worktrees/codex
  - id: cursor
    role: worker
    harness: cursor-app
    lifecycle: attached
    workspace: .crosstalk/worktrees/cursor
`;

async function tempRepo(config: string = CONFIG): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-ladder-'));
  await writeFile(join(dir, 'crosstalk.yaml'), config, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

async function withDaemon<T>(fn: (d: DaemonHandle) => Promise<T>, config?: string): Promise<T> {
  const daemon = await startDaemon({ repo: await tempRepo(config) });
  try {
    return await fn(daemon);
  } finally {
    await daemon.close();
  }
}

const auth = (d: DaemonHandle, id: string) => ({ authorization: `Bearer ${d.tokens.get(id)!}` });

async function post(d: DaemonHandle, path: string, body: unknown, id: string): Promise<Response> {
  return fetch(`${d.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(d, id) },
    body: JSON.stringify(body),
  });
}

async function events(d: DaemonHandle): Promise<CrosstalkEvent[]> {
  const response = await fetch(`${d.url}/events`, { headers: auth(d, 'leader') });
  return ((await response.json()) as EventsResponse).events;
}

const ev = (sha: string) => ({ kind: 'command' as const, command: 'npm test', output: 'ok', sha });

const CLAIM = {
  against: 'codex',
  target: 'src/economy.ts:41',
  assertion: 'staffing coefficient applied twice',
  severity: 'defect',
  falsifier: 'the focused ledger check would print two rows rather than one',
  evidence: [ev('sha-0')],
};

/**
 * `n` alternating responses on one claim. The responder contests, the raiser
 * upholds, and round `k` leaves `rounds === k`.
 */
async function respondTimes(d: DaemonHandle, n: number): Promise<void> {
  await attachAll(d);
  await post(d, '/claims', CLAIM, 'leader');
  for (let k = 1; k <= n; k += 1) {
    const responderTurn = k % 2 === 1;
    const body = responderTurn
      ? {
          verdict: 'contest',
          rationale: 'built this way because replay determinism needs a single pass',
          falsifier: 'the focused ledger check would print two rows rather than one',
          evidence: [ev(`counter-${k}`)],
        }
      : { verdict: 'uphold', evidence: [ev(`new-${k}`)] };
    const who = responderTurn ? 'codex' : 'leader';
    const response = await post(d, '/claims/C-1/response', body, who);
    if (response.status !== 201) {
      throw new Error(`response ${k} from ${who} failed: ${response.status} ${await response.text()}`);
    }
  }
}

/**
 * Every configured agent polls at `crosstalk up`, which is what puts it in
 * `state.participants`. Without this the ladder's shape depends on which
 * agents happen to have spoken — see the claim in the handoff.
 */
async function attachAll(d: DaemonHandle): Promise<void> {
  for (const id of ['leader', 'codex', 'cursor']) {
    await fetch(`${d.url}/roster`, { headers: auth(d, id) });
  }
}

const kindsOf = (log: CrosstalkEvent[], kind: string) => log.filter((e) => e.kind === kind);

describe('the ladder climbs on its own', () => {
  it('escalates on the 4th response against maxRounds 3', async () => {
    await withDaemon(async (daemon) => {
      await respondTimes(daemon, 4);
      const log = await events(daemon);

      expect(kindsOf(log, 'decision_opened')).toHaveLength(1);
      expect(kindsOf(log, 'rung_entered')).toHaveLength(1);
    });
  });

  it('does not escalate on the 3rd', async () => {
    // The neighbouring case. `rounds` is 0 at raise and increments once per
    // response, so `rounds > 3` is first true at response 4, not 5.
    await withDaemon(async (daemon) => {
      await respondTimes(daemon, 3);
      const log = await events(daemon);

      expect(kindsOf(log, 'decision_opened')).toHaveLength(0);
      expect(kindsOf(log, 'rung_entered')).toHaveLength(0);
    });
  });

  it('opens exactly one decision however long the argument runs', async () => {
    // Without the no-unresolved-decision guard, every response past the maximum
    // opens another ladder, each with its own timers racing the others.
    await withDaemon(async (daemon) => {
      await respondTimes(daemon, 9);
      expect(kindsOf(await events(daemon), 'decision_opened')).toHaveLength(1);
    });
  });

  it('names every voter who could be asked at any rung', async () => {
    await withDaemon(async (daemon) => {
      await respondTimes(daemon, 4);
      const opened = kindsOf(await events(daemon), 'decision_opened')[0]!;
      const decision = (opened as Extract<CrosstalkEvent, { kind: 'decision_opened' }>).decision;

      expect([...decision.voters].sort()).toEqual(['@human', 'codex', 'cursor', 'leader']);
      expect(decision.claimId).toBe('C-1');
      expect(decision.method).toBe('ladder');
    });
  });

  it('carries the plan: skipped populated and currentRung at the start', async () => {
    await withDaemon(async (daemon) => {
      await respondTimes(daemon, 4);
      const opened = kindsOf(await events(daemon), 'decision_opened')[0]!;
      const decision = (opened as Extract<CrosstalkEvent, { kind: 'decision_opened' }>).decision;

      // Two workers, and neither is uninvolved here — codex is the responder
      // and the raiser is the leader — so third_agent has cursor available.
      expect(decision.skipped).toEqual([]);
      expect(decision.currentRung).toBe(0);
    });
  });

  it('addresses the decision to the leader, who is not in the dispute room', async () => {
    await withDaemon(async (daemon) => {
      // codex raises against cursor: a worker-vs-worker dispute, so
      // membersOf('dispute:C-1') excludes the leader entirely.
      await attachAll(daemon);
      await post(daemon, '/claims', { ...CLAIM, against: 'cursor' }, 'codex');
      for (let k = 1; k <= 4; k += 1) {
        const responderTurn = k % 2 === 1;
        const body = responderTurn
          ? {
              verdict: 'contest',
              rationale: 'built this way because replay determinism needs a single pass',
              falsifier: 'the focused ledger check would print two rows rather than one',
              evidence: [ev(`counter-${k}`)],
            }
          : { verdict: 'uphold', evidence: [ev(`new-${k}`)] };
        await post(daemon, '/claims/C-1/response', body, responderTurn ? 'cursor' : 'codex');
      }

      const opened = kindsOf(await events(daemon), 'decision_opened')[0];
      expect(opened).toBeDefined();
      const decision = (opened as Extract<CrosstalkEvent, { kind: 'decision_opened' }>).decision;
      expect(decision.voters).toContain('leader');
    });
  });
});
