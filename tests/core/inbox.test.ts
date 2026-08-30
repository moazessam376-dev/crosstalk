import { describe, expect, it } from 'vitest';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { Task } from '../../src/contracts/task.js';
import { applyEvent, project } from '../../src/core/projection.js';
import { cardFor, renderInbox } from '../../src/core/inbox.js';

function message(overrides: { seq: number; body: string; from?: string; room?: string }): CrosstalkEvent {
  return {
    kind: 'message',
    ts: '2026-08-30T00:00:00.000Z',
    from: overrides.from ?? 'leader',
    room: overrides.room ?? '#floor',
    seq: overrides.seq,
    body: overrides.body,
  };
}

describe('inbox cards', () => {
  it('turns a message into a said card and clips a long body', () => {
    const short = cardFor(message({ seq: 1, body: 'I took auth' }));
    expect(short).toMatchObject({ kind: 'said', from: 'leader', summary: 'I took auth', seq: 1 });

    const long = 'x'.repeat(400);
    const clipped = cardFor(message({ seq: 2, body: long }));
    expect(clipped.summary.length).toBeLessThanOrEqual(120);
    expect(clipped.summary).not.toBe(long);
    expect(clipped.summary.endsWith('…')).toBe(true);
  });

  it('names an assigned task without dumping the brief', () => {
    const event: CrosstalkEvent = {
      kind: 'task_created',
      seq: 3,
      ts: '2026-08-30T00:00:00.000Z',
      from: 'leader',
      room: 'task:T-04',
      task: {
        id: 'T-04',
        title: 'Wire the list',
        brief: 'A'.repeat(800),
        specRefs: [],
        assignee: 'codex',
        deps: [],
        acceptance: [],
        state: 'assigned',
        branch: 'ct/T-04',
      },
    };
    const card = cardFor(event);
    expect(card.kind).toBe('assigned');
    expect(card.summary).toContain('T-04');
    expect(card.summary).not.toContain('A'.repeat(200));
  });
});

describe('renderInbox', () => {
  it('lists only the caller\'s tasks as metadata', () => {
    let state = project([]);
    const mine: Task = {
      id: 'T-01',
      title: 'Mine',
      brief: 'do it',
      specRefs: [],
      assignee: 'codex',
      deps: [],
      acceptance: [],
      state: 'assigned',
      branch: 'ct/T-01',
    };
    const theirs: Task = { ...mine, id: 'T-02', assignee: 'cursor', title: 'Theirs' };
    state = applyEvent(state, {
      kind: 'task_created',
      seq: 1,
      ts: '2026-08-30T00:00:00.000Z',
      from: 'leader',
      room: 'task:T-01',
      task: mine,
    });
    state = applyEvent(state, {
      kind: 'task_created',
      seq: 2,
      ts: '2026-08-30T00:00:00.000Z',
      from: 'leader',
      room: 'task:T-02',
      task: theirs,
    });

    const inbox = renderInbox({
      who: 'codex',
      role: 'worker',
      unread: [],
      state,
    });

    expect(inbox.you).toBe('codex');
    expect(inbox.role).toBe('builder');
    expect(inbox.mine).toEqual([{ id: 'T-01', title: 'Mine', state: 'assigned' }]);
    expect(inbox.next).toBe('T-01 is assigned to you');
  });

  it('says idle when nothing addresses the caller', () => {
    const inbox = renderInbox({
      who: 'codex',
      role: 'worker',
      unread: [],
      state: project([]),
    });
    expect(inbox.next).toBe('idle');
    expect(inbox.unread).toEqual([]);
  });
});
