import { describe, expect, it } from 'vitest';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import type { Participant } from '../../src/contracts/participant.js';
import { deriveState } from '../../src/ui/state/derive.js';

const participant: Participant = {
  id: 'codex',
  role: 'worker',
  harness: 'codex-cli',
  lifecycle: 'attached',
  workspace: '.crosstalk/worktrees/codex',
  transport: 'mcp',
};

function openedDecision(seq: number, id: string): CrosstalkEvent {
  return {
    seq,
    ts: `2026-08-09T00:00:0${seq}Z`,
    from: 'leader',
    room: 'dispute:C-1',
    kind: 'decision_opened',
    decision: {
      id,
      question: 'Which evidence should the hub display?',
      options: ['first', 'second'],
      voters: ['leader'],
      method: 'human',
      rationale: [],
      votes: {},
    },
  };
}

describe('deriveState', () => {
  it('orders by seq and attributes a rejoin to the joined participant', () => {
    const left: CrosstalkEvent = {
      seq: 2,
      ts: '2026-08-09T00:00:02Z',
      from: 'leader',
      kind: 'participant_left',
      participantId: 'codex',
    };
    const rejoined: CrosstalkEvent = {
      seq: 3,
      ts: '2026-08-09T00:00:03Z',
      from: 'leader',
      kind: 'participant_joined',
      participant,
    };

    const state = deriveState([rejoined, left]);

    expect(state.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(state.lastSeq).toBe(3);
    expect(state.participants).toEqual([
      expect.objectContaining({ id: 'codex', status: 'awaiting_turn' }),
    ]);
  });

  it('keeps a room urgent while another human decision remains open', () => {
    const resolved: CrosstalkEvent = {
      seq: 3,
      ts: '2026-08-09T00:00:03Z',
      from: 'leader',
      room: 'dispute:C-1',
      kind: 'decision_resolved',
      decisionId: 'D-1',
      outcome: 'first',
    };

    const state = deriveState([resolved, openedDecision(2, 'D-2'), openedDecision(1, 'D-1')]);

    // #floor is always present — seeded from the FLOOR constant rather than
    // derived from traffic (spec §4.2) — so assert on the dispute room rather
    // than on the exact shape of the whole list.
    expect(state.rooms).toContainEqual(
      expect.objectContaining({ id: 'dispute:C-1', awaitingHuman: true }),
    );
  });

  it('always offers #floor, even in a log where nobody posted there', () => {
    const state = deriveState([openedDecision(1, 'D-1')]);
    expect(state.rooms).toContainEqual(expect.objectContaining({ id: '#floor', kind: 'floor' }));
  });

  it('omits the tier badge for a participant whose transport was never probed', () => {
    const joined: CrosstalkEvent = {
      seq: 1,
      ts: '2026-08-09T00:00:01Z',
      from: 'codex',
      kind: 'participant_joined',
      participant: {
        id: 'codex',
        role: 'worker',
        harness: 'codex-app',
        lifecycle: 'attached',
        workspace: '.crosstalk/worktrees/codex',
      },
    };

    // Undefined must stay undefined: `file` would claim doctor probed and
    // found the lowest tier, which is a different and untrue statement.
    expect(deriveState([joined]).participants[0]?.tier).toBeUndefined();
  });
});
