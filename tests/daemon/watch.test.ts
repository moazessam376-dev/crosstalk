import { describe, expect, it } from 'vitest';

import { ESCALATE_AFTER_MS, QUIET_AFTER_MS, renderWatchAction, watchSeats, type SeatWatch, type WatchMemory } from '../../src/daemon/watch.js';
import type { Task } from '../../src/contracts/task.js';

/**
 * The quiet-seat watchdog.
 *
 * The operator's long runs were mostly silence: a builder that ended its turn
 * with the task open, and a supervisor polling every twenty-five minutes to
 * find out. The rule under test is that the daemon notices from what it
 * already knows — presence says the turn ended, the projection says the task
 * is open — and says so once to the seat, then once to the lead.
 */

const MIN = 60_000;

function task(id: string, assignee: string, state: Task['state']): Task {
  return { id, title: id, brief: '', specRefs: [], assignee, deps: [], acceptance: [], state, branch: `ct/${id}` };
}

function seat(id: string, role: SeatWatch['role'], extra: Partial<SeatWatch> = {}): SeatWatch {
  return { id, role, ...extra };
}

describe('a builder that ended its turn with a task open', () => {
  it('is nudged once after the quiet threshold, not before', () => {
    const memory = new Map<string, WatchMemory>();
    const seats = [seat('lead', 'leader'), seat('b1', 'worker', { activity: { working: false, at: 0 }, running: true })];
    const tasks = [task('T-01', 'b1', 'in_progress')];

    expect(watchSeats({ now: QUIET_AFTER_MS - MIN, seats, tasks, memory })).toEqual([]);
    const first = watchSeats({ now: QUIET_AFTER_MS, seats, tasks, memory });
    expect(first).toEqual([{ kind: 'nudge', seat: 'b1', taskId: 'T-01', quietMs: QUIET_AFTER_MS }]);
    // Still quiet a minute later: nothing. One nudge per episode.
    expect(watchSeats({ now: QUIET_AFTER_MS + MIN, seats, tasks, memory })).toEqual([]);
  });

  it('is not nudged while it is working, whatever the clock says', () => {
    const memory = new Map<string, WatchMemory>();
    const seats = [seat('lead', 'leader'), seat('b1', 'worker', { activity: { working: true, at: 0 }, running: true })];
    expect(watchSeats({ now: 3 * QUIET_AFTER_MS, seats, tasks: [task('T-01', 'b1', 'in_progress')], memory })).toEqual([]);
  });

  it('measures silence from its last board post when that is later than presence', () => {
    const memory = new Map<string, WatchMemory>();
    const seats = [
      seat('lead', 'leader'),
      seat('b1', 'worker', { activity: { working: false, at: 0 }, running: true, spokeAt: 5 * MIN }),
    ];
    const tasks = [task('T-01', 'b1', 'in_progress')];
    expect(watchSeats({ now: QUIET_AFTER_MS + MIN, seats, tasks, memory })).toEqual([]);
    expect(watchSeats({ now: QUIET_AFTER_MS + 5 * MIN, seats, tasks, memory })).toHaveLength(1);
  });

  it('escalates to the lead once if it stays quiet after the nudge', () => {
    const memory = new Map<string, WatchMemory>();
    const seats = [seat('lead', 'leader'), seat('b1', 'worker', { activity: { working: false, at: 0 }, running: true })];
    const tasks = [task('T-01', 'b1', 'in_progress')];
    watchSeats({ now: QUIET_AFTER_MS, seats, tasks, memory });

    expect(watchSeats({ now: QUIET_AFTER_MS + ESCALATE_AFTER_MS - MIN, seats, tasks, memory })).toEqual([]);
    const escalated = watchSeats({ now: QUIET_AFTER_MS + ESCALATE_AFTER_MS, seats, tasks, memory });
    expect(escalated).toEqual([
      { kind: 'escalate', seat: 'b1', taskId: 'T-01', quietMs: QUIET_AFTER_MS + ESCALATE_AFTER_MS, lead: 'lead', reason: 'quiet' },
    ]);
    expect(watchSeats({ now: 10 * QUIET_AFTER_MS, seats, tasks, memory })).toEqual([]);
  });

  it('starts a new episode when it works again and then goes quiet again', () => {
    const memory = new Map<string, WatchMemory>();
    const tasks = [task('T-01', 'b1', 'in_progress')];
    const quiet = [seat('lead', 'leader'), seat('b1', 'worker', { activity: { working: false, at: 0 }, running: true })];
    watchSeats({ now: QUIET_AFTER_MS, seats: quiet, tasks, memory });

    const busy = [seat('lead', 'leader'), seat('b1', 'worker', { activity: { working: true, at: 2 * QUIET_AFTER_MS }, running: true })];
    expect(watchSeats({ now: 2 * QUIET_AFTER_MS, seats: busy, tasks, memory })).toEqual([]);

    const again = [seat('lead', 'leader'), seat('b1', 'worker', { activity: { working: false, at: 2 * QUIET_AFTER_MS }, running: true })];
    expect(watchSeats({ now: 3 * QUIET_AFTER_MS, seats: again, tasks, memory })).toEqual([
      { kind: 'nudge', seat: 'b1', taskId: 'T-01', quietMs: QUIET_AFTER_MS },
    ]);
  });

  it('is left alone once its task is submitted or accepted', () => {
    const memory = new Map<string, WatchMemory>();
    const seats = [seat('lead', 'leader'), seat('b1', 'worker', { activity: { working: false, at: 0 }, running: true })];
    for (const state of ['submitted', 'accepted'] as const) {
      expect(watchSeats({ now: 3 * QUIET_AFTER_MS, seats, tasks: [task('T-01', 'b1', state)], memory })).toEqual([]);
    }
  });

  it('goes straight to the lead when its process has exited, since nothing would read a nudge', () => {
    const memory = new Map<string, WatchMemory>();
    const seats = [seat('lead', 'leader'), seat('b1', 'worker', { running: false })];
    const tasks = [task('T-01', 'b1', 'acknowledged')];
    expect(watchSeats({ now: MIN, seats, tasks, memory })).toEqual([
      { kind: 'escalate', seat: 'b1', taskId: 'T-01', quietMs: 0, lead: 'lead', reason: 'exited' },
    ]);
    expect(watchSeats({ now: 2 * MIN, seats, tasks, memory })).toEqual([]);
  });

  it('says nothing about a seat that has never reported presence', () => {
    // No hook and no turn boundary means no fact to act on. Silence here is
    // honest; a guess would nag a seat that may be mid-edit.
    const memory = new Map<string, WatchMemory>();
    const seats = [seat('lead', 'leader'), seat('b1', 'worker', { running: true })];
    expect(watchSeats({ now: 5 * QUIET_AFTER_MS, seats, tasks: [task('T-01', 'b1', 'in_progress')], memory })).toEqual([]);
  });
});

describe('a lead that ended its turn with work waiting on its verdict', () => {
  it('is reminded once per submitted task', () => {
    const memory = new Map<string, WatchMemory>();
    const seats = [seat('lead', 'leader', { activity: { working: false, at: 0 } }), seat('b1', 'worker')];
    const tasks = [task('T-01', 'b1', 'submitted'), task('T-02', 'b1', 'submitted')];
    const actions = watchSeats({ now: QUIET_AFTER_MS, seats, tasks, memory });
    expect(actions.map((action) => action.kind)).toEqual(['lead-nudge', 'lead-nudge']);
    expect(watchSeats({ now: 2 * QUIET_AFTER_MS, seats, tasks, memory })).toEqual([]);
    // A third submission is news.
    expect(
      watchSeats({ now: 2 * QUIET_AFTER_MS, seats, tasks: [...tasks, task('T-03', 'b1', 'submitted')], memory }),
    ).toEqual([{ kind: 'lead-nudge', lead: 'lead', taskId: 'T-03', quietMs: 2 * QUIET_AFTER_MS }]);
  });

  it('is not reminded while it is working', () => {
    const memory = new Map<string, WatchMemory>();
    const seats = [seat('lead', 'leader', { activity: { working: true, at: 0 } }), seat('b1', 'worker')];
    expect(watchSeats({ now: 5 * QUIET_AFTER_MS, seats, tasks: [task('T-01', 'b1', 'submitted')], memory })).toEqual([]);
  });
});

describe('what the cards say', () => {
  it('tells a nudged builder the two legal moves and who hears next', () => {
    const card = renderWatchAction({ kind: 'nudge', seat: 'b1', taskId: 'T-01', quietMs: 11 * MIN });
    expect(card.to).toBe('b1');
    expect(card.head).toContain('T-01');
    expect(card.body).toMatch(/act\(\{kind:"done"\}\)/);
    expect(card.body).toMatch(/blocked/);
    expect(card.body).toContain('11 min');
  });

  it('tells the lead its three options, including release', () => {
    const card = renderWatchAction({ kind: 'escalate', seat: 'b1', taskId: 'T-01', quietMs: 20 * MIN, lead: 'lead', reason: 'quiet' });
    expect(card.to).toBe('lead');
    expect(card.body).toMatch(/reassign/);
    expect(card.body).toMatch(/release", id:"b1"/);
  });

  it('names an exited process as such, not as quiet', () => {
    const card = renderWatchAction({ kind: 'escalate', seat: 'b1', taskId: 'T-01', quietMs: 0, lead: 'lead', reason: 'exited' });
    expect(card.head).toMatch(/exited/);
  });
});
