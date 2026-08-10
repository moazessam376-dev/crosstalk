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

/** A ladder whose rung timeouts are short enough to actually wait for. */
function configWithTimeouts(ladder: string, timeouts: string): string {
  return `${CONFIG}policy:
  selfCritique:
    required: true
    minRounds: 1
  leaderCritique:
    maxRounds: 2
  dispute:
    maxRounds: 3
    ladder: ${ladder}
    rungTimeouts:
${timeouts}
  taskAcceptance:
    method: leader
`;
}

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

  it('plans third_agent when the second worker is configured but has not connected', async () => {
    // C-14, at the daemon level. `cursor` never polls, so it is absent from
    // state.participants the whole time. The rung must survive that: agents
    // attaching at different times is what `lifecycle: attached` means, and
    // `skipped` is frozen into the log for good.
    await withDaemon(async (daemon) => {
      await post(daemon, '/claims', CLAIM, 'leader');
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
        await post(daemon, '/claims/C-1/response', body, responderTurn ? 'codex' : 'leader');
      }

      const opened = kindsOf(await events(daemon), 'decision_opened')[0]!;
      const decision = (opened as Extract<CrosstalkEvent, { kind: 'decision_opened' }>).decision;
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


/** Poll the log until `predicate` holds, or give up. Beats a fixed sleep. */
async function waitFor(
  d: DaemonHandle,
  predicate: (log: CrosstalkEvent[]) => boolean,
  budgetMs = 8000,
): Promise<CrosstalkEvent[]> {
  const deadline = Date.now() + budgetMs;
  let log = await events(d);
  while (!predicate(log) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    log = await events(d);
  }
  return log;
}

describe('rung timers', () => {
  it("fails a rung that times out and enters the next one", { timeout: 20000 }, async () => {
    await withDaemon(
      async (daemon) => {
        await respondTimes(daemon, 4);
        const log = await waitFor(daemon, (l) => l.some((e) => e.kind === 'rung_failed'));

        const failed = log.filter((e) => e.kind === 'rung_failed');
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ rung: 'discriminating_test', index: 0, reason: 'timeout' });
        // ...and the ladder moved on rather than stopping.
        expect(log.filter((e) => e.kind === 'rung_entered')).toHaveLength(2);
      },
      configWithTimeouts('[discriminating_test, third_agent, leader]', '      discriminating_test: 1s'),
    );
  });

  it('never arms a timer on the last rung, whatever rungTimeouts says', async () => {
    // Spec §5.3: the terminal rung blocks indefinitely by design. Arming here
    // would advance past the end of the ladder, which is a bug not a state.
    await withDaemon(
      async (daemon) => {
        await respondTimes(daemon, 4);
        await new Promise((r) => setTimeout(r, 2500));
        const log = await events(daemon);

        expect(log.filter((e) => e.kind === 'rung_failed')).toHaveLength(0);
        expect(log.filter((e) => e.kind === 'rung_entered')).toHaveLength(1);
      },
      configWithTimeouts('[leader]', '      leader: 1s'),
    );
  });

  it('does not arm a non-final rung that has no configured timeout', async () => {
    await withDaemon(
      async (daemon) => {
        await respondTimes(daemon, 4);
        await new Promise((r) => setTimeout(r, 2000));
        const log = await events(daemon);

        expect(log.filter((e) => e.kind === 'rung_failed')).toHaveLength(0);
      },
      configWithTimeouts('[discriminating_test, leader]', '      third_agent: 1s'),
    );
  });
});

describe('a rung nobody can answer', () => {
  it('enters third_agent, fails it by name, and climbs to the leader', { timeout: 20000 }, async () => {
    // codex vs cursor with only those two workers configured: the rung is
    // planned (two workers exist) but has nobody uninvolved to call. It must
    // be entered and failed, not skipped — skipping makes an unavailable rung
    // indistinguishable from a ladder that never had one.
    await withDaemon(
      async (daemon) => {
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

        const log = await waitFor(daemon, (l) =>
          l.some((e) => e.kind === 'rung_failed' && e.reason === 'no_uninvolved_peer'),
        );

        const failed = log.filter((e) => e.kind === 'rung_failed');
        expect(failed.map((e) => (e as { reason: string }).reason)).toEqual([
          'timeout',
          'no_uninvolved_peer',
        ]);
        // Entered discriminating_test, third_agent, then leader.
        expect(log.filter((e) => e.kind === 'rung_entered')).toHaveLength(3);
        const last = log.filter((e) => e.kind === 'rung_entered').at(-1);
        expect(last).toMatchObject({ rung: 'leader', index: 2 });
      },
      configWithTimeouts('[discriminating_test, third_agent, leader]', '      discriminating_test: 1s'),
    );
  });
});
