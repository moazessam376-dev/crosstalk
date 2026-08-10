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
  against: 'codex',
  target: 'src/economy.ts:41',
  assertion: 'The staffing coefficient is applied twice',
  severity: 'defect',
  falsifier: 'If it were applied once, produce() and consume() would reference different multipliers',
  evidence: [EVIDENCE],
};

describe('mcp tools against a real daemon', () => {
  it('raises a claim and derives raisedBy from the token rather than the payload', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('leader'), 'raise_claim', { ...CLAIM });

      expect(result.isError).toBeUndefined();
      const events = (payload(result) as { events: CrosstalkEvent[] }).events;
      const raised = events.find((event) => event.kind === 'claim_raised');
      if (raised?.kind !== 'claim_raised') throw new Error('no claim_raised in the response');

      expect(raised.claim.raisedBy).toBe('leader');
      expect(raised.from).toBe('leader');
      // The evidence author is derived too — the client never sends `by`.
      expect(raised.claim.evidence[0]?.by).toBe('leader');
    });
  });

  it('surfaces MISSING_FALSIFIER as an error an agent can act on', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('leader'), 'raise_claim', { ...CLAIM, falsifier: '' });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('MISSING_FALSIFIER');
      expect(text(result)).toContain('falsifier');
    });
  });

  it('surfaces VACUOUS_FALSIFIER, so a placeholder is refused as loudly as an empty one', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('leader'), 'raise_claim', {
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
      await callTool(leader, 'raise_claim', { ...CLAIM });

      const contested = await callTool(f.as('codex'), 'respond_to_claim', {
        claimId: 'C-1',
        verdict: 'contest',
        rationale: 'Both sites read the same coefficient but apply it to different quantities.',
        falsifier: 'If they were the same quantity, the two call sites would pass identical arguments',
        evidence: [{ kind: 'command', command: 'npm test -- economy', output: '0 failed', sha: 'def5678' }],
      });
      expect(contested.isError).toBeUndefined();

      // The same evidence the claim already carries. `uphold` restates a claim
      // whose falsifier is on the record, so it needs new evidence — not a
      // new falsifier, and not more conviction.
      const stale = await callTool(leader, 'respond_to_claim', {
        claimId: 'C-1',
        verdict: 'uphold',
        rationale: 'Still stands.',
        evidence: [EVIDENCE],
      });

      expect(stale.isError).toBe(true);
      expect(text(stale)).toContain('UPHOLD_WITHOUT_NEW_EVIDENCE');

      // The neighbouring case that must stay legal: new evidence, no falsifier.
      const upheld = await callTool(leader, 'respond_to_claim', {
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
      const opened = await callTool(leader, 'open_decision', {
        question: 'Do we ship the daemon before the CLI?',
        options: ['yes', 'no'],
        voters: ['leader'],
        method: 'majority',
      });
      expect(opened.isError).toBeUndefined();

      const voted = await callTool(leader, 'vote', {
        decisionId: 'D-1',
        option: 'yes',
        rationale: 'The CLI has nothing to talk to until the daemon exists.',
      });

      expect(voted.isError).toBeUndefined();
      // An agent that reads only the first event never learns the decision closed.
      expect(kinds(voted)).toEqual(['vote_cast', 'decision_resolved']);
    });
  });

  it('acknowledges a task and moves it through gate 1 in one call', async () => {
    await withDaemon(async (f) => {
      const leader = f.as('leader');
      await callTool(leader, 'create_task', {
        id: 'T-01',
        title: 'Build the MCP server',
        brief: 'Tier 1 transport.',
        specRefs: ['§6.2'],
        assignee: 'codex',
        deps: [],
        acceptance: ['tools listed'],
        branch: 'track-h/mcp',
      });
      await callTool(leader, 'set_task_state', { taskId: 'T-01', state: 'assigned' });


      const acked = await callTool(f.as('codex'), 'ack_task', {
        taskId: 'T-01',
        restatement: 'Build a stdio MCP server whose tool schemas teach the protocol.',
        ambiguities: ['Whether submit_task is in scope given the contract calls the route blocked'],
      });

      expect(acked.isError).toBeUndefined();
      // The daemon prepends `participant_joined` on a participant's first
      // authenticated request, and this is codex's — surfaced, not dropped,
      // because an agent that never sees its own join cannot tell whether the
      // roster knows about it. Gate 1's two events are the tail.
      expect(kinds(acked)).toContain('participant_joined');
      expect(kinds(acked).slice(-2)).toEqual(['brief_ack', 'task_state']);
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

      const result = await callTool(leader, 'set_task_state', { taskId: 'T-02', state: 'merged' });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('ILLEGAL_TRANSITION');
    });
  });

  it('reads a room whose id contains a "#", which an unencoded path would drop', async () => {
    await withDaemon(async (f) => {
      const leader = f.as('leader');
      await callTool(leader, 'say', { room: '#floor', body: 'pushed at 9911aaa' });

      const result = await callTool(f.as('codex'), 'read_events', { room: '#floor' });

      expect(result.isError).toBeUndefined();
      const events = (payload(result) as { events: CrosstalkEvent[] }).events;
      expect(events.map((event) => event.kind)).toContain('message');
      expect(events.every((event) => event.room === '#floor')).toBe(true);
    });
  });

  it('encodes room ids rather than pasting them into a path', () => {
    expect(roomPath('#floor')).toBe('/rooms/%23floor/events');
    expect(roomPath('dispute:C-118')).toBe('/rooms/dispute%3AC-118/events');
  });

  it('treats `since` as exclusive, so paging cannot re-read or skip an event', async () => {
    await withDaemon(async (f) => {
      const leader = f.as('leader');
      await callTool(leader, 'say', { room: '#floor', body: 'one' });
      await callTool(leader, 'say', { room: '#floor', body: 'two' });

      const all = payload(await callTool(leader, 'read_events', {})) as {
        events: CrosstalkEvent[];
        lastSeq: number;
      };
      const next = payload(await callTool(leader, 'read_events', { since: all.lastSeq })) as {
        events: CrosstalkEvent[];
      };

      expect(all.events.length).toBeGreaterThan(0);
      // Inclusive `since` would hand back the last event a second time.
      expect(next.events).toEqual([]);

      const fromFirst = payload(await callTool(leader, 'read_events', { since: 1 })) as {
        events: CrosstalkEvent[];
      };
      expect(fromFirst.events.map((event) => event.seq)).not.toContain(1);
      expect(fromFirst.events[0]?.seq).toBe(2);
    });
  });

  it('await_turn returns idle when nothing addresses the caller', async () => {
    await withDaemon(async (f) => {
      const result = await callTool(f.as('codex'), 'await_turn', { timeout_s: 1 });

      expect(result.isError).toBeUndefined();
      expect(payload(result)).toEqual({ idle: true });
    });
  });

  // Added because a mutation survived: setting await_turn's `since` to
  // undefined broke nothing, so nothing was testing that it reached the server.
  // The daemon tracks a per-participant delivered mark, which makes the default
  // path and the explicit path look identical until you re-read something you
  // have already consumed.
  it('forwards await_turn\'s `since`, so a caller can re-read what it already consumed', async () => {
    await withDaemon(async (f) => {
      const codex = f.as('codex');
      await callTool(f.as('leader'), 'say', { room: '#floor', body: 'review posted' });

      const first = payload(await callTool(codex, 'await_turn', { timeout_s: 5 })) as {
        events: CrosstalkEvent[];
      };
      expect(first.events.length).toBeGreaterThan(0);

      // The delivered mark has advanced, so the default path now has nothing.
      expect(payload(await callTool(codex, 'await_turn', { timeout_s: 1 }))).toEqual({ idle: true });

      // ...but an explicit `since` must override that mark. Without it being
      // forwarded, this is idle too and the test cannot tell the difference.
      const replayed = payload(await callTool(codex, 'await_turn', { timeout_s: 1, since: 0 })) as {
        events: CrosstalkEvent[];
      };
      expect(replayed.events.some((event) => event.kind === 'message' && event.body === 'review posted')).toBe(
        true,
      );
    });
  });

  it('await_turn wakes on another participant speaking, and not on the caller itself', async () => {
    await withDaemon(async (f) => {
      const codex = f.as('codex');
      const leader = f.as('leader');

      // Join first, so the wait starts from a known delivered mark.
      await callTool(codex, 'await_turn', { timeout_s: 1 });

      const waiting = callTool(codex, 'await_turn', { timeout_s: 20 });
      // The caller's own write must not resolve its own wait — a loop that
      // wakes on your own events looks like progress and is not.
      await callTool(codex, 'say', { room: '#floor', body: 'still working' });
      await callTool(leader, 'say', { room: '#floor', body: 'review posted' });

      const result = await waiting;
      const events = (payload(result) as { events: CrosstalkEvent[] }).events;

      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.from !== 'codex')).toBe(true);
      expect(events.some((event) => event.kind === 'message' && event.body === 'review posted')).toBe(true);
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
      // Not "request failed": the message names the route that would have worked.
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
      expect(text(result)).toContain('raise_claim');
    });
  });

  it('reads the roster and the board', async () => {
    await withDaemon(async (f) => {
      const roster = payload(await callTool(f.as('leader'), 'roster', {})) as {
        participants: { id: string; model?: string }[];
      };
      expect(roster.participants.map((p) => p.id)).toContain('codex');

      const board = payload(await callTool(f.as('leader'), 'board', {})) as { tasks: unknown[] };
      expect(Array.isArray(board.tasks)).toBe(true);
      // board is metadata only — a body key anywhere makes it a firehose.
      expect(JSON.stringify(board)).not.toContain('"body"');
    });
  });

  it('returns the caller\'s own tasks only', async () => {
    await withDaemon(async (f) => {
      await f.as('leader').post('/tasks', {
        id: 'T-09',
        title: 'x',
        brief: 'y',
        specRefs: [],
        assignee: 'codex',
        deps: [],
        acceptance: ['z'],
        branch: 'b',
      });

      const mine = payload(await callTool(f.as('codex'), 'my_tasks', {})) as { tasks: { id: string }[] };
      const leaders = payload(await callTool(f.as('leader'), 'my_tasks', {})) as { tasks: { id: string }[] };

      expect(mine.tasks.map((t) => t.id)).toContain('T-09');
      expect(leaders.tasks.map((t) => t.id)).not.toContain('T-09');
    });
  });
});
