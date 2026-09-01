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

  it('stays idle for a builder who only has a #floor card and no task', () => {
    const job = '# Quorum\n\nHide resolved rows.';
    let state = project([]);
    state = applyEvent(state, message({ seq: 1, from: '@human', body: job }));
    const inbox = renderInbox({
      who: 'codex',
      role: 'worker',
      unread: [message({ seq: 1, from: '@human', body: job })],
      state,
    });
    expect(inbox.job).toBeUndefined();
    expect(inbox.next).toBe('idle');
    expect(inbox.unread[0]?.kind).toBe('said');
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

  it('keeps the @human #floor job on the leader after the card is read', () => {
    const job = '# Quorum\n\nHide resolved rows. The header shows a resolved count.';
    let state = project([]);
    state = applyEvent(state, message({ seq: 1, from: '@human', body: job }));
    state = applyEvent(state, message({ seq: 2, from: 'leader', body: 'cutting tasks' }));

    const lead = renderInbox({ who: 'leader', role: 'leader', unread: [], state });
    expect(lead.job).toBe(job);
    expect(lead.next).toBe('cut tasks from #floor');

    // Neighbouring seat: a builder without a task must not receive the novel.
    // First-edit ceremony is the builder's intake; dumping JOB.md here is why
    // solo won loops 1–4 on tokens before first code edit.
    const builder = renderInbox({ who: 'codex', role: 'worker', unread: [], state });
    expect(builder.job).toBeUndefined();
    expect(builder.next).toBe('idle');
    expect(builder.unread).toEqual([]);
  });

  it('hands a builder the assigned task brief, not the floor job', () => {
    const floor = '# Quorum\n\n' + 'Hide resolved. '.repeat(40);
    const brief = 'App() loads API seed. Do not change the empty-props render() test.';
    let state = project([]);
    state = applyEvent(state, message({ seq: 1, from: '@human', body: floor }));
    state = applyEvent(state, {
      kind: 'task_created',
      seq: 2,
      ts: '2026-08-30T00:00:00.000Z',
      from: 'leader',
      room: 'task:T-01',
      task: {
        id: 'T-01',
        title: 'Wire seed',
        brief,
        specRefs: [],
        assignee: 'codex',
        deps: [],
        acceptance: [],
        state: 'assigned',
        branch: 'main',
      },
    });

    const inbox = renderInbox({ who: 'codex', role: 'worker', unread: [], state });
    expect(inbox.job).toContain('T-01');
    expect(inbox.job).toContain(brief);
    expect(inbox.job).not.toContain(floor);
    expect(inbox.next).toBe('T-01 is assigned to you');

    const lead = renderInbox({ who: 'leader', role: 'leader', unread: [], state });
    expect(lead.job).toBe(floor);
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
    expect(builder.job).toBeUndefined();
    expect(builder.next).toBe('idle');
  });

  it('does not tell the leader to cut more tasks after the job is tasked', () => {
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
        state: 'accepted',
        branch: 'main',
      },
    });
    const lead = renderInbox({
      who: 'leader',
      role: 'leader',
      unread: [
        {
          kind: 'claim_raised',
          seq: 3,
          ts: '2026-08-30T00:00:00.000Z',
          from: 'critic',
          room: 'dispute:C-1',
          claim: {
            id: 'C-1',
            raisedBy: 'critic',
            against: 'leader',
            target: 'JOB.md:19',
            assertion: 'contradiction',
            severity: 'defect',
            falsifier: 'x',
            evidence: [],
            state: 'open',
            rounds: 0,
          },
        },
      ],
      state,
    });
    expect(lead.job).toBe(job);
    expect(lead.next).toBe('idle');
  });

  it('does not treat a teammate task as the builder job', () => {
    let state = project([]);
    state = applyEvent(state, message({ seq: 1, from: '@human', body: 'Build Quorum' }));
    state = applyEvent(state, {
      kind: 'task_created',
      seq: 2,
      ts: '2026-08-30T00:00:00.000Z',
      from: 'leader',
      room: 'task:T-01',
      task: {
        id: 'T-01',
        title: 'Wire seed',
        brief: 'secret brief for the assignee only',
        specRefs: [],
        assignee: 'cursor',
        deps: [],
        acceptance: [],
        state: 'assigned',
        branch: 'main',
      },
    });
    const inbox = renderInbox({ who: 'codex', role: 'worker', unread: [], state });
    expect(inbox.job).toBeUndefined();
    expect(inbox.next).toBe('idle');
    expect(inbox.mine).toEqual([]);
  });
});
