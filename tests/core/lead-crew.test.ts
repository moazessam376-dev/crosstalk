import { describe, expect, it } from 'vitest';

import { SHAPES, shapeNamed, type GateId } from '../../src/core/shape.js';
import { allTasksAccepted, phaseStatus } from '../../src/core/phase.js';
import type { Task } from '../../src/contracts/task.js';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { renderBrief } from '../../src/harness/brief.js';
import { DEFAULT_POLICY } from '../../src/contracts/config.js';
import { CLI_COMMANDS } from '../../src/cli/index.js';
import { TOOLS_BY_NAME } from '../../src/mcp/tools.js';

/**
 * The `lead-crew` shape: one lead, a crew it hires itself, every task checked.
 *
 * What is pinned here is the mechanism, not the prose. The lead cannot leave
 * plan with nobody hired; build cannot end while a task the lead has not
 * accepted exists; and the brief names only verbs that exist.
 */

const shape = shapeNamed('lead-crew')!;

function task(id: string, state: Task['state'], assignee = 'builder-1'): Task {
  return { id, title: id, brief: '', specRefs: [], assignee, deps: [], acceptance: [], state, branch: `ct/${id}` };
}

function gate(id: string, from: string, seq: number): CrosstalkEvent {
  return { seq, ts: new Date(seq * 1000).toISOString(), kind: 'message', from, room: '#floor', body: id, ref: `gate:${id}` };
}

const PLAN_MET = new Map<GateId, { met: boolean }>([['contract-exists', { met: true }], ['no-shared-files', { met: true }]]);

describe('the shape', () => {
  it('is registered and lays out only the lead: the crew is hired', () => {
    expect(SHAPES.has('lead-crew')).toBe(true);
    const crew = shape.seats.find((seat) => seat.role === 'worker')!;
    expect(crew.count).toBe(0);
    expect(crew.varies).toBe(true);
    expect(crew.hired).toBe(true);
  });

  it('gives builders no `plan` verb, so cross-review has nowhere to go', () => {
    expect(shape.seats.find((seat) => seat.role === 'worker')!.tags).not.toContain('plan');
    expect(shape.seats.find((seat) => seat.role === 'leader')!.tags).toContain('plan');
  });
});

describe('leaving plan', () => {
  const asked = [{ id: 'D-1', question: 'q', options: ['a'], voters: ['@human'], method: 'human' as const, votes: { '@human': 'a' }, outcome: 'a', currentRung: 0, ladder: [], rationale: [] }];

  it('holds until a builder is hired, however much else is done', () => {
    const without = phaseStatus(shape, {
      events: [gate('slices-posted', 'lead', 1)],
      participants: ['lead'],
      workspace: PLAN_MET,
      decisions: asked as never,
      roles: new Map([['lead', 'leader']]),
    });
    expect(without.id).toBe('plan');
    expect(without.blocking.join(' ')).toMatch(/crew-hired/);
    expect(without.blocking.join(' ')).not.toMatch(/operator-questioned|slices-posted|contract-exists/);

    const hired = phaseStatus(shape, {
      events: [gate('slices-posted', 'lead', 1)],
      participants: ['lead', 'builder-1'],
      workspace: PLAN_MET,
      decisions: asked as never,
      roles: new Map([['lead', 'leader'], ['builder-1', 'worker']]),
    });
    expect(hired.id).toBe('build');
  });
});

describe('leaving build', () => {
  const roles = new Map([['lead', 'leader'], ['builder-1', 'worker']] as const);
  const asked = [{ id: 'D-1', question: 'q', options: ['a'], voters: ['@human'], method: 'human' as const, votes: { '@human': 'a' }, outcome: 'a', currentRung: 0, ladder: [], rationale: [] }];
  const inBuild = (tasks: Task[]) =>
    phaseStatus(shape, {
      events: [gate('slices-posted', 'lead', 1)],
      participants: ['lead', 'builder-1'],
      workspace: PLAN_MET,
      decisions: asked as never,
      roles: roles as never,
      tasks,
    });

  it('is not vacuous: no tasks means nothing has been accepted', () => {
    expect(allTasksAccepted([])).toBe(false);
    expect(inBuild([]).id).toBe('build');
  });

  it('holds while any task is short of accepted, including a builder that said done', () => {
    for (const state of ['assigned', 'in_progress', 'submitted'] as const) {
      const status = inBuild([task('T-01', 'accepted'), task('T-02', state)]);
      expect(status.id, state).toBe('build');
      expect(status.blocking.join(' ')).toMatch(/tasks-accepted/);
    }
  });

  it('opens once the lead has accepted every task', () => {
    expect(inBuild([task('T-01', 'accepted'), task('T-02', 'merged')]).id).toBe('verify');
  });
});

describe('the briefs', () => {
  const policy = DEFAULT_POLICY;
  const descriptor = { key: 'claude-code-live', briefFile: 'CLAUDE.md', mcp: 'stdio' as const, supervisable: true };
  const render = (role: 'leader' | 'worker', id: string) =>
    renderBrief({ id, role, harness: 'claude-code-live', lifecycle: 'supervised', workspace: role === 'leader' ? '.' : `.crosstalk/worktrees/${id}` }, descriptor, policy, 'mcp', '/repo', 'lead-crew');

  it('name only act kinds the tool accepts', () => {
    const kinds = (TOOLS_BY_NAME.get('act')!.inputSchema.properties['kind'] as { enum: string[] }).enum;
    for (const brief of [render('leader', 'lead'), render('worker', 'builder-1')]) {
      for (const match of brief.matchAll(/act\(\{kind:"([a-z]+)"/g)) {
        expect(kinds, match[1]).toContain(match[1]);
      }
    }
  });

  it('tell the lead to commit the spec before hiring, and to release an accepted builder', () => {
    const lead = render('leader', 'lead');
    expect(lead).toMatch(/[Cc]ommit it to the main branch before you hire/);
    expect(lead).toMatch(/act\(\{kind:"hire"/);
    expect(lead).toMatch(/act\(\{kind:"release"/);
    expect(lead).toMatch(/act\(\{kind:"reject"/);
  });

  it('tell a builder that done is `act done` and that ending a turn with the task open is read as quiet', () => {
    const builder = render('worker', 'builder-1');
    expect(builder).toMatch(/act\(\{kind:"done"/);
    expect(builder).toMatch(/nudged/);
    expect(builder).toMatch(/Done means stop/);
  });

  it('name only CLI commands that exist, like every other brief', () => {
    for (const brief of [render('leader', 'lead'), render('worker', 'builder-1')]) {
      for (const match of brief.matchAll(/`crosstalk ([a-z]+)/g)) {
        expect(CLI_COMMANDS, match[1]).toContain(match[1]);
      }
    }
  });
});
