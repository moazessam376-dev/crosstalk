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

describe('who may move a task', () => {
  /**
   * A sibling of `configWithMaxRounds` rather than a generalisation of it, for
   * the same reason spelled out there: `policy` replaces `DEFAULT_POLICY`
   * wholesale, so every block has to be present or `ladder` and `rungTimeouts`
   * come back undefined.
   */
  const configWithAcceptance = (method: string, extraParticipants = ''): string =>
    `${CONFIG}${extraParticipants}policy:
  selfCritique:
    required: true
    minRounds: 1
  leaderCritique:
    maxRounds: 2
  dispute:
    maxRounds: 3
    ladder: [discriminating_test, third_agent, leader]
    rungTimeouts:
      discriminating_test: 30m
      third_agent: 30m
  taskAcceptance:
    method: ${method}
`;

  // Quoted: '@' opens a reserved YAML indicator, so a bare `@human` will not parse.
  const HUMAN_PARTICIPANT = `  - id: "@human"
    role: human
    harness: human
    lifecycle: attached
    workspace: .
`;

  async function withConfig<T>(config: string, fn: (d: DaemonHandle) => Promise<T>): Promise<T> {
    const daemon = await startDaemon({ repo: await tempRepo(config) });
    try {
      return await fn(daemon);
    } finally {
      await daemon.close();
    }
  }

  /** Read back from the board rather than from the write's reply: a refusal that
   *  returned an error *and* appended the event would pass a status-only test. */
  async function stateOf(daemon: DaemonHandle, id: string): Promise<string | undefined> {
    const { tasks } = await readJson<{ tasks: { id: string; state: string }[] }>(
      await get(daemon, '/board', 'leader'),
    );
    return tasks.find((task) => task.id === id)?.state;
  }

  const setState = (daemon: DaemonHandle, state: string, who: string): Promise<Response> =>
    post(daemon, '/tasks/T-01/state', { state }, who);

  /** T-01, assigned to codex, through gate 1. */
  async function toAcknowledged(daemon: DaemonHandle): Promise<void> {
    await post(daemon, '/tasks', TASK, 'leader');
    await setState(daemon, 'assigned', 'leader');
    await post(daemon, '/tasks/T-01/ack', { restatement: 'build the log', ambiguities: [] }, 'codex');
  }

  /** …and on through gate 2 to the state acceptance is reached from. */
  async function toUnderReview(daemon: DaemonHandle): Promise<void> {
    await toAcknowledged(daemon);
    await setState(daemon, 'in_progress', 'codex');
    await post(daemon, '/tasks/T-01/submit', { critique: CRITIQUE, evidence: [] }, 'codex');
    await setState(daemon, 'submitted', 'codex');
    await setState(daemon, 'under_review', 'leader');
    expect(await stateOf(daemon, 'T-01')).toBe('under_review');
  }

  it('refuses a non-assignee moving a task to in_progress, and permits the assignee', async () => {
    await withDaemon(async (daemon) => {
      await toAcknowledged(daemon);

      const stranger = await setState(daemon, 'in_progress', 'cursor');
      expect(stranger.status).toBe(403);
      const { error } = await readJson<WireError>(stranger);
      expect(error).toMatchObject({ domain: 'protocol', code: 'NOT_TASK_AUTHORITY' });
      // Naming who may is the whole value of the refusal to the agent reading it.
      expect(error.message).toContain('codex');
      expect(await stateOf(daemon, 'T-01')).toBe('acknowledged');

      // The neighbouring permitted case. Without it the assertions above pass
      // against a guard that refuses everybody.
      expect((await setState(daemon, 'in_progress', 'codex')).status).toBe(201);
      expect(await stateOf(daemon, 'T-01')).toBe('in_progress');
    });
  });

  it('refuses the assignee opening review on its own task, and permits the leader', async () => {
    await withDaemon(async (daemon) => {
      await toAcknowledged(daemon);
      await setState(daemon, 'in_progress', 'codex');
      await post(daemon, '/tasks/T-01/submit', { critique: CRITIQUE, evidence: [] }, 'codex');
      await setState(daemon, 'submitted', 'codex');

      const assignee = await setState(daemon, 'under_review', 'codex');
      expect(assignee.status).toBe(403);
      const { error } = await readJson<WireError>(assignee);
      expect(error.code).toBe('NOT_TASK_AUTHORITY');
      expect(error.message).toContain('leader');
      expect(await stateOf(daemon, 'T-01')).toBe('submitted');

      expect((await setState(daemon, 'under_review', 'leader')).status).toBe(201);
      expect(await stateOf(daemon, 'T-01')).toBe('under_review');
    });
  });

  it('refuses a worker accepting under method: leader, and permits the leader', async () => {
    await withConfig(configWithAcceptance('leader'), async (daemon) => {
      await toUnderReview(daemon);

      const worker = await setState(daemon, 'accepted', 'codex');
      expect(worker.status).toBe(403);
      expect((await readJson<WireError>(worker)).error.code).toBe('NOT_TASK_AUTHORITY');
      expect(await stateOf(daemon, 'T-01')).toBe('under_review');

      expect((await setState(daemon, 'accepted', 'leader')).status).toBe(201);
      expect(await stateOf(daemon, 'T-01')).toBe('accepted');
    });
  });

  it('sends acceptance to @human under method: human — and then refuses the leader', async () => {
    await withConfig(configWithAcceptance('human', HUMAN_PARTICIPANT), async (daemon) => {
      await toUnderReview(daemon);

      // The pair that proves `policy.taskAcceptance.method` is read rather than
      // hard-coded: the same caller that may accept under `leader` may not here.
      const leader = await setState(daemon, 'accepted', 'leader');
      expect(leader.status).toBe(403);
      const { error } = await readJson<WireError>(leader);
      expect(error.code).toBe('NOT_TASK_AUTHORITY');
      expect(error.message).toContain('@human');
      expect(await stateOf(daemon, 'T-01')).toBe('under_review');

      expect((await setState(daemon, 'accepted', '@human')).status).toBe(201);
      expect(await stateOf(daemon, 'T-01')).toBe('accepted');
    });
  });

  it('refuses every participant under method: majority and names the decision route', async () => {
    await withConfig(configWithAcceptance('majority', HUMAN_PARTICIPANT), async (daemon) => {
      await toUnderReview(daemon);

      for (const who of ['leader', 'codex', '@human']) {
        const response = await setState(daemon, 'accepted', who);
        expect(response.status).toBe(403);
        const { error } = await readJson<WireError>(response);
        expect(error.code).toBe('NOT_TASK_AUTHORITY');
        // A majority names a decision, not a participant; the refusal has to
        // say where the decision is opened or it is a dead end.
        expect(error.message).toContain('POST /decisions');
      }
      expect(await stateOf(daemon, 'T-01')).toBe('under_review');
    });
  });

  it('stops an unrelated worker’s march from in_progress to merged at the first step', async () => {
    await withDaemon(async (daemon) => {
      await toAcknowledged(daemon);
      await setState(daemon, 'in_progress', 'codex');

      // The verified incident, replayed: `cursor` is neither the assignee nor
      // the leader and drove all of this before A6.
      const march = ['self_reviewed', 'submitted', 'under_review', 'resolving', 'accepted', 'merged'];
      const outcomes: { status: number; code: string }[] = [];
      for (const state of march) {
        const response = await setState(daemon, state, 'cursor');
        outcomes.push({ status: response.status, code: (await readJson<WireError>(response)).error.code });
      }

      expect(outcomes[0]).toEqual({ status: 403, code: 'NOT_TASK_AUTHORITY' });
      expect(outcomes).toHaveLength(6);
      expect(outcomes.every((outcome) => outcome.code === 'NOT_TASK_AUTHORITY')).toBe(true);
      expect(await stateOf(daemon, 'T-01')).toBe('in_progress');
    });
  });

  it('still reports ILLEGAL_TRANSITION when the caller has authority but the move is impossible', async () => {
    await withDaemon(async (daemon) => {
      await post(daemon, '/tasks', TASK, 'leader');

      // codex owns `in_progress`, so nothing here is a permission question —
      // legality and permission must not collapse into one another.
      const response = await setState(daemon, 'in_progress', 'codex');
      expect(response.status).toBe(409);
      expect((await readJson<WireError>(response)).error.code).toBe('ILLEGAL_TRANSITION');
    });
  });

  it('still 404s a state change on a task that does not exist', async () => {
    await withDaemon(async (daemon) => {
      const response = await post(daemon, '/tasks/T-99/state', { state: 'assigned' }, 'leader');
      expect(response.status).toBe(404);
      expect((await readJson<WireError>(response)).error.code).toBe('UNKNOWN_TASK');
    });
  });
});

describe('CT-8 an agent can find out who its token made it', () => {
  // Two sessions started in the repo root both authenticated as `leader` and
  // neither could detect it, because no tool echoed the resolved identity. The
  // envelope said `leader`; the message bodies said `metrics` and `skeleton`.
  it('tells the caller which identity its token resolved to', async () => {
    await withDaemon(async (daemon) => {
      const asCodex = await readJson<{ you: string }>(await get(daemon, '/roster', 'codex'));
      expect(asCodex.you).toBe('codex');
    });
  });

  it('answers differently for a different token', async () => {
    // The neighbouring case, and the one that matters: a hard-coded `leader`
    // would satisfy the test above while reproducing the exact bug.
    await withDaemon(async (daemon) => {
      const asLeader = await readJson<{ you: string }>(await get(daemon, '/roster', 'leader'));
      expect(asLeader.you).toBe('leader');
    });
  });

  it('carries the identity on every authenticated response, not just roster', async () => {
    // `roster` is the kickoff call, but an agent that starts elsewhere needs
    // the same answer. The header is what lets the MCP layer attach `you` to
    // every tool without each tool remembering to.
    await withDaemon(async (daemon) => {
      const board = await get(daemon, '/board', 'cursor');
      expect(board.headers.get('x-crosstalk-you')).toBe('cursor');
    });
  });
});

describe('CT-9 a participant running outside its declared workspace is told', () => {
  // `doctor` validates the config hard and never checks the process. Identity
  // is resolved by whichever `.mcp.json` the harness found from its working
  // directory, so a harness that relocates itself — Claude Code creates a
  // per-session worktree under `.claude/worktrees/<slug>` — silently
  // re-resolves to a different participant, or to none.
  // Encoded exactly as `DaemonClient` encodes it. Sending a raw path here
  // would pass regardless — an ASCII path decodes to itself — and would stop
  // pinning the contract the moment the client's encoding changed.
  const cwdHeader = (d: DaemonHandle, id: string, cwd: string): Promise<Response> =>
    fetch(`${d.url}/roster`, {
      headers: { ...auth(d, id), 'x-crosstalk-cwd': encodeURIComponent(cwd) },
    });

  /** Like `withDaemon`, but hands back the repo so a cwd can be built under it. */
  async function withRepoDaemon<T>(fn: (d: DaemonHandle, repo: string) => Promise<T>): Promise<T> {
    const repo = await tempRepo();
    const daemon = await startDaemon({ repo });
    try {
      return await fn(daemon, repo);
    } finally {
      await daemon.close();
    }
  }

  /**
   * Asserts 200 before reading the body, always.
   *
   * Without it these tests pass against a 500: an error body has no `warnings`
   * either, so every "stays quiet" case was green while the request was
   * failing outright. That is what hid an `ERR_INVALID_CHAR` from an em-dash in
   * a header value — three of four tests reported success on a broken route.
   */
  async function warningsFrom(response: Response): Promise<string[]> {
    expect(response.status).toBe(200);
    return (await readJson<{ warnings?: string[] }>(response)).warnings ?? [];
  }

  it('warns when the process is outside the declared workspace', async () => {
    await withRepoDaemon(async (daemon, repo) => {
      const strayed = join(repo, '.claude', 'worktrees', 'crosstalk-codex-setup-236158');
      const warnings = await warningsFrom(await cwdHeader(daemon, 'codex', strayed));

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('.crosstalk/worktrees/codex');
      expect(warnings[0]).toContain(strayed);
    });
  });

  it('stays quiet when the process is inside it', async () => {
    // The neighbouring case. A check that warned unconditionally would satisfy
    // the test above and make the warning worthless.
    await withRepoDaemon(async (daemon, repo) => {
      const home = join(repo, '.crosstalk', 'worktrees', 'codex');
      expect(await warningsFrom(await cwdHeader(daemon, 'codex', home))).toEqual([]);
    });
  });

  it('stays quiet for a subdirectory of the workspace', async () => {
    await withRepoDaemon(async (daemon, repo) => {
      const nested = join(repo, '.crosstalk', 'worktrees', 'codex', 'src', 'deep');
      expect(await warningsFrom(await cwdHeader(daemon, 'codex', nested))).toEqual([]);
    });
  });

  it('says nothing at all when no cwd was reported', async () => {
    // The CLI resolves identity from --as against a token file and never from
    // the working directory, so it has no cwd to report and nothing to warn
    // about. Absence must not read as a violation.
    await withDaemon(async (daemon) => {
      expect(await warningsFrom(await get(daemon, '/roster', 'codex'))).toEqual([]);
    });
  });
});

describe('CT-7 a probe does not make an agent look live', () => {
  interface Roster {
    participants: { id: string; status: string }[];
  }
  const statusOf = (r: Roster, id: string): string =>
    r.participants.find((p) => p.id === id)!.status;

  it('reports a participant that has never spoken as offline', async () => {
    await withDaemon(async (daemon) => {
      const r = await readJson<Roster>(await get(daemon, '/roster', 'leader'));
      expect(statusOf(r, 'cursor')).toBe('offline');
    });
  });

  it('reports it active right after it speaks', async () => {
    // The neighbouring case: expiry must not mean "always offline".
    await withDaemon(async (daemon) => {
      await get(daemon, '/board', 'cursor');
      const r = await readJson<Roster>(await get(daemon, '/roster', 'leader'));
      expect(statusOf(r, 'cursor')).toBe('active');
    });
  });
});

describe('CT-9 the cwd header survives a path that is not Latin-1', () => {
  it('warns about a directory with an accent in its name', async () => {
    // Header values are Latin-1. An unencoded path like this throws inside
    // `fetch` and takes every tool call with it, so the round trip is the
    // thing under test, not the warning.
    const repo = await tempRepo();
    const daemon = await startDaemon({ repo });
    try {
      const strayed = join(repo, '.claude', 'wörktrees', 'café');
      const response = await fetch(`${daemon.url}/roster`, {
        headers: { ...auth(daemon, 'codex'), 'x-crosstalk-cwd': encodeURIComponent(strayed) },
      });

      expect(response.status).toBe(200);
      const warnings = (await readJson<{ warnings?: string[] }>(response)).warnings ?? [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(strayed);
    } finally {
      await daemon.close();
    }
  });
});
