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

/**
 * C2. `DEFAULT_MAX_ROUNDS = 3` lived in two files and neither read the config
 * the daemon was running. The denominator is configuration, so it arrives as
 * one, or it does not arrive at all.
 */
describe('C2 maxRounds threading', () => {
  const disputeEvents: CrosstalkEvent[] = [
    {
      seq: 1,
      ts: '2026-08-09T00:00:01Z',
      kind: 'claim_raised',
      from: 'leader',
      room: 'dispute:C-1',
      claim: {
        id: 'C-1',
        raisedBy: 'leader',
        against: 'codex',
        target: 'src/economy.ts:41',
        assertion: 'The staffing coefficient is applied twice.',
        severity: 'defect',
        falsifier: 'produce() and consume() reference different multipliers.',
        evidence: [],
        state: 'open',
        rounds: 2,
      },
    },
  ];

  it('carries the configured maximum onto dispute rooms', () => {
    const state = deriveState(disputeEvents, 5);

    expect(state.rooms.find((room) => room.id === 'dispute:C-1')?.maxRounds).toBe(5);
  });

  it('leaves the maximum undefined when no config supplied one', () => {
    // Never 3. A default here reinstates the bug and hides the regression.
    const state = deriveState(disputeEvents);

    expect(state.rooms.find((room) => room.id === 'dispute:C-1')?.maxRounds).toBeUndefined();
  });
});

/**
 * C2. The `human` badge was computed from `ladder[currentRung ?? 0]`, so it
 * fired only when `human` was the *first* rung. Spec §10.3 makes the human the
 * terminal authority, and terminal rungs are reached by escalating — which is
 * exactly the case the badge missed.
 */
describe('C2 human badge follows the live rung', () => {
  function ladderDecision(seq: number): CrosstalkEvent {
    return {
      seq,
      ts: `2026-08-09T00:00:0${seq}Z`,
      from: 'leader',
      room: 'dispute:C-2',
      kind: 'decision_opened',
      decision: {
        id: 'D-2',
        question: 'Does the staffing coefficient apply twice?',
        options: ['twice', 'once'],
        voters: ['leader', '@human'],
        method: 'ladder',
        ladder: ['discriminating_test', 'leader', 'human'],
        currentRung: 0,
        rationale: [],
        votes: {},
      },
    };
  }

  it('badges the room once the ladder escalates to the human rung', () => {
    const escalated: CrosstalkEvent[] = [
      ladderDecision(1),
      {
        seq: 2,
        ts: '2026-08-09T00:00:02Z',
        from: 'leader',
        room: 'dispute:C-2',
        kind: 'rung_entered',
        decisionId: 'D-2',
        rung: 'human',
        index: 2,
      },
    ];

    const state = deriveState(escalated);

    expect(state.rooms.find((room) => room.id === 'dispute:C-2')?.awaitingHuman).toBe(true);
  });

  it('does not badge a room whose ladder has not reached the human rung', () => {
    // The neighbouring case that must not fire: `human` is configured, but the
    // dispute is still on rung 0 and nobody is waiting on a person.
    const state = deriveState([ladderDecision(1)]);

    expect(state.rooms.find((room) => room.id === 'dispute:C-2')?.awaitingHuman).toBeFalsy();
  });
});
