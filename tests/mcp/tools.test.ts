import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/server.js';
import { DaemonClient, DaemonRequestError, roomPath } from '../../src/mcp/client.js';
import { callTool, type ToolResult } from '../../src/mcp/server.js';

/**
 * Every test here runs against a real daemon on an ephemeral port.
 *
 * A mocked HTTP layer would have agreed with whatever this client happened to
 * send — including an unencoded `#floor`, which produces an empty path and a
 * fragment the server never sees, and a `since` off by one, which silently
 * re-delivers an event on every reconnect. Neither is visible from inside a
 * mock, and both are in the contract because they were nearly shipped.
 */
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
`;

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ct-mcp-'));
  await writeFile(join(dir, 'crosstalk.yaml'), CONFIG, 'utf8');
  await mkdir(join(dir, '.crosstalk'), { recursive: true });
  return dir;
}

interface Fixture {
  daemon: DaemonHandle;
  repo: string;
  as(id: string): DaemonClient;
}

async function withDaemon<T>(fn: (f: Fixture) => Promise<T>): Promise<T> {
  const repo = await tempRepo();
  const daemon = await startDaemon({ repo });
  try {
    return await fn({
      daemon,
      repo,
      as: (id) => new DaemonClient(daemon.url, daemon.tokens.get(id)!),
    });
  } finally {
    await daemon.close();
  }
}

function payload(result: ToolResult): unknown {
  return JSON.parse(result.content[0]!.text);
}

function text(result: ToolResult): string {
  return result.content[0]!.text;
}

function kinds(result: ToolResult): string[] {
  return (payload(result) as { events: CrosstalkEvent[] }).events.map((event) => event.kind);
}

const EVIDENCE = {
  kind: 'command',
  command: 'npx vitest run tests/core/economy.test.ts',
  output: '1 failed',
  sha: 'abc1234',
};

const CLAIM = {
  kind: 'raise' as const,
  against: 'codex',
  target: 'src/economy.ts:41',
  assertion: 'The staffing coefficient is applied twice',
  severity: 'defect',
  falsifier: 'If it were applied once, produce() and consume() would reference different multipliers',
  evidence: [EVIDENCE],
};

/**
 * The tool envelope minus `warnings`, which is a fact about where this test
 * process happens to be running rather than about the tool.
 */
function shapeOf(result: ToolResult): { rest: Record<string, unknown>; warnings: unknown } {
  const { warnings, ...rest } = payload(result) as Record<string, unknown>;
  return { rest, warnings };
}

describe('mcp tools against a real daemon', () => {
  it('raises a claim and derives raisedBy from the token rather than the payload', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('leader'), 'claim', { ...CLAIM });

      expect(result.isError).toBeUndefined();
      const events = (payload(result) as { events: CrosstalkEvent[] }).events;
      const raised = events.find((event) => event.kind === 'claim_raised');
      if (raised?.kind !== 'claim_raised') throw new Error('no claim_raised in the response');

      expect(raised.claim.raisedBy).toBe('leader');
      expect(raised.from).toBe('leader');
      expect(raised.claim.evidence[0]?.by).toBe('leader');
    });
  });

  it('surfaces MISSING_FALSIFIER as an error an agent can act on', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('leader'), 'claim', { ...CLAIM, falsifier: '' });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('MISSING_FALSIFIER');
      expect(text(result)).toContain('falsifier');
    });
  });

  it('surfaces VACUOUS_FALSIFIER, so a placeholder is refused as loudly as an empty one', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('leader'), 'claim', {
        ...CLAIM,
        falsifier: 'if it did not work I would see it fail',
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('VACUOUS_FALSIFIER');
    });
  });

  it('refuses an uphold that carries no new evidence, and says why', async () => {
    await withDaemon(async (f) => {
      const leader = f.as('leader');
      await callTool(leader, 'claim', { ...CLAIM });

      const contested = await callTool(f.as('codex'), 'claim', {
        kind: 'respond',
        claimId: 'C-1',
        verdict: 'contest',
        rationale: 'Both sites read the same coefficient but apply it to different quantities.',
        falsifier: 'If they were the same quantity, the two call sites would pass identical arguments',
        evidence: [{ kind: 'command', command: 'npm test -- economy', output: '0 failed', sha: 'def5678' }],
      });
      expect(contested.isError).toBeUndefined();

      const stale = await callTool(leader, 'claim', {
        kind: 'respond',
        claimId: 'C-1',
        verdict: 'uphold',
        rationale: 'Still stands.',
        evidence: [EVIDENCE],
      });

      expect(stale.isError).toBe(true);
      expect(text(stale)).toContain('UPHOLD_WITHOUT_NEW_EVIDENCE');

      const upheld = await callTool(leader, 'claim', {
        kind: 'respond',
        claimId: 'C-1',
        verdict: 'uphold',
        rationale: 'Narrowing the defect.',
        evidence: [{ kind: 'command', command: 'node probe.js', output: 'x2', sha: '9911aaa' }],
      });

      expect(upheld.isError).toBeUndefined();
      expect(kinds(upheld)).toContain('claim_response');
    });
  });

  it('returns every event a write appends, not just the first', async () => {
    await withDaemon(async (f) => {
      const leader = f.as('leader');
      const opened = await callTool(leader, 'claim', {
        kind: 'open',
        question: 'Do we ship the daemon before the CLI?',
        options: ['yes', 'no'],
        voters: ['leader'],
        method: 'majority',
      });
      expect(opened.isError).toBeUndefined();

      const voted = await callTool(leader, 'claim', {
        kind: 'vote',
        decisionId: 'D-1',
        option: 'yes',
        rationale: 'The CLI has nothing to talk to until the daemon exists.',
      });

      expect(voted.isError).toBeUndefined();
      expect(kinds(voted)).toEqual(['vote_cast', 'decision_resolved']);
    });
  });

  it('assigns in one act and acknowledges through gate 1 in one call', async () => {
    await withDaemon(async (f) => {
      const assigned = await callTool(f.as('leader'), 'act', {
        kind: 'assign',
        id: 'T-01',
        title: 'Build the MCP server',
        brief: 'Tier 1 transport.',
        specRefs: ['§6.2'],
        assignee: 'codex',
        deps: [],
        acceptance: ['tools listed'],
        branch: 'track-h/mcp',
      });
      expect(assigned.isError).toBeUndefined();
      expect(kinds(assigned)).toEqual(expect.arrayContaining(['task_created', 'task_state']));

      const acked = await callTool(f.as('codex'), 'act', {
        kind: 'ack',
        taskId: 'T-01',
        restatement: 'Build a stdio MCP server whose tool schemas teach the protocol.',
      });

      expect(acked.isError).toBeUndefined();
      expect(kinds(acked)).toContain('participant_joined');
      expect(kinds(acked).slice(-2)).toEqual(['brief_ack', 'task_state']);
    });
  });

  it('refuses a worker calling act.assign', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('codex'), 'act', {
        kind: 'assign',
        id: 'T-99',
        title: 'Nope',
        brief: 'Not yours.',
        assignee: 'codex',
        branch: 'ct/nope',
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('NOT_TASK_AUTHORITY');
    });
  });

  it('refuses act.done without a critique record, and submits with one', async () => {
    await withDaemon(async (f) => {
      await callTool(f.as('leader'), 'act', {
        kind: 'assign',
        id: 'T-03',
        title: 'Ship it',
        brief: 'Done.',
        assignee: 'codex',
        branch: 'ct/T-03',
      });
      await callTool(f.as('codex'), 'act', {
        kind: 'ack',
        taskId: 'T-03',
        restatement: 'Ship it',
      });
      await f.as('codex').post('/tasks/T-03/state', { state: 'in_progress' });

      // Gate 2 is authored, never fabricated: the server used to invent
      // `{rounds: 1, critic: 'self', findings: []}` on omission, which made the
      // gate a rubber stamp for the agent that said nothing.
      const silent = await callTool(f.as('codex'), 'act', { kind: 'done', taskId: 'T-03' });
      expect(silent.isError).toBe(true);
      expect(text(silent)).toContain('GATE_NOT_SELF_REVIEWED');

      const done = await callTool(f.as('codex'), 'act', {
        kind: 'done',
        taskId: 'T-03',
        critique: { rounds: 1, critic: 'self', findings: [] },
      });
      expect(done.isError).toBeUndefined();
      expect(kinds(done)).toEqual(expect.arrayContaining(['self_review', 'task_state']));

      const inbox = payload(await callTool(f.as('codex'), 'inbox', { wait: false })) as {
        mine: { id: string; state: string }[];
      };
      expect(inbox.mine.find((task) => task.id === 'T-03')?.state).toBe('submitted');
    });
  });

  it('lets the leader accept a submitted task and refuses a worker', async () => {
    await withDaemon(async (f) => {
      await callTool(f.as('leader'), 'act', {
        kind: 'assign',
        id: 'T-04',
        title: 'Ship it',
        brief: 'Done.',
        assignee: 'codex',
        branch: 'ct/T-04',
      });
      await callTool(f.as('codex'), 'act', {
        kind: 'ack',
        taskId: 'T-04',
        restatement: 'Ship it',
      });
      await f.as('codex').post('/tasks/T-04/state', { state: 'in_progress' });
      await callTool(f.as('codex'), 'act', {
        kind: 'done',
        taskId: 'T-04',
        critique: { rounds: 1, critic: 'self', findings: [] },
      });

      const waiting = payload(await callTool(f.as('leader'), 'inbox', { wait: false })) as { next?: string };
      expect(waiting.next).toBe('T-04 is submitted — accept');

      const worker = await callTool(f.as('codex'), 'act', { kind: 'accept', taskId: 'T-04' });
      expect(worker.isError).toBe(true);
      expect(text(worker)).toContain('NOT_TASK_AUTHORITY');

      const accepted = await callTool(f.as('leader'), 'act', { kind: 'accept', taskId: 'T-04' });
      expect(accepted.isError).toBeUndefined();
      const inbox = payload(await callTool(f.as('leader'), 'inbox', { wait: false })) as {
        next?: string;
        mine: { id: string; state: string }[];
      };
      expect(inbox.next).not.toBe('T-04 is submitted — accept');
    });
  });

  it('refuses a task transition the table forbids instead of applying it', async () => {
    await withDaemon(async (f) => {
      const leader = f.as('leader');
      await leader.post('/tasks', {
        id: 'T-02',
        title: 'x',
        brief: 'y',
        specRefs: [],
        assignee: 'codex',
        deps: [],
        acceptance: ['z'],
        branch: 'b',
      });

      const error = await leader
        .post('/tasks/T-02/state', { state: 'merged' })
        .then(() => undefined)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DaemonRequestError);
      expect((error as DaemonRequestError).code).toBe('ILLEGAL_TRANSITION');
    });
  });

  it('encodes room ids rather than pasting them into a path', () => {
    expect(roomPath('#floor')).toBe('/rooms/%23floor/events');
    expect(roomPath('dispute:C-118')).toBe('/rooms/dispute%3AC-118/events');
  });

  it('treats inbox since as exclusive, so paging cannot re-read or skip an event', async () => {
    await withDaemon(async (f) => {
      const leader = f.as('leader');
      const codex = f.as('codex');
      await callTool(leader, 'say', { room: '#floor', body: 'one' });
      await callTool(leader, 'say', { room: '#floor', body: 'two' });

      const all = payload(await callTool(codex, 'inbox', { wait: false, since: 0 })) as {
        unread: { seq: number }[];
      };
      expect(all.unread.length).toBeGreaterThan(0);
      const last = all.unread[all.unread.length - 1]!.seq;
      const next = payload(await callTool(codex, 'inbox', { wait: false, since: last })) as {
        unread: { seq: number }[];
      };

      expect(next.unread).toEqual([]);
    });
  });

  it('inbox returns idle when nothing addresses the caller', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('codex'), 'inbox', { timeout_s: 1, wait: false });

      expect(result.isError).toBeUndefined();
      const { rest, warnings } = shapeOf(result);
      expect(rest['you']).toBe('codex');
      expect(rest['next']).toBe('idle');
      expect(rest['unread']).toEqual([]);
      expect(warnings).toBeDefined();
    });
  });

  it('forwards inbox `since`, so a caller can re-read what it already consumed', async () => {
    await withDaemon(async (f) => {
      const codex = f.as('codex');
      await callTool(f.as('leader'), 'say', { room: '#floor', body: 'review posted' });

      const first = payload(await callTool(codex, 'inbox', { timeout_s: 5 })) as {
        unread: { kind: string; summary: string }[];
      };
      expect(first.unread.length).toBeGreaterThan(0);

      expect(shapeOf(await callTool(codex, 'inbox', { timeout_s: 1, wait: false })).rest['next']).toBe('idle');

      const replayed = payload(await callTool(codex, 'inbox', { timeout_s: 1, since: 0 })) as {
        unread: { kind: string; summary: string }[];
      };
      expect(replayed.unread.some((card) => card.kind === 'said' && card.summary === 'review posted')).toBe(true);
    });
  });

  it('inbox wakes on another participant speaking, and not on the caller itself', async () => {
    await withDaemon(async (f) => {
      const codex = f.as('codex');
      const leader = f.as('leader');

      await callTool(codex, 'inbox', { timeout_s: 1, wait: false });

      const waiting = callTool(codex, 'inbox', { timeout_s: 20 });
      await callTool(codex, 'say', { room: '#floor', body: 'still working' });
      await callTool(leader, 'say', { room: '#floor', body: 'review posted' });

      const result = await waiting;
      const unread = (payload(result) as { unread: { from: string; summary: string }[] }).unread;

      expect(unread.length).toBeGreaterThan(0);
      expect(unread.every((card) => card.from !== 'codex')).toBe(true);
      expect(unread.some((card) => card.summary === 'review posted')).toBe(true);
    });
  });

  it('passes the daemon\'s wrong-door message through with the right route named', async () => {
    await withDaemon(async (f) => {
      const error = await f
        .as('leader')
        .post('/events', { kind: 'claim_raised', room: '#floor' })
        .then(() => undefined)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DaemonRequestError);
      const failure = error as DaemonRequestError;
      expect(failure.code).toBe('EVENT_KIND_NOT_APPENDABLE');
      expect(failure.message).toContain('POST /claims');
    });
  });

  it('surfaces FROM_NOT_ALLOWED rather than letting an agent believe it spoke as someone else', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('codex'), 'say', {
        room: '#floor',
        body: 'this is the leader',
        from: 'leader',
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('FROM_NOT_ALLOWED');
    });
  });

  it('names the available tools when asked for one that does not exist', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('leader'), 'raise_a_claim', {});

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('claim');
      expect(text(result)).toContain('inbox');
    });
  });

  it('lists the caller and only the caller\'s tasks on inbox', async () => {
    await withDaemon(async (f) => {
      await callTool(f.as('leader'), 'act', {
        kind: 'assign',
        id: 'T-09',
        title: 'x',
        brief: 'y',
        assignee: 'codex',
        branch: 'b',
      });

      const mine = payload(await callTool(f.as('codex'), 'inbox', { wait: false })) as {
        you: string;
        mine: { id: string }[];
      };
      const leaders = payload(await callTool(f.as('leader'), 'inbox', { wait: false })) as {
        mine: { id: string }[];
      };

      expect(mine.you).toBe('codex');
      expect(mine.mine.map((task) => task.id)).toContain('T-09');
      expect(leaders.mine.map((task) => task.id)).not.toContain('T-09');
      expect(JSON.stringify(mine.mine)).not.toContain('"body"');
    });
  });
});
