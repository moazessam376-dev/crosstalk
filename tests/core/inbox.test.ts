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
    expect(inbox.job).toBeUndefined();
  });

  it('keeps the @human #floor job after the card is read, and does not say idle', () => {
    const job = '# Quorum\n\nHide resolved rows. The header shows a resolved count.';
    let state = project([]);
    state = applyEvent(state, message({ seq: 1, from: '@human', body: job }));
    state = applyEvent(state, message({ seq: 2, from: 'leader', body: 'cutting tasks' }));

    const builder = renderInbox({ who: 'codex', role: 'worker', unread: [], state });
    expect(builder.job).toBe(job);
    expect(builder.next).toBe('job on #floor — start');
    expect(builder.unread).toEqual([]);

    const lead = renderInbox({ who: 'leader', role: 'leader', unread: [], state });
    expect(lead.job).toBe(job);
    expect(lead.next).toBe('cut tasks from #floor');
  });

  it('does not treat a teammate #floor post as the job', () => {
    let state = project([]);
    state = applyEvent(state, message({ seq: 1, from: 'leader', body: 'not the job' }));
    const inbox = renderInbox({ who: 'codex', role: 'worker', unread: [], state });
    expect(inbox.job).toBeUndefined();
    expect(inbox.next).toBe('idle');
  });

  it('tells the leader to accept a submitted task', () => {
    const job = 'Build Quorum';
    let state = project([]);
    state = applyEvent(state, message({ seq: 1, from: '@human', body: job }));
    state = applyEvent(state, {
      kind: 'task_created',
      seq: 2,
      ts: '2026-08-30T00:00:00.000Z',
      from: 'leader',
      room: 'task:T-01',
      task: {
        id: 'T-01',
        title: 'Wire seed',
        brief: 'do it',
        specRefs: [],
        assignee: 'codex',
        deps: [],
        acceptance: [],
        state: 'submitted',
        branch: 'main',
      },
    });
    const lead = renderInbox({ who: 'leader', role: 'leader', unread: [], state });
    expect(lead.job).toBe(job);
    expect(lead.next).toBe('T-01 is submitted — accept');

    const builder = renderInbox({ who: 'codex', role: 'worker', unread: [], state });
    expect(builder.next).toBe('job on #floor — start');
  });

  it('prefers an assigned task over the floor job for next', () => {
    const job = 'Build Quorum';
    let state = project([]);
    state = applyEvent(state, message({ seq: 1, from: '@human', body: job }));
    state = applyEvent(state, {
      kind: 'task_created',
      seq: 2,
      ts: '2026-08-30T00:00:00.000Z',
      from: 'leader',
      room: 'task:T-01',
      task: {
        id: 'T-01',
        title: 'Wire seed',
        brief: 'do it',
        specRefs: [],
        assignee: 'codex',
        deps: [],
        acceptance: [],
        state: 'assigned',
        branch: 'main',
      },
    });
    const inbox = renderInbox({ who: 'codex', role: 'worker', unread: [], state });
    expect(inbox.job).toBe(job);
    expect(inbox.next).toBe('T-01 is assigned to you');
  });
});
