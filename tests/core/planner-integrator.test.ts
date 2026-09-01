import { describe, expect, it } from 'vitest';
import type { CrosstalkEvent } from '../../src/contracts/events.js';
import { operatorWasAsked, phaseStatus } from '../../src/core/phase.js';
import { SHAPES, gateRef } from '../../src/core/shape.js';
import { renderInbox } from '../../src/core/inbox.js';
import { project } from '../../src/core/projection.js';

const SHAPE = SHAPES.get('planner-integrator')!;
const SEATS = ['planner', 'b-1', 'b-2'];

function decisionOpened(seq: number, method: 'human' | 'leader'): CrosstalkEvent {
  return {
    kind: 'decision_opened',
    seq,
    ts: '2026-09-01T00:00:00.000Z',
    from: 'planner',
    room: '#floor',
    decision: {
      id: 'D-01',
      question: 'Do we ship the map before the combat?',
      options: ['map first', 'combat first'],
      voters: ['@human'],
      method,
      rationale: [],
      votes: {},
    },
  };
}

function voted(seq: number, from: string): CrosstalkEvent {
  return {
    kind: 'vote_cast',
    seq,
    ts: '2026-09-01T00:00:00.000Z',
    from,
    room: '#floor',
    decisionId: 'D-01',
    option: 'map first',
  };
}

const met = new Map([
  ['contract-exists' as const, { met: true }],
  ['no-shared-files' as const, { met: true }],
]);

/**
 * Planning with the operator, made mechanical.
 *
 * "Plan with the user first" is exactly the kind of instruction that reads well
 * in a brief and changes nothing — the vault-team brief told every seat to use
 * side rooms, twice, and across 1187 events none did. A gate is the difference.
 */
describe('the operator-questioned gate', () => {
  it('is not met by a question nobody answered', () => {
    expect(operatorWasAsked([decisionOpened(1, 'human')])).toBe(false);
  });

  it('is met once the operator votes', () => {
    expect(operatorWasAsked([decisionOpened(1, 'human'), voted(2, '@human')])).toBe(true);
  });

  it('is not met by a decision the seats settled among themselves', () => {
    // The neighbouring case. Three agents agreeing with each other is not the
    // operator having been asked.
    expect(operatorWasAsked([decisionOpened(1, 'leader'), voted(2, 'b-1')])).toBe(false);
    expect(operatorWasAsked([decisionOpened(1, 'human'), voted(2, 'b-1')])).toBe(false);
  });

  it('holds the plan phase shut until it is met', () => {
    const before = phaseStatus(SHAPE, { events: [], participants: SEATS, workspace: met });
    expect(before.id).toBe('plan');
    expect(before.blocking.join(' ')).toContain('operator-questioned');

    const after = phaseStatus(SHAPE, {
      events: [decisionOpened(1, 'human'), voted(2, '@human')],
      participants: SEATS,
      workspace: met,
    });
    expect(after.blocking.join(' ')).not.toContain('operator-questioned');
  });
});

describe('a phase that belongs to one seat', () => {
  function say(seq: number, from: string, gate: Parameters<typeof gateRef>[0]): CrosstalkEvent {
    return {
      kind: 'message',
      seq,
      ts: '2026-09-01T00:00:00.000Z',
      from,
      room: '#floor',
      body: 'posted',
      ref: gateRef(gate),
    };
  }

  // Everything through the end of build, so the team is sitting in verify.
  const throughBuild: CrosstalkEvent[] = [
    decisionOpened(1, 'human'),
    voted(2, '@human'),
    say(3, 'planner', 'slices-posted'),
    say(4, 'b-1', 'slice-done'),
    say(5, 'b-2', 'slice-done'),
    say(6, 'planner', 'slice-done'),
  ];

  const phase = phaseStatus(SHAPE, { events: throughBuild, participants: SEATS, workspace: met });

  function inboxFor(role: 'leader' | 'worker') {
    return renderInbox({
      who: role === 'leader' ? 'planner' : 'b-1',
      role,
      unread: [],
      state: project([]),
      phase,
    });
  }

  it('is verify, and it is the planner’s', () => {
    expect(phase.id).toBe('verify');
    expect(phase.owner).toBe('leader');
  });

  it('leaves a builder idle rather than telling it about a gate it cannot meet', () => {
    // 51% of the vault-team run's peer messages came after the work was built.
    // A seat told, every turn, about a gate that is not its own will fill a
    // board with something.
    expect(inboxFor('worker').next).toBe('idle');
  });

  it('still tells the seat that owns it what is outstanding', () => {
    expect(inboxFor('leader').next).toContain('bug-list-posted');
  });

  it('still delivers a message addressed to an idle builder', () => {
    // The failure mode this must not have: three seats that cannot be woken.
    // `next` governs whether a turn is spent, never whether a card arrives.
    const asked = renderInbox({
      who: 'b-1',
      role: 'worker',
      unread: [
        {
          kind: 'message',
          seq: 9,
          ts: '2026-09-01T00:00:00.000Z',
          from: 'planner',
          room: 'dm:b-1~planner',
          body: 'your slice regressed on merge — can you look?',
          head: 'your slice regressed on merge — can you look?',
          tag: 'ask',
          to: 'b-1',
        },
      ],
      state: project([]),
      phase,
    });

    expect(asked.unread).toHaveLength(1);
    expect(asked.unread[0]!.summary).toContain('regressed');
  });
});
