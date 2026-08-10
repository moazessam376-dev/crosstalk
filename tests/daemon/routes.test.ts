import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { EventsResponse, WireError, WriteResponse } from '../../src/daemon/contract.js';
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
    model: luna-5.6
    lifecycle: attached
    workspace: .crosstalk/worktrees/codex
  - id: cursor
    role: worker
    harness: cursor-app
    lifecycle: attached
    workspace: .crosstalk/worktrees/cursor
`;

async function tempRepo(config: string = CONFIG): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-routes-'));
  await writeFile(join(dir, 'crosstalk.yaml'), config, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

/**
 * `policy` replaces `DEFAULT_POLICY` wholesale in the loader
 * (`src/daemon/config.ts:78`), so a partial block would leave `ladder` and
 * `rungTimeouts` undefined. Spelled out in full for that reason.
 */
const configWithMaxRounds = (maxRounds: number): string => `${CONFIG}policy:
  selfCritique:
    required: true
    minRounds: 1
  leaderCritique:
    maxRounds: 2
  dispute:
    maxRounds: ${maxRounds}
    ladder: [discriminating_test, third_agent, leader]
    rungTimeouts:
      discriminating_test: 30m
      third_agent: 30m
  taskAcceptance:
    method: leader
`;

async function withDaemon<T>(fn: (d: DaemonHandle) => Promise<T>): Promise<T> {
  const daemon = await startDaemon({ repo: await tempRepo() });
  try {
    return await fn(daemon);
  } finally {
    await daemon.close();
  }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const auth = (d: DaemonHandle, id: string): Record<string, string> => ({
  authorization: `Bearer ${d.tokens.get(id)!}`,
});

async function post(d: DaemonHandle, path: string, body: unknown, id: string): Promise<Response> {
  return fetch(`${d.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(d, id) },
    body: JSON.stringify(body),
  });
}

const get = (d: DaemonHandle, path: string, id: string): Promise<Response> =>
  fetch(`${d.url}${path}`, { headers: auth(d, id) });

const ev = (sha: string) => ({ kind: 'command' as const, command: 'npm test', output: 'ok', sha });

const CLAIM = {
  against: 'codex',
  target: 'src/economy.ts:41',
  assertion: 'staffing coefficient applied twice',
  severity: 'defect',
  falsifier: 'produce() and consume() would reference different multipliers',
  evidence: [ev('abc1234')],
};

const TASK = {
  id: 'T-01',
  title: 'Build the log',
  brief: 'A very long brief that has no business appearing on the board.',
  specRefs: ['§4.1'],
  assignee: 'codex',
  deps: [],
  acceptance: ['seq is monotonic'],
  branch: 'ct/T-01-log',
};

const CRITIQUE = { rounds: 1, findings: [], critic: 'codex subagent' };

function kinds(events: CrosstalkEvent[]): string[] {
  return events.map((event) => event.kind);
}

describe('claims over the wire', () => {
  it('refuses a claim with no falsifier, in the protocol domain', async () => {
    await withDaemon(async (daemon) => {
      const response = await post(daemon, '/claims', { ...CLAIM, falsifier: '' }, 'leader');
      expect(response.status).toBe(422);
      expect((await readJson<WireError>(response)).error).toMatchObject({
        domain: 'protocol',
        code: 'MISSING_FALSIFIER',
      });
    });
  });

  it('refuses a vacuous falsifier', async () => {
    await withDaemon(async (daemon) => {
      const response = await post(daemon, '/claims', { ...CLAIM, falsifier: 'if it did not work' }, 'leader');
      expect(response.status).toBe(422);
      expect((await readJson<WireError>(response)).error.code).toBe('VACUOUS_FALSIFIER');
    });
  });

  it('assigns the claim id itself and takes raisedBy from the token', async () => {
    await withDaemon(async (daemon) => {
      const response = await post(daemon, '/claims', { ...CLAIM, id: 'C-999' }, 'leader');
      expect(response.status).toBe(201);
      const { events } = await readJson<WriteResponse>(response);
      const raised = events.find((event) => event.kind === 'claim_raised');
      expect(raised).toMatchObject({ from: 'leader', claim: { id: 'C-1', raisedBy: 'leader' } });
    });
  });

  it('rejects a body that sets raisedBy or evidence.by', async () => {
    await withDaemon(async (daemon) => {
      const withRaisedBy = await post(daemon, '/claims', { ...CLAIM, raisedBy: 'codex' }, 'leader');
      expect(withRaisedBy.status).toBe(403);
      expect((await readJson<WireError>(withRaisedBy)).error.code).toBe('FROM_NOT_ALLOWED');

      const withBy = await post(
        daemon,
        '/claims',
        { ...CLAIM, evidence: [{ ...ev('abc1234'), by: 'codex' }] },
        'leader',
      );
      expect(withBy.status).toBe(403);
    });
  });

  it('refuses a contest with no rationale', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/claims', CLAIM, 'leader');
      const response = await post(
        daemon,
        '/claims/C-1/response',
        { verdict: 'contest', falsifier: 'the ledger would diverge on tick three', evidence: [ev('def')] },
        'codex',
      );
      expect(response.status).toBe(422);
      expect((await readJson<WireError>(response)).error.code).toBe('CONTEST_WITHOUT_RATIONALE');
    });
  });

  it('refuses a response from a participant the claim is not against', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/claims', CLAIM, 'leader');
      const response = await post(
        daemon,
        '/claims/C-1/response',
        { verdict: 'accept', evidence: [ev('def')] },
        'cursor',
      );
      expect(response.status).toBe(403);
      expect((await readJson<WireError>(response)).error).toMatchObject({
        domain: 'protocol',
        code: 'NOT_CLAIM_RESPONDER',
      });
    });
  });

  it('refuses an uphold carrying no new evidence', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/claims', CLAIM, 'leader');
      await post(
        daemon,
        '/claims/C-1/response',
        {
          verdict: 'contest',
          rationale: 'built this way because replay determinism needs one pass',
          falsifier: 'a second multiplier would show as a divergent ledger on tick three',
          evidence: [ev('old-sha')],
        },
        'codex',
      );
      const response = await post(
        daemon,
        '/claims/C-1/response',
        { verdict: 'uphold', evidence: [ev('abc1234')] },
        'leader',
      );
      expect(response.status).toBe(422);
      expect((await readJson<WireError>(response)).error.code).toBe('UPHOLD_WITHOUT_NEW_EVIDENCE');
    });
  });

  it('404s a response to a claim that does not exist', async () => {
    await withDaemon(async (daemon) => {
      const response = await post(daemon, '/claims/C-99/response', { verdict: 'accept', evidence: [] }, 'codex');
      expect(response.status).toBe(404);
      expect((await readJson<WireError>(response)).error.code).toBe('UNKNOWN_CLAIM');
    });
  });
});

describe('tasks and the two gates', () => {
  it('only the leader may create a task', async () => {
    await withDaemon(async (daemon) => {
      expect((await post(daemon, '/tasks', TASK, 'codex')).status).toBe(403);
      expect((await post(daemon, '/tasks', TASK, 'leader')).status).toBe(201);
    });
  });

  it('refuses in_progress before the task is acknowledged', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/tasks', TASK, 'leader');
      await post(daemon, '/tasks/T-01/state', { state: 'assigned' }, 'leader');

      const response = await post(daemon, '/tasks/T-01/state', { state: 'in_progress' }, 'codex');
      expect(response.status).toBe(409);
      expect((await readJson<WireError>(response)).error.code).toBe('GATE_NOT_ACKNOWLEDGED');
    });
  });

  it('acknowledging records the ack and moves the task in one request', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/tasks', TASK, 'leader');
      await post(daemon, '/tasks/T-01/state', { state: 'assigned' }, 'leader');

      const response = await post(
        daemon,
        '/tasks/T-01/ack',
        { restatement: 'build the append-only log', ambiguities: [] },
        'codex',
      );
      expect(response.status).toBe(201);
      const { events } = await readJson<WriteResponse>(response);
      expect(kinds(events)).toEqual(expect.arrayContaining(['brief_ack', 'task_state']));

      expect((await post(daemon, '/tasks/T-01/state', { state: 'in_progress' }, 'codex')).status).toBe(201);
    });
  });

  it('only the assignee may acknowledge', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/tasks', TASK, 'leader');
      const response = await post(
        daemon,
        '/tasks/T-01/ack',
        { restatement: 'not mine', ambiguities: [] },
        'cursor',
      );
      expect(response.status).toBe(403);
      expect((await readJson<WireError>(response)).error.code).toBe('ROLE_NOT_PERMITTED');
    });
  });

  it('refuses submitted before a self-review, then permits it after — CT-D-1 end to end', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/tasks', TASK, 'leader');
      await post(daemon, '/tasks/T-01/state', { state: 'assigned' }, 'leader');
      await post(daemon, '/tasks/T-01/ack', { restatement: 'build it', ambiguities: [] }, 'codex');
      await post(daemon, '/tasks/T-01/state', { state: 'in_progress' }, 'codex');

      const tooEarly = await post(daemon, '/tasks/T-01/state', { state: 'submitted' }, 'codex');
      expect(tooEarly.status).toBe(409);
      expect((await readJson<WireError>(tooEarly)).error.code).toBe('GATE_NOT_SELF_REVIEWED');

      const submitted = await post(daemon, '/tasks/T-01/submit', { critique: CRITIQUE, evidence: [] }, 'codex');
      expect(submitted.status).toBe(201);
      expect(kinds((await readJson<WriteResponse>(submitted)).events)).toContain('self_review');

      // The gate that no event in the log could satisfy this morning.
      expect((await post(daemon, '/tasks/T-01/state', { state: 'submitted' }, 'codex')).status).toBe(201);
    });
  });

  it('accepts a zero-finding critique record', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/tasks', TASK, 'leader');
      await post(daemon, '/tasks/T-01/state', { state: 'assigned' }, 'leader');
      await post(daemon, '/tasks/T-01/ack', { restatement: 'build it', ambiguities: [] }, 'codex');
      await post(daemon, '/tasks/T-01/state', { state: 'in_progress' }, 'codex');

      const response = await post(
        daemon,
        '/tasks/T-01/submit',
        { critique: { rounds: 1, findings: [], critic: 'subagent' }, evidence: [] },
        'codex',
      );
      // Legal and recorded, not blocked — the gate asks for a record, not for findings.
      expect(response.status).toBe(201);
    });
  });

  it('rejects a transition not in the table', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/tasks', TASK, 'leader');
      const response = await post(daemon, '/tasks/T-01/state', { state: 'merged' }, 'leader');
      expect(response.status).toBe(409);
      expect((await readJson<WireError>(response)).error.code).toBe('ILLEGAL_TRANSITION');
    });
  });

  it('board returns metadata only, never message or brief text', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/tasks', TASK, 'leader');
      await post(daemon, '/events', { kind: 'message', room: '#floor', body: 'chatter' }, 'leader');

      const raw = await (await get(daemon, '/board', 'cursor')).text();
      expect(raw).toContain('T-01');
      // A firehose at a dozen participants is the failure this guards.
      expect(raw).not.toContain('no business appearing');
      expect(raw).not.toContain('chatter');
      expect(JSON.parse(raw).tasks[0]).not.toHaveProperty('brief');
    });
  });

  it('my_tasks returns only the caller’s work', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/tasks', TASK, 'leader');
      const mine = await readJson<{ tasks: { id: string }[] }>(await get(daemon, '/tasks/mine', 'codex'));
      const theirs = await readJson<{ tasks: { id: string }[] }>(await get(daemon, '/tasks/mine', 'cursor'));
      expect(mine.tasks.map((task) => task.id)).toEqual(['T-01']);
      expect(theirs.tasks).toHaveLength(0);
    });
  });
});

describe('decisions', () => {
  const DECISION = {
    question: 'Adopt the ladder?',
    options: ['yes', 'no'],
    voters: ['leader', 'codex'],
    method: 'majority',
  };

  it('rejects a ladder whose last rung is not terminal', async () => {
    await withDaemon(async (daemon) => {
      const response = await post(
        daemon,
        '/decisions',
        { ...DECISION, method: 'ladder', ladder: ['discriminating_test', 'third_agent'] },
        'leader',
      );
      expect(response.status).toBe(422);
      expect((await readJson<WireError>(response)).error.code).toBe('NON_TERMINAL_LADDER');
    });
  });

  it('refuses a vote with no rationale and a vote from a non-voter', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/decisions', DECISION, 'leader');

      const noRationale = await post(daemon, '/decisions/D-1/vote', { option: 'yes' }, 'leader');
      expect(noRationale.status).toBe(422);
      expect((await readJson<WireError>(noRationale)).error.code).toBe('VOTE_WITHOUT_RATIONALE');

      const stranger = await post(
        daemon,
        '/decisions/D-1/vote',
        { option: 'yes', rationale: 'because' },
        'cursor',
      );
      expect(stranger.status).toBe(403);
      expect((await readJson<WireError>(stranger)).error.code).toBe('NOT_ELIGIBLE_VOTER');
    });
  });

  it('resolves once the tally carries', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/decisions', DECISION, 'leader');

      const first = await post(daemon, '/decisions/D-1/vote', { option: 'yes', rationale: 'a' }, 'leader');
      expect(kinds((await readJson<WriteResponse>(first)).events)).not.toContain('decision_resolved');

      const second = await post(daemon, '/decisions/D-1/vote', { option: 'yes', rationale: 'b' }, 'codex');
      expect(kinds((await readJson<WriteResponse>(second)).events)).toContain('decision_resolved');
    });
  });
});

describe('rooms, roster and the long poll', () => {
  it('reads a percent-encoded room id', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/events', { kind: 'message', room: '#floor', body: 'hello' }, 'leader');
      // Unencoded, the '#' is a fragment and never reaches the server at all.
      const response = await get(daemon, '/rooms/%23floor/events', 'codex');
      expect(response.status).toBe(200);
      const { events } = await readJson<EventsResponse>(response);
      expect(events.every((event) => event.room === '#floor')).toBe(true);
      expect(events.some((event) => event.kind === 'message')).toBe(true);
    });
  });

  it('refuses a room the caller is not in', async () => {
    await withDaemon(async (daemon) => {
      const response = await get(daemon, `/rooms/${encodeURIComponent('dm:codex~leader')}/events`, 'cursor');
      expect(response.status).toBe(403);
      expect((await readJson<WireError>(response)).error.code).toBe('NOT_A_ROOM_MEMBER');
    });
  });

  it('roster reports id, role, harness and model, and omits an unprobed tier', async () => {
    await withDaemon(async (daemon) => {
      const { participants } = await readJson<{ participants: Record<string, unknown>[] }>(
        await get(daemon, '/roster', 'leader'),
      );
      const codex = participants.find((participant) => participant['id'] === 'codex')!;
      expect(codex).toMatchObject({ role: 'worker', harness: 'codex-app', model: 'luna-5.6' });
      // Absence says "not probed"; a defaulted `file` would claim something untrue.
      expect(codex).not.toHaveProperty('transport');
    });
  });

  it('returns idle when nothing addresses the caller', async () => {
    await withDaemon(async (daemon) => {
      const response = await get(daemon, '/await?timeout_s=0', 'codex');
      expect(await readJson<{ idle: boolean }>(response)).toEqual({ idle: true });
    });
  });

  it('wakes on a message from someone else in a shared room', async () => {
    await withDaemon(async (daemon) => {
      await get(daemon, '/await?timeout_s=0', 'codex'); // register presence and the delivery mark
      const waiting = get(daemon, '/await?timeout_s=5', 'codex');
      await new Promise((done) => setTimeout(done, 50));
      await post(daemon, '/events', { kind: 'message', room: '#floor', body: 'wake up' }, 'leader');

      const payload = await readJson<{ events?: CrosstalkEvent[] }>(await waiting);
      expect(payload.events?.some((event) => event.kind === 'message')).toBe(true);
    });
  });

  it('does not wake on the caller’s own writes', async () => {
    await withDaemon(async (daemon) => {
      await get(daemon, '/await?timeout_s=0', 'codex');
      const waiting = get(daemon, '/await?timeout_s=1', 'codex');
      await new Promise((done) => setTimeout(done, 50));
      await post(daemon, '/events', { kind: 'message', room: '#floor', body: 'my own' }, 'codex');

      // A wait that returns on your own writes is a busy loop that looks like progress.
      expect(await readJson<{ idle?: boolean }>(await waiting)).toEqual({ idle: true });
    });
  });
});

describe('shutdown', () => {
  it('refuses a worker and accepts the leader', async () => {
    const repo = await tempRepo();
    const daemon = await startDaemon({ repo });
    let stopped = false;
    try {
      expect((await post(daemon, '/shutdown', {}, 'codex')).status).toBe(403);
      expect((await post(daemon, '/shutdown', {}, 'leader')).status).toBe(200);
      // The reply comes before the stop, so a caller can tell a clean stop from a crash.
      await new Promise((done) => setTimeout(done, 200));
      await expect(get(daemon, '/health', 'leader')).rejects.toThrow();
      stopped = true;
    } finally {
      if (!stopped) await daemon.close();
    }
  });
});

describe('protocol events reach the people they concern', () => {
  it('wakes the participant a claim is raised against', async () => {
    await withDaemon(async (daemon) => {
      await get(daemon, '/await?timeout_s=0', 'codex');
      const waiting = get(daemon, '/await?timeout_s=5', 'codex');
      await new Promise((done) => setTimeout(done, 50));
      await post(daemon, '/claims', CLAIM, 'leader');

      // Without a room on the event this never fires: `addressesParticipant`
      // has nothing to match, and the one message a worker most needs —
      // "a claim has been raised against you" — is the one it never gets.
      const payload = await readJson<{ events?: CrosstalkEvent[] }>(await waiting);
      expect(kinds(payload.events ?? [])).toContain('claim_raised');
    });
  });

  it('does not wake an uninvolved participant on a direct message', async () => {
    await withDaemon(async (daemon) => {
      await get(daemon, '/await?timeout_s=0', 'cursor');
      const waiting = get(daemon, '/await?timeout_s=1', 'cursor');
      await new Promise((done) => setTimeout(done, 50));
      await post(
        daemon,
        '/events',
        { kind: 'message', room: 'dm:codex~leader', body: 'private' },
        'leader',
      );

      // The neighbouring case: a room cursor is not in must not wake it, or
      // "addresses me" degrades into "anything happened".
      expect(await readJson<{ idle?: boolean }>(await waiting)).toEqual({ idle: true });
    });
  });

  it('authenticates the hub over a cookie, and lets a bearer token override it', async () => {
    await withDaemon(async (daemon) => {
      const cookie = await fetch(`${daemon.url}/events`, {
        headers: { cookie: `ct_token=${daemon.tokens.get('leader')!}` },
      });
      expect(cookie.status).toBe(200);

      // EventSource cannot send headers, so the hub has only this path; a
      // bearer token must still win, or a CLI run beside a browser could be
      // silently re-identified.
      const both = await fetch(`${daemon.url}/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `ct_token=${daemon.tokens.get('leader')!}`,
          ...auth(daemon, 'codex'),
        },
        body: JSON.stringify({ kind: 'message', room: '#floor', body: 'whose?' }),
      });
      const { events } = await readJson<WriteResponse>(both);
      expect(events.find((event) => event.kind === 'message')).toMatchObject({ from: 'codex' });
    });
  });

  it('closes presence on shutdown', async () => {
    const daemon = await startDaemon({ repo: await tempRepo() });
    let stopped = false;
    try {
      await post(daemon, '/events', { kind: 'message', room: '#floor', body: 'hi' }, 'codex');
      const response = await post(daemon, '/shutdown', {}, 'leader');
      expect(kinds((await readJson<WriteResponse>(response)).events)).toContain('participant_left');
      await new Promise((done) => setTimeout(done, 200));
      stopped = true;
    } finally {
      if (!stopped) await daemon.close();
    }
  });
});

describe('GET /config.json', () => {
  // Track C reads `maxRounds` from here for the round counter. The header and
  // the channel row both hard-code 3 today, so the value has to be the loaded
  // one — a served constant would let that bug survive the fix.
  it('serves the loaded dispute maxRounds, not a constant', async () => {
    const daemon = await startDaemon({ repo: await tempRepo(configWithMaxRounds(5)) });
    try {
      const body = await readJson<{ maxRounds: number }>(
        await get(daemon, '/config.json', 'leader'),
      );
      expect(body.maxRounds).toBe(5);
    } finally {
      await daemon.close();
    }
  });

  // The neighbouring case: a different config must move the served value.
  // Together these two kill any hard-coded number, including a hard-coded 5.
  it('moves with the config', async () => {
    const daemon = await startDaemon({ repo: await tempRepo(configWithMaxRounds(7)) });
    try {
      const body = await readJson<{ maxRounds: number }>(
        await get(daemon, '/config.json', 'leader'),
      );
      expect(body.maxRounds).toBe(7);
    } finally {
      await daemon.close();
    }
  });
});

describe('a dispute is an argument, not one turn', () => {
  // The acceptance criterion verbatim: before A1 this sequence ended with
  // ILLEGAL_CLAIM_RESPONSE on the worker's second contest, so the leader could
  // uphold forever and the worker got one turn.
  it('accepts the responder contesting again after an uphold, at round 3', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/claims', CLAIM, 'leader');
      const contest = {
        verdict: 'contest',
        rationale: 'built this way because replay determinism needs a single pass',
        falsifier: 'the focused ledger check would print two rows rather than one',
        evidence: [ev('counter-1')],
      };

      expect((await post(daemon, '/claims/C-1/response', contest, 'codex')).status).toBe(201);
      expect(
        (await post(daemon, '/claims/C-1/response', { verdict: 'uphold', evidence: [ev('new-1')] }, 'leader'))
          .status,
      ).toBe(201);

      const second = await post(
        daemon,
        '/claims/C-1/response',
        { ...contest, evidence: [ev('counter-2')] },
        'codex',
      );
      expect(second.status).toBe(201);

      const { events } = await readJson<EventsResponse>(await get(daemon, '/events', 'leader'));
      const raised = events.find((e) => e.kind === 'claim_raised');
      expect(raised).toBeDefined();
      const responses = events.filter((e) => e.kind === 'claim_response');
      expect(responses).toHaveLength(3);
    });
  });

  it('refuses the responder answering twice in a row', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/claims', CLAIM, 'leader');
      const contest = {
        verdict: 'contest',
        rationale: 'built this way because replay determinism needs a single pass',
        falsifier: 'the focused ledger check would print two rows rather than one',
        evidence: [ev('counter-1')],
      };
      await post(daemon, '/claims/C-1/response', contest, 'codex');

      const again = await post(
        daemon,
        '/claims/C-1/response',
        { ...contest, evidence: [ev('counter-2')] },
        'codex',
      );
      expect(again.status).toBe(403);
      expect((await readJson<WireError>(again)).error.code).toBe('NOT_CLAIM_RESPONDER');
    });
  });
});
